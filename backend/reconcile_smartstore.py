"""스마트스토어 상품 리콘실 — 네이버에서 삭제한 상품을 DB(smartstore_product)에서도 제거해 상품수 일치.

기존 sync_products 는 UPSERT 만 하고 '스토어에 없어진 상품 삭제'가 없어, 네이버에서 상품을 지워도
DB 에 stale 행이 남는다. 이 스크립트는:
  1) 스토어별 API 전체 fetch → 라이브 originProductNo 집합 (권위있는 현재 목록)
  2) sync_products() 로 UPSERT (신규/변경 반영)
  3) DB 에만 있고 라이브에 없는 행 = 삭제된 상품 → DELETE
  4) 최종 DB 카운트 == 라이브 카운트 검증
모든 스토어를 스레드로 병렬 처리.

안전장치:
  - API fetch 실패/0건 → 해당 스토어 삭제 SKIP (전량삭제 참사 방지)
  - 삭제 비율이 --max-delete-ratio 초과 → SKIP + 플래그 (--force 로 강행)
  - 기본은 PREVIEW (쓰기 없음). 실제 반영은 --apply.

원본 상품(네이버 origin)은 절대 API DELETE 안 함 — DB 미러 행만 삭제 (CLAUDE.md 준수).

사용:
  python3 reconcile_smartstore.py                 # 전체 스토어 미리보기
  python3 reconcile_smartstore.py --apply         # 전체 반영
  python3 reconcile_smartstore.py --store 81       # 특정 스토어만 미리보기
  python3 reconcile_smartstore.py --apply --store 81 --force
"""
import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections  # noqa: E402
from smartstore.smartstore_product_service import (  # noqa: E402
    fetch_all_products_from_naver, sync_products,
)

NAVERDB = 'myproduct'
_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def get_active_stores(only_store=None):
    with connections[NAVERDB].cursor() as cur:
        sql = ("SELECT id, store_name, commerce_api_key, commerce_secret_key "
               "FROM smartstoreIdList "
               "WHERE commerce_api_key IS NOT NULL AND commerce_api_key<>''")
        params = []
        if only_store:
            sql += " AND id=%s"
            params.append(only_store)
        cur.execute(sql, params)
        return [
            {'id': r[0], 'name': r[1], 'api_key': r[2], 'secret': r[3]}
            for r in cur.fetchall()
        ]


def db_origin_set(store_id):
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT origin_product_no FROM smartstore_product WHERE store_id=%s",
            [store_id],
        )
        return {str(r[0]) for r in cur.fetchall() if r[0] is not None}


def _fetch_with_retry(api_key, secret, tries=4):
    """429(레이트리밋) 시 지수 백오프 재시도."""
    for i in range(tries):
        try:
            return fetch_all_products_from_naver(api_key, secret)
        except Exception as e:
            if '429' in str(e) and i < tries - 1:
                time.sleep(2 ** i * 2)  # 2,4,8s
                continue
            raise


