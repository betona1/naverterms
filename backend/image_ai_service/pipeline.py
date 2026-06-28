"""이미지 처리 파이프라인 — bg_remove / text_remove / upscale / rotate.

각 모델은 lazy load (첫 요청에서 다운로드/메모리 적재).
GPU 가용 시 자동 사용, 실패 시 CPU fallback.
"""
import logging
import os
from typing import Optional

from PIL import Image, ImageDraw, ImageFilter

log = logging.getLogger(__name__)

# Lazy globals
_rembg_session = None
_lama_model = None
_ocr_reader = None
_realesrgan = None  # None=미시도, False=불가, 객체=사용가능
_sam_predictor = None  # SAM 글자 마스크 정교화 — None=미시도, False=불가, 객체=사용가능
_device_cache: Optional[str] = None


def device() -> str:
    global _device_cache
    if _device_cache is not None:
        return _device_cache
    try:
        import torch
        if torch.cuda.is_available():
            _device_cache = f"cuda:{torch.cuda.get_device_name(0)}"
        else:
            _device_cache = "cpu"
    except Exception:
        _device_cache = "cpu"
    return _device_cache


def loaded_models() -> dict:
    import os
    return {
        'rembg': getattr(_rembg_session, 'model_name', None) if _rembg_session else None,
        'lama': bool(_lama_model),
        'ocr': bool(_ocr_reader),
        'realesrgan': bool(_realesrgan) if _realesrgan is not False else 'unavailable',
        'gemini': bool(os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY')),
    }


# ─────────────────── 1) 배경 제거 ───────────────────

def bg_remove(img: Image.Image, model: str = 'isnet-general-use') -> Image.Image:
    """rembg 로 배경 제거. RGBA(투명 배경) 반환.
    모델: u2net / u2netp / isnet-general-use / silueta / sam / birefnet-general 등.
    """
    global _rembg_session
    from rembg import remove, new_session
    if _rembg_session is None or getattr(_rembg_session, 'model_name', None) != model:
        log.info(f"[bg_remove] loading rembg session: {model}")
        _rembg_session = new_session(model)
        _rembg_session.model_name = model
    return remove(img, session=_rembg_session)


# ─────────────────── 2) 글씨 제거 (OCR + LaMa) ───────────────────

def _get_ocr():
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        gpu = device().startswith('cuda')
        log.info(f"[text_remove] loading easyocr (gpu={gpu})")
        _ocr_reader = easyocr.Reader(['ko', 'en'], gpu=gpu, verbose=False)
    return _ocr_reader


def _get_lama():
    global _lama_model
    if _lama_model is None:
        from simple_lama_inpainting import SimpleLama
        log.info("[text_remove] loading simple-lama-inpainting")
        _lama_model = SimpleLama()
    return _lama_model


def _try_load_sam():
    """SAM ViT-B 1회 로드. weights/sam_vit_b_01ec64.pth 필요 (~358MB)."""
    global _sam_predictor
    if _sam_predictor is not None:
        return
    try:
        from segment_anything import sam_model_registry, SamPredictor
        import torch
        weight = os.path.join(os.path.dirname(__file__), 'weights', 'sam_vit_b_01ec64.pth')
        if not os.path.exists(weight):
            log.warning(f"[sam] 가중치 없음 → OTSU fallback ({weight})")
            _sam_predictor = False
            return
        sam = sam_model_registry['vit_b'](checkpoint=weight)
        if torch.cuda.is_available():
            sam.to('cuda')
        _sam_predictor = SamPredictor(sam)
        log.info("[sam] ViT-B 로드 완료")
    except Exception as e:
        log.warning(f"[sam] 불가 → OTSU fallback: {e}")
        _sam_predictor = False


def _refine_text_box_sam(rgb_arr, boxes):
    """SAM box prompt 로 글자 픽셀만 정확히 분할.
    한 번에 set_image (인코딩) 후 박스마다 predict.
    Returns: H×W 마스크 (uint8 0/255) 또는 None.
    """
    import numpy as np
    _try_load_sam()
    if not _sam_predictor:
        return None
    predictor = _sam_predictor
    predictor.set_image(rgb_arr)
    H, W = rgb_arr.shape[:2]
    full = np.zeros((H, W), dtype=np.uint8)
    for box in boxes:
        xs = [int(p[0]) for p in box]
        ys = [int(p[1]) for p in box]
        x1 = max(0, min(xs) - 1); x2 = min(W, max(xs) + 1)
        y1 = max(0, min(ys) - 1); y2 = min(H, max(ys) + 1)
        if x2 - x1 < 4 or y2 - y1 < 4:
            continue
        sam_box = np.array([x1, y1, x2, y2])
        try:
            masks, scores, _ = predictor.predict(box=sam_box, multimask_output=False)
        except Exception as e:
            log.warning(f"[sam] predict 실패: {e}")
            continue
        m = (masks[0].astype(np.uint8) * 255)
        full = np.maximum(full, m)
    # SAM 마스크가 너무 빡빡할 수 있어서 살짝 dilate (anti-aliasing 가장자리 커버)
    import cv2
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    full = cv2.dilate(full, k, iterations=1)
    return full


def _refine_text_box(rgb_arr, box, dilate_px: int = 2):
    """OCR 박스 내에서 실제 글자 픽셀만 추출 (OTSU + 모폴로지).
       박스 전체가 아니라 stroke 만 마스킹해서 상품이 같이 지워지는 거 방지.
       Returns: (x1, y1, binary mask H×W) or None on invalid input.
    """
    import cv2
    import numpy as np
    xs = [int(p[0]) for p in box]
    ys = [int(p[1]) for p in box]
    H, W = rgb_arr.shape[:2]
    x1 = max(0, min(xs) - 2); x2 = min(W, max(xs) + 2)
    y1 = max(0, min(ys) - 2); y2 = min(H, max(ys) + 2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    crop = rgb_arr[y1:y2, x1:x2]
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    # 텍스트 극성 판정 — 평균이 128 초과면 밝은 배경/어두운 글자, 미만이면 반대
    mean = gray.mean()
    flag = cv2.THRESH_BINARY_INV if mean > 128 else cv2.THRESH_BINARY
    _, binary = cv2.threshold(gray, 0, 255, flag + cv2.THRESH_OTSU)
    # 글자 stroke 빈틈 메우기 → 살짝 dilate 로 안티앨리어싱 가장자리 커버
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    if dilate_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (dilate_px * 2 + 1, dilate_px * 2 + 1))
        binary = cv2.dilate(binary, k)
    return x1, y1, binary


def text_remove(img: Image.Image, mask: Optional[Image.Image] = None,
                refine: str = 'sam') -> tuple[Image.Image, int]:
    """글씨 제거. mask 가 주어지면 그 영역만 인페인팅, 아니면 OCR 자동 검출.
       refine='sam' (기본) → SAM 으로 박스 내 글자 픽셀만 정확히 마스킹. SAM 불가 시 OTSU fallback.
       refine='otsu' → OCR 박스 내 OTSU + 모폴로지로 글자 stroke 만 마스킹 (빠름, 정확도 SAM 보다 낮음).
       refine='box' → 박스 전체 마스킹 (옛 동작, 깔끔하지만 박스 안 상품 같이 지워짐).
       backwards-compat: bool 도 받음 (True=otsu, False=box)
    """
    # backwards-compat
    if isinstance(refine, bool):
        refine = 'otsu' if refine else 'box'

    rgb = img.convert('RGB')
    n_boxes = 0

    if mask is None:
        import numpy as np
        reader = _get_ocr()
        rgb_arr = np.array(rgb)
        boxes_raw = reader.readtext(rgb_arr, detail=1, paragraph=False)
        n_boxes = len(boxes_raw)
        if n_boxes == 0:
            return img, 0
        boxes = [b[0] for b in boxes_raw]  # 좌표만 추출

        if refine == 'sam':
            mask_arr = _refine_text_box_sam(rgb_arr, boxes)
            if mask_arr is not None:
                mask = Image.fromarray(mask_arr, mode='L')
            else:
                refine = 'otsu'  # SAM 불가 → fallback

        if mask is None and refine == 'otsu':
            mask_arr = np.zeros((rgb.size[1], rgb.size[0]), dtype=np.uint8)
            for box in boxes:
                res = _refine_text_box(rgb_arr, box, dilate_px=2)
                if res is None:
                    xs = [int(p[0]) for p in box]; ys = [int(p[1]) for p in box]
                    pad = 3
                    x1 = max(0, min(xs) - pad); x2 = min(rgb.size[0], max(xs) + pad)
                    y1 = max(0, min(ys) - pad); y2 = min(rgb.size[1], max(ys) + pad)
                    mask_arr[y1:y2, x1:x2] = 255
                    continue
                x1, y1, binary = res
                h, w = binary.shape
                region = mask_arr[y1:y1 + h, x1:x1 + w]
                mask_arr[y1:y1 + h, x1:x1 + w] = np.maximum(region, binary)
            mask = Image.fromarray(mask_arr, mode='L')

        if mask is None:
            # refine='box' (또는 위 두 단계 다 실패) → 박스 통째로
            mask = Image.new('L', rgb.size, 0)
            draw = ImageDraw.Draw(mask)
            for box in boxes:
                xs = [int(p[0]) for p in box]; ys = [int(p[1]) for p in box]
                pad = 5
                draw.rectangle(
                    [max(0, min(xs) - pad), max(0, min(ys) - pad),
                     min(rgb.size[0], max(xs) + pad), min(rgb.size[1], max(ys) + pad)],
                    fill=255,
                )
    else:
        mask = mask.convert('L').resize(rgb.size)

    lama = _get_lama()
    out = lama(rgb, mask)
    if img.mode == 'RGBA':
        out = out.convert('RGBA')
        out.putalpha(img.split()[-1])
    return out, n_boxes


# ─────────────────── 3) 업스케일 / 선명도 ───────────────────

def upscale_engine() -> str:
    if _realesrgan is False:
        return 'pillow_lanczos'
    if _realesrgan is None:
        return 'pillow_lanczos (not_loaded)'
    return 'realesrgan'


def _try_load_realesrgan():
    global _realesrgan
    if _realesrgan is not None:
        return
    try:
        import torch
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
        weight = os.path.join(os.path.dirname(__file__), 'weights', 'RealESRGAN_x2plus.pth')
        if not os.path.exists(weight):
            log.warning(f"[upscale] Real-ESRGAN 가중치 없음 → Lanczos fallback ({weight})")
            _realesrgan = False
            return
        model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
        _realesrgan = RealESRGANer(scale=2, model_path=weight, model=model, half=torch.cuda.is_available())
        log.info("[upscale] Real-ESRGAN 로드 완료")
    except Exception as e:
        log.warning(f"[upscale] Real-ESRGAN 불가 → Lanczos fallback: {e}")
        _realesrgan = False


def upscale(img: Image.Image, scale: float = 2.0, sharpness: float = 1.5) -> Image.Image:
    """선명도 증가 + 업스케일. Real-ESRGAN 가능 시 사용, 아니면 Lanczos + UnsharpMask."""
    _try_load_realesrgan()
    if _realesrgan:
        import numpy as np
        rgb = img.convert('RGB')
        arr = np.array(rgb)
        out_arr, _ = _realesrgan.enhance(arr, outscale=scale)
        out = Image.fromarray(out_arr)
        # 알파 복원
        if img.mode == 'RGBA':
            a = img.split()[-1].resize(out.size, Image.LANCZOS)
            out = out.convert('RGBA')
            out.putalpha(a)
    else:
        w, h = img.size
        out = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    # 후처리: 살짝 더 또렷하게
    out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=int(sharpness * 100), threshold=2))
    return out


