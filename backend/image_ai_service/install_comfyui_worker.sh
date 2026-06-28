#!/usr/bin/env bash
# 88번 워커에 ComfyUI + FLUX 설치 — 백그라운드 nohup 실행.
# 진행상황: ~/comfyui_install.log
# 완료 후: http://192.168.219.88:8188
set -e

INSTALL_DIR="$HOME/ComfyUI"
MODELS_DIR="$INSTALL_DIR/models"
LOG_FILE="$HOME/comfyui_install.log"

exec > >(tee -a "$LOG_FILE") 2>&1
echo "==== ComfyUI + FLUX 설치 시작 $(date) ===="

# 0) 의존성
sudo apt-get update -qq && sudo apt-get install -y -qq git wget python3-venv aria2 || true

# 1) ComfyUI clone
if [ ! -d "$INSTALL_DIR" ]; then
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 2) venv + PyTorch CUDA
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
pip install --upgrade pip wheel -q
echo "==== PyTorch CUDA 설치 ===="
pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu121 -q
pip install -r requirements.txt -q

# 3) 핵심 커스텀 노드들
mkdir -p custom_nodes && cd custom_nodes
[ -d ComfyUI-Manager ] || git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager.git
[ -d ComfyUI-GGUF ] || git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git
[ -d ComfyUI_IPAdapter_plus ] || git clone --depth 1 https://github.com/cubiq/ComfyUI_IPAdapter_plus.git
[ -d comfyui_controlnet_aux ] || git clone --depth 1 https://github.com/Fannovel16/comfyui_controlnet_aux.git
[ -d ComfyUI-Custom-Scripts ] || git clone --depth 1 https://github.com/pythongosssss/ComfyUI-Custom-Scripts.git

# 각 커스텀 노드 requirements
for d in */; do
  if [ -f "$d/requirements.txt" ]; then
    echo "→ $d requirements"
    pip install -r "$d/requirements.txt" -q || echo "  ($d requirements 실패 — 계속)"
  fi
done

cd "$INSTALL_DIR"

# 4) FLUX 모델 다운로드 — city96 의 GGUF Q4 (10GB 3080 호환)
echo "==== FLUX 모델 다운로드 시작 ===="
DL() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then
    echo "→ skip (이미 있음): $out"
    return
  fi
  echo "→ 다운로드: $out"
  mkdir -p "$(dirname "$out")"
  aria2c -x 8 -s 8 --console-log-level=warn --download-result=hide \
         -o "$(basename "$out")" -d "$(dirname "$out")" "$url" \
    || wget -q --show-progress -O "$out" "$url"
}

# 텍스트 인코더 + VAE (공통)
DL "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors" \
   "$MODELS_DIR/clip/clip_l.safetensors"
DL "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors" \
   "$MODELS_DIR/clip/t5xxl_fp8_e4m3fn.safetensors"
DL "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors" \
   "$MODELS_DIR/vae/ae.safetensors"

# FLUX.1 dev Q4 (text2img 기본)
DL "https://huggingface.co/city96/FLUX.1-dev-gguf/resolve/main/flux1-dev-Q4_K_S.gguf" \
   "$MODELS_DIR/unet/flux1-dev-Q4_K_S.gguf"

# FLUX.1 Fill Q4 (inpaint/outpaint — 가장 중요)
DL "https://huggingface.co/YarvixPA/FLUX.1-Fill-dev-gguf/resolve/main/flux1-fill-dev-Q4_K_S.gguf" \
   "$MODELS_DIR/unet/flux1-fill-dev-Q4_K_S.gguf"

# FLUX.1 Kontext (자연어 인컨텍스트 편집)
DL "https://huggingface.co/QuantStack/FLUX.1-Kontext-dev-GGUF/resolve/main/flux1-kontext-dev-Q4_K_S.gguf" \
   "$MODELS_DIR/unet/flux1-kontext-dev-Q4_K_S.gguf"

# FLUX.1 Redux (이미지 variation/스타일)
DL "https://huggingface.co/black-forest-labs/FLUX.1-Redux-dev/resolve/main/flux1-redux-dev.safetensors" \
   "$MODELS_DIR/style_models/flux1-redux-dev.safetensors"
DL "https://huggingface.co/google/siglip-so400m-patch14-384/resolve/main/model.safetensors" \
   "$MODELS_DIR/clip_vision/sigclip_vision_patch14_384.safetensors"

# ControlNet — Union (Pose/Canny/Depth/Tile 통합 모델, FLUX 용)
DL "https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro/resolve/main/diffusion_pytorch_model.safetensors" \
   "$MODELS_DIR/controlnet/flux-union-pro.safetensors"

# IP-Adapter (참조 이미지 스타일 클론)
DL "https://huggingface.co/InstantX/FLUX.1-dev-IP-Adapter/resolve/main/ip-adapter.bin" \
   "$MODELS_DIR/ipadapter/flux-ip-adapter.bin"

# 5) extra_model_paths 설정 (옵션)

# 6) 시작 스크립트
cat > "$INSTALL_DIR/start_comfyui.sh" <<'EOSH'
#!/usr/bin/env bash
cd "$(dirname "$0")"
. .venv/bin/activate
# --lowvram: GPU 부족 시 자동 CPU offload (Ollama 동거)
# --listen 0.0.0.0: 외부 접속 허용
# --port 8188: 기본 포트
exec python3 main.py --listen 0.0.0.0 --port 8188 --lowvram --use-pytorch-cross-attention
EOSH
chmod +x "$INSTALL_DIR/start_comfyui.sh"

echo "==== 설치 완료 $(date) ===="
echo "용량: $(du -sh $INSTALL_DIR | awk '{print $1}')"
echo
echo "시작 방법:"
echo "  $INSTALL_DIR/start_comfyui.sh"
echo "또는 nohup 백그라운드:"
echo "  nohup $INSTALL_DIR/start_comfyui.sh > $HOME/comfyui.log 2>&1 &"
