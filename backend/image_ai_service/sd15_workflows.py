"""SD 1.5 워크플로우 — FLUX 모델 다운로드 전 임시 대안 (비-gated, 2GB).
체크포인트: dreamshaper_8Inpainting.safetensors (Lykon/DreamShaper)

FLUX 와 차이:
- DualCLIPLoader → CheckpointLoaderSimple (CLIP 내장)
- FluxGuidance 제거 (CFG 7.0 사용)
- sampler: euler → euler_ancestral
- guidance: 30 → 7.0
- 결과 품질은 FLUX 보다 떨어지지만 즉시 작동
"""
from typing import Optional

INPAINT_CKPT = 'dreamshaper_8Inpainting.safetensors'  # fill 전용 (9-channel)
BASE_CKPT = 'dreamshaper_8.safetensors'                # img2img/variation/upscale 용
IPADAPTER_MODEL = 'ip-adapter-plus_sd15.safetensors'
CLIP_VISION = 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'
DEFAULT_STEPS = 25
DEFAULT_CFG = 7.0
DEFAULT_W, DEFAULT_H = 768, 768

NEG_PROMPT = ('lowres, worst quality, jpeg artifacts, deformed, mutated, '
              'extra fingers, watermark, signature, text, ugly')


def _ckpt_nodes(ckpt: str = INPAINT_CKPT) -> dict:
    """공통 베이스: CheckpointLoader (UNet + CLIP + VAE 통합)."""
    return {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': ckpt}},
    }


# ────────────────── 1) Fill — 인페인팅 ──────────────────

def fill_workflow(image_name: str, mask_name: str, prompt: str,
                  steps: int = DEFAULT_STEPS, cfg: float = DEFAULT_CFG,
                  seed: Optional[int] = None) -> dict:
    """SD 1.5 inpainting — 마스크 영역만 prompt 로 재생성."""
    wf = _ckpt_nodes(INPAINT_CKPT)
    wf.update({
        '2': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '3': {'class_type': 'LoadImage', 'inputs': {'image': mask_name}},
        '4': {'class_type': 'ImageToMask', 'inputs': {'image': ['3', 0], 'channel': 'red'}},
        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['1', 1]}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_PROMPT, 'clip': ['1', 1]}},
        '7': {'class_type': 'VAEEncodeForInpaint', 'inputs': {
            'pixels': ['2', 0], 'vae': ['1', 2], 'mask': ['4', 0], 'grow_mask_by': 6,
        }},
        '8': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['5', 0],
            'negative': ['6', 0],
            'latent_image': ['7', 0],
            'seed': seed if seed is not None else '__random__',
            'steps': steps, 'cfg': cfg,
            'sampler_name': 'euler_ancestral', 'scheduler': 'normal',
            'denoise': 1.0,
        }},
        '9': {'class_type': 'VAEDecode', 'inputs': {'samples': ['8', 0], 'vae': ['1', 2]}},
        '10': {'class_type': 'SaveImage', 'inputs': {'images': ['9', 0], 'filename_prefix': 'naverterms_sd15_fill'}},
    })
    return wf


# ────────────────── 2) Img2Img — Kontext 대체 ──────────────────

def img2img_workflow(image_name: str, prompt: str,
                     denoise: float = 0.75, steps: int = DEFAULT_STEPS,
                     cfg: float = DEFAULT_CFG) -> dict:
    """SD 1.5 img2img — prompt 로 기존 이미지 변형 (denoise 강도 조절).
    낮은 denoise(0.3~0.5) = 원본 유지 + 약간 변형
    높은 denoise(0.7~0.95) = 큰 변형
    """
    wf = _ckpt_nodes(BASE_CKPT)
    wf.update({
        '2': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['1', 1]}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_PROMPT, 'clip': ['1', 1]}},
        '5': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['2', 0], 'vae': ['1', 2]}},
        '6': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['3', 0],
            'negative': ['4', 0],
            'latent_image': ['5', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': cfg,
            'sampler_name': 'euler_ancestral', 'scheduler': 'normal',
            'denoise': denoise,
        }},
        '7': {'class_type': 'VAEDecode', 'inputs': {'samples': ['6', 0], 'vae': ['1', 2]}},
        '8': {'class_type': 'SaveImage', 'inputs': {'images': ['7', 0], 'filename_prefix': 'naverterms_sd15_img2img'}},
    })
    return wf


# ────────────────── 3) Variation — 4장 다른 seed ──────────────────

def variation_workflow(image_name: str, prompt: str = '', n: int = 4,
                       denoise: float = 0.55, steps: int = DEFAULT_STEPS,
                       cfg: float = DEFAULT_CFG) -> dict:
    """SD 1.5 variation — batch_size=N 으로 한번에 N장 다른 seed 결과 생성."""
    wf = _ckpt_nodes(BASE_CKPT)
    wf.update({
        '2': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {
            'text': prompt or 'professional product photography, clean background, sharp focus',
            'clip': ['1', 1],
        }},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_PROMPT, 'clip': ['1', 1]}},
        '5': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['2', 0], 'vae': ['1', 2]}},
        '6': {'class_type': 'RepeatLatentBatch', 'inputs': {'samples': ['5', 0], 'amount': n}},
        '7': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['3', 0],
            'negative': ['4', 0],
            'latent_image': ['6', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': cfg,
            'sampler_name': 'euler_ancestral', 'scheduler': 'normal',
            'denoise': denoise,
        }},
        '8': {'class_type': 'VAEDecode', 'inputs': {'samples': ['7', 0], 'vae': ['1', 2]}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': 'naverterms_sd15_var'}},
    })
    return wf


