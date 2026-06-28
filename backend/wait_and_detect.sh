#!/bin/bash
# 라벨 재크롤 모든 워커 완료 폴링 → 즉시 detect_missing_attrs.py 실행
# 결과는 /tmp/detect_result.log 에 저장

set -e
cd /home/joacham/projects/naverterms/backend

WORKERS=("ws220" "ws227" "ws228" "ws229" "ws230" "ws231" "ws218" "ws226" "vm11" "vm12" "vm13" "vm14" "ws15")

echo "=== 라벨 재크롤 완료 대기 시작 $(date '+%H:%M:%S') ==="
while true; do
  active=0
  for w in "${WORKERS[@]}"; do
    cnt=$(ssh -o ConnectTimeout=3 "$w" "ps aux | grep -v grep | grep -c attr_label_crawl" 2>/dev/null || echo 1)
    active=$((active + cnt))
  done
  # local 100 box
  local_p=$(ps aux | grep -v grep | grep -c attr_label_crawl || true)
  total=$((active + local_p))
  echo "$(date '+%H:%M:%S') active workers: $active  local: $local_p  total: $total"
  if [ "$total" -le 1 ]; then  # local 의 grep 자체 1개 카운트
    if [ "$active" -eq 0 ]; then
      break
    fi
  fi
  sleep 30
done

echo
echo "=== 라벨 재크롤 완료 — DB 상태 확인 ==="
DB_USER=$(grep MYPRODUCT_DB_USER /home/joacham/projects/naverterms/.env | cut -d= -f2)
DB_PASS=$(grep MYPRODUCT_DB_PASS /home/joacham/projects/naverterms/.env | cut -d= -f2)
mysql -h 192.168.219.200 -u "$DB_USER" -p"$DB_PASS" myproduct -e "
SELECT (SELECT COUNT(*) FROM smartstore_category_attribute) AS link_rows,
       (SELECT COUNT(DISTINCT category_id) FROM smartstore_category_attribute) AS cats;" 2>&1 | grep -v Warning

echo
echo "=== detect_missing_attrs.py 실행 $(date '+%H:%M:%S') ==="
python3 detect_missing_attrs.py --reset 2>&1 | tee /tmp/detect_result.log

echo
echo "=== detect 완료 — 통계 ==="
mysql -h 192.168.219.200 -u "$DB_USER" -p"$DB_PASS" myproduct -e "
SELECT COUNT(*) AS total_missing,
       COUNT(DISTINCT seller_management_code) AS skus_with_missing,
       COUNT(DISTINCT attribute_seq) AS unique_attrs,
       SUM(CASE WHEN candidate_count=1 THEN 1 ELSE 0 END) AS auto_candidates
FROM smartstore_product_missing_attrs;
SELECT '---';
SELECT attribute_name, COUNT(*) AS missing_skus
FROM smartstore_product_missing_attrs
GROUP BY attribute_seq, attribute_name
ORDER BY missing_skus DESC LIMIT 15;" 2>&1 | grep -v Warning

echo
echo "=== 모두 완료 $(date '+%H:%M:%S') ==="
