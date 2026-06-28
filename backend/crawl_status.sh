#!/bin/bash
# Stage 1 진행상황 스냅샷
WORKERS=("ws220" "ws227" "ws228" "ws229" "ws230" "ws231" "ws218" "ws226" "vm11" "vm12" "vm13" "vm14" "ws15")

DB_USER=$(grep MYPRODUCT_DB_USER /home/joacham/projects/naverterms/.env | cut -d= -f2)
DB_PASS=$(grep MYPRODUCT_DB_PASS /home/joacham/projects/naverterms/.env | cut -d= -f2)

echo "=== 시각: $(date '+%Y-%m-%d %H:%M:%S') ==="

mysql -h 192.168.219.200 -u "$DB_USER" -p"$DB_PASS" myproduct -e "
SELECT
  (SELECT COUNT(*) FROM smartstore_attr_crawl_log WHERE status='ok') AS ok_total,
  (SELECT COUNT(*) FROM smartstore_attr_crawl_log WHERE status='fail') AS fail_total,
  (SELECT COUNT(*) FROM smartstore_attr_crawl_log WHERE status='ok' AND crawled_at >= NOW() - INTERVAL 1 HOUR) AS ok_last_hour,
  (SELECT COUNT(DISTINCT seller_management_code) FROM smartstore_product WHERE status_type='SALE' AND seller_management_code<>'') AS total_sale_skus;
" 2>&1 | grep -v Warning

echo
echo "=== 스토어별 진행률 ==="
mysql -h 192.168.219.200 -u "$DB_USER" -p"$DB_PASS" myproduct -e "
SELECT
  s.store_name, l.store_id,
  (SELECT COUNT(*) FROM smartstore_product p WHERE p.store_id=l.store_id AND p.status_type='SALE') AS total,
  COUNT(CASE WHEN l.status='ok' THEN 1 END) AS ok,
  COUNT(CASE WHEN l.status='fail' THEN 1 END) AS fail,
  ROUND(100*COUNT(CASE WHEN l.status='ok' THEN 1 END) / NULLIF((SELECT COUNT(*) FROM smartstore_product p WHERE p.store_id=l.store_id AND p.status_type='SALE'),0), 1) AS pct
FROM smartstore_attr_crawl_log l
JOIN smartstoreIdList s ON s.id=l.store_id
GROUP BY l.store_id, s.store_name
ORDER BY s.store_name;
" 2>&1 | grep -v Warning

echo
echo "=== 워커 라이브 상태 ==="
for w in "${WORKERS[@]}"; do
  ssh -o ConnectTimeout=4 "$w" "
    p=\$(ps aux | grep -v grep | grep -c api_attr_crawl)
    last=\$(tail -2 ~/naverterms-worker/run.log 2>/dev/null | tr -d '\n' | tail -c 200)
    echo \"$w  procs=\$p  | \$last\"
  " 2>&1 &
done
wait
