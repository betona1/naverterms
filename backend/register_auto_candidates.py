"""
자동 후보 (candidate_count=1, status=pending) 일괄 등록.
SKU 단위로 묶어서 한 번 PUT 로 그 SKU 의 모든 자동 속성 등록.

사용:
  python3 register_auto_candidates.py --limit 50              # 샘플
  python3 register_auto_candidates.py --offset 0 --total 11  # 분산 (워커 idx 0)
  python3 register_auto_candidates.py --skip-stores 93       # 특정 store 제외
"""
import os, sys, time, argparse
from datetime import datetime

import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections
from smartstore import missing_attrs_service


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--total', type=int, default=1)
    ap.add_argument('--skip-stores', default='', help='제외할 store_id 콤마 (예: 93)')
    ap.add_argument('--print-every', type=int, default=20)
    args = ap.parse_args()

    skip_set = {int(x) for x in args.skip_stores.split(',') if x.strip()}

    # 1) summary 에서 자동 후보 있는 SKU 선택 (가벼움)
    with connections['myproduct'].cursor() as c:
        sql = """
            SELECT seller_management_code, store_id
            FROM smartstore_sku_missing_summary
            WHERE auto_count > 0 AND pending_count > 0
        """
        if args.total > 1:
            sql += f" AND MOD(store_id, {args.total}) = {args.offset}"
        if skip_set:
            sql += f" AND store_id NOT IN ({','.join(str(s) for s in skip_set)})"
        sql += " ORDER BY missing_count DESC"
        if args.limit:
            sql += f" LIMIT {int(args.limit)}"
        c.execute(sql)
        sku_keys = c.fetchall()

    if not sku_keys:
        print('[load] no targets')
        return

    print(f'[load] target SKUs: {len(sku_keys):,}')

    # 2) 각 SKU 의 자동 후보 attribute_seq + recommended_value 조회 (SKU 별 lookup, index 사용)
    sku_list = []
    with connections['myproduct'].cursor() as c:
        for seller, sid in sku_keys:
            c.execute("""
                SELECT attribute_seq, recommended_value_seq, recommended_value_text
                FROM smartstore_product_missing_attrs
                WHERE seller_management_code=%s AND store_id=%s
                  AND candidate_count=1 AND status='pending'
                  AND recommended_value_seq IS NOT NULL
            """, [seller, sid])
            sels = [{
                'attribute_seq': aseq, 'value_seq': vseq, 'value_text': vtext or '',
            } for aseq, vseq, vtext in c.fetchall()]
            if sels:
                sku_list.append(((seller, sid), sels))

    print(f'[load] effective SKUs (auto+pending): {len(sku_list):,}  total attrs: {sum(len(v) for _,v in sku_list):,}')
    if not sku_list:
        return

    total_ok = total_fail = total_attrs = 0
    fail_samples = []
    start = time.time()

    for i, ((seller, sid), selections) in enumerate(sku_list, 1):
        try:
            r = missing_attrs_service.register_for_sku(
                seller_management_code=seller, store_id=sid,
                selections=selections, dry_run=False,
            )
        except Exception as e:
            r = {'ok': False, 'error': str(e)[:300]}

        if r.get('ok'):
            total_ok += 1
            total_attrs += r.get('attrs_set', 0)
        else:
            total_fail += 1
            err = r.get('error', '?')
            if len(fail_samples) < 10:
                fail_samples.append(f'{seller}: {err[:150]}')

        if i % args.print_every == 0 or i == len(sku_list):
            elapsed = time.time() - start
            rate = i / max(elapsed, 0.001)
            eta = (len(sku_list) - i) / max(rate, 0.001)
            print(f'  [{i}/{len(sku_list)}] OK {total_ok} FAIL {total_fail} attrs {total_attrs} | {rate:.2f}/s ETA={eta/60:.1f}분')

    elapsed = (time.time() - start) / 60
    print(f'\n=== DONE === SKU OK {total_ok:,} / FAIL {total_fail:,}  attrs {total_attrs:,}  경과 {elapsed:.1f}분')
    if fail_samples:
        print('샘플 에러:')
        for e in fail_samples:
            print(' ', e)


if __name__ == '__main__':
    main()
