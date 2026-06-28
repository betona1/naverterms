"""상품등록정보검토(memopan iframe) 수집기.

셀러센터 #/product/product-diagnosis → in-app.memopan.io 아이프레임 DOM 스크래핑.
테이블 5칸: 상품(명+카테고리+썸네일) | 브랜드 | 제조사 | 속성 | 태그.
각 셀 = 값 또는 '미등록'(+수정버튼). 페이지네이션 순회하여 전체 수집 → naver_product_diagnosis.
"""
from __future__ import annotations

import re
import time
import threading
import traceback
from datetime import datetime

from django.db import connections

from . import store_collector as sc

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'
DIAG_URL = 'https://sell.smartstore.naver.com/#/product/product-diagnosis'

_state = {'running': False, 'login': None, 'store': None, 'collected': 0, 'log': [], 'done': False}
_lock = threading.Lock()


def get_status() -> dict:
    with _lock:
        return dict(_state, log=_state['log'][-30:])


def _log(msg: str):
    with _lock:
        _state['log'].append('%s %s' % (datetime.now().strftime('%H:%M:%S'), msg))
    print('[diagnosis]', msg, flush=True)


def _strip_btn(text: str) -> str:
    """셀 텍스트에서 말미 '수정' 버튼 라벨 제거."""
    return re.sub(r'\s*수정\s*$', '', (text or '').strip()).strip()


def _enter_iframe(drv) -> bool:
    """memopan 진단 아이프레임 진입."""
    for f in drv.find_elements('tag name', 'iframe'):
        if 'memopan' in (f.get_attribute('src') or ''):
            drv.switch_to.frame(f)
            return True
    return False


def _parse_page(drv, page_no: int) -> list[dict]:
    rows = drv.find_elements('css selector', 'tbody tr')
    out = []
    for r in rows:
        tds = r.find_elements('css selector', 'td')
        if len(tds) < 5:
            continue
        t0 = [x for x in tds[0].text.strip().split('\n') if x.strip()]
        name = t0[0] if t0 else ''
        cat = ''
        for line in t0[1:]:
            if line.strip() != '수정':
                cat = line.strip(); break
        thumb = ''
        try:
            thumb = tds[0].find_element('css selector', 'img').get_attribute('src') or ''
        except Exception:
            pass
        brand = _strip_btn(tds[1].text)
        mfr = _strip_btn(tds[2].text)
        attr = _strip_btn(tds[3].text)
        tag = _strip_btn(tds[4].text)
        if not name:
            continue
        out.append({
            'name': name, 'cat': cat, 'thumb': thumb, 'page_no': page_no,
            'brand_value': None if brand == '미등록' else brand[:200],
            'brand_missing': 1 if brand == '미등록' else 0,
            'mfr_value': None if mfr == '미등록' else mfr[:200],
            'mfr_missing': 1 if mfr == '미등록' else 0,
            'attr_value': None if attr == '미등록' else attr[:1000],
            'attr_missing': 1 if attr in ('미등록', '-', '') else 0,
            'tag_missing': 1 if tag == '미등록' else 0,
        })
    return out


def _click_page(drv, target: int) -> bool:
    """페이지네이션에서 target 번호 버튼 클릭. 없으면 False."""
    try:
        els = drv.find_elements('css selector', "[class*=Pagination] button, [class*=pagination] button")
        for e in els:
            if e.text.strip() == str(target):
                drv.execute_script('arguments[0].click();', e)
                return True
    except Exception:
        pass
    return False


def _enter_iframe_wait(drv, timeout: float = 40) -> bool:
    """memopan 아이프레임 출현까지 폴링 후 진입."""
    end = time.time() + timeout
    while time.time() < end:
        if _enter_iframe(drv):
            return True
        time.sleep(2)
    return False


def _wait_rows(drv, timeout: float = 30) -> int:
    """아이프레임 내 tbody tr 행이 나타날 때까지 폴링."""
    end = time.time() + timeout
    while time.time() < end:
        n = len(drv.find_elements('css selector', 'tbody tr'))
        if n > 0:
            return n
        time.sleep(2)
    return 0


