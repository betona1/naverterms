#!/usr/bin/env bash
# 단일 Linux 워커에 ComfyUI + SD 1.5 자동 설치.
# 토큰 불필요 (비-gated 모델만). 각 워커에서 nohup 백그라운드로 실행.
# 로그: ~/comfyui_install.log
set -e

INSTALL="$HOME/ComfyUI"
MODELS="$INSTALL/models"
LOG="$HOME/comfyui_install.log"

exec > >(tee -a "$LOG") 2>&1
echo "==== SD 1.5 ComfyUI 설치 시작 $(date) ===="

# 0) 의존성
which aria2c >/dev/null || sudo apt-get install -y -qq aria2 2>&1 | tail -1 || true

# 1) ComfyUI clone
if [ ! -d "$INSTALL" ]; then
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$INSTALL"
fi
cd "$INSTALL"

# 2) venv + PyTorch CUDA
if [ ! -d .venv ]; then python3 -m venv .venv; fi
. .venv/bin/activate
pip install --upgrade pip wheel -q 2>&1 | tail -1
echo "==== PyTorch CUDA 12.1 설치 ===="
pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu121 -q 2>&1 | tail -2
pip install -r requirements.txt -q 2>&1 | tail -2

# 3) 커스텀 노드
mkdir -p custom_nodes
cd custom_nodes
for repo in \
  ltdrdata/ComfyUI-Manager \
  city96/ComfyUI-GGUF \
  cubiq/ComfyUI_IPAdapter_plus \
  Fannovel16/comfyui_controlnet_aux \
  pythongosssss/ComfyUI-Custom-Scripts ; do
  name=$(basename "$repo")
  [ -d "$name" ] || git clone --depth 1 "https://github.com/$repo.git"
  if [ -f "$name/requirements.txt" ]; then
    pip install -r "$name/requirements.txt" -q 2>&1 | tail -1 || true
  fi
done
cd "$INSTALL"

# 4) SD 1.5 모델 다운로드 (비-gated)
echo "==== SD 1.5 모델 다운로드 ===="
DL() {
  local url="$1" out="$2"
  [ -f "$out" ] && { echo "  skip $out"; return; }
  mkdir -p "$(dirname "$out")"
  echo "  ↓ $out"
  aria2c -x 8 -s 8 --console-log-level=warn --download-result=hide \
         -o "$(basename "$out")" -d "$(dirname "$out")" "$url" 2>&1 | tail -1 \
    || wget -q -O "$out" "$url"
}

DL https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_INPAINTING.inpainting.safetensors \
   "$MODELS/checkpoints/dreamshaper_8Inpainting.safetensors"
DL https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors \
   "$MODELS/checkpoints/dreamshaper_8.safetensors"
DL https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors \
   "$MODELS/ipadapter/ip-adapter-plus_sd15.safetensors"
DL https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors \
   "$MODELS/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"

# 5) 시작 스크립트
cat > "$INSTALL/start_comfyui.sh" << 'EOSH'
#!/usr/bin/env bash
cd "$(dirname "$0")"
. .venv/bin/activate
exec python3 main.py --listen 0.0.0.0 --port 8188 --lowvram --use-pytorch-cross-attention
EOSH
chmod +x "$INSTALL/start_comfyui.sh"

# 6) 방화벽 (sudo 가능 시)
if command -v ufw >/dev/null; then
  sudo -n ufw allow from 192.168.219.0/24 to any port 8188 proto tcp 2>&1 | head -1 || \
    echo "(ufw allow 실패 — 수동: sudo ufw allow from 192.168.219.0/24 to any port 8188)"
fi

# 7) 백그라운드 실행
pkill -f "main.py --listen 0.0.0.0 --port 8188" 2>/dev/null || true
sleep 1
nohup "$INSTALL/start_comfyui.sh" > "$HOME/comfyui.log" 2>&1 < /dev/null &
disown
sleep 3
echo
echo "==== 설치 완료 $(date) ===="
echo "디스크: $(du -sh $INSTALL | awk '{print $1}')"
echo "PID: $(pgrep -f 'main.py --listen 0.0.0.0 --port 8188' | head -1)"
echo "포트 LISTEN: $(ss -tlnp 2>/dev/null | grep :8188 | head -1 || echo '아직 시작중...')"
