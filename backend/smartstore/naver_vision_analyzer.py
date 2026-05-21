"""상품 이미지 → 시각 속성 JSON 추출기 (Ollama gemma3:12b 멀티모달).

상품명 생성 정확도 향상을 위해 이미지에서 추출:
  - color (주요 색상 1~3개)
  - material (소재/재질)
  - form (상품 형태/유형)
  - package_qty (패키지 수량/구성 정보)
  - key_features (눈에 띄는 특징 키워드 배열)
  - readable_text (이미지 안에 보이는 글자 — 모델명, 용량 등)

결과를 naver_my_product.image_analysis (JSON) 에 캐싱. 한 상품당 1회만 호출.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from datetime import datetime

import requests
from django.db import connections

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_URL = (
    os.environ.get('OLLAMA_VISION_URL_OVERRIDE')
    or os.environ.get('OLLAMA_URL_OVERRIDE')
    or os.environ.get('NAVER_OLLAMA_URL')
    or 'http://localhost:11438'
)
DEFAULT_MODELS = ['qwen2.5vl:7b', 'gemma3:12b']  # qwen2.5vl 우선(한국어/e-commerce), gemma3 fallback
HTTP_TIMEOUT = float(os.environ.get('NAVER_VISION_TIMEOUT', '90'))
IMAGE_DL_TIMEOUT = float(os.environ.get('NAVER_IMAGE_DL_TIMEOUT', '10'))
IMAGE_MAX_BYTES = 5 * 1024 * 1024  # 5MB 안전 한도


_VISION_PROMPT = """당신은 한국 이커머스 상품 이미지 분석 전문가입니다.
주어진 상품 사진을 보고 네이버 쇼핑 상품명 작성에 도움될 시각적 속성을 JSON으로만 출력하세요.

추출 항목:
- color: 주요 색상 1~3개 (한글, 예: ["블랙", "화이트"])
- material: 소재/재질 (한글, 예: "스테인리스" / "면" / "플라스틱" / null)
- form: 상품 형태/유형 (한글, 예: "텀블러" / "후크" / "캐리어" / null)
- package_qty: 패키지 구성 정보 (예: "1세트", "10개입", "2팩", null)
- key_features: 눈에 띄는 특징 3~6개 한글 키워드 배열 (예: ["접이식", "휴대용", "이중구조"])
- readable_text: 이미지 안에서 보이는 글자 (모델명/용량/숫자 등, 그대로 1줄, 없으면 null)

규칙:
- 보이지 않는/추측해야 하는 항목은 null 또는 빈 배열
- 한국어로만 작성
- 광고 문구/홍보 어휘는 무시
- 출력은 JSON 한 개 객체. ```json``` fence 도 붙이지 말 것. 설명 문장 금지.

