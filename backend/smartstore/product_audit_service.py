"""
전상품 네이버 API 검증 서비스.

전체 스마트스토어 상품의 status_type을 네이버 API로 확인하여
DB↔실제 불일치를 자동 수정하고 product_audit_log/change에 기록.

API 키 기준 ~14그룹 병렬 처리 (ThreadPoolExecutor).
"""
import json
import time
import logging
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests as requests_lib

from django.conf import settings
from django.db import connections

from smartstore.smartstore_product_service import _get_access_token

logger = logging.getLogger(__name__)

# ── 글로벌 상태 (폴링용) ──

_state_lock = threading.Lock()
_audit_state = {
    'running': False,
    'stop_flag': False,
    'audit_log_id': 0,
    'started_at': None,
    'total': 0,
    'checked': 0,
    'match': 0,
    'mismatch': 0,
    'fixed': 0,
    'closed': 0,
    'errors': 0,
    'current_api_key': '',
    'logs': [],       # 최근 100줄
}

MAX_LOG_LINES = 200


def _send_telegram(message):
    """텔레그램 봇으로 메시지 전송."""
    token = getattr(settings, 'TELEGRAM_BOT_TOKEN', '')
    chat_id = getattr(settings, 'TELEGRAM_CHAT_ID', '')
    if not token or not chat_id:
        _add_log('텔레그램 설정 없음 (TELEGRAM_BOT_TOKEN/CHAT_ID)')
        return
    try:
        requests_lib.post(
            f'https://api.telegram.org/bot{token}/sendMessage',
            json={'chat_id': chat_id, 'text': message, 'parse_mode': 'HTML'},
            timeout=10,
        )
    except Exception as e:
        _add_log(f'텔레그램 전송 실패: {e}')


def _build_audit_report(st, elapsed, api_key_results):
    """검증 결과를 텔레그램용 HTML 리포트 문자열로 생성."""
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    lines = [
        '<b>📋 스마트스토어 품단종 검증 리포트</b>',
        '',
        f'🕐 소요시간: {minutes}분 {seconds}초',
        f'📦 검증 대상: {st["total"]:,}개',
        f'✅ 확인 완료: {st["checked"]:,}개',
        '',
        '<b>── 검증 결과 ──</b>',
        f'🟢 일치: {st["match"]:,}',
        f'🟡 불일치 (자동수정): {st["mismatch"]:,}',
        f'🔴 CLOSE 처리: {st["closed"]:,}',
        f'⚠️ 에러: {st["errors"]:,}',
        f'🔧 총 수정: {st["fixed"]:,}',
    ]

    # 불일치율
    if st['checked'] > 0:
        mismatch_rate = (st['mismatch'] + st['closed']) / st['checked'] * 100
        lines.append(f'📊 불일치율: {mismatch_rate:.2f}%')

    # API키별 요약 (불일치/CLOSE가 있는 것만)
    problem_keys = {k: v for k, v in api_key_results.items()
                    if v.get('mismatch', 0) > 0 or v.get('closed', 0) > 0 or v.get('errors', 0) > 0}
    if problem_keys:
        lines.append('')
        lines.append('<b>── 문제 API키 ──</b>')
        for k, v in sorted(problem_keys.items(), key=lambda x: -(x[1].get('mismatch', 0) + x[1].get('closed', 0))):
            parts = []
            if v.get('mismatch', 0): parts.append(f'불일치 {v["mismatch"]}')
            if v.get('closed', 0): parts.append(f'CLOSE {v["closed"]}')
            if v.get('errors', 0): parts.append(f'에러 {v["errors"]}')
            lines.append(f'  {k}: {", ".join(parts)}')

    lines.append('')
    lines.append(f'📅 {datetime.now().strftime("%Y-%m-%d %H:%M")}')

    return '\n'.join(lines)


def _reset_state():
    with _state_lock:
        _audit_state.update({
            'running': False,
            'stop_flag': False,
            'audit_log_id': 0,
            'started_at': None,
            'total': 0,
            'checked': 0,
            'match': 0,
            'mismatch': 0,
            'fixed': 0,
            'closed': 0,
            'errors': 0,
            'current_api_key': '',
            'logs': [],
        })


