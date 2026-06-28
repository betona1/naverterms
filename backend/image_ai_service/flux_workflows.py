"""FLUX 워크플로우 7개 — ComfyUI API 포맷 (node_id → {class_type, inputs}).

각 함수는 ComfyUI 에 제출 가능한 dict 반환.
입력 image_name 은 사전에 /upload/image 로 업로드된 파일명.
"""
from typing import Optional


# 공통 모델 파일명 (install_comfyui_worker.sh 와 일치)
T5_NAME = 't5xxl_fp8_e4m3fn.safetensors'
CLIP_L_NAME = 'clip_l.safetensors'
VAE_NAME = 'ae.safetensors'

DEV_UNET = 'flux1-dev-Q4_K_S.gguf'
FILL_UNET = 'flux1-fill-dev-Q4_K_S.gguf'
KONTEXT_UNET = 'flux1-kontext-dev-Q4_K_S.gguf'

REDUX_STYLE = 'flux1-redux-dev.safetensors'
SIGCLIP_VISION = 'sigclip_vision_patch14_384.safetensors'

CTRL_UNION = 'flux-union-pro.safetensors'
IPADAPTER_FLUX = 'flux-ip-adapter.bin'

DEFAULT_STEPS = 20
DEFAULT_GUIDANCE = 30.0  # FLUX Fill 권장값


def _flux_base_nodes(unet: str = DEV_UNET) -> dict:
    """공통 베이스: UNet(GGUF), DualCLIP, VAE 로드."""
    return {
        '1': {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': unet}},
        '2': {'class_type': 'DualCLIPLoader', 'inputs': {
            'clip_name1': T5_NAME,
            'clip_name2': CLIP_L_NAME,
            'type': 'flux',
        }},
        '3': {'class_type': 'VAELoader', 'inputs': {'vae_name': VAE_NAME}},
    }


# ────────────────── 1) Fill (인페인팅 — auto/manual 공통) ──────────────────

def fill_workflow(image_name: str, mask_name: str, prompt: str,
                  steps: int = DEFAULT_STEPS, guidance: float = DEFAULT_GUIDANCE,
                  seed: Optional[int] = None) -> dict:
    """FLUX.1 Fill — 마스크 영역만 prompt 로 재생성.
    mask: 흰색=재생성 영역 (배경), 검은색=보존 영역 (상품).
    """
    wf = _flux_base_nodes(FILL_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'LoadImage', 'inputs': {'image': mask_name}},
        '6': {'class_type': 'ImageToMask', 'inputs': {'image': ['5', 0], 'channel': 'red'}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '9': {'class_type': 'InpaintModelConditioning', 'inputs': {
            'positive': ['7', 0], 'negative': ['8', 0],
            'vae': ['3', 0], 'pixels': ['4', 0], 'mask': ['6', 0],
            'noise_mask': True,
        }},
        '10': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['9', 0], 'guidance': guidance}},
        '11': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['10', 0],
            'negative': ['9', 1],
            'latent_image': ['9', 2],
            'seed': seed if seed is not None else '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 1.0,
        }},
        '12': {'class_type': 'VAEDecode', 'inputs': {'samples': ['11', 0], 'vae': ['3', 0]}},
        '13': {'class_type': 'SaveImage', 'inputs': {'images': ['12', 0], 'filename_prefix': 'naverterms_fill'}},
    })
    return wf


# ────────────────── 2) Redux — 4장 variation ──────────────────

def redux_workflow(image_name: str, prompt: str = '', n: int = 4,
                   strength: float = 1.0, steps: int = DEFAULT_STEPS) -> dict:
    """FLUX.1 Redux — 입력 이미지의 컨디셔닝을 사용해 variation 생성.
    배치(n장)로 한번에 생성.
    """
    wf = _flux_base_nodes(DEV_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'CLIPVisionLoader', 'inputs': {'clip_name': SIGCLIP_VISION}},
        '6': {'class_type': 'StyleModelLoader', 'inputs': {'style_model_name': REDUX_STYLE}},
        '7': {'class_type': 'CLIPVisionEncode', 'inputs': {
            'clip_vision': ['5', 0], 'image': ['4', 0],
            'crop': 'center',
        }},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '9': {'class_type': 'StyleModelApply', 'inputs': {
            'conditioning': ['8', 0],
            'style_model': ['6', 0],
            'clip_vision_output': ['7', 0],
            'strength': strength,
            'strength_type': 'multiply',
        }},
        '10': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['9', 0], 'guidance': 3.5}},
        '11': {'class_type': 'EmptySD3LatentImage', 'inputs': {
            'width': 1024, 'height': 1024, 'batch_size': n,
        }},
        '12': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '13': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['10', 0],
            'negative': ['12', 0],
            'latent_image': ['11', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 1.0,
        }},
        '14': {'class_type': 'VAEDecode', 'inputs': {'samples': ['13', 0], 'vae': ['3', 0]}},
        '15': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': 'naverterms_redux'}},
    })
    return wf


