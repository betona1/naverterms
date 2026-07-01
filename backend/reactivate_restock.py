"""오너클랜 재입고 상품 → 스마트스토어 판매중(SALE) 재활성화 (독립 프로세스 / 230 전담워커).

한도여유 있는 스토어만 자동 재활성화. 역마진이면 마진2%로 가격수정. 검증실패는 스킵+로그.
로직 본체는 smartstore.restock_service 공용.

cron (230): 0 6 * * *  /usr/bin/python3 .../reactivate_restock.py
사용:
  python3 reactivate_restock.py                 # 전체 자동
  python3 reactivate_restock.py --store 조아팡    # 특정 스토어
  python3 reactivate_restock.py --limit 10       # 최대 10건
  python3 reactivate_restock.py --summary        # 실행 없이 요약만
"""
import os
import sys
import json
import argparse
from datetime import datetime

_BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(_BASE)
if _BASE not in sys.path:
    sys.path.insert(0, _BASE)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django  # noqa: E402
django.setup()

from django.db import connections  # noqa: E402
from smartstore import restock_service as R  # noqa: E402


def _store_id(name):
    if not name:
        return None
    cur = connections['myproduct'].cursor()
    cur.execute("SELECT id FROM smartstoreIdList WHERE store_name=%s LIMIT 1", [name])
    row = cur.fetchone()
    return row[0] if row else -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--store', default=None)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--summary', action='store_true')
    args = ap.parse_args()

    sid = _store_id(args.store)
    if sid == -1:
        print(f'스토어 없음: {args.store}', flush=True)
        return

    summ = R.get_summary(sid)
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 재입고 요약 "
          f"(store={args.store or '전체'}): 대기 {summ['candidates']} / "
          f"지금가능 {summ['reactivatable']} / 한도초과대기 {summ['blocked_over_limit']}", flush=True)
    if args.summary:
        print(json.dumps(summ['per_store'], ensure_ascii=False, indent=1))
        return

    def _log(outcome, c, detail):
        tag = f" [역마진→{detail['new_list']:,}]" if detail.get('new_list') else ''
        print(f"  {outcome:<16} {c['store_name'][:8]:<8} {c['seller_management_code']}{tag}", flush=True)

    stat = R.reactivate(sid, args.limit, on_log=_log)
    print(f"[{datetime.now():%H:%M:%S}] 완료: 재활성화 {stat['reactivated']} "
          f"(역마진수정 {stat['price_fixed']}) / 검증스킵 {stat['skip_validation']} "
          f"/ 한도스킵 {stat['skip_limit']} / 오류 {stat['error']}", flush=True)
    with open(os.path.join(_BASE, 'reactivate_restock_result.json'), 'w') as f:
        json.dump({'ts': datetime.now().isoformat(), 'summary': summ, 'stat': stat},
                  f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
