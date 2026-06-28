"""스마트스토어 전체동기화(리콘실) 서비스 — 백그라운드 실행 + 진행추적 + 마켓ID별 리포트.

reconcile_smartstore.py(독립 스크립트)의 로직을 UI 에서 호출 가능한 서비스로 래핑.
스토어별: 네이버 API 전체 fetch → DB에만 있고 라이브에 없는 행(=삭제됨) DELETE + UPSERT → 카운트 일치.

안전장치:
  - API 0건 → 삭제 SKIP (전량삭제 참사 방지)
  - 삭제 비율 > max_delete_ratio → SKIP (force 아니면)
  - 429 지수 백오프 재시도
원본 네이버 상품 API DELETE 안 함 — DB 미러 행만 삭제 (CLAUDE.md 준수).
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from django.db import connections

from .smartstore_product_service import (
    fetch_all_products_from_naver, sync_products,
)

NAVERDB = 'myproduct'

_lock = threading.Lock()
_state = {
    'running': False,
    'phase': 'idle',          # idle | running | done | error
    'total': 0,
    'done': 0,
    'started_at': None,
    'finished_at': None,
    'apply': False,
    'results': [],            # 스토어별 결과
    'error': None,
}


def get_status():
    with _lock:
        return {
            'running': _state['running'],
            'phase': _state['phase'],
            'total': _state['total'],
            'done': _state['done'],
            'started_at': _state['started_at'],
            'finished_at': _state['finished_at'],
            'apply': _state['apply'],
            'results': list(_state['results']),
            'error': _state['error'],
            'summary': _summary(),
        }


def _summary():
    res = _state['results']
    return {
        'stores': len(res),
        'total_deleted': sum(r.get('deleted', 0) or 0 for r in res),
        'total_upserted': sum(r.get('upserted', 0) or 0 for r in res),
        'matched': sum(1 for r in res if r.get('matched')),
        'blocked': [r['store_id'] for r in res if r.get('status') == 'ratio_block'],
        'errors': [r['store_id'] for r in res if r.get('status') in ('api_error', 'empty_skip')],
        'db_total': sum(r.get('db_after', r.get('db_before', 0)) or 0 for r in res),
    }


def _active_stores():
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT id, store_name, commerce_api_key, commerce_secret_key "
            "FROM smartstoreIdList "
            "WHERE commerce_api_key IS NOT NULL AND commerce_api_key<>'' "
            "ORDER BY id")
        return [{'id': r[0], 'name': r[1], 'api_key': r[2], 'secret': r[3]}
                for r in cur.fetchall()]


def _fetch_retry(api_key, secret, tries=4):
    for i in range(tries):
        try:
            return fetch_all_products_from_naver(api_key, secret)
        except Exception as e:
            if '429' in str(e) and i < tries - 1:
                time.sleep(2 ** i * 2)
                continue
            raise


def _db_origin_set(store_id):
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT origin_product_no FROM smartstore_product WHERE store_id=%s",
                    [store_id])
        return {str(r[0]) for r in cur.fetchall() if r[0] is not None}


def _reconcile_one(store, apply, max_delete_ratio, force):
    sid, name = store['id'], store['name']
    r = {'store_id': sid, 'name': name, 'status': 'ok',
         'live': 0, 'db_before': 0, 'to_delete': 0, 'to_add': 0,
         'deleted': 0, 'upserted': None, 'db_after': 0, 'matched': False}
    try:
        live = _fetch_retry(store['api_key'], store['secret'])
    except Exception as e:
        r['status'] = 'api_error'
        r['error'] = str(e)[:150]
        return r

    live_set = {str(p.get('originProductNo')) for p in live if p.get('originProductNo')}
    db_set = _db_origin_set(sid)
    r['live'] = len(live_set)
    r['db_before'] = len(db_set)

    if not live_set:
        r['status'] = 'empty_skip'
        return r

    to_delete = db_set - live_set
    to_add = live_set - db_set
    r['to_delete'] = len(to_delete)
    r['to_add'] = len(to_add)
    del_ratio = len(to_delete) / len(db_set) if db_set else 0
    r['del_ratio'] = round(del_ratio, 3)

    if not apply:
        r['status'] = 'preview'
        return r

    if del_ratio > max_delete_ratio and not force:
        r['status'] = 'ratio_block'
        return r

    # UPSERT (429 재시도)
    for i in range(4):
        sync_res = sync_products(sid)
        if not sync_res.get('error'):
            r['upserted'] = sync_res.get('synced') or 0
            break
        if '429' in str(sync_res.get('error', '')) and i < 3:
            time.sleep(2 ** i * 4)
            continue
        r['sync_error'] = str(sync_res['error'])[:120]
        break

    # 삭제분 DELETE
    deleted = 0
    if to_delete:
        ids = list(to_delete)
        with connections[NAVERDB].cursor() as cur:
            for i in range(0, len(ids), 1000):
                chunk = ids[i:i + 1000]
                ph = ','.join(['%s'] * len(chunk))
                cur.execute(
                    f"DELETE FROM smartstore_product "
                    f"WHERE store_id=%s AND origin_product_no IN ({ph})",
                    [sid, *chunk])
                deleted += cur.rowcount
    r['deleted'] = deleted
    r['db_after'] = len(_db_origin_set(sid))
    r['matched'] = (r['db_after'] == len(live_set))
    return r


def _run(apply, max_delete_ratio, force, workers):
    stores = _active_stores()
    with _lock:
        _state.update(running=True, phase='running', total=len(stores), done=0,
                      results=[], error=None, finished_at=None, apply=apply)
    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(_reconcile_one, s, apply, max_delete_ratio, force): s
                    for s in stores}
            for f in as_completed(futs):
                try:
                    res = f.result()
                except Exception as e:
                    s = futs[f]
                    res = {'store_id': s['id'], 'name': s['name'],
                           'status': 'api_error', 'error': str(e)[:150]}
                with _lock:
                    _state['results'].append(res)
                    _state['done'] += 1
        with _lock:
            _state.update(running=False, phase='done',
                          finished_at=time.strftime('%Y-%m-%d %H:%M:%S'))
    except Exception as e:
        with _lock:
            _state.update(running=False, phase='error', error=str(e)[:200],
                          finished_at=time.strftime('%Y-%m-%d %H:%M:%S'))


def start_reconcile(apply=True, max_delete_ratio=0.5, force=False, workers=3):
    with _lock:
        if _state['running']:
            return {'ok': False, 'error': '이미 동기화가 진행 중입니다.'}
        _state.update(running=True, phase='running', started_at=time.strftime('%Y-%m-%d %H:%M:%S'),
                      finished_at=None, results=[], done=0, total=0, error=None, apply=apply)
    threading.Thread(target=_run, args=(apply, max_delete_ratio, force, workers),
                     daemon=True, name='ss-reconcile').start()
    return {'ok': True, 'started': True}
