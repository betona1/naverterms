#!/usr/bin/env python3
"""매일 밤 12시 자동 실행: 전체 스토어 상품 동기화 스크립트"""
import os
import sys
import time
import logging
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

import django
django.setup()

from smartstore.smartstore_product_service import sync_products
from smartstore.smartstore_service import get_stores
from smartstore.smartstore_order_service import update_product_sales_summary

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(os.path.dirname(__file__), '..', 'sync.log')),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


def main():
    logger.info('=== 전체 스토어 상품 동기화 시작 ===')
    stores = get_stores(include_inactive=False)
    active = [s for s in stores if s.get('commerce_api_key')]
    logger.info(f'동기화 대상: {len(active)}개 스토어')

    success = 0
    fail = 0
    for s in active:
        try:
            result = sync_products(s['id'])
            if 'error' in result:
                logger.warning(f'FAIL {s["store_name"]}: {result["error"]}')
                fail += 1
            else:
                logger.info(f'OK {s["store_name"]}: {result["synced"]}개 동기화')
                success += 1
        except Exception as e:
            logger.error(f'ERROR {s["store_name"]}: {e}')
            fail += 1
        time.sleep(2)

    logger.info(f'=== 동��화 완료: 성공 {success}, 실패 {fail} ===')

    # 판매 집계 업데이트
    try:
        cnt = update_product_sales_summary()
        logger.info(f'판매 집계 업데이트: {cnt}건')
    except Exception as e:
        logger.error(f'판매 집계 오류: {e}')


if __name__ == '__main__':
    main()
