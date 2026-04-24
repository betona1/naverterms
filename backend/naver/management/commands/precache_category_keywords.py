"""
집중관리/우수상품의 카테고리별 키워드를 미리 캐시하는 management command.

대상: is_focus=1 또는 seller_management_code LIKE 'W%' (우수상품)
카테고리: 상품의 category_id에서 마지막(최하위) 카테고리 추출
동작: 네이버 데이터랩 카테고리 키워드 API를 천천히 호출하여 캐시 저장
완료 후 텔레그램 보고

사용: python3 manage.py precache_category_keywords
"""
import time
import requests as http_requests
from datetime import datetime, timedelta
from django.core.management.base import BaseCommand
from django.db import connections
from django.conf import settings
from naver import services
from naver.models import CategoryKeywordCache


class Command(BaseCommand):
    help = '집중관리/우수상품 카테고리 키워드 미리 캐시'

    def add_arguments(self, parser):
        parser.add_argument('--delay', type=float, default=3.0, help='카테고리 간 딜레이 (초)')
        parser.add_argument('--level', type=int, default=4, help='카테고리 레벨 (2=2차, 3=3차, 4=4차)')
        parser.add_argument('--min-products', type=int, default=10, help='최소 상품수 (이하 스킵)')
        parser.add_argument('--no-telegram', action='store_true', help='텔레그램 보고 안함')

    def handle(self, *args, **options):
        delay = options['delay']
        level = options['level']
        min_products = options['min_products']
        no_telegram = options.get('no_telegram', False)
        start_time = datetime.now()

        self.stdout.write(f'[{start_time:%H:%M:%S}] 카테고리 키워드 캐시 시작 (레벨={level}, 딜레이={delay}초, 최소상품={min_products})')

        # 1. 대상 상품의 고유 카테고리 추출
        categories = [(cid, cnt) for cid, cnt in self._get_target_categories(level) if cnt >= min_products]
        total = len(categories)
        self.stdout.write(f'대상 카테고리: {total}개')

        if total == 0:
            self.stdout.write('대상 카테고리 없음. 종료.')
            return

        # 2. 이미 캐시된 카테고리 확인 (24시간 이내)
        from django.utils import timezone
        cutoff = timezone.now() - timedelta(hours=24)
        cached_cids = set(
            CategoryKeywordCache.objects.filter(
                filter_key='__', cached_at__gte=cutoff
            ).values_list('cid', flat=True)
        )
        need_fetch = [(cid, cnt) for cid, cnt in categories if cid not in cached_cids]
        skip_count = total - len(need_fetch)
        self.stdout.write(f'캐시됨: {skip_count}개 스킵, 조회 필요: {len(need_fetch)}개')

        # 3. 날짜 범위
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

        # 4. 순회하며 캐시
        success = 0
        errors = []
        for idx, (cid, product_count) in enumerate(need_fetch, 1):
            self.stdout.write(f'  [{idx}/{len(need_fetch)}] cid={cid} (상품 {product_count}개)...')
            try:
                result = services.get_category_keyword_rank(
                    cid, start_date, end_date,
                    age='', gender='', device='', max_count=500,
                )
                rank_count = len(result.get('ranks', []))
                self.stdout.write(self.style.SUCCESS(f'    → {rank_count}개 키워드 캐시 완료'))
                success += 1
            except Exception as e:
                err_msg = f'cid={cid}: {e}'
                self.stderr.write(self.style.ERROR(f'    → 에러: {e}'))
                errors.append(err_msg)
                # 에러 시 추가 대기
                time.sleep(delay * 2)

            # 딜레이
            if idx < len(need_fetch):
                time.sleep(delay)

        elapsed = datetime.now() - start_time
        elapsed_min = elapsed.total_seconds() / 60

        # 5. 결과 요약
        summary = (
            f'카테고리 키워드 캐시 완료\n'
            f'━━━━━━━━━━━━━━━━━━\n'
            f'대상: 집중관리/우수상품 ({level}차 카테고리)\n'
            f'전체: {total}개 | 스킵: {skip_count}개\n'
            f'성공: {success}개 | 실패: {len(errors)}개\n'
            f'소요: {elapsed_min:.1f}분'
        )
        if errors:
            summary += f'\n\n에러 목록:\n' + '\n'.join(f'  - {e}' for e in errors[:10])

        self.stdout.write(self.style.SUCCESS(f'\n{summary}'))

        # 6. 텔레그램 보고
        if not no_telegram:
            self._send_telegram(summary)

    def _get_target_categories(self, level):
        """집중관리/우수상품의 고유 카테고리 ID와 상품수 반환"""
        # level에 따라 category_id에서 추출할 depth 결정
        # category_id 형태: "50000008>50000165>50001038>50003544"
        # level=2 → "50000008>50000165" 의 마지막 = "50000165"
        # level=3 → 세번째 = "50001038"
        # level=4 → 네번째 = "50003544" (있으면)
        with connections['myproduct'].cursor() as cur:
            if level == 2:
                extract_sql = "SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 2), '>', -1)"
            elif level == 3:
                extract_sql = """
                    CASE WHEN LENGTH(category_id) - LENGTH(REPLACE(category_id, '>', '')) >= 2
                         THEN SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 3), '>', -1)
                         ELSE SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 2), '>', -1)
                    END
                """
            else:  # level=4
                extract_sql = """
                    CASE WHEN LENGTH(category_id) - LENGTH(REPLACE(category_id, '>', '')) >= 3
                         THEN SUBSTRING_INDEX(category_id, '>', -1)
                         WHEN LENGTH(category_id) - LENGTH(REPLACE(category_id, '>', '')) >= 2
                         THEN SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 3), '>', -1)
                         ELSE SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 2), '>', -1)
                    END
                """
            cur.execute(f"""
                SELECT {extract_sql} as cid, COUNT(*) as cnt
                FROM smartstore_product
                WHERE status_type = 'SALE'
                  AND (is_focus = 1 OR seller_management_code LIKE 'W%%')
                  AND category_id != ''
                  AND category_id IS NOT NULL
                GROUP BY cid
                ORDER BY cnt DESC
            """)
            return [(row[0], row[1]) for row in cur.fetchall() if row[0]]

    def _send_telegram(self, message):
        token = getattr(settings, 'TELEGRAM_BOT_TOKEN', '')
        chat_id = getattr(settings, 'TELEGRAM_CHAT_ID', '')
        if not token or not chat_id:
            self.stderr.write('텔레그램 설정 없음 (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)')
            return
        try:
            resp = http_requests.post(
                f'https://api.telegram.org/bot{token}/sendMessage',
                json={'chat_id': chat_id, 'text': message},
                timeout=10,
            )
            if resp.ok:
                self.stdout.write(self.style.SUCCESS('텔레그램 전송 완료'))
            else:
                self.stderr.write(f'텔레그램 전송 실패: {resp.text}')
        except Exception as e:
            self.stderr.write(f'텔레그램 전송 에러: {e}')
