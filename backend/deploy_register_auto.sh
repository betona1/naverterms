#!/bin/bash
# 자동 등록 16,190 SKU 를 11 워커 + 100 box 에 분산
set -e
WORKERS=("ws220" "ws227" "ws228" "ws229" "ws230" "ws231" "vm11" "vm12" "vm13" "vm14" "ws15")
TOTAL=12   # 11 워커 + 100 box
LOCAL_OFFSET=11

echo "=== sync code to workers ==="
for w in "${WORKERS[@]}"; do
  rsync -az --quiet \
    /home/joacham/projects/naverterms/backend/register_auto_candidates.py "$w":~/naverterms-worker/backend/ &
  rsync -az --quiet \
    /home/joacham/projects/naverterms/backend/smartstore/missing_attrs_service.py "$w":~/naverterms-worker/backend/smartstore/ &
done
wait

echo
echo "=== launch ==="
# 100 box (local) — offset 11
nohup python3 -u register_auto_candidates.py --offset $LOCAL_OFFSET --total $TOTAL --print-every 50 \
  > /tmp/register_local.log 2>&1 &
LPID=$!
echo "  local (100): offset=$LOCAL_OFFSET PID=$LPID"

# 워커 11개
i=0
for w in "${WORKERS[@]}"; do
  ssh -f "$w" "cd ~/naverterms-worker/backend && nohup python3 -u register_auto_candidates.py --offset $i --total $TOTAL --print-every 50 > ~/naverterms-worker/register.log 2>&1 &"
  echo "  $w: offset=$i"
  i=$((i+1))
done

sleep 10
echo
echo "=== status ==="
for w in "${WORKERS[@]}"; do
  echo "--- $w ---"
  ssh "$w" "ps aux | grep -v grep | grep -c register_auto; tail -2 ~/naverterms-worker/register.log" 2>&1
done
echo "--- local ---"
ps -p $LPID -o pid,etime,state,cmd 2>/dev/null || echo "local exited"
tail -3 /tmp/register_local.log
