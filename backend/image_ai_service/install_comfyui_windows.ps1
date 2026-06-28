# ============================================================
# ComfyUI + SD 1.5 자동 설치 (Windows 워커용)
# 92 / 108 / 111 / 136 / 130 / 140 — 각 PC 에서 관리자 PowerShell 실행
#
# 전제조건:
#   - Python 3.10+ 설치되어 있어야 함 (https://www.python.org/downloads/windows/)
#   - NVIDIA GPU 드라이버 + CUDA 12.1+
#   - 인터넷 연결 (모델 다운로드)
#   - 디스크 여유 ~10GB (PyTorch + 모델)
#
# 실행:
#   .\install_comfyui_windows.ps1
# ============================================================
$ErrorActionPreference = 'Stop'
$INSTALL = "$env:USERPROFILE\ComfyUI"
$STORAGE_HOST = '192.168.219.218'

Write-Host "==== ComfyUI Windows 설치 시작 $(Get-Date) ===="

# 0) Python 확인
$pyVer = python --version 2>&1
if (-not ($pyVer -match 'Python 3\.(1[0-9]|[2-9][0-9])')) {
  Write-Error "Python 3.10+ 가 필요합니다. 현재: $pyVer"
  Write-Host "다운로드: https://www.python.org/downloads/windows/"
  exit 1
}
Write-Host "Python: $pyVer"

# 1) Git 확인 (없으면 안내)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "Git 이 필요합니다. https://git-scm.com/download/win 설치 후 재실행"
  exit 1
}

# 2) ComfyUI clone
if (-not (Test-Path $INSTALL)) {
  Write-Host "→ ComfyUI clone"
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $INSTALL
}
Set-Location $INSTALL

# 3) venv + PyTorch CUDA
if (-not (Test-Path .venv)) {
  python -m venv .venv
}
& .\.venv\Scripts\Activate.ps1
Write-Host "→ PyTorch CUDA 12.1 설치 (~2GB, 5분)"
pip install --upgrade pip wheel -q
pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu121 -q
pip install -r requirements.txt -q

# 4) 커스텀 노드
$nodes = @(
  'https://github.com/ltdrdata/ComfyUI-Manager.git',
  'https://github.com/city96/ComfyUI-GGUF.git',
  'https://github.com/cubiq/ComfyUI_IPAdapter_plus.git',
  'https://github.com/Fannovel16/comfyui_controlnet_aux.git'
)
foreach ($url in $nodes) {
  $name = ($url -split '/')[-1] -replace '\.git$', ''
  if (-not (Test-Path "custom_nodes\$name")) {
    git clone --depth 1 $url "custom_nodes\$name"
  }
  if (Test-Path "custom_nodes\$name\requirements.txt") {
    pip install -r "custom_nodes\$name\requirements.txt" -q
  }
}

# 5) SD 1.5 모델 다운로드 (비-gated, 토큰 불필요)
Write-Host "→ SD 1.5 모델 다운로드"
$models = @(
  @{ url = 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_INPAINTING.inpainting.safetensors';
     dst = 'models\checkpoints\dreamshaper_8Inpainting.safetensors' },
  @{ url = 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors';
     dst = 'models\checkpoints\dreamshaper_8.safetensors' },
  @{ url = 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors';
     dst = 'models\ipadapter\ip-adapter-plus_sd15.safetensors' },
  @{ url = 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors';
     dst = 'models\clip_vision\CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors' }
)
foreach ($m in $models) {
  $dstAbs = Join-Path $INSTALL $m.dst
  if (Test-Path $dstAbs) { Write-Host "  skip $($m.dst)"; continue }
  $dir = Split-Path $dstAbs
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Write-Host "  ↓ $($m.dst)"
  Invoke-WebRequest -Uri $m.url -OutFile $dstAbs -UseBasicParsing
}

# 6) 시작 batch (lowvram 모드, 0.0.0.0:8188)
$startBat = @'
@echo off
cd /d %~dp0
call .venv\Scripts\activate
python main.py --listen 0.0.0.0 --port 8188 --lowvram --use-pytorch-cross-attention
'@
$startBat | Out-File -FilePath "$INSTALL\start_comfyui.bat" -Encoding ASCII

# 7) 방화벽 — 8188 열기
New-NetFirewallRule -Name 'comfyui-8188' -DisplayName 'ComfyUI 8188 (naverterms)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 8188 `
  -RemoteAddress 192.168.219.0/24 -ErrorAction SilentlyContinue

# 8) 부팅 시 자동 시작 — Task Scheduler 등록 (선택)
$actionArg = "$INSTALL\start_comfyui.bat"
schtasks /create /tn "ComfyUI Naverterms" /tr "$actionArg" /sc onlogon /rl highest /f 2>&1 | Out-Null

Write-Host ""
Write-Host "==== 설치 완료 $(Get-Date) ===="
Write-Host "시작: $INSTALL\start_comfyui.bat (더블클릭)"
Write-Host "또는: 재로그인 시 자동 시작"
Write-Host "확인: http://localhost:8188 (브라우저)"
Write-Host "외부: http://$($env:COMPUTERNAME):8188"
