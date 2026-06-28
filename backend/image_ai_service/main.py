"""Naverterms Image AI Service (FastAPI, port 8902).

PoC: 단일 이미지 처리 엔드포인트 4개.
모든 엔드포인트는 image_b64 (data URL 또는 순수 base64) 입력 → 처리 → image_b64 반환.
"""
import base64
import io
import logging
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

import os as _os
import pipeline
import flux_client
import flux_workflows as fw
import sd15_workflows as sw

# 모델 가족 선택: 'flux' | 'sd15' | 'auto'
# auto: ComfyUI 에 FLUX 가 있으면 우선, 없으면 SD15 fallback
_MODEL_FAMILY = _os.getenv('IMAGE_AI_MODEL_FAMILY', 'auto').lower()


def _use_sd15() -> bool:
    """현재 SD 1.5 워크플로우를 사용할지 결정."""
    if _MODEL_FAMILY == 'sd15':
        return True
    if _MODEL_FAMILY == 'flux':
        return False
    # auto — ComfyUI 의 가용 unet 목록 조회 (캐시 안 함, 매번 체크)
    try:
        import urllib.request
        import json as _json
        r = urllib.request.urlopen(f'{flux_client.COMFYUI_BASE}/object_info/UnetLoaderGGUF', timeout=3)
        info = _json.loads(r.read())
        unets = info.get('UnetLoaderGGUF', {}).get('input', {}).get('required', {}).get('unet_name', [[]])[0]
        if any('flux' in u.lower() for u in unets):
            return False
    except Exception:
        pass
    return True  # FLUX 안 보이면 SD15 fallback

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('image_ai')

app = FastAPI(title='Naverterms Image AI', version='0.0.1')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


class ImageReq(BaseModel):
    image_b64: Optional[str] = None
    image_url: Optional[str] = None  # http(s) URL — 서버사이드 fetch
    model: Optional[str] = None
    params: Optional[dict] = None


class ImageResp(BaseModel):
    ok: bool
    image_b64: str
    op: str
    elapsed_ms: int
    meta: dict = {}