def _collect_diagnosis(drv) -> list[dict]:
    """진단 페이지 진입 + 전 페이지 순회 수집 (이름 기준 dedup). 로딩 폴링+재시도."""
    for attempt in range(3):
        drv.switch_to.default_content()
        drv.get(DIAG_URL)
        time.sleep(6)
        if not _enter_iframe_wait(drv, timeout=40):
            _log('memopan iframe 없음 (시도%d)' % (attempt + 1))
            continue
        if _wait_rows(drv, timeout=30) > 0:
            break
        _log('테이블 행 0 (시도%d) — 재시도' % (attempt + 1))
        drv.switch_to.default_content()
    else:
        return []
    seen = set()
    rows = []
    page = 1
    while page <= 25:
        page_rows = _parse_page(drv, page)
        new = [r for r in page_rows if r['name'] not in seen]
        for r in new:
            seen.add(r['name'])
        rows.extend(new)
        _log('page %d: +%d (누적 %d)' % (page, len(new), len(rows)))
        if not new and page > 1:
            break
        if not _click_page(drv, page + 1):
            break
        page += 1
        time.sleep(2.5)
    drv.switch_to.default_content()
    return rows


def _match_wcodes(store_id: int, rows: list[dict]):
    """상품명 → smartstore_product.seller_management_code 매칭."""
    names = [r['name'] for r in rows]
    name2code = {}
    with connections[MYPRODUCT_DB].cursor() as cur:
        for i in range(0, len(names), 300):
            chunk = names[i:i + 300]
            ph = ','.join(['%s'] * len(chunk))
            cur.execute(
                f"SELECT name, seller_management_code FROM smartstore_product "
                f"WHERE store_id=%s AND name IN ({ph})", [store_id] + chunk)
            for nm, code in cur.fetchall():
                name2code[nm] = code
    for r in rows:
        r['wcode'] = name2code.get(r['name'])


def _save(store_id: int, login_id: str, store_name: str, rows: list[dict]) -> int:
    with connections[NAVERDB].cursor() as cur:
        cur.execute("DELETE FROM naver_product_diagnosis WHERE store_id=%s", [store_id])
        n = 0
        for r in rows:
            cur.execute(
                """INSERT INTO naver_product_diagnosis
                   (store_id, login_id, store_name, product_name, category_text, thumbnail,
                    seller_management_code, brand_value, brand_missing, mfr_value, mfr_missing,
                    attr_value, attr_missing, tag_missing, page_no)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON DUPLICATE KEY UPDATE
                    category_text=VALUES(category_text), thumbnail=VALUES(thumbnail),
                    seller_management_code=VALUES(seller_management_code),
                    brand_value=VALUES(brand_value), brand_missing=VALUES(brand_missing),
                    mfr_value=VALUES(mfr_value), mfr_missing=VALUES(mfr_missing),
                    attr_value=VALUES(attr_value), attr_missing=VALUES(attr_missing),
                    tag_missing=VALUES(tag_missing), page_no=VALUES(page_no), captured_at=NOW()""",
                [store_id, login_id, store_name, r['name'][:500], r['cat'][:400], (r['thumb'] or '')[:500],
                 r.get('wcode'), r['brand_value'], r['brand_missing'], r['mfr_value'], r['mfr_missing'],
                 r['attr_value'], r['attr_missing'], r['tag_missing'], r['page_no']])
            n += 1
    return n


def collect_login(login_id: str, password: str, store_names: list[str],
                  store_pk_map: dict) -> dict:
    """1 로그인 → 등록된 스토어들 진단 수집."""
    sc._ensure_display()
    disp = sc._get_display_env()
    drv = sc._create_driver('/tmp/diag_dl')
    drv.implicitly_wait(4)
    total = 0
    try:
        sc._login(drv, login_id, password, disp)
        time.sleep(4)
        try: sc._close_popups(drv)
        except Exception: pass
        for sname in store_names:
            with _lock:
                _state['store'] = sname
            try:
                if len(store_names) > 1:
                    sc._switch_store(drv, sname)
                    time.sleep(3)
                rows = _collect_diagnosis(drv)
                sid = store_pk_map.get(sname)
                if sid and rows:
                    _match_wcodes(sid, rows)
                    saved = _save(sid, login_id, sname, rows)
                    total += saved
                    with _lock:
                        _state['collected'] += saved
                    _log('%s 저장 %d건' % (sname, saved))
            except Exception as e:
                _log('%s 실패: %s' % (sname, str(e)[:120]))
    finally:
        sc._safe_quit_driver(drv)
    return {'login_id': login_id, 'total': total}


