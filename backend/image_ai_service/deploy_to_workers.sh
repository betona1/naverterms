#!/usr/bin/env bash
# SD 1.5 ComfyUI 일괄 배포 — install_sd15_worker.sh 를 각 워커에 scp + nohup 실행.
# 토큰 불필요 (비-gated). Linux 전용.
# 사용: ./deploy_to_workers.sh joacham@192.168.219.80 joacham@192.168.219.219
set -e

SCRIPT_DIR=$(dirname "$(readlink -f "$0")")
INSTALL_SH="$SCRIPT_DIR/install_sd15_worker.sh"
LOG_DIR=/tmp/comfyui_deploy_$(date +%s)
mkdir -p "$LOG_DIR"

[ $# -ge 1 ] || { echo "사용: $0 <user@ip> [<user@ip> ...]"; exit 1; }
[ -f "$INSTALL_SH" ] || { echo "install_sd15_worker.sh 없음: $INSTALL_SH"; exit 1; }

deploy_one() {
  local target="$1"
  local logf="$LOG_DIR/$(echo "$target" | tr '@' '_').log"
  {
    echo "==== Deploy to $target ===="
    # 1) 스크립트 전송
    scp -o BatchMode=yes "$INSTALL_SH" "${target}:~/install_sd15_worker.sh"
    ssh -o BatchMode=yes "$target" 'chmod +x ~/install_sd15_worker.sh'
    # 2) 백그라운드 nohup 실행 — install 끝나면 ComfyUI 자동 시작
    ssh -o BatchMode=yes "$target" 'nohup bash ~/install_sd15_worker.sh > ~/comfyui_install_run.log 2>&1 < /dev/null & echo "install pid=$!"'
    echo "✓ $target — 백그라운드 설치 시작됨 (~5-15분 소요)"
  } > "$logf" 2>&1
  echo "[$(date +%H:%M:%S)] $target started (log: $logf)"
}

echo "==== 배포 시작 — $# 대 ===="
for target in "$@"; do
  deploy_one "$target" &
done
wait

echo
echo "==== 배포 트리거 완료. 각 워커에서 백그라운드 설치 진행중 ===="
echo "진행상황 확인:"
for target in "$@"; do
  echo "  ssh ${target} 'tail -10 ~/comfyui_install_run.log'"
done
echo
echo "최종 확인: ./check_workers.sh"