def _decode(b64: str) -> Image.Image:
    if ',' in b64[:64]:
        b64 = b64.split(',', 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGBA')


def _fetch_url(url: str) -> Image.Image:
    import urllib.request
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://shopping.naver.com/',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
    return Image.open(io.BytesIO(data)).convert('RGBA')


def _load(req: 'ImageReq') -> Image.Image:
    if req.image_b64:
        return _decode(req.image_b64)
    if req.image_url:
        return _fetch_url(req.image_url)
    raise HTTPException(400, 'image_b64 또는 image_url 중 하나 필요')


def _encode(img: Image.Image, fmt: str = 'WEBP') -> str:
    buf = io.BytesIO()
    if fmt == 'JPEG' and img.mode == 'RGBA':
        img = img.convert('RGB')
    if fmt == 'WEBP':
        img.save(buf, format='WEBP', quality=92, method=6, lossless=False)
    else:
        img.save(buf, format=fmt, quality=92)
    return base64.b64encode(buf.getvalue()).decode()


@app.get('/api/v1/health')
def health():
    return {
        'ok': True,
        'device': pipeline.device(),
        'loaded': pipeline.loaded_models(),
        'upscale_engine': pipeline.upscale_engine(),
        'flux': flux_client.health(),
    }


# ────────────────── FLUX (ComfyUI 백엔드, 워커 88:8188) ──────────────────

class FluxReq(BaseModel):
    image_b64: Optional[str] = None
    image_url: Optional[str] = None
    prompt: Optional[str] = None
    mask_b64: Optional[str] = None      # 흰색=재생성, 검은색=보존
    ref_b64: Optional[str] = None       # IP-Adapter / Redux 참조
    strength: Optional[float] = None
    guidance: Optional[float] = None
    steps: Optional[int] = None
    scale: Optional[float] = None       # upscale 전용
    n: Optional[int] = None             # redux 배치 크기 (1~4)


class FluxResp(BaseModel):
    ok: bool
    images_b64: list[str]               # 결과 이미지들 (redux=N개, 나머지=1개)
    op: str
    elapsed_ms: int
    meta: dict = {}


def _load_pil(req: FluxReq) -> 'Image.Image':
    """image_b64 또는 image_url 에서 PIL Image 로드."""
    if req.image_b64:
        return _decode(req.image_b64)
    if req.image_url:
        return _fetch_url(req.image_url)
    raise HTTPException(400, 'image_b64 또는 image_url 중 하나 필요')


def _auto_inverse_mask(img: 'Image.Image') -> 'Image.Image':
    """rembg 로 상품 마스크 → 반전 (배경 = 흰색 = 재생성 영역)."""
    out = pipeline.bg_remove(img, model='isnet-general-use')
    alpha = out.split()[-1]
    # alpha=255 (상품) → mask=0 (보존), alpha=0 (배경) → mask=255 (재생성)
    from PIL import ImageOps
    return ImageOps.invert(alpha).convert('RGB')


@app.post('/api/v1/flux-fill', response_model=FluxResp)
def flux_fill_auto(req: FluxReq):
    """배경 교체 (자동 마스크) — FLUX-Fill 또는 SD 1.5 inpaint 자동 선택."""
    t0 = time.time()
    use_sd15 = _use_sd15()
    try:
        img = _load_pil(req)
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 필요')
        if req.mask_b64:
            mask = _decode(req.mask_b64).convert('RGB')
        else:
            mask = _auto_inverse_mask(img)
        image_name = flux_client.upload_image(img)
        mask_name = flux_client.upload_image(mask)
        if use_sd15:
            wf = sw.fill_workflow(image_name, mask_name, req.prompt.strip(),
                                  steps=req.steps or sw.DEFAULT_STEPS, cfg=req.guidance or sw.DEFAULT_CFG)
        else:
            wf = fw.fill_workflow(image_name, mask_name, req.prompt.strip(),
                                  steps=req.steps or 20, guidance=req.guidance or fw.DEFAULT_GUIDANCE)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_fill failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_fill',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'auto_mask': req.mask_b64 is None,
              'family': 'sd15' if use_sd15 else 'flux'},
    )


@app.post('/api/v1/flux-redux', response_model=FluxResp)
def flux_redux(req: FluxReq):
    """4장 시안 variation — FLUX Redux 또는 SD 1.5 batch variation."""
    t0 = time.time()
    use_sd15 = _use_sd15()
    try:
        img = _load_pil(req)
        n = max(1, min(4, req.n or 4))
        image_name = flux_client.upload_image(img)
        if use_sd15:
            wf = sw.variation_workflow(image_name, req.prompt or '', n=n,
                                       denoise=0.5 + (req.strength or 0.0) * 0.3)
        else:
            wf = fw.redux_workflow(image_name, req.prompt or '', n=n,
                                   strength=req.strength or 1.0, steps=req.steps or 20)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_redux failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_redux',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'n': n, 'family': 'sd15' if use_sd15 else 'flux'},
    )


@app.post('/api/v1/flux-kontext', response_model=FluxResp)
def flux_kontext(req: FluxReq):
    """자연어 편집 — FLUX Kontext 또는 SD 1.5 img2img (denoise 0.6)."""
    t0 = time.time()
    use_sd15 = _use_sd15()
    try:
        img = _load_pil(req)
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 필요')
        image_name = flux_client.upload_image(img)
        if use_sd15:
            wf = sw.img2img_workflow(image_name, req.prompt.strip(),
                                     denoise=req.strength or 0.6)
        else:
            wf = fw.kontext_workflow(image_name, req.prompt.strip(),
                                     steps=req.steps or 20, guidance=req.guidance or 2.5)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_kontext failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_kontext',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'family': 'sd15' if use_sd15 else 'flux'},
    )