def _add_log(msg):
    with _state_lock:
        _audit_state['logs'].append(f'[{datetime.now().strftime("%H:%M:%S")}] {msg}')
        if len(_audit_state['logs']) > MAX_LOG_LINES:
            _audit_state['logs'] = _audit_state['logs'][-MAX_LOG_LINES:]


def _inc(key, val=1):
    with _state_lock:
        _audit_state[key] = _audit_state.get(key, 0) + val


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


# ── 공개 API ──

def get_audit_status():
    with _state_lock:
        s = dict(_audit_state)
        s['logs'] = list(s['logs'])
    elapsed = 0
    if s['started_at']:
        elapsed = (datetime.now() - s['started_at']).total_seconds()
    total = max(s['total'], 1)
    return {
        'running': s['running'],
        'progress_pct': round(s['checked'] / total * 100, 1) if total else 0,
        'checked': s['checked'],
        'total': s['total'],
        'match': s['match'],
        'mismatch': s['mismatch'],
        'fixed': s['fixed'],
        'closed': s['closed'],
        'errors': s['errors'],
        'current_api_key': s['current_api_key'],
        'logs': s['logs'],
        'elapsed': round(elapsed, 1),
        'audit_log_id': s['audit_log_id'],
    }


def stop_audit():
    with _state_lock:
        _audit_state['stop_flag'] = True
    _add_log('중지 요청됨')


def start_audit(source='api'):
    """전상품 검증 시작. 이미 실행 중이면 에러 반환."""
    with _state_lock:
        if _audit_state['running']:
            return {'ok': False, 'message': '이미 검증 진행 중입니다.'}

    _reset_state()
    with _state_lock:
        _audit_state['running'] = True
        _audit_state['started_at'] = datetime.now()

    if source == 'ownerclan':
        t = threading.Thread(target=_run_ownerclan_audit, daemon=True)
        t.start()
        return {'ok': True, 'message': '오너클랜 ↔ 스마트스토어 상태 비교를 시작합니다.'}

    # 백그라운드 스레드에서 실행
    t = threading.Thread(target=_run_audit, args=(source,), daemon=True)
    t.start()
    return {'ok': True, 'message': '전상품 API 검증을 시작합니다.'}


def get_audit_logs(limit=20):
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT * FROM product_audit_log ORDER BY id DESC LIMIT %s", [limit]
        )
        rows = _dictfetchall(cur)
    for r in rows:
        for k in ('started_at', 'completed_at'):
            if r.get(k) and isinstance(r[k], datetime):
                r[k] = r[k].isoformat()
        if r.get('elapsed_sec'):
            from decimal import Decimal
            if isinstance(r['elapsed_sec'], Decimal):
                r['elapsed_sec'] = float(r['elapsed_sec'])
        if r.get('by_api_key') and isinstance(r['by_api_key'], str):
            try:
                r['by_api_key'] = json.loads(r['by_api_key'])
            except Exception:
                pass
    return rows


def get_audit_log_detail(audit_log_id, limit=500):
    with connections['myproduct'].cursor() as cur:
        # 요약
        cur.execute(
            "SELECT action, COUNT(*) as cnt FROM product_audit_change "
            "WHERE audit_log_id = %s GROUP BY action ORDER BY cnt DESC",
            [audit_log_id]
        )
        summary = _dictfetchall(cur)
        # 상세 (불일치/수정 건만 — match 제외)
        cur.execute(
            "SELECT * FROM product_audit_change "
            "WHERE audit_log_id = %s AND action != 'match' "
            "ORDER BY id LIMIT %s",
            [audit_log_id, limit]
        )
        changes = _dictfetchall(cur)
    for c in changes:
        if c.get('checked_at') and isinstance(c['checked_at'], datetime):
            c['checked_at'] = c['checked_at'].isoformat()
    return {'summary': summary, 'changes': changes}


# ── 오너클랜 비교 검증 ──

REVERSE_STATUS = {1: '판매중', 2: '품절', 3: '단종'}


