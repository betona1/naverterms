#!/bin/bash
# 9대 워커에 코드 sync + 분산 launch
set -e

WORKERS=("ws220" "ws227" "ws228" "ws229" "ws230" "vm11" "vm12" "vm13" "vm14")

# login 분배 (균형 잡기)
declare -A ASSIGN
ASSIGN[ws220]="bitiot@nate.com"
ASSIGN[ws227]="betona1@nate.com"
ASSIGN[ws228]="bitic05@nate.com"
ASSIGN[ws229]="netkjy@hanmail.net,joacham@nate.com"
ASSIGN[ws230]="betona3@nate.com,betona4@nate.com"
ASSIGN[vm11]="netkjy@naver.com,betona5@nate.com"
ASSIGN[vm12]="joys3763@nate.com,betona8@nate.com"
ASSIGN[vm13]="exansys@nate.com,betona2@nate.com"
ASSIGN[vm14]="betona7@nate.com"

# 1) sync (이미 ws220 했으니 나머지)
echo "=== sync code & .env ==="
for w in "${WORKERS[@]}"; do
  if [ "$w" != "ws220" ]; then
    rsync -az --exclude='__pycache__' --exclude='exports/' --exclude='logs/' --exclude='chrome_profiles/' --exclude='*.pyc' \
      /home/joacham/projects/naverterms/backend/ "$w":~/naverterms-worker/backend/ &
  else
    rsync -az /home/joacham/projects/naverterms/backend/api_attr_crawl.py "$w":~/naverterms-worker/backend/api_attr_crawl.py &
  fi
done
wait
for w in "${WORKERS[@]}"; do
  rsync -az /home/joacham/projects/naverterms/.env "$w":~/naverterms-worker/.env &
done
wait

# 2) deps install
echo "=== install deps ==="
for w in "${WORKERS[@]}"; do
  ssh "$w" 'pip3 install --user --quiet --break-system-packages "django<6" requests pymysql bcrypt python-dotenv django-cors-headers djangorestframework openpyxl 2>&1 | grep -E "ERROR|error" || true' &
done
wait

# 3) launch (병렬)
echo "=== launch crawls ==="
for w in "${WORKERS[@]}"; do
  logins="${ASSIGN[$w]}"
  echo "  $w → $logins"
  ssh -f "$w" "cd ~/naverterms-worker/backend && nohup python3 -u api_attr_crawl.py --since-sold 2025-04-01 --login-id '$logins' --print-every 100 --sleep-ms 300 > ~/naverterms-worker/run.log 2>&1 &"
done

sleep 5
echo
echo "=== status ==="
for w in "${WORKERS[@]}"; do
  echo "--- $w (${ASSIGN[$w]}) ---"
  ssh "$w" "head -3 ~/naverterms-worker/run.log; echo ''; tail -3 ~/naverterms-worker/run.log"
done
