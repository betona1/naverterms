"""스마트스토어 셀러 정책(상품등록한도) 스냅샷 수집기 — 내부 API 직접 호출 방식.

데이터 출처 (DOM 스크래핑 폐기):
  GET https://sell.smartstore.naver.com/api/v1/sellers/policy/product-limit
  {
    "saleLimitProductCount": 1000,      # 현재 상품등록한도 (네이버 확정값)
    "appliedYmd": "20260602",           # 적용일 (6/2 신정책)
    "dailyStat": {
      "standardYmd": "20260602",
      "productCount90dAvg": 413,        # 90일 평균 등록상품수
      "saleProductCount400d": 4,        # 400일 판매상품수
      "saleActiveRatio": 1.0            # 판매상품비중(일)
    },
    "monthlySaleActiveRatio": 0.9,      # 이번달 판매상품비중
    "cumulationSaleAmount": 575500,     # 누적 거래액
    "cumulationSaleCount": 12           # 누적 판매건수
  }

흐름:
  1. store_collector 의 Xvfb/driver/_login/_switch_store 재사용
  2. 로그인 → (스토어 전환) → execute_async_script 로 위 API fetch (세션 쿠키 자동 첨부)
  3. _save_snapshot → myproduct.smartstore_seller_policy_snapshot UPSERT

PoC:
  from smartstore.naver_store_policy_service import run_poc_joacham
  run_poc_joacham()        # joacham 첫 스토어만 API 호출 + DB INSERT

전체:
  from smartstore.naver_store_policy_service import start_collect
  start_collect()          # 전체 로그인 × 모든 스토어 백그라운드 순회
"""
from __future__ import annotations

import json
import re
import threading
import time
import traceback
from datetime import datetime, date

from django.db import connections

# store_collector 의 Xvfb/driver/로그인/스토어 전환 재사용
from . import store_collector as sc

SELLER_BASE = 'https://sell.smartstore.naver.com/'
PRODUCT_LIMIT_API = '/api/v1/sellers/policy/product-limit'
TABLE = 'smartstore_seller_policy_snapshot'

# 신규 컬럼 (없으면 ALTER ADD) — 실제 API 필드 저장용
_NEW_COLUMNS = {
    'store_pk': 'INT DEFAULT NULL',                       # smartstoreIdList.id (분석 조인용)
    'sale_limit_count': 'INT DEFAULT NULL',               # saleLimitProductCount
    'applied_ymd': 'VARCHAR(8) DEFAULT NULL',             # appliedYmd
    'product_count_90d_avg': 'INT DEFAULT NULL',          # dailyStat.productCount90dAvg
    'sale_product_count_400d': 'INT DEFAULT NULL',        # dailyStat.saleProductCount400d
    'sale_active_ratio': 'DECIMAL(8,4) DEFAULT NULL',     # dailyStat.saleActiveRatio
    'monthly_sale_active_ratio': 'DECIMAL(8,4) DEFAULT NULL',  # monthlySaleActiveRatio
    'cumulation_sale_amount': 'BIGINT DEFAULT NULL',      # cumulationSaleAmount
    'cumulation_sale_count': 'INT DEFAULT NULL',          # cumulationSaleCount
    'api_status': 'INT DEFAULT NULL',                     # HTTP status
}

_state = {
    'running': False,
    'login_idx': 0,
    'store_idx': 0,
    'total_logins': 0,
    'current_login': None,
    'current_store': None,
    'phase': 'idle',
    'logs': [],
    'last_result': None,
    'error': None,
}
_lock = threading.Lock()


def _log(msg: str) -> None:
    ts = datetime.now().strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    with _lock:
        _state['logs'].append(line)
        if len(_state['logs']) > 500:
            _state['logs'] = _state['logs'][-300:]


# ── DB ───────────────────────────────────────────────────────────────