# ────────────────── 3) Kontext — 자연어 인컨텍스트 편집 ──────────────────

def kontext_workflow(image_name: str, prompt: str,
                     steps: int = DEFAULT_STEPS, guidance: float = 2.5) -> dict:
    """FLUX.1 Kontext — Gemini 2.5 Flash Image 와 유사한 자연어 편집."""
    wf = _flux_base_nodes(KONTEXT_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'FluxKontextImageScale', 'inputs': {'image': ['4', 0]}},
        '6': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['5', 0], 'vae': ['3', 0]}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '8': {'class_type': 'ReferenceLatent', 'inputs': {
            'conditioning': ['7', 0], 'latent': ['6', 0],
        }},
        '9': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['8', 0], 'guidance': guidance}},
        '10': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '11': {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['10', 0]}},
        '12': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['9', 0],
            'negative': ['11', 0],
            'latent_image': ['6', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 1.0,
        }},
        '13': {'class_type': 'VAEDecode', 'inputs': {'samples': ['12', 0], 'vae': ['3', 0]}},
        '14': {'class_type': 'SaveImage', 'inputs': {'images': ['13', 0], 'filename_prefix': 'naverterms_kontext'}},
    })
    return wf


# ────────────────── 4) ControlNet — Canny ──────────────────

def canny_workflow(image_name: str, prompt: str,
                   strength: float = 0.7, steps: int = DEFAULT_STEPS,
                   guidance: float = 3.5) -> dict:
    """FLUX + Union ControlNet — Canny 엣지 보존하며 모든 텍스처 변경."""
    wf = _flux_base_nodes(DEV_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'CannyEdgePreprocessor', 'inputs': {
            'image': ['4', 0], 'low_threshold': 100, 'high_threshold': 200, 'resolution': 1024,
        }},
        '6': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': CTRL_UNION}},
        '7': {'class_type': 'SetUnionControlNetType', 'inputs': {
            'control_net': ['6', 0], 'type': 'canny',
        }},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '9': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '10': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {
            'positive': ['8', 0], 'negative': ['9', 0],
            'control_net': ['7', 0], 'image': ['5', 0],
            'strength': strength, 'start_percent': 0.0, 'end_percent': 1.0,
        }},
        '11': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['10', 0], 'guidance': guidance}},
        '12': {'class_type': 'EmptySD3LatentImage', 'inputs': {
            'width': 1024, 'height': 1024, 'batch_size': 1,
        }},
        '13': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['11', 0],
            'negative': ['10', 1],
            'latent_image': ['12', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 1.0,
        }},
        '14': {'class_type': 'VAEDecode', 'inputs': {'samples': ['13', 0], 'vae': ['3', 0]}},
        '15': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': 'naverterms_canny'}},
    })
    return wf


# ────────────────── 5) ControlNet — Depth ──────────────────

def depth_workflow(image_name: str, prompt: str,
                   strength: float = 0.7, steps: int = DEFAULT_STEPS,
                   guidance: float = 3.5) -> dict:
    """FLUX + Union ControlNet — Depth 보존."""
    wf = _flux_base_nodes(DEV_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'DepthAnythingV2Preprocessor', 'inputs': {
            'image': ['4', 0], 'ckpt_name': 'depth_anything_v2_vitl.pth', 'resolution': 1024,
        }},
        '6': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': CTRL_UNION}},
        '7': {'class_type': 'SetUnionControlNetType', 'inputs': {
            'control_net': ['6', 0], 'type': 'depth',
        }},
        '8': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '9': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '10': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {
            'positive': ['8', 0], 'negative': ['9', 0],
            'control_net': ['7', 0], 'image': ['5', 0],
            'strength': strength, 'start_percent': 0.0, 'end_percent': 1.0,
        }},
        '11': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['10', 0], 'guidance': guidance}},
        '12': {'class_type': 'EmptySD3LatentImage', 'inputs': {
            'width': 1024, 'height': 1024, 'batch_size': 1,
        }},
        '13': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['11', 0],
            'negative': ['10', 1],
            'latent_image': ['12', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 1.0,
        }},
        '14': {'class_type': 'VAEDecode', 'inputs': {'samples': ['13', 0], 'vae': ['3', 0]}},
        '15': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': 'naverterms_depth'}},
    })
    return wf