# ─────────────────── 4) 회전 ───────────────────

# ─────────────────── 6) Pillow 조정/필터/후처리 (로컬, 즉시) ───────────────────

def adjust(img: Image.Image, brightness: float = 1.0, contrast: float = 1.0,
           saturation: float = 1.0, sharpness: float = 1.0) -> Image.Image:
    """밝기/대비/채도/선명도 — 각 1.0 = 변경 없음, 0.5 = 절반, 1.5 = 1.5배."""
    from PIL import ImageEnhance
    out = img
    if brightness != 1.0:
        out = ImageEnhance.Brightness(out).enhance(brightness)
    if contrast != 1.0:
        out = ImageEnhance.Contrast(out).enhance(contrast)
    if saturation != 1.0:
        out = ImageEnhance.Color(out).enhance(saturation)
    if sharpness != 1.0:
        out = ImageEnhance.Sharpness(out).enhance(sharpness)
    return out


_FILTER_MATRICES = {
    # 컬러매트릭스 (RGB → RGB linear)
    'sepia': (0.393, 0.769, 0.189, 0,
              0.349, 0.686, 0.168, 0,
              0.272, 0.534, 0.131, 0),
    'cool':  (0.95, 0.05, 0.0, 0,
              0.0, 0.95, 0.05, 0,
              0.05, 0.1, 1.05, 0),
    'warm':  (1.1, 0.05, 0.0, 0,
              0.05, 1.0, 0.0, 0,
              0.0, 0.0, 0.9, 0),
    'vintage': (0.62, 0.35, 0.18, 0,
                0.30, 0.71, 0.13, 0,
                0.21, 0.31, 0.71, 0),
}


