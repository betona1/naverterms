"""
새벽 배치: 카테고리키워드 캐시 갱신

사용법:
  python manage.py cache_datalab              # 기존 캐시된 카테고리만 갱신
  python manage.py cache_datalab --all        # 전 카테고리 (대+중) 수집
  python manage.py cache_datalab --depth 3    # 대+중+소 까지 수집

PM2 cron 또는 crontab:
  0 3 * * * cd /home/joacham/projects/naverterms/backend && python manage.py cache_datalab --all
"""
import time
import logging
from datetime import datetime, timedelta
from django.core.management.base import BaseCommand
from django.utils import timezone
from naver.models import CategoryKeywordCache, KeywordEnrichCache
from naver import services

logger = logging.getLogger('cache_datalab')


class Command(BaseCommand):
    help = '카테고리키워드 캐시 갱신 (DataLab TOP 500 + 검색량/상품수)'

    def add_arguments(self, parser):
        parser.add_argument('--all', action='store_true', help='전 카테고리 수집 (기본: 기존 캐시만 갱신)')
        parser.add_argument('--depth', type=int, default=2, help='--all 시 수집 깊이 (1=대, 2=대+중, 3=대+중+소)')
        parser.add_argument('--filter', default='__', help='필터 키 (age_gender_device)')

    def handle(self, *args, **options):
        start = time.time()
        do_all = options['all']
        depth = options['depth']
        filter_key = options['filter']

        if do_all:
            cids = self._collect_cids(depth)
            # 기존 캐시에만 있는 소/세부 카테고리도 합산
            cached_cids = set(CategoryKeywordCache.objects.values_list('cid', flat=True).distinct())
            new_cids = set(cids)
            extra = cached_cids - new_cids
            cids = list(new_cids | cached_cids)
            self.stdout.write(f'전 카테고리 수집: {len(new_cids)}개 (depth={depth}) + 기존 캐시 {len(extra)}개 = 총 {len(cids)}개')
        else:
            cached = CategoryKeywordCache.objects.values_list('cid', flat=True).distinct()
            cids = list(cached)
            self.stdout.write(f'기존 캐시 갱신: {len(cids)}개 카테고리')

        if not cids:
            self.stdout.write('갱신할 카테고리가 없습니다.')
            return

        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

        # age/gender/device 파싱
        parts = filter_key.split('_')
        age = parts[0] if len(parts) > 0 else ''
        gender = parts[1] if len(parts) > 1 else ''
        device = parts[2] if len(parts) > 2 else ''

        all_keywords = set()
        success = 0
        fail = 0

        for i, cid in enumerate(cids):
            try:
                ranks = services._fetch_category_keyword_rank_live(
                    cid, start_date, end_date, age, gender, device,
                )
                CategoryKeywordCache.objects.update_or_create(
                    cid=cid, filter_key=filter_key,
                    defaults={'ranks_json': ranks},
                )
                for r in ranks:
                    all_keywords.add(r['keyword'])
                success += 1
                if (i + 1) % 10 == 0:
                    self.stdout.write(f'  진행: {i+1}/{len(cids)} ({success} 성공, {fail} 실패)')
            except Exception as e:
                fail += 1
                logger.warning(f'cid={cid} 실패: {e}')
            time.sleep(0.3)

        self.stdout.write(f'카테고리 완료: {success}/{len(cids)} (실패 {fail})')
        self.stdout.write(f'고유 키워드: {len(all_keywords)}개 — enrichment 시작')

        # Enrich — 캐시 만료된 것만
        cutoff = timezone.now() - timedelta(hours=24)
        cached_kws = set(
            KeywordEnrichCache.objects.filter(
                keyword__in=list(all_keywords), cached_at__gte=cutoff,
            ).values_list('keyword', flat=True)
        )
        uncached = [kw for kw in all_keywords if kw not in cached_kws]
        self.stdout.write(f'미캐시 키워드: {len(uncached)}개 (캐시: {len(cached_kws)}개)')

        batch_size = 50
        enrich_ok = 0
        for i in range(0, len(uncached), batch_size):
            batch = uncached[i:i + batch_size]
            try:
                live = services._enrich_keywords_live(batch)
                for kw, data in live.items():
                    KeywordEnrichCache.objects.update_or_create(
                        keyword=kw,
                        defaults={
                            'monthly_pc_qc': data.get('monthlyPcQcCnt', 0),
                            'monthly_mobile_qc': data.get('monthlyMobileQcCnt', 0),
                            'comp_idx': data.get('compIdx', ''),
                            'product_count': data.get('productCount', 0),
                            'category_name': data.get('category', ''),
                        },
                    )
                enrich_ok += len(live)
            except Exception as e:
                logger.warning(f'enrich batch 실패: {e}')
            if (i + batch_size) % 200 == 0:
                self.stdout.write(f'  enrich 진행: {min(i + batch_size, len(uncached))}/{len(uncached)}')

        elapsed = time.time() - start
        self.stdout.write(self.style.SUCCESS(
            f'완료! 카테고리 {success}개, enrich {enrich_ok}개, 소요시간 {elapsed:.0f}초'
        ))

    def _collect_cids(self, depth):
        """재귀적으로 카테고리 CID 수집"""
        cids = []
        try:
            level1 = services.get_datalab_categories('0')
        except Exception:
            return cids

        for c1 in level1:
            cids.append(c1['cid'])
            if depth < 2:
                continue
            time.sleep(0.1)
            try:
                level2 = services.get_datalab_categories(c1['cid'])
            except Exception:
                continue
            for c2 in level2:
                cids.append(c2['cid'])
                if depth < 3:
                    continue
                time.sleep(0.1)
                try:
                    level3 = services.get_datalab_categories(c2['cid'])
                except Exception:
                    continue
                for c3 in level3:
                    cids.append(c3['cid'])

        return cids