def _run_ownerclan_audit():
    """오너클랜 sale_status ↔ 스마트스토어 status_type 비교 (DB대DB, 수초 완료)."""
    from smartstore.smartstore_product_service import refresh_master_tracking, STATUS_MAP

    try:
        now = datetime.now()
        _add_log('오너클랜 마스터 추적 데이터 갱신 중...')
        with _state_lock:
            _audit_state['current_api_key'] = 'ownerclan'

        # 1) refresh_master_tracking → status_mismatch 플래그 최신화
        updated = refresh_master_tracking(store_pk=0)
        _add_log(f'마스터 추적 갱신 완료: {updated:,}건')

        # 2) 전체 상품 조회 (W코드 있는 것만, CLOSE 제외)
        with connections['myproduct'].cursor() as cur:
            cur.execute("""
                SELECT p.id, p.origin_product_no, p.seller_management_code,
                       p.status_type, p.name, p.master_sale_status, p.status_mismatch,
                       s.store_name
                FROM smartstore_product p
                JOIN smartstoreIdList s ON s.id = p.store_id
                WHERE p.seller_management_code IS NOT NULL
                  AND p.seller_management_code != ''
                  AND p.status_type != 'CLOSE'
            """)
            products = _dictfetchall(cur)

            # W코드 없는 상품 수
            cur.execute("""
                SELECT COUNT(*) FROM smartstore_product
                WHERE (seller_management_code IS NULL OR seller_management_code = '')
                  AND status_type != 'CLOSE'
            """)
            no_wcode_count = cur.fetchone()[0]

        total = len(products)
        with _state_lock:
            _audit_state['total'] = total

        _add_log(f'비교 대상: {total:,}개 (W코드 없는 상품: {no_wcode_count:,}개 제외)')

        # 3) audit_log 생성
        audit_log_id = 0
        try:
            with connections['myproduct'].cursor() as cur:
                cur.execute(
                    "INSERT INTO product_audit_log "
                    "(started_at, source, total_target) VALUES (%s, %s, %s)",
                    [now, 'ownerclan', total]
                )
                audit_log_id = cur.lastrowid
            with _state_lock:
                _audit_state['audit_log_id'] = audit_log_id
        except Exception as e:
            _add_log(f'로그 생성 실패: {e}')

        # 4) 비교 수행
        changes = []  # (audit_log_id, opno, wcode, store, db_status, oc_status, action, new, detail)
        store_summary = {}  # store_name → {match, mismatch_selling, mismatch_stopped}

        # 상세 불일치 카테고리
        oc_selling_ss_not = []   # 오너클랜 판매중 ↔ SS 판매중지/품절
        oc_stopped_ss_sale = []  # 오너클랜 품절/단종 ↔ SS 판매중

        for p in products:
            wcode = p['seller_management_code']
            ss_status = p['status_type']
            oc_status = p['master_sale_status']
            mismatch = p['status_mismatch']
            store = p['store_name'] or ''

            if store not in store_summary:
                store_summary[store] = {'total': 0, 'match': 0, 'oc_sell_ss_not': 0, 'oc_stop_ss_sell': 0}
            store_summary[store]['total'] += 1

            if oc_status is None or oc_status == 0:
                # 오너클랜에 매칭 안 됨 (master_sale_status가 갱신되지 않은 상품)
                _inc('errors')
                _inc('checked')
                continue

            if not mismatch:
                _inc('match')
                store_summary[store]['match'] += 1
            else:
                _inc('mismatch')
                oc_label = REVERSE_STATUS.get(oc_status, str(oc_status))

                if oc_status == 1 and ss_status != 'SALE':
                    # 오너클랜 판매중인데 SS는 판매중이 아님
                    oc_selling_ss_not.append({
                        'wcode': wcode, 'ss': ss_status,
                        'name': (p['name'] or '')[:40], 'store': store,
                    })
                    store_summary[store]['oc_sell_ss_not'] += 1
                elif oc_status in (2, 3) and ss_status == 'SALE':
                    # 오너클랜 품절/단종인데 SS는 판매중
                    oc_stopped_ss_sale.append({
                        'wcode': wcode, 'oc': oc_label,
                        'name': (p['name'] or '')[:40], 'store': store,
                    })
                    store_summary[store]['oc_stop_ss_sell'] += 1

                changes.append((
                    audit_log_id, p['origin_product_no'], wcode,
                    store, ss_status, oc_label, 'mismatch', ss_status,
                    f'OC={oc_label} SS={ss_status}'
                ))

            _inc('checked')

        # 5) 불일치 건 DB 일괄 기록
        if changes and audit_log_id:
            _add_log(f'불일치 {len(changes):,}건 DB 기록 중...')
            with connections['myproduct'].cursor() as cur:
                batch_size = 1000
                for i in range(0, len(changes), batch_size):
                    chunk = changes[i:i + batch_size]
                    vals = ','.join(['(%s,%s,%s,%s,%s,%s,%s,%s,%s)'] * len(chunk))
                    params = []
                    for c in chunk:
                        params.extend(c)
                    cur.execute(
                        f"INSERT INTO product_audit_change "
                        f"(audit_log_id, origin_product_no, seller_management_code, "
                        f"store_name, db_status, api_status, action, new_status, error_detail) "
                        f"VALUES {vals}",
                        params
                    )

        # 6) audit_log 업데이트
        elapsed = (datetime.now() - now).total_seconds()
        with _state_lock:
            st = dict(_audit_state)

        by_store_json = json.dumps(
            {k: v for k, v in store_summary.items() if v.get('oc_sell_ss_not') or v.get('oc_stop_ss_sell')},
            ensure_ascii=False
        )

        if audit_log_id:
            try:
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "UPDATE product_audit_log SET "
                        "completed_at=%s, checked=%s, match_count=%s, mismatch_count=%s, "
                        "fixed_count=%s, api_error_count=%s, closed_count=%s, "
                        "by_api_key=%s, elapsed_sec=%s WHERE id=%s",
                        [datetime.now(), st['checked'], st['match'], st['mismatch'],
                         0, st['errors'], 0,
                         by_store_json, round(elapsed, 1), audit_log_id]
                    )
            except Exception as e:
                _add_log(f'로그 업데이트 실패: {e}')

        _add_log(f'비교 완료: {st["checked"]:,}건 확인, '
                 f'일치 {st["match"]:,}, 불일치 {st["mismatch"]:,}, '
                 f'에러 {st["errors"]:,} ({round(elapsed, 1)}초)')

        # 7) 텔레그램 리포트
        try:
            report = _build_ownerclan_report(
                st, elapsed, no_wcode_count, store_summary,
                oc_selling_ss_not, oc_stopped_ss_sale
            )
            _send_telegram(report)
            _add_log('텔레그램 리포트 전송 완료')
        except Exception as e:
            _add_log(f'텔레그램 전송 실패: {e}')

    except Exception as e:
        logger.exception('[OC_AUDIT] 치명적 오류')
        _add_log(f'치명적 오류: {e}')
    finally:
        with _state_lock:
            _audit_state['running'] = False


