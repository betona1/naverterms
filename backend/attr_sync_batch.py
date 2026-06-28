"""속성 동기화(적용) 배치 — 스테이징(status='classified')된 추론값을 네이버에 PUT.
이 배치만 네이버 커머스 API 등록(PUT)을 수행한다 (3단계 = 동기화).

usage: python3 attr_sync_batch.py <limit> [store_id]
"""
import os, sys, time
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import missing_attrs_service
from smartstore.worker_log_handler import WorkerLog

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
STORE = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] not in ('-', 'all') else None

wl = WorkerLog('attr_sync', name='속성 동기화(적용)', worker_type='attr')
wl.start(meta={'limit': LIMIT, 'store_id': STORE})

# 대상: 등록가능 SKU 의 classified 행 → SKU 별 selections 그룹핑
where = ["m.status='classified'"]
params = []
if STORE:
    where.append('p.store_id=%s'); params.append(STORE)
where_sql = ' AND '.join(where)

with connections['myproduct'].cursor() as c:
    c.execute(f"""
        SELECT m.seller_management_code, p.store_id,
               m.attribute_seq, m.recommended_value_seq, m.recommended_value_text
        FROM smartstore_product_missing_attrs m
        JOIN smartstore_product p
          ON p.seller_management_code=m.seller_management_code COLLATE utf8mb4_unicode_ci
             AND p.store_id=m.store_id
        WHERE {where_sql} AND p.origin_product_no IS NOT NULL
          AND p.status_type='SALE'
        ORDER BY p.store_id, m.seller_management_code
        LIMIT %s
    """, params + [LIMIT])
    rows = c.fetchall()

skus = {}
for seller, sid, aseq, vseq, vtext in rows:
    skus.setdefault((seller, sid), []).append({
        'attribute_seq': aseq,
        'value_seq': vseq or 0,
        'value_text': (vtext or '').split(',')[0].strip() if vtext else '',
    })

if not skus:
    wl.done('대상 없음', meta={}); print('DONE no-targets'); sys.exit(0)

wl.heartbeat(f'대상 {len(skus)} SKU / {len(rows)} 속성 동기화 시작')

stat = {'sku': len(skus), 'rows': len(rows), 'ok': 0, 'fail': 0, 'attrs': 0, 'done': 0}
for (seller, sid), sels in skus.items():
    try:
        r = missing_attrs_service.register_for_sku(seller, sid, sels, dry_run=False)
    except Exception as e:
        r = {'ok': False, 'error': f'exc: {e}'}
    stat['done'] += 1
    if r.get('ok'):
        stat['ok'] += 1; stat['attrs'] += r.get('attrs_set', 0)
    else:
        stat['fail'] += 1
    if stat['done'] % 10 == 0:
        wl.heartbeat(f"처리 {stat['done']}/{len(skus)} · 등록 {stat['ok']}SKU/{stat['attrs']}속성 · 실패 {stat['fail']}")
    time.sleep(0.3)  # rate-limit

wl.done(f"완료 — 등록 {stat['ok']}SKU / {stat['attrs']}속성 · 실패 {stat['fail']} (대상 {len(skus)}SKU)", meta=stat)
print('DONE', stat)