def filter_preset(img: Image.Image, preset: str) -> Image.Image:
    """프리셋 컬러 필터: grayscale / sepia / cool / warm / vintage / invert / posterize / solarize."""
    from PIL import ImageOps
    alpha = img.split()[-1] if img.mode == 'RGBA' else None
    rgb = img.convert('RGB')
    if preset == 'grayscale':
        out = ImageOps.grayscale(rgb).convert('RGB')
    elif preset == 'invert':
        out = ImageOps.invert(rgb)
    elif preset == 'posterize':
        out = ImageOps.posterize(rgb, 3)
    elif preset == 'solarize':
        out = ImageOps.solarize(rgb, 128)
    elif preset in _FILTER_MATRICES:
        out = rgb.convert('RGB', _FILTER_MATRICES[preset])
    else:
        raise ValueError(f'unknown preset: {preset}')
    if alpha is not None:
        out = out.convert('RGBA')
        out.putalpha(alpha)
    return out


def blur(img: Image.Image, radius: float = 3.0) -> Image.Image:
    """가우시안 블러 — radius 1~20 권장."""
    return img.filter(ImageFilter.GaussianBlur(radius))


def vignette(img: Image.Image, strength: float = 0.5) -> Image.Image:
    """비네팅 — 외곽이 점점 어두워지는 효과. strength 0~1."""
    from PIL import ImageDraw
    w, h = img.size
    mask = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(mask)
    # 타원 그라데이션 - 중심 흰색, 외곽 검정
    cx, cy = w // 2, h // 2
    max_r = int(max(w, h) * 0.75)
    for i in range(max_r, 0, -2):
        alpha = int(255 * (1 - i / max_r))
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=alpha)
    # blur mask softer
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max_r // 8))
    # 곱하기 — 외곽 어둡게
    darken = Image.new('RGB', (w, h), (0, 0, 0))
    rgb = img.convert('RGB')
    # interpolate
    factor = max(0.0, min(1.0, strength))
    # mask는 255=원본 그대로, 0=darken
    blended = Image.composite(rgb, darken, mask)
    out = Image.blend(rgb, blended, factor)  # strength=0→원본, 1→비네팅 full
    if img.mode == 'RGBA':
        out = out.convert('RGBA')
        out.putalpha(img.split()[-1])
    return out