def reconcile_store(store, apply=False, max_delete_ratio=0.5, force=False,
                    skip_upsert=False):
    sid, name = store['id'], store['name']
    result = {'store_id': sid, 'name': name, 'status': 'ok'}
    try:
        live = _fetch_with_retry(store['api_key'], store['secret'])
    except Exception as e:
        result.update(status='api_error', error=str(e)[:200])
        log(f'  ✗ store#{sid:<4} {name[:14]:14} API 오류: {str(e)[:80]}')
        return result

    live_set = {str(p.get('originProductNo')) for p in live if p.get('originProductNo')}
    db_set = db_origin_set(sid)
    db_before = len(db_set)

    # 안전장치 1: API 0건 → 삭제 스킵 (오류로 간주)
    if not live_set:
        result.update(status='empty_skip', live=0, db_before=db_before,
                      to_delete=0, to_add=0)
        log(f'  ⚠ store#{sid:<4} {name[:14]:14} 라이브 0건 → 삭제 SKIP (API 이상 의심)')
        return result

    to_delete = db_set - live_set       # DB 에만 있음 = 네이버에서 삭제됨
    to_add = live_set - db_set          # 라이브에만 있음 = 신규 (upsert 로 추가)
    del_ratio = len(to_delete) / db_before if db_before else 0
    result.update(live=len(live_set), db_before=db_before,
                  to_delete=len(to_delete), to_add=len(to_add),
                  del_ratio=round(del_ratio, 3))

    # 안전장치 2: 삭제 비율 초과 → 스킵 (force 아니면)
    ratio_block = del_ratio > max_delete_ratio and not force

    if not apply:
        flag = '  ‼ 삭제비율초과(미반영, --force 필요)' if ratio_block else ''
        log(f'  · store#{sid:<4} {name[:14]:14} 라이브 {len(live_set):>6,} | DB {db_before:>6,} '
            f'| 삭제대상 {len(to_delete):>5,} | 추가 {len(to_add):>4,} ({del_ratio:.0%}){flag}')
        result['status'] = 'preview_ratio_block' if ratio_block else 'preview'
        return result

    if ratio_block:
        result['status'] = 'ratio_block'
        log(f'  ‼ store#{sid:<4} {name[:14]:14} 삭제비율 {del_ratio:.0%} > {max_delete_ratio:.0%} → SKIP (--force 로 강행)')
        return result

    # 1) UPSERT (신규/변경) — 실패해도 삭제는 진행 (count-match 가 목적)
    if skip_upsert:
        result['upserted'] = None
    else:
        sync_res = sync_products(sid)
        if sync_res.get('error'):
            result['upserted'] = None
            result['sync_error'] = str(sync_res['error'])[:120]
            log(f'  ⚠ store#{sid:<4} {name[:14]:14} upsert 실패(삭제는 진행): {result["sync_error"]}')
        else:
            result['upserted'] = sync_res.get('synced') or 0

    # 2) 삭제분 DELETE (DB 에만 있는 origin_product_no)
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
                    [sid, *chunk],
                )
                deleted += cur.rowcount
    result['deleted'] = deleted

    # 3) 검증
    db_after = len(db_origin_set(sid))
    result['db_after'] = db_after
    result['matched'] = (db_after == len(live_set))
    mark = '✓' if result['matched'] else '✗ 불일치'
    ups = result.get('upserted')
    ups_s = f'{ups:>5,}' if ups is not None else '  skip'
    log(f'  {mark} store#{sid:<4} {name[:14]:14} upsert {ups_s} | '
        f'삭제 {deleted:>5,} | DB {db_before:,}→{db_after:,} (라이브 {len(live_set):,})')
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='실제 반영 (기본은 미리보기)')
    ap.add_argument('--store', type=int, default=None, help='특정 스토어 id 만')
    ap.add_argument('--workers', type=int, default=3, help='동시 스토어 처리 수 (429 방지로 기본 3)')
    ap.add_argument('--max-delete-ratio', type=float, default=0.5,
                    help='삭제 비율 안전 상한 (초과 시 스킵, --force 로 강행)')
    ap.add_argument('--force', action='store_true', help='삭제 비율 상한 무시')
    ap.add_argument('--skip-upsert', action='store_true',
                    help='UPSERT 생략하고 삭제만 (API 호출 절반, count-match 만 목적일 때)')
    args = ap.parse_args()

    stores = get_active_stores(args.store)
    mode = 'APPLY(반영)' if args.apply else 'PREVIEW(미리보기)'
    log(f'=== 스마트스토어 리콘실 [{mode}] — 스토어 {len(stores)}개, 동시 {args.workers} ===')
    if not args.apply:
        log('  (쓰기 없음. 실제 반영하려면 --apply)')

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(reconcile_store, s, args.apply,
                          args.max_delete_ratio, args.force, args.skip_upsert): s
                for s in stores}
        for f in as_completed(futs):
            results.append(f.result())

    # 요약
    log('\n=== 요약 ===')
    tot_del = sum(r.get('to_delete', 0) for r in results)
    tot_add = sum(r.get('to_add', 0) for r in results)
    blocked = [r for r in results if r['status'] in ('ratio_block', 'preview_ratio_block')]
    errs = [r for r in results if r['status'] in ('api_error', 'empty_skip')]
    if args.apply:
        done = [r for r in results if 'deleted' in r]
        log(f'  반영 스토어 {len(done)} | 총 삭제 {sum(r.get("deleted",0) for r in done):,} '
            f'| 총 upsert {sum(r.get("upserted",0) or 0 for r in done):,}')
        mismatch = [r for r in done if not r.get('matched')]
        if mismatch:
            log(f'  ✗ 카운트 불일치 스토어: {[r["store_id"] for r in mismatch]}')
        else:
            log('  ✓ 반영된 스토어 전부 라이브 카운트와 일치')
    else:
        log(f'  삭제 대상 합계 {tot_del:,} | 추가 대상 합계 {tot_add:,}')
    if blocked:
        log(f'  ‼ 삭제비율 초과로 보류: {[r["store_id"] for r in blocked]} (--force 필요)')
    if errs:
        log(f'  ⚠ API오류/빈응답 스토어: {[(r["store_id"], r["status"]) for r in errs]}')


if __name__ == '__main__':
    main()
