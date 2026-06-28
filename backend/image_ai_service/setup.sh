#!/usr/bin/env bash
# Image AI 서비스 셋업 — venv 생성 + 의존성 설치.
# 1회 실행. CUDA 가용 시 onnxruntime-gpu 추가 설치.
set -e
cd "$(dirname "$0")"

PYBIN=${PYBIN:-python3}

if [ ! -d .venv ]; then
  echo "→ venv 생성"
  "$PYBIN" -m venv .venv
fi

. .venv/bin/activate

echo "→ pip 업그레이드"
pip install --upgrade pip wheel

echo "→ 기본 의존성 설치"
pip install -r requirements.txt

echo "→ simple-lama-inpainting 설치 (--no-deps: pillow<10 핀 회피)"
pip install --no-deps simple-lama-inpainting

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "→ GPU 감지 → onnxruntime-gpu 설치 시도"
  pip install "onnxruntime-gpu" || pip install onnxruntime || true
else
  echo "→ GPU 없음 → onnxruntime(cpu) 설치"
  pip install onnxruntime
fi

echo
echo "✅ setup 완료. 실행:"
echo "   ./start.sh"
echo
echo "선택사항 — Real-ESRGAN 가중치 다운로드 (없으면 Lanczos fallback):"
echo "   mkdir -p weights"
echo "   wget -O weights/RealESRGAN_x2plus.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"
echo "   pip install realesrgan basicsr"