def pad_square(img: Image.Image, color: str = '#ffffff', size: int = 0) -> Image.Image:
    """비정사각 이미지를 1:1 캔버스에 색상 패딩. size=0 이면 max(w,h)."""
    w, h = img.size
    if w == h and size == 0:
        return img
    side = size if size > 0 else max(w, h)
    # color = '#fff' or '#ffffff' → tuple
    c = color.lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    canvas = Image.new('RGBA', (side, side), (r, g, b, 255))
    # 원본 비율 유지하며 side x side 안에 맞춤
    scale = min(side / w, side / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = img.resize((nw, nh), Image.LANCZOS)
    if resized.mode != 'RGBA':
        resized = resized.convert('RGBA')
    x = (side - nw) // 2
    y = (side - nh) // 2
    canvas.paste(resized, (x, y), resized if resized.mode == 'RGBA' else None)
    return canvas


def frame(img: Image.Image, border_px: int = 0, border_color: str = '#ffffff',
          shadow: bool = False, shadow_blur: int = 20, shadow_offset: int = 10,
          rounded: int = 0) -> Image.Image:
    """테두리/그림자/둥근 모서리 추가."""
    from PIL import ImageDraw
    w, h = img.size
    base = img.convert('RGBA')

    # 둥근 모서리 (mask)
    if rounded > 0:
        mask = Image.new('L', (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w, h], radius=rounded, fill=255)
        # alpha 와 합치기
        a = base.split()[-1]
        new_a = Image.eval(mask, lambda v: v) if a is None else Image.composite(a, Image.new('L', (w, h), 0), mask)
        base.putalpha(new_a)

    # 테두리 (외곽 캔버스에 색상)
    if border_px > 0:
        c = border_color.lstrip('#')
        if len(c) == 3:
            c = ''.join(ch * 2 for ch in c)
        r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
        canvas = Image.new('RGBA', (w + border_px * 2, h + border_px * 2), (r, g, b, 255))
        canvas.paste(base, (border_px, border_px), base)
        base = canvas
        w, h = base.size

    # 그림자
    if shadow:
        pad = shadow_blur + shadow_offset + 5
        sw, sh = w + pad * 2, h + pad * 2
        shadow_layer = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
        # 검은 사각형 (모양만) 만들어서 blur
        shape = Image.new('RGBA', (w, h), (0, 0, 0, 180))
        if base.mode == 'RGBA':
            shape.putalpha(base.split()[-1])
        shadow_layer.paste(shape, (pad + shadow_offset, pad + shadow_offset), shape)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(shadow_blur))
        # 원본 위로
        shadow_layer.paste(base, (pad, pad), base)
        base = shadow_layer

    return base


