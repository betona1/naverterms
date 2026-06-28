# =============================================================
# naverterms one-shot installer
# OpenSSH + Python + Git + ComfyUI + SD 1.5 models
#
# Run (PowerShell as Administrator):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   iwr "http://192.168.219.100:8900/install_all.ps1" -OutFile install_all.ps1
#   .\install_all.ps1
# =============================================================
$ErrorActionPreference = 'Continue'
# CRITICAL: 윈도우 PowerShell Invoke-WebRequest 가 Progress 표시 때문에 100배 느림. 끄면 빠름.
$ProgressPreference = 'SilentlyContinue'
$INSTALL = "$env:USERPROFILE\ComfyUI"
$LOG = "$env:USERPROFILE\comfyui_install.log"

function W($m){ Write-Host ("[{0}] {1}" -f (Get-Date -F HH:mm:ss), $m) -ForegroundColor Cyan }
function OK($m){ Write-Host ("  [OK] {0}" -f $m) -ForegroundColor Green }
function ERR($m){ Write-Host ("  [ERR] {0}" -f $m) -ForegroundColor Red }

Start-Transcript -Path $LOG -Append | Out-Null
W "==== naverterms worker one-shot install ===="

# Admin check
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  ERR "Administrator required. Open PowerShell 'Run as administrator' and retry."
  Pause; exit 1
}
OK "Administrator OK"

# -------- 1) OpenSSH --------
W "Install OpenSSH Server"
$sshState = (Get-WindowsCapability -Online -Name OpenSSH.Server*).State
if ($sshState -ne 'Installed') {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
  OK "OpenSSH installed"
} else { OK "OpenSSH already installed" }

Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType 'Automatic' -ErrorAction SilentlyContinue
OK "sshd service running, automatic"

