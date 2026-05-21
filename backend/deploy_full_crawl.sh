#!/bin/bash
# Stage 1 — 11 워커에 24개 store 균등 분배 + 전체 SKU API 크롤
set -e

WORKERS=("ws220" "ws227" "ws228" "ws229" "ws230" "ws231" "vm11" "vm12" "vm13" "vm14" "ws15")

# store_id 분배 (smartstoreIdList.id 기준)
# 24개 스토어 / 11 워커 — 일부 워커 3개 할당
declare -A STORES
STORES[ws220]="84,76"          # 나인조이, 조아다
STORES[ws227]="82,77"          # 비트정보통신, 조아컴
STORES[ws228]="79,78"          # 조아참, 비트아이오티
STORES[ws229]="2,73"           # 조아가, 비투나
STORES[ws230]="72,74"          # 조아핑, 조아난
STORES[ws231]="80,75"          # 조아냥, 조아마미
STORES[vm11]="86,81"           # 행원만물상, 조아팡
STORES[vm12]="90,88"           # 이처럼, 나경헬스
STORES[vm13]="89,87"           # 이로워, 나경조이
STORES[vm14]="92,83,94"        # 바둑이네하우스, 비트윙, 조아컴퓨존
STORES[ws15]="91,85,93"        # 캠프와우, 나인톡톡, 엑사마켓

echo "=== sync code & .env ==="
for w in "${WORKERS[@]}"; do
  rsync -az --quiet \
    --exclude='__pycache__' --exclude='exports/' --exclude='logs/' \
    --exclude='chrome_profiles/' --exclude='*.pyc' --exclude='/tmp' \
    /home/joacham/projects/naverterms/backend/ "$w":~/naverterms-worker/backend/ &
done
wait
for w in "${WORKERS[@]}"; do
  rsync -az /home/joacham/projects/naverterms/.env "$w":~/naverterms-worker/.env &
done
wait

echo "=== launch crawls ==="
for w in "${WORKERS[@]}"; do
  sids="${STORES[$w]}"
  echo "  $w → store_id=$sids"
  ssh -f "$w" "cd ~/naverterms-worker/backend && nohup python3 -u api_attr_crawl.py --store-id '$sids' --skip-done --print-every 200 --sleep-ms 250 > ~/naverterms-worker/run.log 2>&1 &"
done

sleep 8
echo
echo "=== status ==="
for w in "${WORKERS[@]}"; do
  echo "--- $w (stores=${STORES[$w]}) ---"
  ssh "$w" "ps aux | grep -v grep | grep api_attr_crawl | head -1; tail -3 ~/naverterms-worker/run.log"
done