def ocr_extract(img: Image.Image, languages: tuple[str, ...] = ('ko', 'en')) -> dict:
    """EasyOCR 로 글자 인식 (제거하지 않음, 결과만 반환).
    응답: {texts: [{box, text, confidence}], all_text: '...'}
    """
    global _ocr_reader
    import numpy as np
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(list(languages), gpu=device().startswith('cuda'), verbose=False)
    rgb = img.convert('RGB')
    results = _ocr_reader.readtext(np.array(rgb), detail=1, paragraph=False)
    items = []
    for box, txt, conf in results:
        items.append({
            'box': [[int(p[0]), int(p[1])] for p in box],
            'text': txt,
            'confidence': float(conf),
        })
    return {
        'texts': items,
        'all_text': '\n'.join(t['text'] for t in items),
        'count': len(items),
    }


def inpaint_mask(img: Image.Image, mask: Image.Image, dilate: int = 4) -> Image.Image:
    """사용자 마스크 영역을 LaMa 로 자연스럽게 채움 (글씨 외에도 임의 객체 제거).
    mask: 흰색=채울 영역, 검정=보존.
    """
    lama = _get_lama()
    rgb = img.convert('RGB')
    m = mask.convert('L').resize(rgb.size)
    if dilate > 0:
        # MaxFilter 로 마스크 확장 (경계 깔끔)
        m = m.filter(ImageFilter.MaxFilter(2 * dilate + 1))
    out = lama(rgb, m)
    if img.mode == 'RGBA':
        out = out.convert('RGBA')
        out.putalpha(img.split()[-1])
    return out


