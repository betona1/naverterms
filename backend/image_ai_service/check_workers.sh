#!/usr/bin/env bash
# 모든 ComfyUI 워커 상태 확인 (8188 포트 + GPU)
# 사용: ./check_workers.sh
WORKERS=(
  "joacham@192.168.219.88:88"
  "joacham@192.168.219.80:80"
  "joacham@192.168.219.219:219"
  "user@192.168.219.130:130"
  "user@192.168.219.140:140"
  "user@192.168.219.92:92"
  "user@192.168.219.108:108"
  "user@192.168.219.111:111"
  "user@192.168.219.136:136"
)
for entry in "${WORKERS[@]}"; do
  target="${entry%:*}"
  name="${entry##*:}"
  ip="${target##*@}"
  port_ok=$(timeout 3 bash -c "echo > /dev/tcp/$ip/8188" 2>/dev/null && echo "LISTEN" || echo "—")
  if [ "$port_ok" = "LISTEN" ]; then
    queue=$(timeout 3 curl -s "http://$ip:8188/queue" 2>/dev/null | python3 -c 'import sys,json; r=json.load(sys.stdin); print(f"run={len(r[\"queue_running\"])} pend={len(r[\"queue_pending\"])}")' 2>/dev/null || echo "?")
    echo "✓ $name ($ip:8188) $queue"
  else
    install_status=$(timeout 3 ssh -o BatchMode=yes -o ConnectTimeout=2 "$target" 'tail -1 ~/comfyui_install_run.log 2>/dev/null || echo "no log"' 2>&1 | head -1)
    echo "✗ $name ($ip:8188) — port closed | $install_status"
  fi
done
