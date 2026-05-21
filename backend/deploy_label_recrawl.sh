#!/bin/bash
# 라벨 재크롤 — 5대 분산 (100 box + ws220 + ws227 + ws228 + ws231)
set -e

# 5대 = 본 box 포함
WORKERS=("ws220" "ws227" "ws228" "ws231")  # SSH 워커
LOCAL_RUN=true                              # 100 box 도 같이 가동

# 각자 사용할 login_id (DB에 등록된 활성 계정)
declare -A LOGIN
LOGIN[local]="betona1@nate.com"
LOGIN[ws220]="bitic05@nate.com"
LOGIN[ws227]="joys3763@nate.com"
LOGIN[ws228]="netkjy@hanmail.net"
LOGIN[ws231]="bitiot@nate.com"

DB_USER=$(grep MYPRODUCT_DB_USER /home/joacham/projects/naverterms/.env | cut -d= -f2)
DB_PASS=$(grep MYPRODUCT_DB_PASS /home/joacham/projects/naverterms/.env | cut -d= -f2)

echo "=== 카테고리 목록 추출 ==="
mysql -h 192.168.219.200 -u "$DB_USER" -p"$DB_PASS" myproduct --batch --skip-column-names -e "
SELECT DISTINCT category_id FROM smartstore_attr_crawl_log
WHERE status='ok' AND category_id IS NOT NULL AND category_id<>''
ORDER BY category_id" > /tmp/all_cats.txt 2>&1

TOTAL=$(wc -l < /tmp/all_cats.txt)
echo "총 카테고리: $TOTAL"

# 5등분
PER=$(( (TOTAL + 4) / 5 ))
echo "워커당: $PER"

split -l "$PER" -d --suffix-length=1 /tmp/all_cats.txt /tmp/cats_chunk_

ls -la /tmp/cats_chunk_*
echo

echo "=== sync code to workers ==="
for w in "${WORKERS[@]}"; do
  rsync -az --quiet \
    --exclude='__pycache__' --exclude='exports/' --exclude='logs/' \
    --exclude='chrome_profiles/' --exclude='*.pyc' \
    /home/joacham/projects/naverterms/backend/attr_label_crawl.py "$w":~/naverterms-worker/backend/ &
done
wait

# 청크 파일 전송
i=1
for w in "${WORKERS[@]}"; do
  scp -q "/tmp/cats_chunk_${i}" "$w":~/naverterms-worker/cats.txt &
  i=$((i+1))
done
wait

echo
echo "=== launch ==="
# 100 box (local) — chunk 0
nohup python3 attr_label_crawl.py --categories-file /tmp/cats_chunk_0 --force --sleep-ms 200 --login-id "${LOGIN[local]}" > /tmp/label_local.log 2>&1 &
echo "  local (100): chunk_0  login=${LOGIN[local]}"

i=1
for w in "${WORKERS[@]}"; do
  ll="${LOGIN[$w]}"
  echo "  $w: chunk_${i}  login=$ll"
  ssh -f "$w" "cd ~/naverterms-worker/backend && nohup python3 -u attr_label_crawl.py --categories-file ~/naverterms-worker/cats.txt --force --sleep-ms 200 --login-id '$ll' > ~/naverterms-worker/label.log 2>&1 &"
  i=$((i+1))
done

sleep 8
echo
echo "=== status ==="
echo "--- local ---"
tail -3 /tmp/label_local.log

for w in "${WORKERS[@]}"; do
  echo "--- $w ---"
  ssh "$w" "ps aux | grep -v grep | grep -c attr_label_crawl; tail -3 ~/naverterms-worker/label.log" 2>&1
done
