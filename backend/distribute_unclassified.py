#!/usr/bin/env python3
"""미분류 풀 → 한도 미달 스토어 라운드로빈 분배.

규칙:
- 판매 W코드(smartstore_product.ownerclan_soldout=1) 제외
- 스토어 한도(analytics current_limit) - 현재 폴더 카운트 만큼 채움
- 한 스토어 안에서 leaf 카테고리당 최대 CAT_CAP_PER_STORE 개 (다양화)
- DELETE 없이 folder_id 만 UPDATE
"""
import os
import sys
import random
import itertools
from collections import defaultdict, Counter

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django
django.setup()
from django.db import connections

import json
import urllib.request

CAT_CAP_PER_STORE = int(os.environ.get('CAT_CAP', '20'))
DRY_RUN = os.environ.get('DRY_RUN') == '1'

print(f'=== 미분류 분배 시작 (cap={CAT_CAP_PER_STORE}, dry_run={DRY_RUN}) ===')

# 1) analytics 한도
url = 'http://localhost:8901/api/smartstore/analytics/registration-limits/'
data = json.loads(urllib.request.urlopen(url, timeout=30).read())
limits = {s['store_id']: s['current_limit'] for s in data['stores']}
store_names = {s['store_id']: s['store_name'] for s in data['stores']}

# 2) store→folder 매핑 + 현재 폴더 카운트
with connections['naverdb'].cursor() as cur:
    cur.execute("SELECT id, store_id FROM naver_my_product_folder WHERE store_id IS NOT NULL")
    folder_by_store = {sid: fid for fid, sid in cur.fetchall()}

    cur.execute("SELECT folder_id, COUNT(*) FROM naver_my_product GROUP BY folder_id")
    folder_counts = dict(cur.fetchall())

needs = {}  # fid -> remaining_gap
fid_to_sid = {}
for sid, lim in limits.items():
    fid = folder_by_store.get(sid)
    if not fid:
        continue
    cur_cnt = folder_counts.get(fid, 0)
    gap = lim - cur_cnt
    if gap > 0:
        needs[fid] = gap
        fid_to_sid[fid] = sid

if not needs:
    print('한도 미달 폴더 없음. 종료.')
    sys.exit(0)

print(f'\n분배 대상 스토어 ({len(needs)}개), 총 필요량 {sum(needs.values()):,}:')
for fid, gap in sorted(needs.items(), key=lambda x: -x[1]):
    sid = fid_to_sid[fid]
    print(f"  fid={fid:>3d} {store_names.get(sid,'?'):10s} (sid={sid:>3d}) 한도={limits[sid]:>6d}  현재={folder_counts.get(fid,0):>5d}  +{gap:>5d}")

# 3) 각 스토어 폴더의 현재 leaf 카테고리 카운트
store_cat = defaultdict(Counter)
with connections['naverdb'].cursor() as cur:
    fids_sql = ','.join(str(f) for f in needs.keys())
    cur.execute(f"""
        SELECT folder_id,
               SUBSTRING_INDEX(IFNULL(category_name,''), '>', -1) AS leaf,
               COUNT(*)
        FROM naver_my_product
        WHERE folder_id IN ({fids_sql})
        GROUP BY folder_id, leaf
    """)
    for fid, leaf, cnt in cur.fetchall():
        store_cat[fid][leaf or '(none)'] = int(cnt)

# 4) 판매된 W코드 set
with connections['myproduct'].cursor() as cur:
    cur.execute("SELECT seller_management_code FROM smartstore_product WHERE ownerclan_soldout=1")
    sold_codes = {r[0] for r in cur.fetchall() if r[0]}
print(f'\n판매(soldout=1) W코드: {len(sold_codes):,} 개 — 분배에서 제외')

# 5) 미분류 풀 → leaf 카테고리별 묶기
with connections['naverdb'].cursor() as cur:
    cur.execute("""
        SELECT id, product_code,
               SUBSTRING_INDEX(IFNULL(category_name,''), '>', -1) AS leaf
        FROM naver_my_product WHERE folder_id=1
    """)
    pool_by_cat = defaultdict(list)
    skipped_sold = 0
    for pid, pcode, leaf in cur.fetchall():
        if pcode and pcode in sold_codes:
            skipped_sold += 1
            continue
        pool_by_cat[leaf or '(none)'].append(pid)

total_pool = sum(len(v) for v in pool_by_cat.values())
print(f'분배 가능 풀: {total_pool:,} 개 (sold 스킵 {skipped_sold:,}), leaf 카테고리 {len(pool_by_cat):,} 종')

# 6) 라운드로빈 분배 — 스토어 라운드 × 카테고리 cycle
random.seed(42)
cats = list(pool_by_cat.keys())
random.shuffle(cats)
for cat in cats:  # 카테고리 내부도 셔플 (편향 제거)
    random.shuffle(pool_by_cat[cat])

cat_cycle = itertools.cycle(cats)
store_fids = list(needs.keys())
random.shuffle(store_fids)

moves = defaultdict(list)
moved_total = 0

while any(needs[fid] > 0 for fid in store_fids):
    progressed = False
    for fid in store_fids:
        if needs[fid] <= 0:
            continue
        # cap 안 찬 + 풀 있는 카테고리 하나 잡기
        tried = 0
        while tried < len(cats):
            cat = next(cat_cycle)
            tried += 1
            if store_cat[fid][cat] >= CAT_CAP_PER_STORE:
                continue
            if not pool_by_cat[cat]:
                continue
            pid = pool_by_cat[cat].pop()
            moves[fid].append(pid)
            store_cat[fid][cat] += 1
            needs[fid] -= 1
            moved_total += 1
            progressed = True
            break
    if not progressed:
        break

# 7) 실제 이동 (or dry-run)
if DRY_RUN:
    print(f'\n[DRY-RUN] 이동 예정 {moved_total:,} 건. 실제 UPDATE 안 함.')
else:
    print(f'\n=== UPDATE 실행 ({moved_total:,} 건) ===')
    with connections['naverdb'].cursor() as cur:
        updated = 0
        for fid, ids in moves.items():
            for i in range(0, len(ids), 500):
                chunk = ids[i:i+500]
                ph = ','.join(['%s'] * len(chunk))
                cur.execute(
                    f'UPDATE naver_my_product SET folder_id=%s WHERE id IN ({ph})',
                    [fid] + chunk,
                )
                updated += cur.rowcount
        print(f'updated rows: {updated:,}')

# 8) 결과 리포트
print(f'\n=== 결과 ===')
print(f"{'fid':>4s} {'store':10s} {'moved':>7s} {'남은갭':>7s} {'leaf카테고리수':>12s}")
for fid in sorted(moves.keys()):
    sid = fid_to_sid[fid]
    cnt = len(moves[fid])
    remaining = needs[fid]
    cat_cnt = len({c for c, n in store_cat[fid].items() if n > 0})
    print(f"  {fid:>3d} {store_names.get(sid,'?'):10s} {cnt:>7,d} {remaining:>7,d} {cat_cnt:>12,d}")

print(f'\n총 이동: {moved_total:,} 건')