def _worker(login_ids):
    try:
        with connections[MYPRODUCT_DB].cursor() as cur:
            if login_ids:
                ph = ','.join(['%s'] * len(login_ids))
                cur.execute(f"SELECT id, store_id, store_pw, store_name FROM smartstoreIdList WHERE id IN ({ph})", login_ids)
            else:
                cur.execute("SELECT id, store_id, store_pw, store_name FROM smartstoreIdList WHERE store_pw<>''")
            rows = cur.fetchall()
        groups: dict = {}
        pkmap: dict = {}
        for pk, lid, pw, nm in rows:
            groups.setdefault(lid, {'pw': pw, 'stores': []})
            if nm:
                groups[lid]['stores'].append(nm); pkmap[nm] = pk
        with _lock:
            _state.update(running=True, done=False, collected=0, log=[], total_logins=len(groups))
        for lid, g in groups.items():
            with _lock:
                _state['login'] = lid
            _log('로그인 %s (스토어 %d)' % (lid, len(g['stores'])))
            collect_login(lid, g['pw'], g['stores'], pkmap)
    except Exception:
        _log('worker 예외: ' + traceback.format_exc()[:300])
    finally:
        with _lock:
            _state['running'] = False; _state['done'] = True
        _log('=== 수집 완료 ===')


def start(login_ids: list[int] | None = None) -> dict:
    with _lock:
        if _state['running']:
            return {'ok': False, 'error': '이미 수집 중'}
    t = threading.Thread(target=_worker, args=(login_ids,), daemon=True)
    t.start()
    return {'ok': True, 'started': True}


def dispatch_parallel(login_ids: list[str] | None = None, concurrency: int = 5) -> dict:
    """아이디별 워커 프로세스를 병렬(동시 N개)로 띄워 진단 수집.

    login_ids: smartstoreIdList.store_id(이메일) 목록. None=전체 활성.
    각 워커는 독립 Xvfb로 실행되어 충돌 없음.
    """
    import os
    import subprocess

    with connections[MYPRODUCT_DB].cursor() as cur:
        if login_ids:
            ph = ','.join(['%s'] * len(login_ids))
            cur.execute(f"SELECT DISTINCT store_id FROM smartstoreIdList WHERE store_pw<>'' AND store_id IN ({ph})", login_ids)
        else:
            cur.execute("SELECT DISTINCT store_id FROM smartstoreIdList WHERE store_pw<>'' AND store_id IS NOT NULL")
        logins = [r[0] for r in cur.fetchall()]

    if not logins:
        return {'ok': False, 'error': '대상 로그인 없음'}

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    worker = os.path.join(here, 'diagnosis_worker.py')

    def _launcher():
        import time as _t
        running = []
        queue = list(logins)
        while queue or running:
            running = [p for p in running if p.poll() is None]
            while queue and len(running) < concurrency:
                lid = queue.pop(0)
                p = subprocess.Popen(['python3', worker, lid], cwd=here,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                running.append(p)
                _log(f'워커 시작 {lid} (동시 {len(running)})')
                _t.sleep(2)
            _t.sleep(5)
        _log('=== 전체 워커 디스패치 완료 ===')

    threading.Thread(target=_launcher, daemon=True).start()
    return {'ok': True, 'dispatched': len(logins), 'concurrency': concurrency, 'logins': logins}


def sync_status() -> dict:
    """진단 수집 워커 상태 (worker_status 테이블 기반) + 스토어별 수집 현황."""
    workers = []
    try:
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                "SELECT worker_key, worker_name, status, last_log_line, last_heartbeat_at "
                "FROM crawl_worker_status WHERE worker_type='diagnosis' ORDER BY updated_at DESC")
            cols = [d[0] for d in cur.description]
            workers = [dict(zip(cols, r)) for r in cur.fetchall()]
    except Exception:
        pass
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT COUNT(DISTINCT store_id), COUNT(*) FROM naver_product_diagnosis")
        stores, items = cur.fetchone()
    return {'workers': workers, 'stores_collected': stores or 0, 'items_total': items or 0}


def get_results(store_id: int) -> dict:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT product_name, category_text, thumbnail, seller_management_code, "
            "brand_value, brand_missing, mfr_value, mfr_missing, attr_value, attr_missing, tag_missing "
            "FROM naver_product_diagnosis WHERE store_id=%s ORDER BY id", [int(store_id)])
        cols = [d[0] for d in cur.description]
        items = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.execute(
            "SELECT COUNT(*), SUM(brand_missing), SUM(mfr_missing), SUM(attr_missing), SUM(tag_missing) "
            "FROM naver_product_diagnosis WHERE store_id=%s", [int(store_id)])
        tot, b, m, a, t = cur.fetchone()
    return {'items': items, 'total': tot or 0,
            'brand_missing': int(b or 0), 'mfr_missing': int(m or 0),
            'attr_missing': int(a or 0), 'tag_missing': int(t or 0)}
