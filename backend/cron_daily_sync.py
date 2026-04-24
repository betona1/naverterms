#!/usr/bin/env python3
"""매일 저녁 7시 실행: 전상품 API 동기화 + 주문데이터 + 마스터추적 갱신"""
import os
import sys
import time
import requests
import logging

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

logging.basicConfig(
    filename=os.path.join(BASE_DIR, 'logs', 'cron_daily_sync.log'),
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger(__name__)

API_BASE = 'http://localhost:8900/api/smartstore'


def main():
    log.info('=== 일일 동기화 시작 ===')
    start = time.time()

    # 1. 스토어 목록
    try:
        stores = requests.get(f'{API_BASE}/stores/', timeout=10).json()
    except Exception as e:
        log.error(f'스토어 목록 조회 실패: {e}')
        return

    # 2. 전체 스토어 API 동기화 (순차)
    total_synced = 0
    for i, s in enumerate(stores):
        sid = s['id']
        sname = s['store_name']
        for attempt in range(3):
            try:
                r = requests.post(f'{API_BASE}/products/sync/', json={'store_id': sid}, timeout=300)
                d = r.json()
                if 'error' in d and '429' in d['error']:
                    wait = 60 * (attempt + 1)
                    log.warning(f'[{sname}] 429 → {wait}초 대기')
                    time.sleep(wait)
                    continue
                elif 'error' in d:
                    log.error(f'[{sname}] {d["error"]}')
                else:
                    synced = d.get('synced', 0)
                    total_synced += synced
                    log.info(f'[{i+1}/{len(stores)}] {sname}: API={d.get("total_from_api",0)} synced={synced}')
                break
            except Exception as e:
                log.error(f'[{sname}] {e}')
                break
        time.sleep(5)

    # 3. 마스터 추적 + 주문 데이터 갱신
    try:
        r = requests.post(f'{API_BASE}/products/refresh-tracking/', json={'store_id': 0}, timeout=120)
        d = r.json()
        log.info(f'추적 갱신: master={d.get("refreshed",0)} orders={d.get("orders_updated",0)}')
    except Exception as e:
        log.error(f'추적 갱신 실패: {e}')

    # 4. 일일 판매 스냅샷 저장
    try:
        r = requests.post(f'{API_BASE}/products/sales-snapshot/', timeout=30)
        d = r.json()
        log.info(f'스냅샷 저장: {d.get("saved",0)}건')
    except Exception as e:
        log.error(f'스냅샷 저장 실패: {e}')

    elapsed = time.time() - start
    log.info(f'=== 일일 동기화 완료: {total_synced:,}건 / {elapsed:.0f}초 ===')


if __name__ == '__main__':
    os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)
    main()