# ────────────────── 4) Upscale (latent x2 + low denoise) ──────────────────

# ────────────────── 5) IP-Adapter — 참조 이미지 스타일 ──────────────────

def ipadapter_workflow(image_name: str, ref_image_name: str, prompt: str,
                       weight: float = 0.7, denoise: float = 0.7,
                       steps: int = DEFAULT_STEPS, cfg: float = DEFAULT_CFG) -> dict:
    """SD 1.5 + IP-Adapter — 참조 이미지(ref)의 스타일/분위기를 입력 이미지에 적용."""
    wf = _ckpt_nodes(BASE_CKPT)
    wf.update({
        '2': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '3': {'class_type': 'LoadImage', 'inputs': {'image': ref_image_name}},
        '4': {'class_type': 'IPAdapterModelLoader', 'inputs': {'ipadapter_file': IPADAPTER_MODEL}},
        '5': {'class_type': 'CLIPVisionLoader', 'inputs': {'clip_name': CLIP_VISION}},
        '6': {'class_type': 'IPAdapter', 'inputs': {
            'model': ['1', 0],
            'ipadapter': ['4', 0],
            'image': ['3', 0],
            'clip_vision': ['5', 0],
            'weight': weight,
            'start_at': 0.0,
            'end_at': 0.7,
            'weight_type': 'standard',
        }},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['1', 1]}},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_PROMPT, 'clip': ['1', 1]}},
        '9': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['2', 0], 'vae': ['1', 2]}},
        '10': {'class_type': 'KSampler', 'inputs': {
            'model': ['6', 0],
            'positive': ['7', 0],
            'negative': ['8', 0],
            'latent_image': ['9', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': cfg,
            'sampler_name': 'euler_ancestral', 'scheduler': 'normal',
            'denoise': denoise,
        }},
        '11': {'class_type': 'VAEDecode', 'inputs': {'samples': ['10', 0], 'vae': ['1', 2]}},
        '12': {'class_type': 'SaveImage', 'inputs': {'images': ['11', 0], 'filename_prefix': 'naverterms_sd15_ipa'}},
    })
    return wf


def realesrgan_workflow(image_name: str, scale: float = 1.5) -> dict:
    """Real-ESRGAN x2 업스케일 — SD inference 없이 GPU super-resolution (2~3s/이미지).
    RealESRGAN_x2plus.pth 가 워커 ComfyUI/models/upscale_models/ 에 있어야 함.
    Pipeline: LoadImage → Real-ESRGAN x2 → ImageScaleBy (scale/2.0) → SaveImage.
    scale=1.5 → 2x 후 0.75x downscale = 정확히 1.5x.
    scale=2.0 → 2x 후 그대로.
    """
    return {
        '1': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '2': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': 'RealESRGAN_x2plus.pth'}},
        '3': {'class_type': 'ImageUpscaleWithModel', 'inputs': {
            'upscale_model': ['2', 0], 'image': ['1', 0],
        }},
        '4': {'class_type': 'ImageScaleBy', 'inputs': {
            'image': ['3', 0], 'upscale_method': 'lanczos', 'scale_by': max(0.25, scale / 2.0),
        }},
        '5': {'class_type': 'SaveImage', 'inputs': {
            'images': ['4', 0], 'filename_prefix': 'naverterms_realesrgan',
        }},
    }


def upscale_workflow(image_name: str, scale: float = 2.0,
                     denoise: float = 0.25, steps: int = 15,
                     cfg: float = DEFAULT_CFG) -> dict:
    """SD 1.5 latent upscale — 깨끗하게 키우면서 디테일 추가."""
    wf = _ckpt_nodes(BASE_CKPT)
    wf.update({
        '2': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '3': {'class_type': 'ImageScaleBy', 'inputs': {
            'image': ['2', 0], 'upscale_method': 'lanczos', 'scale_by': scale,
        }},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {
            'text': 'high quality, detailed, sharp focus, professional product photo',
            'clip': ['1', 1],
        }},
        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': NEG_PROMPT, 'clip': ['1', 1]}},
        '6': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['3', 0], 'vae': ['1', 2]}},
        '7': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['4', 0],
            'negative': ['5', 0],
            'latent_image': ['6', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': cfg,
            'sampler_name': 'euler_ancestral', 'scheduler': 'normal',
            'denoise': denoise,
        }},
        '8': {'class_type': 'VAEDecode', 'inputs': {'samples': ['7', 0], 'vae': ['1', 2]}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': 'naverterms_sd15_up'}},
    })
    return wf
