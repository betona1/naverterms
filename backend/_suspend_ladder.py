"""494 방치품절(오너클랜 품절/단종 ↔ 스스 SALE) 통제 품절처리 — 검증사다리용.
_sync_store_batch(실제 네이버 GET→PUT→DB반영) 재사용, 슬라이스 단위 실행 + 독립 재검증.
사용: python3 _suspend_ladder.py --offset 0 --limit 1
"""
import os, sys, time, argparse, django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from ownerclan.ownerclan_product_service import _sync_store_batch, _dictfetchall

SUSPEND_SQL = '''
  SELECT sp.id, sp.origin_product_no, sp.store_id, op.product_code,
         op.id AS oc_id, op.sale_status, sp.status_type AS old_ss_status,
         s.commerce_api_key, s.commerce_secret_key, s.store_name
  FROM ownerclan_product op
  JOIN myproduct.smartstore_product sp ON sp.seller_management_code = op.product_code
  JOIN myproduct.smartstoreIdList s ON s.id = sp.store_id
  WHERE op.sale_status IN (2,3) AND sp.status_type = 'SALE'
  ORDER BY sp.id
'''

def load_targets():
    with connections['ads'].cursor() as cur:
        cur.execute(SUSPEND_SQL)
        return _dictfetchall(cur)

def verify(opno, api_key, secret_key):
    import requests
    from smartstore.smartstore_product_service import _get_access_token
    try:
        tok = _get_access_token(api_key, secret_key)
        r = requests.get(f'https://api.commerce.naver.com/external/v2/products/origin-products/{opno}',
                         headers={'Authorization': f'Bearer {tok}'}, timeout=20)
        if r.status_code == 200:
            return r.json()['originProduct'].get('statusType', '?')
        return f'HTTP {r.status_code}'
    except Exception as e:
        return f'ERR {str(e)[:40]}'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--limit', type=int, default=1)
    ap.add_argument('--verify', action='store_true', help='처리 후 네이버 재GET으로 실제 상태 확인')
    a = ap.parse_args()

    targets = load_targets()
    total = len(targets)
    sl = targets[a.offset:a.offset + a.limit]
    print(f'전체 대상 {total}개 | 이번 실행 [{a.offset}:{a.offset+a.limit}] = {len(sl)}건')
    if not sl:
        print('대상 없음'); return

    groups = {}
    for t in sl:
        groups.setdefault(t['store_id'], {'k': t['commerce_api_key'], 's': t['commerce_secret_key'], 'items': []})
        groups[t['store_id']]['items'].append((t, 'SUSPENSION'))

    agg = {'success': 0, 'skipped': 0, 'fail': 0}
    processed = []
    for sid, g in groups.items():
        res = _sync_store_batch(sid, g['items'], g['k'], g['s'])
        agg['success'] += res['success']; agg['skipped'] += res['skipped']; agg['fail'] += len(res['errors'])
        for t, ns in g['items']:
            processed.append(t)
        for e in res['errors']:
            print(f"  ERROR {e['product_code']}: {e['error']}")
    print(f"결과: 성공(품절반영) {agg['success']} | 스킵(이미품절등) {agg['skipped']} | 실패 {agg['fail']}")

    if a.verify:
        print('── 네이버 실측 재검증 ──')
        for t in processed[:15]:
            live = verify(t['origin_product_no'], t['commerce_api_key'], t['commerce_secret_key'])
            mark = 'OK' if live in ('SUSPENSION', 'OUTOFSTOCK', 'CLOSE') else '⚠️'
            print(f"  {mark} {t['product_code']} opno={t['origin_product_no']} {t['store_name'][:8]} → 네이버:{live}")
            time.sleep(0.3)

if __name__ == '__main__':
    main()