def _build_ownerclan_report(st, elapsed, no_wcode, store_summary,
                            oc_selling_ss_not, oc_stopped_ss_sale):
    """오너클랜 비교 결과 텔레그램 HTML 리포트."""
    sec = round(elapsed, 1)

    lines = [
        '<b>오너클랜 ↔ 스마트스토어 상태 비교</b>',
        '',
        f'검증: {st["checked"]:,}개 / {sec}초',
        f'일치: {st["match"]:,}  |  불일치: {st["mismatch"]:,}',
    ]

    if st['checked'] > 0:
        rate = st['mismatch'] / st['checked'] * 100
        lines.append(f'불일치율: {rate:.1f}%')

    if no_wcode:
        lines.append(f'W코드 없음 (제외): {no_wcode:,}개')

    # 핵심: 두 가지 불일치 유형
    if oc_selling_ss_not:
        lines.append('')
        lines.append(f'<b>OC 판매중 → SS 비판매: {len(oc_selling_ss_not)}건</b>')
        for item in oc_selling_ss_not[:15]:
            lines.append(f'  {item["wcode"]} [{item["ss"]}] {item["name"]}')
        if len(oc_selling_ss_not) > 15:
            lines.append(f'  ... 외 {len(oc_selling_ss_not) - 15}건')

    if oc_stopped_ss_sale:
        lines.append('')
        lines.append(f'<b>OC 품절/단종 → SS 판매중: {len(oc_stopped_ss_sale)}건</b>')
        for item in oc_stopped_ss_sale[:15]:
            lines.append(f'  {item["wcode"]} [{item["oc"]}] {item["name"]}')
        if len(oc_stopped_ss_sale) > 15:
            lines.append(f'  ... 외 {len(oc_stopped_ss_sale) - 15}건')

    # 스토어별 불일치 요약
    problem_stores = {k: v for k, v in store_summary.items()
                      if v.get('oc_sell_ss_not') or v.get('oc_stop_ss_sell')}
    if problem_stores:
        lines.append('')
        lines.append('<b>스토어별 불일치</b>')
        for s, v in sorted(problem_stores.items(),
                           key=lambda x: -(x[1].get('oc_sell_ss_not', 0) + x[1].get('oc_stop_ss_sell', 0))):
            parts = []
            if v['oc_sell_ss_not']: parts.append(f'OC판매→SS중지 {v["oc_sell_ss_not"]}')
            if v['oc_stop_ss_sell']: parts.append(f'OC품절→SS판매 {v["oc_stop_ss_sell"]}')
            lines.append(f'  {s}: {", ".join(parts)}')

    lines.append('')
    lines.append(f'{datetime.now().strftime("%Y-%m-%d %H:%M")}')

    return '\n'.join(lines)


