"""오너클랜 재입고 → 판매중 재활성화 서비스.

규칙 (2026-07-01 확정):
 - 대상: status_type=SUSPENSION AND ownerclan_soldout=0 (재입고분)
 - 스토어 한도여유(한도 - 판매중/대기/품절) 있는 만큼만. 한도초과 스토어 제외.
 - 역마진(결제가×0.93 < 원가)이면 판매가를 마진 2%로 재계산(할인율 그로스업) 후 가격도 PUT.
 - 네이버 검증실패(KC인증·단위가격 등)는 스킵+로그. 자동보정 안 함.

standalone cron(reactivate_restock.py)과 웹 뷰가 공용으로 사용.
"""
import math
import time

from django.db import connections

from . import smartstore_product_service as S

MARGIN = 0.02          # 목표 마진 2%
NET = 0.93             # 네이버 수수료 7% 정산율
ACTIVE = ('SALE', 'WAIT', 'OUTOFSTOCK')   # 한도 포함 상태


def _round10_up(x):
    return int(math.ceil(x / 10.0) * 10)


def _new_price(cost, rate_pct, fixed_won):
    """원가 → 마진2% 결제가 → 할인 그로스업 정가. 반환 (정가, 결제가)."""
    new_pay = _round10_up(cost * (1 + MARGIN) / NET)
    if rate_pct:
        new_list = _round10_up(new_pay / (1 - rate_pct / 100.0))
    elif fixed_won:
        new_list = new_pay + fixed_won
    else:
        new_list = new_pay
    return new_list, new_pay


def _store_headroom(store_id=None):
    """스토어별 {store_id: {name, limit, active, headroom}}."""
    cur = connections['myproduct'].cursor()
    where = "s.is_active=1"
    params = []
    if store_id:
        where += " AND s.id=%s"
        params.append(store_id)
    cur.execute(
        "SELECT s.id, s.store_name, SUM(p.status_type IN %s) AS active_cnt "
        "FROM smartstoreIdList s LEFT JOIN smartstore_product p ON p.store_id=s.id "
        f"WHERE {where} GROUP BY s.id, s.store_name",
        [ACTIVE] + params,
    )
    out = {}
    for sid, name, act in cur.fetchall():
        cur.execute(
            "SELECT sale_limit_count FROM smartstore_seller_policy_snapshot "
            "WHERE store_pk=%s ORDER BY captured_at DESC LIMIT 1", [sid])
        row = cur.fetchone()
        lim = int(row[0]) if row and row[0] else 1000
        a = int(act or 0)
        out[sid] = {'name': name, 'limit': lim, 'active': a, 'headroom': lim - a}
    return out


def _candidate_counts(store_id=None):
    """스토어별 재입고 후보수 {store_id: count}."""
    cur = connections['myproduct'].cursor()
    where = ("p.status_type='SUSPENSION' AND p.ownerclan_soldout=0 "
             "AND p.seller_management_code IS NOT NULL AND p.seller_management_code!=''")
    params = []
    if store_id:
        where += " AND p.store_id=%s"
        params.append(store_id)
    cur.execute(
        f"SELECT p.store_id, COUNT(*) FROM smartstore_product p WHERE {where} "
        "GROUP BY p.store_id", params)
    return {r[0]: int(r[1]) for r in cur.fetchall()}


def get_summary(store_id=None):
    """재입고 재활성화 요약. store_id=None/0 이면 전체 합산."""
    store_id = store_id or None
    heads = _store_headroom(store_id)
    cands = _candidate_counts(store_id)
    candidates = 0
    reactivatable = 0
    blocked_full = 0     # 한도초과로 막힌 후보수
    per_store = []
    for sid, cnt in cands.items():
        h = heads.get(sid, {})
        head = max(0, h.get('headroom', 0))
        can = min(cnt, head)
        candidates += cnt
        reactivatable += can
        blocked_full += (cnt - can)
        per_store.append({'store_id': sid, 'store_name': h.get('name'),
                          'candidates': cnt, 'limit': h.get('limit'),
                          'active': h.get('active'), 'headroom': h.get('headroom'),
                          'reactivatable': can})
    per_store.sort(key=lambda x: -x['reactivatable'])
    return {'candidates': candidates, 'reactivatable': reactivatable,
            'blocked_over_limit': blocked_full, 'per_store': per_store}