JSON:"""


def _download_image_b64(url: str) -> str | None:
    """이미지 URL → base64. 실패 시 None."""
    try:
        r = requests.get(url, timeout=IMAGE_DL_TIMEOUT, stream=True)
        r.raise_for_status()
        data = r.raw.read(IMAGE_MAX_BYTES + 1, decode_content=True)
        if len(data) > IMAGE_MAX_BYTES:
            logger.warning('이미지 너무 큼 (%dB): %s', len(data), url[:80])
            return None
        return base64.b64encode(data).decode('ascii')
    except Exception as e:
        logger.warning('이미지 다운로드 실패: %s — %s', url[:80], e)
        return None


def _call_ollama_vision(b64: str, model: str, url: str) -> str:
    payload = {
        'model': model,
        'messages': [
            {
                'role': 'user',
                'content': _VISION_PROMPT,
                'images': [b64],
            },
        ],
        'stream': False,
        'options': {'temperature': 0.2, 'num_predict': 600},
    }
    r = requests.post(f'{url}/api/chat', json=payload, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    return (data.get('message') or {}).get('content', '') or ''


_JSON_RE = re.compile(r'\{[\s\S]*\}')


def _parse_json(text: str) -> dict | None:
    text = text.strip()
    # ```json ... ``` fence 제거
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```\s*$', '', text)
    # 첫 { ... } 만 추출
    m = _JSON_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        # 누락 콤마 등 미세 보정 시도
        s = m.group(0)
        s = re.sub(r',\s*}', '}', s)
        s = re.sub(r',\s*]', ']', s)
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return None


def _normalize(data: dict) -> dict:
    """필드 정규화 — 누락 키는 None/[]로 채움."""
    out = {
        'color': data.get('color'),
        'material': data.get('material'),
        'form': data.get('form'),
        'package_qty': data.get('package_qty'),
        'key_features': data.get('key_features') or [],
        'readable_text': data.get('readable_text'),
    }
    # color/key_features 가 문자열이면 리스트로
    if isinstance(out['color'], str):
        out['color'] = [c.strip() for c in re.split(r'[,/]', out['color']) if c.strip()]
    if isinstance(out['key_features'], str):
        out['key_features'] = [c.strip() for c in re.split(r'[,/]', out['key_features']) if c.strip()]
    # 빈 문자열 → None
    for k in ('material', 'form', 'package_qty', 'readable_text'):
        if out[k] in ('', '없음', 'null', 'None', None):
            out[k] = None
    return out


# ── DB ─────────────────────────────────────────────

def _fetch_product_image(product_id: int) -> dict | None:
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            "SELECT id, image_large, image_medium, image_small, image_analysis "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if not row:
            return None
        return {
            'id': row[0],
            'image_large': row[1],
            'image_medium': row[2],
            'image_small': row[3],
            'image_analysis': row[4],
        }


def _save_analysis(product_id: int, analysis: dict):
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product "
            "SET image_analysis=%s, image_analyzed_at=NOW() "
            "WHERE id=%s",
            [json.dumps(analysis, ensure_ascii=False), product_id],
        )


def get_cached_analysis(product_id: int) -> dict | None:
    """DB에 캐싱된 분석 결과 가져오기 (없으면 None)."""
    p = _fetch_product_image(product_id)
    if not p:
        return None
    raw = p.get('image_analysis')
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


# ── Public ─────────────────────────────────────────

def analyze_product_image(product_id: int,
                          force: bool = False,
                          url: str | None = None,
                          models: list[str] | None = None) -> dict:
    """상품 이미지 분석 (캐시 우선).

    Args:
        product_id: naver_my_product.id
        force: True 면 캐시 무시하고 재분석
        url, models: 디버그/오버라이드
    """
    p = _fetch_product_image(product_id)
    if not p:
        return {'ok': False, 'error': 'not_found'}

    # 캐시 hit
    cached = None if force else (p.get('image_analysis') and get_cached_analysis(product_id))
    if cached:
        return {'ok': True, 'analysis': cached, 'cached': True, 'elapsed_ms': 0}

    # 이미지 URL 결정 (large > medium > small)
    img_url = p['image_large'] or p['image_medium'] or p['image_small']
    if not img_url:
        return {'ok': False, 'error': 'no_image_url'}

    t0 = time.time()
    b64 = _download_image_b64(img_url)
    if not b64:
        return {'ok': False, 'error': 'image_download_failed', 'image_url': img_url}

    use_url = url or DEFAULT_OLLAMA_URL
    use_models = models or DEFAULT_MODELS

    last_err = None
    for model in use_models:
        try:
            raw = _call_ollama_vision(b64, model, use_url)
        except Exception as e:
            last_err = str(e)[:200]
            logger.warning('vision %s 실패: %s', model, e)
            continue

        data = _parse_json(raw)
        if not data:
            last_err = f'JSON 파싱 실패: {raw[:120]!r}'
            continue

        analysis = _normalize(data)
        _save_analysis(product_id, analysis)
        elapsed_ms = int((time.time() - t0) * 1000)
        return {
            'ok': True,
            'analysis': analysis,
            'cached': False,
            'model': model,
            'elapsed_ms': elapsed_ms,
            'image_url': img_url,
        }

    return {'ok': False, 'error': last_err or 'all_models_failed', 'image_url': img_url}
