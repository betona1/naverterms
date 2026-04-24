"""
오너클랜 상품 변동사항 감지 management command.

동작:
  1. ownerclan_product에서 현재값 vs orig_ 값 비교
  2. 달라진 필드를 product_change_log에 기록 (기존 미반영 로그 삭제 후 재기록)
  3. smartstore_product 마스터 추적 컬럼 갱신 (refresh_master_tracking)

사용:
  python3 manage.py detect_changes               # 전체 감지 + 반영
  python3 manage.py detect_changes --dry-run      # DB 변경 없이 건수만 확인
"""
import logging
from datetime import datetime

from django.core.management.base import BaseCommand
from django.db import connections

from ownerclan.ownerclan_product_service import (
    CHANGE_DETECT_FIELDS, FIELD_TO_GROUP, CHANGE_GROUP_LABELS,
    _any_field_changed_sql, DB,
)
from smartstore.smartstore_product_service import refresh_master_tracking

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = '오너클랜 상품 변동사항 감지 (현재값 vs orig_ 비교)'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true',
                            help='DB 변경 없이 건수만 확인')
        parser.add_argument('--no-telegram', action='store_true',
                            help='텔레그램 보고 안함')

    def handle(self, *args, **options):
        dry_run = options.get('dry_run', False)
        no_telegram = options.get('no_telegram', False)
        start_time = datetime.now()

        self.stdout.write(f'[{start_time:%H:%M:%S}] 오너클랜 변동사항 감지 시작')
        if dry_run:
            self.stdout.write(self.style.WARNING('  DRY-RUN 모드'))

        # 1. 변경된 상품 조회
        where = _any_field_changed_sql()
        fields = ', '.join(
            [f'{f}, orig_{f}' for f in CHANGE_DETECT_FIELDS.keys()]
        )

        with connections[DB].cursor() as cur:
            cur.execute(
                f"SELECT id, product_code, {fields} "
                f"FROM ownerclan_product WHERE {where}"
            )
            columns = [col[0] for col in cur.description]
            changed_rows = [dict(zip(columns, row)) for row in cur.fetchall()]

        self.stdout.write(f'변경 감지 상품: {len(changed_rows):,}개')

        if not changed_rows:
            self.stdout.write(self.style.SUCCESS('변경사항 없음. 종료.'))
            return

        # 2. 변경 내역 분석
        group_counts = {}
        total_field_changes = 0
        inserts = []

        for row in changed_rows:
            product_id = row['id']
            product_code = row['product_code']
            for field, ftype in CHANGE_DETECT_FIELDS.items():
                cur_val = row.get(field)
                orig_val = row.get(f'orig_{field}')
                if ftype == 'int':
                    cur_cmp = int(cur_val or 0)
                    orig_cmp = int(orig_val or 0)
                else:
                    cur_cmp = str(cur_val or '')
                    orig_cmp = str(orig_val or '')
                if cur_cmp != orig_cmp:
                    group = FIELD_TO_GROUP.get(field, 'etc')
                    group_counts[group] = group_counts.get(group, 0) + 1
                    total_field_changes += 1
                    inserts.append((
                        product_id, product_code, group, field,
                        str(orig_val) if orig_val is not None else '',
                        str(cur_val) if cur_val is not None else '',
                    ))

        # 그룹별 요약 출력
        self.stdout.write(f'총 필드 변경: {total_field_changes:,}건')
        for g, cnt in sorted(group_counts.items(), key=lambda x: -x[1]):
            label = CHANGE_GROUP_LABELS.get(g, g)
            self.stdout.write(f'  {label}: {cnt:,}건')

        if dry_run:
            elapsed = (datetime.now() - start_time).total_seconds()
            self.stdout.write(self.style.SUCCESS(
                f'\nDRY-RUN 완료 (DB 변경 없음). 소요: {elapsed:.1f}초'
            ))
            return

        # 3. 기존 미반영 로그 삭제 + 새로 기록
        with connections[DB].cursor() as cur:
            cur.execute("DELETE FROM product_change_log WHERE is_applied = 0")
            deleted = cur.rowcount
            self.stdout.write(f'기존 미반영 로그 삭제: {deleted:,}건')

            if inserts:
                # 배치 INSERT
                for i in range(0, len(inserts), 5000):
                    batch = inserts[i:i + 5000]
                    cur.executemany(
                        "INSERT INTO product_change_log "
                        "(product_id, product_code, change_group, field_name, "
                        "old_value, new_value) "
                        "VALUES (%s, %s, %s, %s, %s, %s)",
                        batch,
                    )
                self.stdout.write(self.style.SUCCESS(
                    f'변경 로그 기록: {len(inserts):,}건'
                ))

        # 4. smartstore_product 마스터 추적 갱신
        self.stdout.write('smartstore_product 마스터 추적 갱신 중...')
        tracking_result = refresh_master_tracking()
        self.stdout.write(self.style.SUCCESS(
            f'마스터 추적 갱신 완료: {tracking_result}'
        ))

        elapsed = (datetime.now() - start_time).total_seconds()

        summary = (
            f'\n오너클랜 변동사항 감지 완료\n'
            f'━━━━━━━━━━━━━━━━━━\n'
            f'변경 상품: {len(changed_rows):,}개\n'
            f'필드 변경: {total_field_changes:,}건\n'
            f'소요: {elapsed:.1f}초'
        )
        self.stdout.write(self.style.SUCCESS(summary))

        if not no_telegram:
            self._send_telegram(summary)

    def _send_telegram(self, message):
        from django.conf import settings
        import requests as http_requests
        token = getattr(settings, 'TELEGRAM_BOT_TOKEN', '')
        chat_id = getattr(settings, 'TELEGRAM_CHAT_ID', '')
        if not token or not chat_id:
            return
        try:
            http_requests.post(
                f'https://api.telegram.org/bot{token}/sendMessage',
                json={'chat_id': chat_id, 'text': message},
                timeout=10,
            )
        except Exception:
            pass
