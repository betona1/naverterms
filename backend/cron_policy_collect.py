"""상품등록한도 일일 수집 (독립 프로세스).

웹(PM2) 프로세스 재시작과 무관하게 자체 프로세스에서 동기 실행한다.
cron: 0 5 * * * /usr/bin/python3 /home/joacham/projects/naverterms/backend/cron_policy_collect.py
"""
import os
import sys
from datetime import datetime

# 위치 독립 실행 (cwd 무관하게 backend 디렉터리 기준)
_BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(_BASE)
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django  # noqa: E402
django.setup()

from smartstore.naver_store_policy_service import _collect_worker  # noqa: E402


def main():
    login_ids = None
    if len(sys.argv) > 1:
        login_ids = [int(x) for x in sys.argv[1:] if x.isdigit()]
    print(f'[{datetime.now():%Y-%m-%d %H:%M:%S}] 정책 한도 수집 시작 '
          f'(login_ids={login_ids or "전체"}, 순차)', flush=True)
    _collect_worker(login_ids, concurrency=1)   # 동기 실행 — 끝날 때까지 블록
    print(f'[{datetime.now():%Y-%m-%d %H:%M:%S}] 정책 한도 수집 종료', flush=True)


if __name__ == '__main__':
    main()