# ── API 검증 (내부 실행) ──

def _run_audit(source):
    """메인 검증 로직 (백그라운드 스레드)."""
    import requests as req_lib  # noqa: F811

    try:
        _add_log('전상품 목록 조회 중...')

        # 1) 전체 상품 + 상점 정보 조회 (CLOSE 제외)
        with connections['myproduct'].cursor() as cur:
            cur.execute('''
                SELECT p.id, p.origin_product_no, p.status_type,
                       p.seller_management_code, p.store_id,
                       s.store_name, s.commerce_api_key, s.commerce_secret_key
                FROM smartstore_product p
                JOIN smartstoreIdList s ON s.id = p.store_id
                WHERE p.status_type != 'CLOSE'
                  AND s.commerce_api_key IS NOT NULL
                  AND s.commerce_api_key != ''
            ''')
            all_products = _dictfetchall(cur)

        total = len(all_products)
        with _state_lock:
            _audit_state['total'] = total

        _add_log(f'검증 대상: {total:,}개 상품')

        # 2) API 키별 그룹핑
        api_groups = {}
        for p in all_products:
            key = p['commerce_api_key']
            if key not in api_groups:
                api_groups[key] = {
                    'secret_key': p['commerce_secret_key'],
                    'products': [],
                }
            api_groups[key]['products'].append(p)

        _add_log(f'API 키 그룹: {len(api_groups)}개')

        # 3) 세션 로그 생성
        now = datetime.now()
        audit_log_id = 0
        try:
            with connections['myproduct'].cursor() as cur:
                cur.execute(
                    "INSERT INTO product_audit_log "
                    "(started_at, source, total_target) VALUES (%s, %s, %s)",
                    [now, source, total]
                )
                audit_log_id = cur.lastrowid
            with _state_lock:
                _audit_state['audit_log_id'] = audit_log_id
        except Exception as e:
            _add_log(f'세션 로그 생성 실패: {e}')

        # 4) API 키별 병렬 실행
        all_changes = []
        api_key_results = {}
        max_workers = min(24, len(api_groups))

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {}
            for api_key, group in api_groups.items():
                f = pool.submit(
                    _audit_api_key_batch,
                    api_key, group['secret_key'], group['products'], audit_log_id
                )
                futures[f] = api_key

            for future in as_completed(futures):
                api_key = futures[future]
                try:
                    result = future.result()
                    all_changes.extend(result['changes'])
                    api_key_results[api_key[:8] + '...'] = {
                        'total': result['total'],
                        'match': result['match'],
                        'mismatch': result['mismatch'],
                        'closed': result['closed'],
                        'errors': result['errors'],
                    }
                except Exception as e:
                    _add_log(f'API키 {api_key[:8]}... 스레드 에러: {e}')

        # 5) 세션 로그 업데이트
        elapsed = (datetime.now() - now).total_seconds()
        with _state_lock:
            st = dict(_audit_state)

        if audit_log_id:
            try:
                errors_json = None
                error_changes = [c for c in all_changes if c.get('action') == 'error']
                if error_changes:
                    errors_json = json.dumps(
                        [{'wcode': c.get('seller_management_code', ''), 'err': c.get('error_detail', '')}
                         for c in error_changes[:50]],
                        ensure_ascii=False
                    )
                by_api_json = json.dumps(api_key_results, ensure_ascii=False)
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "UPDATE product_audit_log SET "
                        "completed_at=%s, checked=%s, match_count=%s, mismatch_count=%s, "
                        "fixed_count=%s, api_error_count=%s, closed_count=%s, "
                        "by_api_key=%s, errors=%s, elapsed_sec=%s WHERE id=%s",
                        [datetime.now(), st['checked'], st['match'], st['mismatch'],
                         st['fixed'], st['errors'], st['closed'],
                         by_api_json, errors_json, round(elapsed, 1), audit_log_id]
                    )
            except Exception as e:
                _add_log(f'세션 로그 업데이트 실패: {e}')

        _add_log(f'검증 완료: {st["checked"]:,}건 확인, '
                 f'일치 {st["match"]:,}, 불일치 {st["mismatch"]:,}, '
                 f'CLOSE {st["closed"]:,}, 에러 {st["errors"]:,}, '
                 f'수정 {st["fixed"]:,} ({round(elapsed, 1)}초)')

        # 텔레그램 리포트 전송
        try:
            report = _build_audit_report(st, elapsed, api_key_results)
            _send_telegram(report)
            _add_log('텔레그램 리포트 전송 완료')
        except Exception as e:
            _add_log(f'텔레그램 전송 실패: {e}')

    except Exception as e:
        logger.exception('[AUDIT] 치명적 오류')
        _add_log(f'치명적 오류: {e}')
    finally:
        with _state_lock:
            _audit_state['running'] = False


