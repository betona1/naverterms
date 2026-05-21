"""자동 후보 (candidate_count=1, status=pending) DRY-RUN.
사용:
  python3 dry_run_auto_candidates.py --limit 200       # 샘플
  python3 dry_run_auto_candidates.py                   # 전체
  python3 dry_run_auto_candidates.py --offset 0 --total 11  # 분산용
"""
import os, sys, json, argparse, time
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
    ap.add_argument('--offset', type=int, default=0, help='워커 idx (0~total-1)')
    ap.add_argument('--total', type=int, default=1, help='워커 총 수 (분산)')
    args = ap.parse_args()

    # 1) 자동 후보 fetch
    with connections['myproduct'].cursor() as c:
        sql = """
            SELECT m.seller_management_code, m.store_id, m.attribute_seq,
                   m.recommended_value_seq, m.recommended_value_text,
                   p.origin_product_no
            FROM smartstore_product_missing_attrs m
            JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = m.seller_management_code
                 AND p.store_id=m.store_id
            WHERE m.candidate_count=1 AND m.status='pending'
              AND m.recommended_value_seq IS NOT NULL
              AND p.origin_product_no IS NOT NULL
        """
        if args.total > 1:
            sql += f" AND MOD(m.attribute_seq + m.store_id, {args.total}) = {args.offset}"
        sql += " ORDER BY m.attribute_seq, m.store_id"
        if args.limit:
            sql += f' LIMIT {int(args.limit)}'
        c.execute(sql)
        cols = [d[0] for d in c.description]
        rows = [dict(zip(cols, r)) for r in c.fetchall()]

    print(f'[load] candidates: {len(rows):,}')
    if not rows:
        return

    # 2) attribute_seq 별로 그룹
    groups = {}
    for r in rows:
        groups.setdefault(r['attribute_seq'], []).append(r)
    print(f'[groups] unique attributes: {len(groups)}')

    total_ok = total_fail = 0
    fail_samples = []
    start = time.time()
    done = 0

    for aseq, items in groups.items():
        value_seq = items[0]['recommended_value_seq']
        value_text = items[0]['recommended_value_text']
        skus = [{
            'seller_management_code': it['seller_management_code'],
            'store_id': it['store_id'],
            'origin_product_no': it['origin_product_no'],
        } for it in items]
        try:
            r = missing_attrs_service.register_bulk(
                skus=skus, attribute_seq=aseq,
                value_seq=value_seq, value_text=value_text,
                dry_run=True,
            )
        except Exception as e:
            r = {'ok': 0, 'fail': len(skus), 'errors': [str(e)]}
        total_ok += r['ok']
        total_fail += r['fail']
        if r['errors']:
            fail_samples.extend(r['errors'][:2])
        done += len(items)
        elapsed = time.time() - start
        rate = done / max(elapsed, 0.001)
        eta = (len(rows) - done) / max(rate, 0.001)
        if done % 50 == 0 or done == len(rows):
            print(f'  attr={aseq} ({value_text}) +{r["ok"]} fail={r["fail"]} | done={done}/{len(rows)} {rate:.1f}/s ETA={eta/60:.1f}분')

    elapsed = (time.time() - start) / 60
    print(f'\n=== DONE === OK {total_ok:,} / FAIL {total_fail:,}  경과 {elapsed:.1f}분')
    if fail_samples:
        print('샘플 에러:')
        for e in fail_samples[:10]:
            print(' ', e[:200])


if __name__ == '__main__':
    main()