New-NetFirewallRule -Name "sshd-naverterms" -DisplayName "OpenSSH (naverterms)" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow `
  -LocalPort 22 -RemoteAddress 192.168.219.0/24 -ErrorAction SilentlyContinue | Out-Null
OK "Firewall 22 open"

# SSH key — Windows OpenSSH has special handling for admin users
$pubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEmQO8RLjkZG13cekvhCGxOhSqBEOjXDHOIMrh+GmIm0 betona1@nate.com'

# User home authorized_keys (for non-admin users)
$sshDir = "$HOME\.ssh"
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force -Path $sshDir | Out-Null }
$authKeys = "$sshDir\authorized_keys"
if (-not (Test-Path $authKeys) -or -not (Select-String -Path $authKeys -Pattern 'IEmQO8RL' -Quiet)) {
  Add-Content -Path $authKeys -Value $pubKey -Encoding ASCII
}
icacls $authKeys /inheritance:r /grant "$($env:USERNAME):F" 2>&1 | Out-Null

# Administrator users — Windows OpenSSH 요구: C:\ProgramData\ssh\administrators_authorized_keys
$sysKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
$sysDir = Split-Path $sysKeys
if (-not (Test-Path $sysDir)) { New-Item -ItemType Directory -Force -Path $sysDir | Out-Null }
if (-not (Test-Path $sysKeys) -or -not (Select-String -Path $sysKeys -Pattern 'IEmQO8RL' -Quiet -ErrorAction SilentlyContinue)) {
  Add-Content -Path $sysKeys -Value $pubKey -Encoding ASCII
}
icacls $sysKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' 2>&1 | Out-Null
Restart-Service sshd -ErrorAction SilentlyContinue
OK "SSH key registered (user + admin paths)"

function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# -------- 2) Python --------
W "Check Python"
$pyOk = $false
try {
  $pyVer = & python --version 2>&1
  if ($pyVer -match 'Python 3\.(1[0-9]|[2-9][0-9])') { $pyOk = $true; OK $pyVer }
} catch {}
if (-not $pyOk) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    W "Installing Python 3.12 via winget (3-5 min)"
    winget install --id Python.Python.3.12 -e --silent --accept-source-agreements --accept-package-agreements
    RefreshPath
    OK "Python installed"
  } else {
    ERR "winget not available. Install Python 3.12 from https://www.python.org/downloads/windows/ (check Add to PATH), then re-run"
    Stop-Transcript; Pause; exit 1
  }
}

# -------- 3) Git --------
W "Check Git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    W "Installing Git via winget"
    winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
    RefreshPath
    OK "Git installed"
  } else {
    ERR "Git required. Install from https://git-scm.com/download/win and re-run"
    Stop-Transcript; Pause; exit 1
  }
} else { OK "Git OK" }

# -------- 4) ComfyUI clone --------
W "Clone ComfyUI"
if (-not (Test-Path "$INSTALL\main.py")) {
  if (Test-Path $INSTALL) { Remove-Item $INSTALL -Recurse -Force }
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $INSTALL
  OK "ComfyUI cloned"
} else { OK "ComfyUI already exists" }
Set-Location $INSTALL

# -------- 5) venv + PyTorch --------
W "Python venv + PyTorch CUDA (~2.5GB, 5-10 min)"
if (-not (Test-Path ".venv\Scripts\Activate.ps1")) {
  python -m venv .venv
}
& ".\.venv\Scripts\Activate.ps1"
# Windows: pip 가 실행 중이라 자기 자신 업그레이드 불가 → python -m pip 사용
python -m pip install --upgrade pip -q 2>&1 | Out-Null
python -m pip install --upgrade wheel -q 2>&1 | Out-Null
python -m pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cu121 -q
python -m pip install -r requirements.txt -q
# ComfyUI requirements 가 torchaudio 를 CUDA 13 빌드로 잘못 가져오는 이슈 fix
python -m pip install --force-reinstall --no-deps torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu121 -q 2>&1 | Out-Null
OK "PyTorch + ComfyUI requirements done (torchaudio cu121 pinned)"

# -------- 6) Custom nodes --------
W "Install 4 custom nodes"
$nodes = @(
  'https://github.com/ltdrdata/ComfyUI-Manager.git',
  'https://github.com/city96/ComfyUI-GGUF.git',
  'https://github.com/cubiq/ComfyUI_IPAdapter_plus.git',
  'https://github.com/Fannovel16/comfyui_controlnet_aux.git'
)
foreach ($url in $nodes) {
  $name = ($url -split '/')[-1] -replace '\.git$', ''
  if (-not (Test-Path "custom_nodes\$name")) {
    git clone --depth 1 $url "custom_nodes\$name" 2>&1 | Out-Null
  }
  if (Test-Path "custom_nodes\$name\requirements.txt") {
    pip install -r "custom_nodes\$name\requirements.txt" -q 2>&1 | Out-Null
  }
  OK $name
}

# -------- 7) SD 1.5 models (~7GB) --------
W "Download SD 1.5 models (~7GB, 5-10 min)"
$models = @(
  @{ url='https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_INPAINTING.inpainting.safetensors';
     dst='models\checkpoints\dreamshaper_8Inpainting.safetensors'; size='2GB' },
  @{ url='https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors';
     dst='models\checkpoints\dreamshaper_8.safetensors'; size='2GB' },
  @{ url='https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors';
     dst='models\ipadapter\ip-adapter-plus_sd15.safetensors'; size='94MB' },
  @{ url='https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors';
     dst='models\clip_vision\CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'; size='2.4GB' }
)
foreach ($m in $models) {
  $dstAbs = Join-Path $INSTALL $m.dst
  if (Test-Path $dstAbs -PathType Leaf) {
    $existSize = (Get-Item $dstAbs).Length / 1MB
    if ($existSize -gt 50) { OK ("skip " + $m.dst + " (" + [math]::Round($existSize,0) + "MB)"); continue }
  }
  $dir = Split-Path $dstAbs
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  W ("  download " + $m.dst + " (" + $m.size + ")")
  # curl.exe (Windows 10+ 기본) — Invoke-WebRequest 보다 10~100배 빠름
  & curl.exe -L --fail --progress-bar -o $dstAbs $m.url
  if (-not $? -or -not (Test-Path $dstAbs)) {
    ERR ("curl 실패, Invoke-WebRequest fallback: " + $m.dst)
    Invoke-WebRequest -Uri $m.url -OutFile $dstAbs -UseBasicParsing
  }
  OK $m.dst
}

# -------- 8) start.bat + firewall 8188 + Task Scheduler --------
W "Start script + firewall + auto-start"
@'
@echo off
cd /d %~dp0
call .venv\Scripts\activate
python main.py --listen 0.0.0.0 --port 8188 --lowvram --use-pytorch-cross-attention
'@ | Out-File -FilePath "$INSTALL\start_comfyui.bat" -Encoding ASCII

New-NetFirewallRule -Name 'comfyui-8188' -DisplayName 'ComfyUI 8188 (naverterms)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow `
  -LocalPort 8188 -RemoteAddress 192.168.219.0/24 -ErrorAction SilentlyContinue | Out-Null

schtasks /create /tn "ComfyUI Naverterms" /tr "$INSTALL\start_comfyui.bat" /sc onlogon /rl highest /f 2>&1 | Out-Null
OK "Task Scheduler registered (auto-start at logon)"

# -------- 9) Launch now --------
W "Launch ComfyUI in background"
Start-Process -FilePath "$INSTALL\start_comfyui.bat" -WindowStyle Minimized

Start-Sleep -Seconds 8
$listening = Get-NetTCPConnection -LocalPort 8188 -ErrorAction SilentlyContinue
if ($listening) {
  OK "ComfyUI listening on 8188"
} else {
  W "  ComfyUI starting... wait ~30s and check http://localhost:8188"
}

Write-Host ""
Write-Host "====================================" -ForegroundColor Green
Write-Host "  All install done" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green
Write-Host ""
$size = (Get-ChildItem $INSTALL -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB
Write-Host ("  Disk used: $INSTALL ({0}GB)" -f [Math]::Round($size, 1))
try {
  $myip = ([System.Net.Dns]::GetHostByName(($env:COMPUTERNAME)).AddressList | Where-Object { $_.AddressFamily -eq 'InterNetwork' })[0].IPAddressToString
  Write-Host "  External:  http://$($myip):8188"
} catch {}
Write-Host "  Log:       $LOG"
Write-Host ""
Stop-Transcript | Out-Null
Pause