@app.post('/api/v1/flux-canny', response_model=FluxResp)
def flux_canny(req: FluxReq):
    """[FLUX 전용] Canny 윤곽 보존. SD 1.5 모드에서는 미지원."""
    if _use_sd15():
        raise HTTPException(503, 'Canny 는 FLUX 전용 (HF 토큰 받은 후 사용 가능). 지금은 fill/kontext/redux/upscale 사용')
    t0 = time.time()
    try:
        img = _load_pil(req)
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 필요')
        image_name = flux_client.upload_image(img)
        wf = fw.canny_workflow(image_name, req.prompt.strip(),
                                strength=req.strength or 0.7,
                                steps=req.steps or 20,
                                guidance=req.guidance or 3.5)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_canny failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_canny',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'strength': req.strength or 0.7},
    )


@app.post('/api/v1/flux-depth', response_model=FluxResp)
def flux_depth(req: FluxReq):
    """[FLUX 전용] Depth 3D 구조 보존. SD 1.5 모드에서는 미지원."""
    if _use_sd15():
        raise HTTPException(503, 'Depth 는 FLUX 전용 (HF 토큰 받은 후 사용 가능)')
    t0 = time.time()
    try:
        img = _load_pil(req)
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 필요')
        image_name = flux_client.upload_image(img)
        wf = fw.depth_workflow(image_name, req.prompt.strip(),
                                strength=req.strength or 0.7,
                                steps=req.steps or 20,
                                guidance=req.guidance or 3.5)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_depth failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_depth',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'strength': req.strength or 0.7},
    )


@app.post('/api/v1/flux-upscale', response_model=FluxResp)
def flux_upscale(req: FluxReq):
    """AI 업스케일 — FLUX Tile 또는 SD 1.5 latent upscale."""
    t0 = time.time()
    use_sd15 = _use_sd15()
    try:
        img = _load_pil(req)
        scale = float(req.scale or 2.0)
        image_name = flux_client.upload_image(img)
        if use_sd15:
            wf = sw.upscale_workflow(image_name, scale=scale, denoise=0.25)
        else:
            wf = fw.upscale_tile_workflow(image_name, scale=scale, denoise=0.3, steps=req.steps or 12)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_upscale failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_upscale',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'scale': scale, 'family': 'sd15' if use_sd15 else 'flux'},
    )


@app.post('/api/v1/flux-ipadapter', response_model=FluxResp)
def flux_ipadapter(req: FluxReq):
    """IP-Adapter 참조 이미지 스타일 — FLUX 또는 SD 1.5 (ip-adapter-plus_sd15)."""
    t0 = time.time()
    use_sd15 = _use_sd15()
    try:
        img = _load_pil(req)
        if not req.ref_b64:
            raise HTTPException(400, 'ref_b64 (참조 이미지) 필요')
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 필요')
        ref_img = _decode(req.ref_b64)
        image_name = flux_client.upload_image(img)
        ref_name = flux_client.upload_image(ref_img)
        if use_sd15:
            wf = sw.ipadapter_workflow(image_name, ref_name, req.prompt.strip(),
                                       weight=req.strength or 0.7, denoise=0.7)
        else:
            wf = fw.ipadapter_workflow(image_name, ref_name, req.prompt.strip(),
                                       strength=req.strength or 0.7, steps=req.steps or 20)
        pid = flux_client.queue_prompt(wf)
        images = flux_client.wait_for_result(pid)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flux_ipadapter failed')
        raise HTTPException(500, str(e))
    return FluxResp(
        ok=True, op='flux_ipadapter',
        images_b64=[_encode(i, 'WEBP') for i in images],
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'prompt': req.prompt, 'strength': req.strength or 0.7,
              'family': 'sd15' if use_sd15 else 'flux'},
    )


@app.post('/api/v1/bg-remove', response_model=ImageResp)
def bg_remove(req: ImageReq):
    t0 = time.time()
    try:
        img = _load(req)
        model = req.model or 'isnet-general-use'
        out = pipeline.bg_remove(img, model=model)
    except Exception as e:
        log.exception('bg_remove failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='bg_remove',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'model': model, 'size': out.size},
    )