def _ensure_table() -> None:
    """테이블 보장 + 신규 컬럼 ALTER ADD (idempotent)."""
    with connections['myproduct'].cursor() as cur:
        cur.execute(f"SHOW TABLES LIKE '{TABLE}'")
        if not cur.fetchone():
            cur.execute(f"""
                CREATE TABLE {TABLE} (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    account_id BIGINT NOT NULL,
                    login_id VARCHAR(100) NOT NULL,
                    store_name VARCHAR(200) DEFAULT NULL,
                    captured_date DATE NOT NULL,
                    captured_at DATETIME NOT NULL,
                    parsed_json LONGTEXT DEFAULT NULL,
                    error VARCHAR(500) DEFAULT NULL,
                    UNIQUE KEY uk_account_store_date (account_id, store_name, captured_date),
                    KEY ix_captured (captured_date),
                    KEY ix_login (login_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            _log(f'테이블 생성: {TABLE}')

        cur.execute(f"SHOW COLUMNS FROM {TABLE}")
        existing = {r[0] for r in cur.fetchall()}
        for col, ddl in _NEW_COLUMNS.items():
            if col not in existing:
                cur.execute(f"ALTER TABLE {TABLE} ADD COLUMN {col} {ddl}")
                _log(f'컬럼 추가: {col}')


def _resolve_store_pk(login_id: str, store_name: str | None) -> int | None:
    """store_name → smartstoreIdList.id (분석 페이지 store_id 조인용)."""
    with connections['myproduct'].cursor() as cur:
        if store_name:
            cur.execute(
                "SELECT id FROM smartstoreIdList WHERE store_id=%s AND store_name=%s LIMIT 1",
                [login_id, store_name],
            )
            row = cur.fetchone()
            if row:
                return row[0]
            # 퍼지: 끝자리 숫자 무시 (네이버 조아마미1 == DB 조아마미)
            norm = re.sub(r'\d+$', '', store_name.strip())
            cur.execute(
                "SELECT id, store_name FROM smartstoreIdList WHERE store_id=%s", [login_id])
            for sid, nm in cur.fetchall():
                if nm and re.sub(r'\d+$', '', nm.strip()) == norm:
                    return sid
        # 단일 스토어 계정 — store_name 미상이면 login_id 로 단일 행 매칭
        cur.execute(
            "SELECT id FROM smartstoreIdList WHERE store_id=%s LIMIT 2", [login_id])
        rows = cur.fetchall()
        if len(rows) == 1:
            return rows[0][0]
    return None


def _save_snapshot(account_id: int, login_id: str, store_name: str | None,
                   store_pk: int | None, data: dict, api_status: int | None,
                   error: str | None = None) -> int:
    """UPSERT: 같은 account+store+날짜 면 갱신.
    단, 실패(데이터 없음)는 같은 날 기존 성공 행을 덮어쓰지 않는다."""
    now = datetime.now()
    today = date.today()
    if (data or {}).get('saleLimitProductCount') is None:
        with connections['myproduct'].cursor() as cur:
            cur.execute(
                f"SELECT id, sale_limit_count FROM {TABLE} "
                f"WHERE account_id=%s AND store_name=%s AND captured_date=%s",
                [account_id, store_name or '', today])
            row = cur.fetchone()
            if row and row[1] is not None:
                return row[0]   # 기존 성공 데이터 보존 (실패로 덮어쓰지 않음)
    daily = (data or {}).get('dailyStat') or {}
    payload = {
        'account_id': account_id,
        'login_id': login_id,
        'store_name': store_name or '',
        'store_pk': store_pk,
        'captured_date': today,
        'captured_at': now,
        'sale_limit_count': (data or {}).get('saleLimitProductCount'),
        'applied_ymd': (data or {}).get('appliedYmd'),
        'product_count_90d_avg': daily.get('productCount90dAvg'),
        'sale_product_count_400d': daily.get('saleProductCount400d'),
        'sale_active_ratio': daily.get('saleActiveRatio'),
        'monthly_sale_active_ratio': (data or {}).get('monthlySaleActiveRatio'),
        'cumulation_sale_amount': (data or {}).get('cumulationSaleAmount'),
        'cumulation_sale_count': (data or {}).get('cumulationSaleCount'),
        'api_status': api_status,
        'parsed_json': json.dumps(data, ensure_ascii=False) if data else None,
        'error': error,
    }
    cols = list(payload.keys())
    placeholders = ', '.join(['%s'] * len(cols))
    update_clause = ', '.join([f"{c}=VALUES({c})" for c in cols if c != 'account_id'])
    sql = (
        f"INSERT INTO {TABLE} ({', '.join(cols)}) "
        f"VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )
    with connections['myproduct'].cursor() as cur:
        cur.execute(sql, [payload[c] for c in cols])
        return cur.lastrowid or 0


# ── API 호출 ─────────────────────────────────────────────────────────

POLICY_PAGE = 'https://sell.smartstore.naver.com/#/seller/policy'

_FETCH_JS = """
const cb = arguments[arguments.length - 1];
fetch(arguments[0], {credentials: 'include', headers: {'accept': 'application/json'}})
  .then(r => r.text().then(t => cb(JSON.stringify({status: r.status, body: t}))))
  .catch(e => cb(JSON.stringify({status: -1, body: String(e)})));
"""


def _warmup(driver, wait: float = 5.0) -> None:
    """정책 페이지(#/seller/policy) 진입으로 SPA 세션/API 컨텍스트 확립.
    SPA 가 스스로 product-limit API 를 호출하며 셀러 세션을 준비한다."""
    try:
        driver.get(POLICY_PAGE)
        time.sleep(wait)
        # SPA 라우팅 보강
        try:
            if 'seller/policy' not in driver.current_url:
                driver.get(POLICY_PAGE)
                time.sleep(wait * 0.6)
        except Exception:
            pass
        try:
            sc._close_popups(driver)
        except Exception:
            pass
    except Exception:
        pass


def _fetch_product_limit(driver, attempts: int = 4,
                         rewarm: bool = True) -> tuple[dict | None, int | None, str | None]:
    """상품등록한도 API 호출. 401/빈응답 시 재워밍업 + 점증 백오프 재시도."""
    last_err = None
    last_status = None
    for k in range(attempts):
        try:
            driver.set_script_timeout(30)
            raw = driver.execute_async_script(_FETCH_JS, PRODUCT_LIMIT_API)
            env = json.loads(raw)
            last_status = env.get('status')
            body = (env.get('body') or '').strip()
            if last_status == 200 and body:
                try:
                    return json.loads(body), last_status, None
                except Exception as e:
                    last_err = f'JSONDecodeError: {e}; body={body[:80]}'
            elif last_status == 401:
                # 세션 미준비 — 정책 페이지 재진입으로 컨텍스트 재확립
                last_err = 'HTTP 401 (session not ready)'
                if rewarm and k < attempts - 1:
                    _warmup(driver, wait=5.0 + k * 1.5)
            else:
                last_err = f'HTTP {last_status}, empty/non-json body'
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'
        if k < attempts - 1:
            time.sleep(3.0 + k * 2.0)  # 점증 백오프 (3→5→7초)
    return None, last_status, last_err


# ── 컬렉터 ────────────────────────────────────────────────────────────

def _get_logins(login_ids: list[int] | None = None) -> list[dict]:
    """smartstoreIdList 에서 로그인 계정 목록 조회 (login_id 단위로 묶음)."""
    with connections['myproduct'].cursor() as cur:
        if login_ids:
            ph = ','.join(['%s'] * len(login_ids))
            cur.execute(
                f"SELECT id, store_id, store_pw, store_name FROM smartstoreIdList "
                f"WHERE id IN ({ph})", login_ids)
        else:
            cur.execute(
                "SELECT id, store_id, store_pw, store_name FROM smartstoreIdList "
                "WHERE store_pw IS NOT NULL AND store_pw<>''")
        rows = cur.fetchall()
    groups: dict[str, dict] = {}
    for pk, login_id, pw, name in rows:
        if login_id not in groups:
            groups[login_id] = {
                'account_id': pk, 'login_id': login_id,
                'password': pw, 'store_names': [],
            }
        if name:
            groups[login_id]['store_names'].append(name)
    return list(groups.values())


def _collect_for_login(driver, display_env, account: dict,
                       only_first_store: bool = False) -> list[dict]:
    """1 로그인 → 등록된 모든 스토어 상품등록한도 API 수집."""
    results: list[dict] = []
    login_id = account['login_id']
    pw = account['password']

    if not sc._login(driver, login_id, pw, display_env):
        _log(f'❌ 로그인 실패: {login_id}')
        return results

    time.sleep(2)
    try:
        sc._close_popups(driver)
    except Exception:
        pass
    # 셀러센터 origin 보장
    try:
        if 'sell.smartstore.naver.com' not in driver.current_url:
            driver.get(SELLER_BASE)
            time.sleep(3)
    except Exception:
        pass

    stores = sc._get_store_list(driver) or []
    _log(f'  스토어 {len(stores)}개 발견 (로그인={login_id})')

    single_store = not stores
    if single_store:
        target_list = [account['store_names'][0] if account['store_names'] else None]
        # 단일 스토어: 전환 워밍업이 없으므로 정책 페이지 진입으로 세션 확립
        _warmup(driver, wait=5.0)
    else:
        target_list = [name for (display, name) in stores]
        if only_first_store:
            target_list = target_list[:1]

    for i, store_name in enumerate(target_list):
        with _lock:
            _state['store_idx'] = i + 1
            _state['current_store'] = store_name
        if stores and store_name:
            if not sc._switch_store(driver, store_name):
                _log(f'  스토어 전환 실패: {store_name}')
                continue
            time.sleep(2)
            _warmup(driver, wait=3.5)   # 전환 후 정책 페이지 진입으로 세션 확립

        data, status, err = _fetch_product_limit(driver)
        store_pk = _resolve_store_pk(login_id, store_name)
        snap_id = _save_snapshot(account['account_id'], login_id, store_name,
                                 store_pk, data, status, error=err)
        if data:
            _log(f'  ✅ {login_id}/{store_name or "-"} (pk={store_pk}) → '
                 f'한도={data.get("saleLimitProductCount")} '
                 f'적용일={data.get("appliedYmd")} '
                 f'거래액={data.get("cumulationSaleAmount")} '
                 f'판매건={data.get("cumulationSaleCount")}')
        else:
            _log(f'  ❌ {login_id}/{store_name or "-"} API 실패: {err}')
        results.append({'store_name': store_name, 'store_pk': store_pk,
                        'data': data, 'snap_id': snap_id, 'error': err})

    return results


def run_poc_joacham(**_ignore) -> dict:
    """PoC: joacham 첫 스토어 1개 API 호출 + DB INSERT."""
    _ensure_table()
    accounts = _get_logins()
    target = next((a for a in accounts if a['login_id'] == 'joacham@nate.com'), None)
    if not target:
        return {'ok': False, 'error': 'joacham 계정 없음'}

    download_dir = '/tmp/naver_policy_chrome_dl'
    import os
    os.makedirs(download_dir, exist_ok=True)
    sc._ensure_display()
    display_env = sc._get_display_env()
    driver = sc._create_driver(download_dir)
    try:
        results = _collect_for_login(driver, display_env, target,
                                     only_first_store=True)
        return {'ok': True, 'login_id': target['login_id'], 'results': results}
    finally:
        sc._safe_quit_driver(driver)


def _collect_worker(login_ids: list[int] | None, concurrency: int = 1) -> None:
    import os
    from concurrent.futures import ThreadPoolExecutor, as_completed
    try:
        _ensure_table()
        accounts = _get_logins(login_ids)
        with _lock:
            _state['total_logins'] = len(accounts)
            _state['done_count'] = 0

        download_dir = '/tmp/naver_policy_chrome_dl'
        os.makedirs(download_dir, exist_ok=True)
        sc._ensure_display()
        display_env = sc._get_display_env()

        all_results: list[dict] = []
        results_lock = threading.Lock()

        def handle(acc: dict) -> None:
            with _lock:
                _state['current_login'] = acc['login_id']
                _state['phase'] = 'collecting'
            driver = sc._create_driver(download_dir)
            try:
                res = _collect_for_login(driver, display_env, acc,
                                         only_first_store=False)
                with results_lock:
                    all_results.append({'login_id': acc['login_id'], 'results': res})
            except Exception as e:
                _log(f'❌ {acc["login_id"]} 처리 중 예외: {e}')
                traceback.print_exc()
            finally:
                sc._safe_quit_driver(driver)
                with _lock:
                    _state['done_count'] += 1
                    _state['login_idx'] = _state['done_count']

        conc = max(1, min(concurrency, len(accounts) or 1))
        _log(f'수집 시작: {len(accounts)}개 로그인, 동시 {conc}개')
        if conc == 1:
            for acc in accounts:
                handle(acc)
        else:
            with ThreadPoolExecutor(max_workers=conc) as ex:
                futs = [ex.submit(handle, acc) for acc in accounts]
                for _f in as_completed(futs):
                    pass

        with _lock:
            _state['phase'] = 'done'
            _state['last_result'] = all_results
            _state['running'] = False
        _log('수집 완료')
    except Exception as e:
        with _lock:
            _state['phase'] = 'error'
            _state['error'] = str(e)
            _state['running'] = False
        traceback.print_exc()


def start_collect(login_ids: list[int] | None = None, concurrency: int = 1,
                  **_ignore) -> dict:
    """백그라운드 수집 시작. login_ids 미지정 시 전체. concurrency=동시 브라우저 수."""
    with _lock:
        if _state['running']:
            return {'ok': False, 'error': 'already_running',
                    'state': dict(_state, logs=_state['logs'][-20:])}
        _state.update({
            'running': True, 'phase': 'starting',
            'login_idx': 0, 'store_idx': 0, 'done_count': 0,
            'current_login': None, 'current_store': None,
            'logs': [], 'last_result': None, 'error': None,
        })
    t = threading.Thread(target=_collect_worker, args=(login_ids, concurrency),
                         daemon=True)
    t.start()
    return {'ok': True}


def get_status() -> dict:
    with _lock:
        return {
            'running': _state['running'],
            'phase': _state['phase'],
            'login_idx': _state['login_idx'],
            'total_logins': _state['total_logins'],
            'store_idx': _state['store_idx'],
            'current_login': _state['current_login'],
            'current_store': _state['current_store'],
            'logs': _state['logs'][-30:],
            'error': _state['error'],
        }
