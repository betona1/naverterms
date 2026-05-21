"""
오너클랜 품절/단종 변동사항 자동 동기화 management command.

동작:
  1. 오너클랜 로그인 (requests 세션)
  2. 날짜 기준으로 변동 내역 조회 (selfcode 필터 없이 전체)
  3. 상품별 최신 변동 → 이전 상태와 비교하여 transition 기록
  4. DB 업데이트:
     - ownerclan_product.sale_status (품절=2, 단종=3, 재입고=1)
     - smartstore_product.ownerclan_soldout (품절/단종=1, 그 외=0)
  5. 결과 JSON 저장 + 텔레그램 보고

사용:
  python3 manage.py sync_soldout                     # 기본: 오늘 변동 조회
  python3 manage.py sync_soldout --days 7            # 최근 7일
  python3 manage.py sync_soldout --dry-run           # DB 변경 없이 조회만
"""
import json
import os
import time
import requests as http_requests
from datetime import datetime, timedelta
from collections import defaultdict

from django.core.management.base import BaseCommand
from django.db import connections
from django.conf import settings

STATUS_LABELS = {1: '판매중', 2: '품절', 3: '단종'}

# 오너클랜 변동유형 → sale_status 매핑
STATUS_MAP = {
    '품절': 2,
    '단종': 3,
    '유통금지': 3,
    '옵션 품절': 2,
    '옵션 단종': 3,
    '재입고': 1,
    '옵션 재입고': 1,
}

# 무시할 변동유형
IGNORE_TYPES = {
    '판매가 인상', '판매가 인하',
    '소비자가 인상', '소비자가 인하',
    '배송비 인상', '배송비 인하',
    '반품/교환비(편도) 인상', '반품/교환비(편도) 인하',
    '옵션가 인상', '옵션가 인하',
    '옵션구성 변경', '옵션수량변경',
    '재고 변경', '카테고리 변경',
    '배송방식 변경', '반품접수유형 변경',
    '모델명 변경', '상품 상세정보 변경',
    '키워드 변경', '목록이미지 변경',
    '상품명 변경', '원산지 변경', '제조사 변경',
    '묶음배송수량 변경', '반품가능여부 변경', '반품불가사유 변경',
    '상품정보제공 고시 변경', '인증정보 고시 변경',
    '미성년자 판매변경', '판매유형 변경',
    '과세/면세 변경',
    '기타',
}

RESULT_PATH = os.path.join(settings.BASE_DIR, 'sync_soldout_result.json')


