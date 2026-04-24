#!/usr/bin/env python3
"""매일 아침 7시 실행: 오너클랜 ↔ 스마트스토어 상태 비교 + 텔레그램 리포트"""
import os
import sys
import time
import logging

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

logging.basicConfig(
    filename=os.path.join(BASE_DIR, 'logs', 'cron_morning_audit.log'),
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger(__name__)


def main():
    import django
    django.setup()

    from smartstore.product_audit_service import start_audit, get_audit_status

    log.info('=== 아침 오너클랜 비교 검증 시작 ===')
    start = time.time()

    result = start_audit(source='ownerclan')
    if not result['ok']:
        log.error(f'시작 실패: {result["message"]}')
        return

    # 완료 대기 (최대 5분)
    for _ in range(300):
        time.sleep(1)
        st = get_audit_status()
        if not st['running']:
            break

    st = get_audit_status()
    elapsed = time.time() - start
    log.info(
        f'=== 비교 완료: {st["checked"]:,}건 확인, '
        f'일치 {st["match"]:,}, 불일치 {st["mismatch"]:,}, '
        f'에러 {st["errors"]:,} / {elapsed:.0f}초 ==='
    )


if __name__ == '__main__':
    os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)
    main()