# ────────────────── 6) Upscale (Tile ControlNet) ──────────────────

def upscale_tile_workflow(image_name: str, scale: float = 2.0,
                          denoise: float = 0.3, steps: int = 12) -> dict:
    """FLUX + Union Tile — AI 업스케일. low denoise 로 디테일 보존."""
    wf = _flux_base_nodes(DEV_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'ImageScaleBy', 'inputs': {
            'image': ['4', 0], 'upscale_method': 'lanczos', 'scale_by': scale,
        }},
        '6': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['5', 0], 'vae': ['3', 0]}},
        '7': {'class_type': 'ControlNetLoader', 'inputs': {'control_net_name': CTRL_UNION}},
        '8': {'class_type': 'SetUnionControlNetType', 'inputs': {
            'control_net': ['7', 0], 'type': 'tile',
        }},
        '9': {'class_type': 'CLIPTextEncode', 'inputs': {
            'text': 'high quality, detailed, sharp, professional product photo',
            'clip': ['2', 0],
        }},
        '10': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '11': {'class_type': 'ControlNetApplyAdvanced', 'inputs': {
            'positive': ['9', 0], 'negative': ['10', 0],
            'control_net': ['8', 0], 'image': ['5', 0],
            'strength': 0.6, 'start_percent': 0.0, 'end_percent': 0.8,
        }},
        '12': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['11', 0], 'guidance': 3.5}},
        '13': {'class_type': 'KSampler', 'inputs': {
            'model': ['1', 0],
            'positive': ['12', 0],
            'negative': ['11', 1],
            'latent_image': ['6', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': denoise,
        }},
        '14': {'class_type': 'VAEDecode', 'inputs': {'samples': ['13', 0], 'vae': ['3', 0]}},
        '15': {'class_type': 'SaveImage', 'inputs': {'images': ['14', 0], 'filename_prefix': 'naverterms_upscale'}},
    })
    return wf


# ────────────────── 7) IP-Adapter — 참조 이미지 스타일 ──────────────────

def ipadapter_workflow(image_name: str, ref_image_name: str, prompt: str,
                       strength: float = 0.7, steps: int = DEFAULT_STEPS) -> dict:
    """FLUX + IP-Adapter — 참조 이미지의 스타일/구도를 입력 이미지에 적용."""
    wf = _flux_base_nodes(DEV_UNET)
    wf.update({
        '4': {'class_type': 'LoadImage', 'inputs': {'image': image_name}},
        '5': {'class_type': 'LoadImage', 'inputs': {'image': ref_image_name}},
        '6': {'class_type': 'CLIPVisionLoader', 'inputs': {'clip_name': SIGCLIP_VISION}},
        '7': {'class_type': 'IPAdapterModelLoader', 'inputs': {'ipadapter_file': IPADAPTER_FLUX}},
        '8': {'class_type': 'IPAdapterFluxLoader', 'inputs': {
            'ipadapter': ['7', 0], 'clip_vision': ['6', 0], 'provider': 'cuda',
        }},
        '9': {'class_type': 'ApplyIPAdapterFlux', 'inputs': {
            'model': ['1', 0],
            'ipadapter_flux': ['8', 0],
            'image': ['5', 0],
            'weight': strength,
            'start_percent': 0.0, 'end_percent': 0.6,
        }},
        '10': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['2', 0]}},
        '11': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['2', 0]}},
        '12': {'class_type': 'FluxGuidance', 'inputs': {'conditioning': ['10', 0], 'guidance': 3.5}},
        '13': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['4', 0], 'vae': ['3', 0]}},
        '14': {'class_type': 'KSampler', 'inputs': {
            'model': ['9', 0],
            'positive': ['12', 0],
            'negative': ['11', 0],
            'latent_image': ['13', 0],
            'seed': '__random__',
            'steps': steps, 'cfg': 1.0,
            'sampler_name': 'euler', 'scheduler': 'simple',
            'denoise': 0.85,
        }},
        '15': {'class_type': 'VAEDecode', 'inputs': {'samples': ['14', 0], 'vae': ['3', 0]}},
        '16': {'class_type': 'SaveImage', 'inputs': {'images': ['15', 0], 'filename_prefix': 'naverterms_ipa'}},
    })
    return wf
