"""ComfyUI HTTP/WebSocket 클라이언트 — FLUX 워크플로우 실행.

ComfyUI 서버: 192.168.219.88:8188 (--lowvram 모드).
워크플로우 JSON 파일은 workflows/ 폴더에 저장.
각 함수: 워크플로우 로드 → input 주입 → /prompt 제출 → 결과 폴링 → /view 로 fetch.
"""
import io
import json
import logging
import os
import time
import uuid
from typing import Any, Optional

import threading
import urllib.request
import urllib.parse

from PIL import Image

log = logging.getLogger(__name__)

COMFYUI_BASE = os.getenv('COMFYUI_BASE_URL', 'http://192.168.219.88:8188')

# Thread-local override — dispatcher 가 워커별로 다른 base 호출 시 race 방지.
_LOCAL = threading.local()


def _base() -> str:
    """현재 스레드의 base URL. set_base() 안 호출했으면 기본 COMFYUI_BASE."""
    return getattr(_LOCAL, 'base', None) or COMFYUI_BASE


def set_base(url: str) -> None:
    """현재 스레드에 한해 base URL 설정. dispatcher 가 워커당 1 thread 에서 호출."""
    _LOCAL.base = url
WORKFLOWS_DIR = os.path.join(os.path.dirname(__file__), 'workflows')

# 기본 timeout — 첫 호출은 모델 로드로 느림
POLL_INTERVAL = 1.5
POLL_TIMEOUT = 300  # 5분


def _post_json(path: str, data: dict) -> dict:
    req = urllib.request.Request(
        f'{_base()}{path}',
        data=json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def _get_json(path: str) -> dict:
    with urllib.request.urlopen(f'{_base()}{path}', timeout=30) as r:
        return json.loads(r.read())


def _get_bytes(path: str) -> bytes:
    with urllib.request.urlopen(f'{_base()}{path}', timeout=60) as r:
        return r.read()


def health() -> dict:
    """ComfyUI 가용성 + 큐 상태."""
    try:
        q = _get_json('/queue')
        s = _get_json('/system_stats')
        return {
            'ok': True,
            'comfyui_base': COMFYUI_BASE,
            'queue_running': len(q.get('queue_running', [])),
            'queue_pending': len(q.get('queue_pending', [])),
            'system': s.get('system', {}),
            'devices': s.get('devices', []),
        }
    except Exception as e:
        return {'ok': False, 'comfyui_base': COMFYUI_BASE, 'error': str(e)}


def upload_image(image: Image.Image, name: Optional[str] = None) -> str:
    """ComfyUI 에 이미지 업로드. /upload/image 엔드포인트는 multipart/form-data."""
    if name is None:
        name = f'nv_{uuid.uuid4().hex[:12]}.png'
    buf = io.BytesIO()
    image.convert('RGBA').save(buf, format='PNG')
    data = buf.getvalue()

    boundary = '----nv' + uuid.uuid4().hex
    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="image"; filename="{name}"\r\n'
        f'Content-Type: image/png\r\n\r\n'
    ).encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(
        f'{_base()}/upload/image',
        data=body,
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'Content-Length': str(len(body)),
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    # 응답: {'name': 'nv_xxx.png', 'subfolder': '', 'type': 'input'}
    return resp.get('name') or name


def load_workflow(workflow_name: str) -> dict:
    """workflows/<name>.json 로드."""
    path = os.path.join(WORKFLOWS_DIR, f'{workflow_name}.json')
    if not os.path.exists(path):
        raise FileNotFoundError(f'workflow not found: {path}')
    with open(path) as f:
        return json.load(f)


def queue_prompt(workflow: dict, client_id: Optional[str] = None) -> str:
    """워크플로우 제출 → prompt_id 반환.
    '__random__' 자리표시자를 seed/noise_seed 에 자동 주입."""
    import random
    for node in workflow.values():
        ins = node.get('inputs', {})
        for k in ('seed', 'noise_seed'):
            if ins.get(k) == '__random__':
                ins[k] = random.randint(1, 2**31 - 1)
    payload: dict[str, Any] = {'prompt': workflow}
    if client_id:
        payload['client_id'] = client_id
    r = _post_json('/prompt', payload)
    return r['prompt_id']


def wait_for_result(prompt_id: str, timeout: int = POLL_TIMEOUT) -> list[Image.Image]:
    """완료까지 폴링 → 출력 이미지 리스트."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = _get_json(f'/history/{prompt_id}')
        if prompt_id in hist:
            entry = hist[prompt_id]
            outputs = entry.get('outputs', {})
            images: list[Image.Image] = []
            for node_id, out in outputs.items():
                for img_meta in out.get('images', []):
                    qs = urllib.parse.urlencode({
                        'filename': img_meta['filename'],
                        'subfolder': img_meta.get('subfolder', ''),
                        'type': img_meta.get('type', 'output'),
                    })
                    data = _get_bytes(f'/view?{qs}')
                    images.append(Image.open(io.BytesIO(data)).convert('RGBA'))
            if not images:
                # 빈 결과 (에러일 수도)
                status = entry.get('status', {})
                raise RuntimeError(f'ComfyUI 빈 결과. status={status}')
            return images
        time.sleep(POLL_INTERVAL)
    raise TimeoutError(f'ComfyUI 폴링 타임아웃 ({timeout}s) prompt_id={prompt_id}')


def run_workflow(workflow_name: str, image_inputs: dict[str, Image.Image],
                 text_inputs: dict, numeric_inputs: dict) -> list[Image.Image]:
    """범용 실행:
      1) workflow 로드
      2) 이미지 입력 업로드 → workflow node 의 inputs.image 에 파일명 주입
      3) 텍스트/숫자 입력 주입
      4) /prompt 제출 → 결과 대기
    """
    workflow = load_workflow(workflow_name)

    # 이미지 업로드 + 노드에 주입
    # workflow JSON 의 LoadImage 노드들에 '__inject_image__' 표시 → 이 부분을 업로드된 파일명으로 치환
    for inject_key, img in image_inputs.items():
        filename = upload_image(img)
        for node in workflow.values():
            ins = node.get('inputs', {})
            for k, v in list(ins.items()):
                if isinstance(v, str) and v == f'__{inject_key}__':
                    ins[k] = filename

    # 텍스트 입력 주입
    for inject_key, text in text_inputs.items():
        for node in workflow.values():
            ins = node.get('inputs', {})
            for k, v in list(ins.items()):
                if isinstance(v, str) and v == f'__{inject_key}__':
                    ins[k] = text

    # 숫자 입력 주입
    for inject_key, num in numeric_inputs.items():
        for node in workflow.values():
            ins = node.get('inputs', {})
            for k, v in list(ins.items()):
                if isinstance(v, str) and v == f'__{inject_key}__':
                    ins[k] = num

    # seed 랜덤화
    import random
    for node in workflow.values():
        if node.get('class_type') in ('KSampler', 'SamplerCustomAdvanced', 'RandomNoise'):
            ins = node.get('inputs', {})
            if 'seed' in ins and ins['seed'] == '__random__':
                ins['seed'] = random.randint(1, 2**31 - 1)
            if 'noise_seed' in ins and ins['noise_seed'] == '__random__':
                ins['noise_seed'] = random.randint(1, 2**31 - 1)

    prompt_id = queue_prompt(workflow)
    log.info(f'[flux] {workflow_name} submitted prompt_id={prompt_id}')
    return wait_for_result(prompt_id)