def flip(img: Image.Image, direction: str = 'h') -> Image.Image:
    """좌우(h) / 상하(v) 반전. 알파 채널 유지."""
    if direction == 'h':
        return img.transpose(Image.FLIP_LEFT_RIGHT)
    if direction == 'v':
        return img.transpose(Image.FLIP_TOP_BOTTOM)
    raise ValueError(f'invalid direction: {direction}')


def rotate(img: Image.Image, angle: float = 0.0, expand: bool = False) -> Image.Image:
    """1~10도 내외 미세 정렬용. expand=False 면 캔버스 유지(귀퉁이 잘림 / 투명채움)."""
    if abs(angle) < 0.01:
        return img
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    return img.rotate(angle, resample=Image.BICUBIC, expand=expand, fillcolor=(0, 0, 0, 0))


# ─────────────────── 5) 생성형 AI — Gemini 2.5 Flash Image ───────────────────

_genai_client = None


def _get_gemini_client():
    global _genai_client
    if _genai_client is None:
        import os
        from google import genai
        api_key = os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY')
        if not api_key:
            raise RuntimeError('GEMINI_API_KEY (or GOOGLE_API_KEY) 환경변수 필요')
        _genai_client = genai.Client(api_key=api_key)
    return _genai_client


def gemini_edit(img: Image.Image, prompt: str, model: str = 'gemini-2.5-flash-image') -> Image.Image:
    """Gemini 2.5 Flash Image 로 이미지 편집.
    상품 자체는 보존하면서 배경 교체/모델 추가 등 컨텍스트 편집.

    NOTE: 상품 보존을 위해 prompt 앞에 "Preserve the product/object exactly..." 안내 추가.
    """
    import io
    from google.genai import types

    client = _get_gemini_client()

    # 상품 보존 지시를 자동 prepend (사용자가 명시적 추가 안 해도 안전)
    safety_prefix = (
        "IMPORTANT: Preserve the main product/subject EXACTLY as-is (same shape, color, "
        "details, branding, text on product). Do NOT modify the product itself. "
        "Only change/add the surroundings as requested below.\n\n"
        "Edit request: "
    )
    full_prompt = safety_prefix + prompt

    # PIL → bytes (PNG, 무손실)
    buf = io.BytesIO()
    rgb = img.convert('RGB')
    rgb.save(buf, format='PNG')
    img_bytes = buf.getvalue()

    response = client.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=img_bytes, mime_type='image/png'),
            full_prompt,
        ],
    )

    # 응답에서 이미지 part 추출
    for cand in response.candidates or []:
        if not cand.content or not cand.content.parts:
            continue
        for part in cand.content.parts:
            inline = getattr(part, 'inline_data', None)
            if inline and inline.data:
                return Image.open(io.BytesIO(inline.data)).convert('RGBA')
    # 텍스트만 돌아온 경우 (편집 거부 등)
    text = ''
    for cand in response.candidates or []:
        for part in (cand.content.parts or []):
            if getattr(part, 'text', None):
                text += part.text + '\n'
    raise RuntimeError(f'Gemini 이미지 미반환. 텍스트 응답: {text.strip() or "(없음)"}')