@app.post('/api/v1/text-remove', response_model=ImageResp)
def text_remove(req: ImageReq):
    t0 = time.time()
    try:
        img = _load(req)
        mask = None
        if req.params and req.params.get('mask_b64'):
            mask = _decode(req.params['mask_b64']).convert('L')
        # refine 기본 'box' — 옛 깔끔모드 (글씨 박스 통째로 마스킹, LaMa 가 자연스럽게 채움).
        # 'sam' = SAM 으로 글자 픽셀만 (상품 보존 시도, 단 잔여물 가능).
        # 'otsu' = 빠른 stroke 추출 (가장 위험).
        # 상품이 같이 지워지면 프론트의 "📐 복원영역 선택" 으로 사각형 복원.
        refine_param = (req.params or {}).get('refine', 'box')
        out, n_boxes = pipeline.text_remove(img, mask=mask, refine=refine_param)
    except Exception as e:
        log.exception('text_remove failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='text_remove',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'text_boxes': n_boxes, 'size': out.size, 'mask_mode': refine_param},
    )


@app.post('/api/v1/upscale', response_model=ImageResp)
def upscale(req: ImageReq):
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        scale = float(p.get('scale', 2.0))
        sharpness = float(p.get('sharpness', 1.5))
        out = pipeline.upscale(img, scale=scale, sharpness=sharpness)
    except Exception as e:
        log.exception('upscale failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='upscale',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'scale': scale, 'sharpness': sharpness,
              'engine': pipeline.upscale_engine(), 'size': out.size},
    )


class GenEditReq(BaseModel):
    image_b64: Optional[str] = None
    image_url: Optional[str] = None
    prompt: str
    model: Optional[str] = None  # gemini 모델 변경 시 (기본: gemini-2.5-flash-image)


@app.post('/api/v1/gemini-edit', response_model=ImageResp)
def gemini_edit(req: GenEditReq):
    """Gemini 2.5 Flash Image 로 자연어 편집.
    상품 자체는 보존되도록 prompt prefix 자동 추가.
    Body: { image_b64 | image_url, prompt, model? }
    """
    t0 = time.time()
    try:
        # 임시 ImageReq 로 변환해서 _load 재사용
        loader = ImageReq(image_b64=req.image_b64, image_url=req.image_url)
        img = _load(loader)
        if not req.prompt or not req.prompt.strip():
            raise HTTPException(400, 'prompt 비어있음')
        model_name = req.model or 'gemini-2.5-flash-image'
        out = pipeline.gemini_edit(img, req.prompt.strip(), model=model_name)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('gemini_edit failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='gemini_edit',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'model': model_name, 'prompt': req.prompt, 'size': out.size},
    )


# ────────────────── 로컬 보너스 (Pillow + LaMa + OCR) ──────────────────

