#!/usr/bin/env bash
# 새 ComfyUI 모델을 모든 워커에 동시 배포 (rsync 병렬).
# 사용:
#   ./deploy_model.sh <URL> <relative-path-in-ComfyUI>
# 예:
#   ./deploy_model.sh \
#     https://huggingface.co/Black-Forest-Labs/FLUX.1-Fill-dev/resolve/main/flux1-fill-dev.safetensors \
#     models/unet/flux1-fill-dev.safetensors

set -e
URL="${1:?URL required}"
REL="${2:?relative path in ~/ComfyUI/ required}"

WORKERS=(
  joacham@192.168.219.88
  joacham@192.168.219.219
  joacham@192.168.219.80
  user@192.168.219.111
  user@192.168.219.140
  user@192.168.219.92
  user@192.168.219.108
  user@192.168.219.136
  user@192.168.219.130
)

# 1) 100서버에 한 번 다운 (cache)
CACHE_DIR="$HOME/.cache/comfyui_models"
mkdir -p "$CACHE_DIR"
FNAME=$(basename "$REL")
LOCAL="$CACHE_DIR/$FNAME"
if [ ! -f "$LOCAL" ]; then
  echo "[100] downloading $FNAME ..."
  curl -L --fail -o "$LOCAL" "$URL"
fi
SIZE=$(du -h "$LOCAL" | awk '{print $1}')
echo "[100] ready: $LOCAL ($SIZE)"

# 2) 각 워커에 동시 push (rsync — 이미 있으면 skip)
push_one() {
  local w="$1"
  local dst_dir="~/ComfyUI/$(dirname "$REL")/"
  ssh -o BatchMode=yes -o ConnectTimeout=3 "$w" "mkdir -p $dst_dir" 2>/dev/null || return 1
  rsync -avz -e "ssh -o BatchMode=yes" --partial --inplace "$LOCAL" "$w:$dst_dir" 2>&1 | tail -3 \
    && echo "  [OK] $w" || echo "  [FAIL] $w"
}

echo "[push] ${#WORKERS[@]} workers in parallel"
for w in "${WORKERS[@]}"; do push_one "$w" & done
wait
echo "[done]"
