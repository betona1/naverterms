"""
W코드 리스트의 실제 상태를 3곳에서 비교 확인.

1) ads.ownerclan_product.sale_status (오너클랜 DB)
2) myproduct.smartstore_product.status_type (스마트스토어 DB)
3) 네이버 커머스 API GET (실제 라이브 상태)

사용:
  python3 manage.py check_product_status W123456 W789012       # W코드 직접 지정
  python3 manage.py check_product_status --file wcodes.txt     # 파일에서 읽기
  python3 manage.py check_product_status --sample 10           # DB에서 무작위 10개
  python3 manage.py check_product_status --api                 # 네이버 API까지 확인
"""
import time
import random
from django.core.management.base import BaseCommand
from django.db import connections
from smartstore.smartstore_product_service import _get_access_token


SALE_STATUS_MAP = {1: '판매중', 2: '품절', 3: '단종'}


class Command(BaseCommand):
    help = 'W코드 상품의 오너클랜/스마트스토어/네이버API 상태 비교'

    def add_arguments(self, parser):
        parser.add_argument('wcodes', nargs='*', help='확인할 W코드 목록')
        parser.add_argument('--file', '-f', help='W코드 목록 파일 경로 (줄바꿈 구분)')
        parser.add_argument('--sample', type=int, default=0,
                            help='DB에서 무작위 N개 샘플 추출')
        parser.add_argument('--api', action='store_true',
                            help='네이버 커머스 API로 실제 상태까지 확인')
        parser.add_argument('--mismatch-only', action='store_true',
                            help='불일치 건만 출력')

    def handle(self, *args, **options):
        wcodes = self._collect_wcodes(options)
        if not wcodes:
            self.stderr.write('W코드가 없습니다. --sample N 또는 W코드를 지정하세요.')
            return

        self.stdout.write(f'확인 대상: {len(wcodes)}개')
        self.stdout.write('━' * 80)

        # 1) 오너클랜 DB 조회
        oc_map = self._query_ownerclan(wcodes)

        # 2) 스마트스토어 DB 조회
        ss_map = self._query_smartstore(wcodes)

        # 3) 네이버 API 조회 (옵션)
        api_map = {}
        if options['api']:
            api_map = self._query_naver_api(ss_map)

        # 결과 출력
        self._print_results(wcodes, oc_map, ss_map, api_map,
                            show_api=options['api'],
                            mismatch_only=options['mismatch_only'])

    def _collect_wcodes(self, options):
        wcodes = list(options.get('wcodes') or [])

        if options.get('file'):
            with open(options['file'], 'r') as f:
                for line in f:
                    code = line.strip()
                    if code and code.startswith('W'):
                        wcodes.append(code)

        if options.get('sample') and not wcodes:
            wcodes = self._random_sample(options['sample'])

        # 중복 제거, 순서 유지
        seen = set()
        unique = []
        for w in wcodes:
            if w not in seen:
                seen.add(w)
                unique.append(w)
        return unique

    def _random_sample(self, n):
        """오너클랜+스마트스토어 양쪽에 존재하는 W코드 중 랜덤 추출"""
        with connections['ads'].cursor() as cur:
            cur.execute(
                "SELECT op.product_code FROM ownerclan_product op "
                "INNER JOIN myproduct.smartstore_product sp "
                "ON sp.seller_management_code = op.product_code "
                "ORDER BY RAND() LIMIT %s", [n]
            )
            return [r[0] for r in cur.fetchall()]

    def _query_ownerclan(self, wcodes):
        """오너클랜 DB에서 sale_status 조회"""
        if not wcodes:
            return {}
        ph = ','.join(['%s'] * len(wcodes))
        with connections['ads'].cursor() as cur:
            cur.execute(
                f"SELECT product_code, sale_status, product_name "
                f"FROM ownerclan_product WHERE product_code IN ({ph})",
                wcodes
            )
            return {r[0]: {'sale_status': r[1], 'name': r[2]} for r in cur.fetchall()}

    def _query_smartstore(self, wcodes):
        """스마트스토어 DB에서 status_type + origin_product_no + store 정보 조회"""
        if not wcodes:
            return {}
        ph = ','.join(['%s'] * len(wcodes))
        with connections['myproduct'].cursor() as cur:
            cur.execute(
                f"SELECT p.seller_management_code, p.status_type, p.origin_product_no, "
                f"p.store_id, s.store_name, s.commerce_api_key, s.commerce_secret_key "
                f"FROM smartstore_product p "
                f"JOIN smartstoreIdList s ON s.id = p.store_id "
                f"WHERE p.seller_management_code IN ({ph})",
                wcodes
            )
            result = {}
            for r in cur.fetchall():
                result[r[0]] = {
                    'status_type': r[1],
                    'origin_product_no': r[2],
                    'store_id': r[3],
                    'store_name': r[4],
                    'api_key': r[5],
                    'secret_key': r[6],
                }
            return result

    def _query_naver_api(self, ss_map):
        """네이버 커머스 API GET으로 실제 상품 상태 조회 (상점별 토큰 재사용)"""
        import requests

        if not ss_map:
            return {}

        # 상점별 그룹핑
        store_groups = {}
        for wcode, info in ss_map.items():
            sid = info['store_id']
            if sid not in store_groups:
                store_groups[sid] = {
                    'api_key': info['api_key'],
                    'secret_key': info['secret_key'],
                    'items': [],
                }
            store_groups[sid]['items'].append((wcode, info['origin_product_no']))

        api_map = {}
        for sid, group in store_groups.items():
            if not group['api_key'] or not group['secret_key']:
                for wcode, _ in group['items']:
                    api_map[wcode] = {'status': 'API키없음', 'error': True}
                continue

            try:
                token = _get_access_token(group['api_key'], group['secret_key'])
            except Exception as e:
                for wcode, _ in group['items']:
                    api_map[wcode] = {'status': f'토큰실패: {e}', 'error': True}
                continue

            headers = {'Authorization': f'Bearer {token}'}
            for wcode, opno in group['items']:
                url = f'https://api.commerce.naver.com/external/v2/products/origin-products/{opno}'
                try:
                    resp = requests.get(url, headers=headers, timeout=10)
                    if resp.status_code == 200:
                        data = resp.json()
                        origin = data.get('originProduct', {})
                        api_map[wcode] = {
                            'status': origin.get('statusType', '?'),
                            'error': False,
                        }
                    else:
                        api_map[wcode] = {'status': f'HTTP {resp.status_code}', 'error': True}
                except Exception as e:
                    api_map[wcode] = {'status': f'요청실패: {e}', 'error': True}
                time.sleep(0.3)

            self.stdout.write(f'  API 조회 완료: 상점 {sid} ({len(group["items"])}건)')

        return api_map

    def _print_results(self, wcodes, oc_map, ss_map, api_map, show_api=False, mismatch_only=False):
        # 헤더
        if show_api:
            header = f'{"W코드":<12} {"오너클랜":>8} {"SS-DB":>12} {"API실제":>12} {"상점":>8} {"상태"}'
        else:
            header = f'{"W코드":<12} {"오너클랜":>8} {"SS-DB":>12} {"상점":>8} {"상태"}'
        self.stdout.write(header)
        self.stdout.write('─' * len(header))

        stats = {'match': 0, 'mismatch': 0, 'oc_missing': 0, 'ss_missing': 0}

        for wcode in wcodes:
            oc = oc_map.get(wcode)
            ss = ss_map.get(wcode)

            oc_str = SALE_STATUS_MAP.get(oc['sale_status'], f'?({oc["sale_status"]})') if oc else '없음'
            ss_str = ss['status_type'] if ss else '없음'
            store_str = ss['store_name'][:6] if ss else '-'

            api_str = ''
            if show_api:
                api_info = api_map.get(wcode)
                api_str = api_info['status'] if api_info else '-'

            # 불일치 판단
            mismatch = False
            if not oc:
                status_str = '원본없음'
                stats['oc_missing'] += 1
            elif not ss:
                status_str = 'SS없음'
                stats['ss_missing'] += 1
            else:
                # 오너클랜 판매중(1) ↔ 스마트스토어 SALE 일치 여부
                oc_selling = (oc['sale_status'] == 1)
                ss_selling = (ss['status_type'] == 'SALE')
                if oc_selling == ss_selling:
                    status_str = 'OK'
                    stats['match'] += 1
                else:
                    status_str = '불일치'
                    mismatch = True
                    stats['mismatch'] += 1

                # API 결과와도 비교
                if show_api and wcode in api_map and not api_map[wcode].get('error'):
                    api_selling = (api_map[wcode]['status'] == 'SALE')
                    if ss_selling != api_selling:
                        status_str += '+DB차이'
                        mismatch = True

            if mismatch_only and not mismatch:
                continue

            if show_api:
                line = f'{wcode:<12} {oc_str:>8} {ss_str:>12} {api_str:>12} {store_str:>8} {status_str}'
            else:
                line = f'{wcode:<12} {oc_str:>8} {ss_str:>12} {store_str:>8} {status_str}'

            # 불일치는 빨간색으로
            if mismatch:
                self.stdout.write(self.style.ERROR(line))
            elif status_str in ('원본없음', 'SS없음'):
                self.stdout.write(self.style.WARNING(line))
            else:
                self.stdout.write(line)

        # 요약
        self.stdout.write('━' * 80)
        total = len(wcodes)
        self.stdout.write(f'합계: {total}개  |  일치: {stats["match"]}  |  '
                          f'불일치: {stats["mismatch"]}  |  '
                          f'오너클랜없음: {stats["oc_missing"]}  |  SS없음: {stats["ss_missing"]}')