@app.post('/api/v1/adjust', response_model=ImageResp)
def adjust(req: ImageReq):
    """밝기/대비/채도/선명도. params: {brightness, contrast, saturation, sharpness} (모두 1.0=원본)"""
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        out = pipeline.adjust(img,
            brightness=float(p.get('brightness', 1.0)),
            contrast=float(p.get('contrast', 1.0)),
            saturation=float(p.get('saturation', 1.0)),
            sharpness=float(p.get('sharpness', 1.0)),
        )
    except Exception as e:
        log.exception('adjust failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='adjust', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'size': out.size, **(req.params or {})})


@app.post('/api/v1/filter', response_model=ImageResp)
def filter_(req: ImageReq):
    """프리셋 필터. params: {preset: 'grayscale'|'sepia'|'cool'|'warm'|'vintage'|'invert'|'posterize'|'solarize'}"""
    t0 = time.time()
    try:
        img = _load(req)
        preset = (req.params or {}).get('preset', 'grayscale')
        out = pipeline.filter_preset(img, preset)
    except Exception as e:
        log.exception('filter failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='filter', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'preset': preset, 'size': out.size})


@app.post('/api/v1/blur', response_model=ImageResp)
def blur(req: ImageReq):
    """가우시안 블러 + 비네팅 (선택).
    params: {radius: 3.0, vignette: 0.0}  — vignette 0 이면 적용 X"""
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        out = img
        r = float(p.get('radius', 0))
        v = float(p.get('vignette', 0))
        if r > 0:
            out = pipeline.blur(out, radius=r)
        if v > 0:
            out = pipeline.vignette(out, strength=v)
    except Exception as e:
        log.exception('blur failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='blur', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'radius': r, 'vignette': v, 'size': out.size})


@app.post('/api/v1/pad-square', response_model=ImageResp)
def pad_square(req: ImageReq):
    """1:1 정사각 캔버스에 색상 패딩 (네이버 권장).
    params: {color: '#ffffff', size: 0}  — size=0 이면 max(w,h)"""
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        out = pipeline.pad_square(img, color=p.get('color', '#ffffff'), size=int(p.get('size', 0)))
    except Exception as e:
        log.exception('pad_square failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='pad_square', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'size': out.size, **(req.params or {})})


@app.post('/api/v1/frame', response_model=ImageResp)
def frame(req: ImageReq):
    """테두리/그림자/둥근 모서리.
    params: {border_px, border_color, shadow, shadow_blur, shadow_offset, rounded}"""
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        out = pipeline.frame(img,
            border_px=int(p.get('border_px', 0)),
            border_color=p.get('border_color', '#ffffff'),
            shadow=bool(p.get('shadow', False)),
            shadow_blur=int(p.get('shadow_blur', 20)),
            shadow_offset=int(p.get('shadow_offset', 10)),
            rounded=int(p.get('rounded', 0)),
        )
    except Exception as e:
        log.exception('frame failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='frame', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'size': out.size, **(req.params or {})})


@app.post('/api/v1/ocr')
def ocr(req: ImageReq):
    """EasyOCR 글자 인식 (제거 X, 결과 반환만).
    응답: {ok, texts: [{box, text, confidence}], all_text, count, elapsed_ms}"""
    t0 = time.time()
    try:
        img = _load(req)
        r = pipeline.ocr_extract(img)
    except Exception as e:
        log.exception('ocr failed'); raise HTTPException(500, str(e))
    return {'ok': True, 'elapsed_ms': int((time.time() - t0) * 1000), **r}


@app.post('/api/v1/inpaint', response_model=ImageResp)
def inpaint(req: ImageReq):
    """사용자 마스크 LaMa 인페인팅 — 마스크 영역을 자연스럽게 채움.
    params: {mask_b64, dilate=4}  — 흰색=채울 영역, 검정=보존"""
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        mask_b64 = p.get('mask_b64')
        if not mask_b64:
            raise HTTPException(400, 'mask_b64 필요')
        mask = _decode(mask_b64).convert('L')
        out = pipeline.inpaint_mask(img, mask, dilate=int(p.get('dilate', 4)))
    except HTTPException:
        raise
    except Exception as e:
        log.exception('inpaint failed'); raise HTTPException(500, str(e))
    return ImageResp(ok=True, op='inpaint', image_b64=_encode(out, 'WEBP'),
                     elapsed_ms=int((time.time() - t0) * 1000), meta={'size': out.size, 'dilate': int(p.get('dilate', 4))})


@app.post('/api/v1/flip', response_model=ImageResp)
def flip(req: ImageReq):
    """좌우(h)/상하(v) 반전. params: {direction: 'h'|'v'}"""
    t0 = time.time()
    try:
        img = _load(req)
        direction = ((req.params or {}).get('direction') or 'h').lower()
        if direction not in ('h', 'v'):
            raise HTTPException(400, "direction must be 'h' or 'v'")
        out = pipeline.flip(img, direction=direction)
    except HTTPException:
        raise
    except Exception as e:
        log.exception('flip failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='flip',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'direction': direction, 'size': out.size},
    )


@app.post('/api/v1/rotate', response_model=ImageResp)
def rotate(req: ImageReq):
    t0 = time.time()
    try:
        img = _load(req)
        p = req.params or {}
        angle = float(p.get('angle', 0))
        expand = bool(p.get('expand', False))
        out = pipeline.rotate(img, angle=angle, expand=expand)
    except Exception as e:
        log.exception('rotate failed')
        raise HTTPException(500, str(e))
    return ImageResp(
        ok=True, op='rotate',
        image_b64=_encode(out, 'WEBP'),
        elapsed_ms=int((time.time() - t0) * 1000),
        meta={'angle': angle, 'expand': expand, 'size': out.size},
    )