def _load_candidates(store_id, limit):
    """한도여유 배정된 후보 리스트."""
    heads = _store_headroom(store_id)
    cur = connections['myproduct'].cursor()
    where = ("p.status_type='SUSPENSION' AND p.ownerclan_soldout=0 "
             "AND p.seller_management_code IS NOT NULL AND p.seller_management_code!=''")
    params = []
    if store_id:
        where += " AND p.store_id=%s"
        params.append(store_id)
    cur.execute(
        "SELECT p.id, p.store_id, s.store_name, p.seller_management_code, p.origin_product_no, "
        "  p.sale_price, p.discount_price, p.master_price, s.commerce_api_key, s.commerce_secret_key "
        "FROM smartstore_product p JOIN smartstoreIdList s ON s.id=p.store_id "
        f"WHERE {where} ORDER BY p.store_id, p.id", params)
    cols = [d[0] for d in cur.description]
    picked, used = [], {}
    for r in cur.fetchall():
        c = dict(zip(cols, r))
        sid = c['store_id']
        head = max(0, heads.get(sid, {}).get('headroom', 0))
        if used.get(sid, 0) >= head:
            continue
        used[sid] = used.get(sid, 0) + 1
        picked.append(c)
        if limit and len(picked) >= limit:
            break
    return picked


def _process(c, token):
    """단일 상품 재활성화. 반환 (outcome, detail)."""
    import requests
    url = S.NAVER_PRODUCT_DETAIL_URL.format(c['origin_product_no'])
    hdr = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    resp = requests.get(url, headers=hdr, timeout=15).json()
    op = resp.get('originProduct')
    if not op:
        return ('error', {'msg': '네이버 상품 없음(삭제됨)'})

    cost = int(c['master_price'] or 0)
    pay = int(c['discount_price'] or c['sale_price'] or 0)
    reverse = cost > 0 and round(pay * NET) < cost

    new_list = new_pay = None
    if reverse:
        idp = (op.get('customerBenefit') or {}).get('immediateDiscountPolicy') or {}
        dm = idp.get('discountMethod') or {}
        rate = dm.get('value', 0) if dm.get('unitType') == 'PERCENT' else 0
        fixed = dm.get('value', 0) if dm.get('unitType') == 'WON' else 0
        new_list, new_pay = _new_price(cost, rate, fixed)
        op['salePrice'] = int(new_list)

    op['statusType'] = 'SALE'
    seo = (op.get('detailAttribute') or {}).get('seoInfo') or {}
    if 'sellerTags' in seo:
        del seo['sellerTags']

    def _put(o):
        return requests.put(url, json={'originProduct': o}, headers=hdr, timeout=25)

    r = _put(op)
    if r.status_code == 400:
        inv = r.json().get('invalidInputs', [])
        if any('limitOver' in i.get('type', '') for i in inv):
            return ('skip_limit', {'msg': '한도초과'})
        fixable = False
        unfix = []
        for it in inv:
            nm = it.get('name', '')
            if nm.endswith('unitPriceYn'):
                (op.setdefault('detailAttribute', {})
                   .setdefault('unitCapacity', {}))['unitPriceYn'] = False
                fixable = True
            else:
                unfix.append(it.get('message', '')[:40])
        if unfix:
            return ('skip_validation', {'errors': unfix})
        if fixable:
            r = _put(op)
    try:
        r.raise_for_status()
    except Exception as e:
        return ('error', {'msg': str(e)[:120]})

    with connections['myproduct'].cursor() as cur:
        if new_list is not None:
            cur.execute(
                "UPDATE smartstore_product SET sale_price=%s, discount_price=%s, "
                "status_type='SALE', restock_at=NOW(), restock_checked=0, "
                "restock_price_changed=1, restock_reverse_margin=0 WHERE id=%s",
                [int(new_list), int(new_pay), c['id']])
        else:
            cur.execute(
                "UPDATE smartstore_product SET status_type='SALE', restock_at=NOW(), "
                "restock_checked=0 WHERE id=%s", [c['id']])
    return ('reactivated', {'reverse': reverse, 'new_list': new_list})


def reactivate(store_id=None, limit=None, on_log=None):
    """재입고 재활성화 실행. 반환 stat dict."""
    store_id = store_id or None
    cands = _load_candidates(store_id, limit)
    tokens = {}
    stat = {'target': len(cands), 'reactivated': 0, 'price_fixed': 0,
            'skip_validation': 0, 'skip_limit': 0, 'error': 0}
    fails = []
    for c in cands:
        sid = c['store_id']
        try:
            if sid not in tokens:
                tokens[sid] = S._get_access_token(c['commerce_api_key'], c['commerce_secret_key'])
            outcome, detail = _process(c, tokens[sid])
        except Exception as e:
            outcome, detail = 'error', {'msg': str(e)[:120]}
        stat[outcome] = stat.get(outcome, 0) + 1
        if outcome == 'reactivated' and detail.get('reverse'):
            stat['price_fixed'] += 1
        if outcome in ('skip_validation', 'error'):
            fails.append({'store': c['store_name'], 'wcode': c['seller_management_code'],
                          'outcome': outcome, **detail})
        if on_log:
            on_log(outcome, c, detail)
        time.sleep(0.3)
    stat['fails'] = fails[:100]
    return stat