def _audit_api_key_batch(api_key, secret_key, products, audit_log_id):
    """단일 API 키의 상품들을 검증하는 스레드 워커."""
    import requests

    result = {'total': len(products), 'match': 0, 'mismatch': 0,
              'closed': 0, 'errors': 0, 'changes': []}

    short_key = api_key[:8] + '...'
    with _state_lock:
        _audit_state['current_api_key'] = short_key
    _add_log(f'[{short_key}] 시작: {len(products):,}개')

    # 토큰 발급
    try:
        token = _get_access_token(api_key, secret_key)
    except Exception as e:
        _add_log(f'[{short_key}] 토큰 실패: {e}')
        for p in products:
            _inc('errors')
            _inc('checked')
            result['errors'] += 1
            result['changes'].append({
                'origin_product_no': p['origin_product_no'],
                'seller_management_code': p.get('seller_management_code', ''),
                'store_name': p.get('store_name', ''),
                'db_status': p['status_type'],
                'api_status': None,
                'action': 'error',
                'new_status': p['status_type'],
                'error_detail': f'토큰실패: {e}',
            })
        return result

    headers = {'Authorization': f'Bearer {token}'}
    batch_count = 0

    for p in products:
        # 중지 체크
        with _state_lock:
            if _audit_state['stop_flag']:
                _add_log(f'[{short_key}] 중지됨 ({batch_count}/{len(products)})')
                break

        opno = p['origin_product_no']
        db_status = p['status_type']
        url = f'https://api.commerce.naver.com/external/v2/products/origin-products/{opno}'

        api_status = None
        action = 'match'
        new_status = db_status
        error_detail = None

        for attempt in range(4):
            try:
                resp = requests.get(url, headers=headers, timeout=15)

                if resp.status_code == 200:
                    data = resp.json()
                    origin = data.get('originProduct', {})
                    api_status = origin.get('statusType', '')

                    if db_status == api_status:
                        action = 'match'
                        _inc('match')
                        result['match'] += 1
                    else:
                        # 불일치 → DB를 API 상태로 수정
                        action = 'fixed'
                        new_status = api_status
                        try:
                            with connections['myproduct'].cursor() as cur:
                                cur.execute(
                                    "UPDATE smartstore_product SET status_type=%s WHERE id=%s",
                                    [api_status, p['id']]
                                )
                            _inc('fixed')
                            result['mismatch'] += 1
                        except Exception as e2:
                            action = 'error'
                            error_detail = f'DB수정실패: {e2}'
                            _inc('errors')
                            result['errors'] += 1
                        _inc('mismatch')
                    break

                elif resp.status_code in (404, 403):
                    # 삭제된 상품
                    api_status = f'HTTP_{resp.status_code}'
                    action = 'closed'
                    new_status = 'CLOSE'
                    try:
                        with connections['myproduct'].cursor() as cur:
                            cur.execute(
                                "UPDATE smartstore_product SET status_type='CLOSE' WHERE id=%s",
                                [p['id']]
                            )
                        _inc('closed')
                        _inc('fixed')
                        result['closed'] += 1
                    except Exception as e2:
                        action = 'error'
                        error_detail = f'CLOSE 처리실패: {e2}'
                        _inc('errors')
                        result['errors'] += 1
                    break

                elif resp.status_code == 429:
                    wait = max(int(resp.headers.get('Retry-After', 10)), 5 * (attempt + 1))
                    _add_log(f'[{short_key}] 429 rate limit, {wait}초 대기 (시도 {attempt+1}/4)')
                    time.sleep(wait)
                    # 토큰 갱신
                    try:
                        token = _get_access_token(api_key, secret_key)
                        headers = {'Authorization': f'Bearer {token}'}
                    except Exception:
                        pass
                    continue

                elif resp.status_code == 401:
                    # 토큰 만료 → 갱신
                    try:
                        token = _get_access_token(api_key, secret_key)
                        headers = {'Authorization': f'Bearer {token}'}
                    except Exception:
                        pass
                    time.sleep(1)
                    continue

                else:
                    api_status = f'HTTP_{resp.status_code}'
                    action = 'error'
                    error_detail = f'HTTP {resp.status_code}'
                    _inc('errors')
                    result['errors'] += 1
                    break

            except requests.exceptions.Timeout:
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                action = 'error'
                error_detail = 'timeout (4회)'
                _inc('errors')
                result['errors'] += 1
                break
            except Exception as e:
                action = 'error'
                error_detail = str(e)[:200]
                _inc('errors')
                result['errors'] += 1
                break
        else:
            # 4회 모두 429
            action = 'error'
            error_detail = '429 rate limit (4회 실패)'
            _inc('errors')
            result['errors'] += 1

        _inc('checked')
        batch_count += 1

        # 불일치/에러 건만 DB에 기록 (match는 건수만 카운트)
        if action != 'match' and audit_log_id:
            try:
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "INSERT INTO product_audit_change "
                        "(audit_log_id, origin_product_no, seller_management_code, "
                        "store_name, db_status, api_status, action, new_status, error_detail) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        [audit_log_id, opno, p.get('seller_management_code', ''),
                         p.get('store_name', ''), db_status, api_status,
                         action, new_status, error_detail]
                    )
            except Exception:
                pass

        # 로그: 500건마다 or 불일치 건
        if batch_count % 500 == 0:
            _add_log(f'[{short_key}] {batch_count:,}/{len(products):,} 진행')
        elif action in ('fixed', 'closed'):
            wcode = p.get('seller_management_code', str(opno))
            _add_log(f'[{short_key}] {wcode}: {db_status} → {new_status} ({action})')

        time.sleep(0.3)

    _add_log(f'[{short_key}] 완료: {batch_count:,}건 (일치 {result["match"]}, '
             f'불일치 {result["mismatch"]}, CLOSE {result["closed"]}, 에러 {result["errors"]})')
    return result