class Command(BaseCommand):
    help = '오너클랜 품절/단종 변동사항 자동 동기화'

    def add_arguments(self, parser):
        parser.add_argument('--days', type=int, default=1,
                            help='조회 기간 일수 (기본: 1 = 오늘)')
        parser.add_argument('--page-size', type=int, default=500,
                            help='페이지당 항목수 (기본: 500)')
        parser.add_argument('--no-telegram', action='store_true',
                            help='텔레그램 보고 안함')
        parser.add_argument('--dry-run', action='store_true',
                            help='DB 변경 없이 조회만')

    def handle(self, *args, **options):
        days = options['days']
        page_size = options['page_size']
        no_telegram = options.get('no_telegram', False)
        dry_run = options.get('dry_run', False)
        start_time = datetime.now()

        self.stdout.write(f'[{start_time:%H:%M:%S}] 오너클랜 품절/단종 동기화 시작')
        if dry_run:
            self.stdout.write(self.style.WARNING('  DRY-RUN 모드'))

        # 1. 오너클랜 로그인
        session = self._login()
        if not session:
            self.stdout.write(self.style.ERROR('오너클랜 로그인 실패. 종료.'))
            return
        self.stdout.write(self.style.SUCCESS('오너클랜 로그인 성공'))

        # 2. 날짜 기준 변동 내역 조회 (selfcode 필터 없음)
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=days - 1)).strftime('%Y-%m-%d')
        self.stdout.write(f'조회 기간: {start_date} ~ {end_date}')

        all_changes = self._fetch_all_changes(
            session, start_date, end_date, page_size,
        )
        # W코드 기준 유니크 상품수
        unique_codes = set()
        for item in all_changes:
            code = item.get('selfcode', '').strip()
            if code and code.startswith('W'):
                unique_codes.add(code)
        self.stdout.write(f'총 변동: 이벤트 {len(all_changes)}건 / 상품 {len(unique_codes)}개 (W코드 기준)')

        # 3. 상품별 최신 변동 분석
        product_status = self._analyze_changes(all_changes)
        self.stdout.write(f'상태 변동 대상 상품: {len(product_status)}개')

        # 4. 이전 상태 조회 + DB 업데이트 + transition 추적
        if not dry_run:
            result, transitions = self._update_db_with_transitions(product_status)
        else:
            transitions = self._get_transitions_dry(product_status)
            result = {'ownerclan_updated': 0, 'smartstore_soldout': 0, 'smartstore_cleared': 0}

        elapsed = (datetime.now() - start_time).total_seconds()

        # 5. 결과 JSON 저장
        sync_result = {
            'synced_at': start_time.strftime('%Y-%m-%d %H:%M:%S'),
            'period': f'{start_date} ~ {end_date}',
            'elapsed': round(elapsed),
            'total_changes': len(unique_codes),  # W코드 기준 유니크 상품수
            'raw_events': len(all_changes),  # API 원본 이벤트 건수
            'status_changes': len(product_status),
            'transitions': transitions,
            'db_result': result,
        }
        self._save_result(sync_result)

        # 6. 요약 보고
        summary = self._build_summary(sync_result, dry_run)
        self.stdout.write(self.style.SUCCESS(f'\n{summary}'))

        if not no_telegram and not dry_run:
            self._send_telegram(summary)

    def _login(self):
        oc_id = getattr(settings, 'OWNERCLAN_ID', 'compwoow')
        oc_pw = getattr(settings, 'OWNERCLAN_PW', 'alswl0628')

        session = http_requests.Session()
        session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) '
                          'Chrome/131.0.0.0 Safari/537.36',
        })
        try:
            session.get('https://ownerclan.com/V2/member/loginform.php', timeout=30)
            resp = session.post(
                'https://ownerclan.com/V2/member/login.php',
                data={'prevUrl': '', 'type': 'login', 'id': oc_id, 'passwd': oc_pw},
                allow_redirects=True,
                timeout=30,
            )
            if '로그아웃' in resp.text:
                return session
        except Exception as e:
            self.stderr.write(f'로그인 에러: {e}')
        return None

    def _fetch_all_changes(self, session, start_date, end_date, page_size):
        """날짜 기준 전체 변동 내역 조회 (selfcode 필터 없음 = 빠름)"""
        all_items = []
        page = 1

        while True:
            self.stdout.write(f'  페이지 {page} 조회 중...')
            try:
                resp = session.post(
                    'https://ownerclan.com/V2/_ajax/getSoldoutList.php',
                    data={
                        'outputType': 'json',
                        'pageNum': str(page),
                        'listNum': str(page_size),
                        'search_start': start_date,
                        'search_end': end_date,
                        'overseaDeli': 'ALL',
                        'search': '',
                        'search_selfcode': '',
                        'search_vendercode': '',
                    },
                    headers={
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': 'https://ownerclan.com/V2/service/soldout.php',
                    },
                    timeout=120,
                )
                data = resp.json()
                total_cnt = int(data.get('totalCnt', 0))
                items = data.get('dataList', [])

                if not items:
                    break

                all_items.extend(items)
                self.stdout.write(f'    -> {len(items)}건 (누적 {len(all_items)}/{total_cnt})')

                if len(all_items) >= total_cnt:
                    break

                page += 1
                time.sleep(0.5)

            except Exception as e:
                self.stderr.write(self.style.ERROR(f'  페이지 {page} 에러: {e}'))
                time.sleep(3)
                try:
                    resp = session.post(
                        'https://ownerclan.com/V2/_ajax/getSoldoutList.php',
                        data={
                            'outputType': 'json',
                            'pageNum': str(page),
                            'listNum': str(page_size),
                            'search_start': start_date,
                            'search_end': end_date,
                            'overseaDeli': 'ALL',
                            'search': '',
                            'search_selfcode': '',
                            'search_vendercode': '',
                        },
                        headers={
                            'X-Requested-With': 'XMLHttpRequest',
                            'Referer': 'https://ownerclan.com/V2/service/soldout.php',
                        },
                        timeout=120,
                    )
                    data = resp.json()
                    items = data.get('dataList', [])
                    if items:
                        all_items.extend(items)
                        page += 1
                    else:
                        break
                except Exception as e2:
                    self.stderr.write(self.style.ERROR(f'  재시도 실패: {e2}'))
                    break

        return all_items

    def _analyze_changes(self, all_changes):
        """변동 내역에서 상품별 최신 상태 결정 (W코드만)"""
        product_changes = defaultdict(list)
        for item in all_changes:
            code = item.get('selfcode', '').strip()
            if not code or not code.startswith('W'):
                continue
            status_text = item.get('soldoutTitle', item.get('content', '')).strip()
            regdate = item.get('regdate', '')
            product_changes[code].append({
                'status_text': status_text,
                'regdate': regdate,
            })

        product_status = {}
        for code, changes in product_changes.items():
            changes.sort(key=lambda x: x['regdate'], reverse=True)
            for change in changes:
                st = change['status_text']
                if st in STATUS_MAP:
                    product_status[code] = {
                        'sale_status': STATUS_MAP[st],
                        'status_text': st,
                        'regdate': change['regdate'],
                    }
                    break
                elif st in IGNORE_TYPES:
                    continue

        return product_status

    def _get_old_statuses(self, codes):
        """ownerclan_product에서 기존 sale_status 조회"""
        if not codes:
            return {}
        old = {}
        batch = list(codes)
        with connections['ads'].cursor() as cur:
            for i in range(0, len(batch), 1000):
                chunk = batch[i:i + 1000]
                ph = ','.join(['%s'] * len(chunk))
                cur.execute(
                    f"SELECT product_code, sale_status FROM ownerclan_product "
                    f"WHERE product_code IN ({ph})",
                    chunk,
                )
                for row in cur.fetchall():
                    old[row[0]] = row[1]
        return old

    def _update_db_with_transitions(self, product_status):
        """DB 업데이트 + transition(이전상태→새상태) 추적"""
        # 1) 이전 상태 조회
        codes = list(product_status.keys())
        old_statuses = self._get_old_statuses(codes)

        # 2) transition 계산 — 우리 DB에 있는 상품만 (W코드 기준)
        transitions = defaultdict(int)
        not_in_db = 0
        for code, info in product_status.items():
            if code not in old_statuses:
                not_in_db += 1
                continue  # DB에 없는 상품은 transition 집계 제외
            old_s = old_statuses[code]
            new_s = info['sale_status']
            if old_s != new_s:
                old_label = STATUS_LABELS.get(old_s, f'상태{old_s}')
                new_label = STATUS_LABELS.get(new_s, f'상태{new_s}')
                transitions[f'{old_label}\u2192{new_label}'] += 1
        if not_in_db:
            self.stdout.write(f'  (DB 미등록 상품 {not_in_db}개 제외)')

        # 3) ownerclan_product 업데이트
        ownerclan_updated = 0
        with connections['ads'].cursor() as cur:
            for code, info in product_status.items():
                cur.execute(
                    "UPDATE ownerclan_product SET sale_status=%s, updated_at=NOW() "
                    "WHERE product_code=%s AND sale_status != %s",
                    [info['sale_status'], code, info['sale_status']],
                )
                ownerclan_updated += cur.rowcount

        # 4) smartstore_product.ownerclan_soldout 업데이트
        soldout_codes = [c for c, i in product_status.items() if i['sale_status'] in (2, 3)]
        restock_codes = [c for c, i in product_status.items() if i['sale_status'] == 1]

        smartstore_soldout = 0
        smartstore_cleared = 0
        with connections['myproduct'].cursor() as cur:
            for i in range(0, len(soldout_codes), 1000):
                chunk = soldout_codes[i:i + 1000]
                ph = ','.join(['%s'] * len(chunk))
                cur.execute(
                    f"UPDATE smartstore_product SET ownerclan_soldout=1 "
                    f"WHERE seller_management_code IN ({ph}) AND ownerclan_soldout != 1",
                    chunk,
                )
                smartstore_soldout += cur.rowcount

            for i in range(0, len(restock_codes), 1000):
                chunk = restock_codes[i:i + 1000]
                ph = ','.join(['%s'] * len(chunk))
                cur.execute(
                    f"UPDATE smartstore_product SET ownerclan_soldout=0 "
                    f"WHERE seller_management_code IN ({ph}) AND ownerclan_soldout = 1",
                    chunk,
                )
                smartstore_cleared += cur.rowcount

        # 5) 재입고 상품 → 스마트스토어 자동 재활성화 (SUSPENSION → SALE)
        reactivate_result = {'success': 0, 'fail': 0}
        if restock_codes:
            try:
                from smartstore.smartstore_product_service import reactivate_products
                reactivate_result = reactivate_products(restock_codes)
                self.stdout.write(
                    f'스마트스토어 재활성화: 성공 {reactivate_result["success"]}건, '
                    f'실패 {reactivate_result["fail"]}건, '
                    f'스킵 {reactivate_result.get("skipped", 0)}건'
                )
            except Exception as e:
                self.stderr.write(f'재활성화 오류: {e}')

        result = {
            'ownerclan_updated': ownerclan_updated,
            'smartstore_soldout': smartstore_soldout,
            'smartstore_cleared': smartstore_cleared,
            'reactivated': reactivate_result.get('success', 0),
            'reactivate_fail': reactivate_result.get('fail', 0),
        }
        return result, dict(transitions)

    def _get_transitions_dry(self, product_status):
        """DRY-RUN: DB 변경 없이 transition만 계산 (DB 등록 상품만)"""
        codes = list(product_status.keys())
        old_statuses = self._get_old_statuses(codes)
        transitions = defaultdict(int)
        for code, info in product_status.items():
            if code not in old_statuses:
                continue  # DB 미등록 제외
            old_s = old_statuses[code]
            new_s = info['sale_status']
            if old_s != new_s:
                old_label = STATUS_LABELS.get(old_s, f'상태{old_s}')
                new_label = STATUS_LABELS.get(new_s, f'상태{new_s}')
                transitions[f'{old_label}\u2192{new_label}'] += 1
        return dict(transitions)

    def _build_summary(self, sync_result, dry_run=False):
        tr = sync_result['transitions']
        db = sync_result['db_result']
        raw = sync_result.get('raw_events', sync_result['total_changes'])
        lines = [
            '오너클랜 품절/단종 동기화 완료',
            '━━━━━━━━━━━━━━━━━━',
            f'기간: {sync_result["period"]}',
            f'변동 상품: {sync_result["total_changes"]:,}개 (이벤트 {raw:,}건)',
            f'상태변경: {sync_result["status_changes"]:,}개',
            '━━━━━━━━━━━━━━━━━━',
        ]
        if tr:
            for key, cnt in sorted(tr.items(), key=lambda x: -x[1]):
                lines.append(f'  {key}: {cnt}건')
        else:
            lines.append('  (상태 변경 없음)')
        lines.append('━━━━━━━━━━━━━━━━━━')
        lines.append(f'DB 반영:')
        lines.append(f'  ownerclan 갱신: {db["ownerclan_updated"]}건')
        lines.append(f'  smartstore 품절마킹: {db["smartstore_soldout"]}건')
        lines.append(f'  smartstore 품절해제: {db["smartstore_cleared"]}건')
        if db.get('reactivated', 0) or db.get('reactivate_fail', 0):
            lines.append(f'  smartstore 재활성화: {db.get("reactivated", 0)}건 (실패 {db.get("reactivate_fail", 0)}건)')
        lines.append(f'소요: {sync_result["elapsed"]}초')
        if dry_run:
            lines.append('\nDRY-RUN (실제 DB 변경 없음)')
        return '\n'.join(lines)

    def _save_result(self, sync_result):
        try:
            with open(RESULT_PATH, 'w', encoding='utf-8') as f:
                json.dump(sync_result, f, ensure_ascii=False, indent=2)
            self.stdout.write(f'결과 저장: {RESULT_PATH}')
        except Exception as e:
            self.stderr.write(f'결과 저장 실패: {e}')
        self._save_to_db(sync_result)

    def _save_to_db(self, sync_result):
        """soldout_sync_log 테이블에 날짜별 이력 저장"""
        try:
            sync_date = sync_result['synced_at'][:10]
            with connections['ads'].cursor() as cur:
                cur.execute("""
                    INSERT INTO soldout_sync_log
                    (sync_date, total_changes, raw_events, status_changes, transitions, db_result, elapsed)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                    total_changes = VALUES(total_changes),
                    raw_events = VALUES(raw_events),
                    status_changes = VALUES(status_changes),
                    transitions = VALUES(transitions),
                    db_result = VALUES(db_result),
                    elapsed = VALUES(elapsed)
                """, [
                    sync_date,
                    sync_result.get('total_changes', 0),
                    sync_result.get('raw_events', 0),
                    sync_result.get('status_changes', 0),
                    json.dumps(sync_result.get('transitions', {}), ensure_ascii=False),
                    json.dumps(sync_result.get('db_result', {}), ensure_ascii=False),
                    sync_result.get('elapsed', 0),
                ])
        except Exception as e:
            self.stderr.write(f'DB 이력 저장 실패: {e}')

    def _send_telegram(self, message):
        token = getattr(settings, 'TELEGRAM_BOT_TOKEN', '')
        chat_id = getattr(settings, 'TELEGRAM_CHAT_ID', '')
        if not token or not chat_id:
            self.stderr.write('텔레그램 설정 없음')
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
                self.stderr.write(f'텔레그램 실패: {resp.text}')
        except Exception as e:
            self.stderr.write(f'텔레그램 에러: {e}')
