import re
import time
import logging
from datetime import date, timedelta
from collections import defaultdict

import requests
from django.db import connections

from .smartstore_order_service import VALID_ORDER_STATUSES, EXCLUDE_SITES, SMARTSTORE_SITE
from .smartstore_product_service import _get_access_token

logger = logging.getLogger(__name__)


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


# ── 비용 계산식 (smartstore_order_service.py와 동일 우선순위) ──

COST_EXPR = """
    CASE
        WHEN o.is_owner_updated=1 AND o.owner_supply_price>0
            THEN o.owner_supply_price
        WHEN o.is_emp_updated=1 AND o.emp_total_payment>0
            THEN o.emp_total_payment
        WHEN o.supply_price>0 THEN o.supply_price
        ELSE 0
    END
"""

# ── 네이버 1차 카테고리 한글명 매핑 ──

TOP_CATEGORY_NAMES = {
    '50000000': '패션의류',
    '50000001': '패션잡화',
    '50000002': '화장품/미용',
    '50000003': '디지털/가전',
    '50000004': '가구/인테리어',
    '50000005': '출산/육아',
    '50000006': '식품',
    '50000007': '스포츠/레저',
    '50000008': '생활/건강',
    '50000009': '여가/생활편의',
    '50000010': '면세점',
    '50000803': '반려동물',
}

STATUS_NAMES = {
    'SALE': '판매중', 'OUTOFSTOCK': '품절', 'SUSPENSION': '판매중지',
    'CLOSE': '종료', 'PROHIBITION': '판매금지', 'UNADMISSION': '미승인',
}

# ── 상품등록한도 단계 (거래액, 판매건, 비중%, 한도) — 높은것부터 매칭 ──
# 50000개: 5000만↑ or 1000건↑, 20000개: 2000만↑ or 400건↑,
# 10000개: 1000만↑ or 200건↑, 5000개: 500만↑ or 100건↑, 1000개: 기본
REGISTRATION_LIMIT_TIERS = [
    (50_000_000, 1000, 3, 50000),
    (20_000_000,  400, 3, 20000),
    (10_000_000,  200, 3, 10000),
    ( 5_000_000,  100, 3,  5000),
    (         0,    0, 0,  1000),
]


# ── 헬퍼 ──

def _base_where():
    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    exclude_ph = ','.join(['%s'] * len(EXCLUDE_SITES))
    where = [
        f'o.order_status IN ({status_ph})',
        f'o.site_name NOT IN ({exclude_ph})',
        'o.site_name = %s',
        "o.product_seller_code IS NOT NULL",
        "o.product_seller_code != ''",
    ]
    params = list(VALID_ORDER_STATUSES) + list(EXCLUDE_SITES) + [SMARTSTORE_SITE]
    return where, params


def _add_date_filter(where, params, start_date, end_date):
    if start_date:
        where.append('o.order_date >= %s')
        params.append(start_date)
    if end_date:
        where.append('o.order_date <= %s')
        params.append(end_date)


def _store_ids_for_business(code):
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT id FROM smartstoreIdList WHERE memo LIKE %s AND is_active=1",
            [f'{code}%'],
        )
        return [r[0] for r in cur.fetchall()]


def _get_stores_map():
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT id, store_name, store_url, memo FROM smartstoreIdList WHERE is_active=1 ORDER BY memo, id"
        )
        rows = _dictfetchall(cur)
    return {r['id']: r for r in rows}


def _parse_business_code(memo):
    if not memo:
        return '99', '기타'
    m = re.match(r'^(\d{2})(.+?)(\d*)$', memo)
    if m:
        return m.group(1), m.group(2)
    return '99', memo


def _store_filter_sql(store_ids):
    if not store_ids:
        return '', []
    ph = ','.join(['%s'] * len(store_ids))
    return (
        f'AND o.product_seller_code IN '
        f'(SELECT seller_management_code FROM myproduct.smartstore_product WHERE store_id IN ({ph}))',
        list(store_ids),
    )


def _period_expr(period):
    return {
        'monthly': "DATE_FORMAT(o.order_date, '%%Y-%%m')",
        'yearly': "CAST(YEAR(o.order_date) AS CHAR)",
    }.get(period, "DATE_FORMAT(o.order_date, '%%Y-%%m')")


# ── 카테고리 이름 캐시 ──

_cat_name_cache = {}


def _load_cat_names():
    global _cat_name_cache
    if _cat_name_cache:
        return _cat_name_cache
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute("SELECT category_id, name FROM naver_category")
            _cat_name_cache = {r[0]: r[1] for r in cur.fetchall()}
    except Exception:
        _cat_name_cache = {}
    for k, v in TOP_CATEGORY_NAMES.items():
        _cat_name_cache.setdefault(k, v)
    return _cat_name_cache


def _cat_name(cat_id):
    names = _load_cat_names()
    return names.get(str(cat_id), str(cat_id) if cat_id else '미분류')


# ══════════════════════════════════════════════════════════
# API 함수
# ══════════════════════════════════════════════════════════

def get_overview(start_date=None, end_date=None):
    """전체 요약 + 14개 사업자별 + 24개 스토어별 브레이크다운"""

    stores_map = _get_stores_map()

    # 1) 스토어별 상품수
    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT p.store_id,
                   COUNT(*) as total_products,
                   SUM(CASE WHEN p.all_order_count > 0 THEN 1 ELSE 0 END) as sold_products
            FROM smartstore_product p
            JOIN smartstoreIdList s ON s.id = p.store_id AND s.is_active=1
            GROUP BY p.store_id
        """)
        product_stats = {r['store_id']: r for r in _dictfetchall(cur)}

    # 2) 스토어별 매출 (크로스DB JOIN)
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT p.store_id,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            JOIN myproduct.smartstore_product p
                ON o.product_seller_code = p.seller_management_code
            WHERE {where_sql}
            GROUP BY p.store_id
        """, params)
        sales_by_store = {r['store_id']: r for r in _dictfetchall(cur)}

    # 3) 스토어별 top 카테고리 (2차 소카테고리 기준 상위 4개)
    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT p.store_id,
                   CASE WHEN p.category_id LIKE '%%>%%'
                        THEN SUBSTRING_INDEX(SUBSTRING_INDEX(p.category_id, '>', 2), '>', -1)
                        ELSE SUBSTRING_INDEX(p.category_id, '>', 1)
                   END as sub_cat,
                   COALESCE(SUM(p.total_order_amount), 0) as amount
            FROM smartstore_product p
            JOIN smartstoreIdList s ON s.id = p.store_id AND s.is_active=1
            WHERE p.category_id IS NOT NULL AND p.category_id != ''
              AND p.total_order_amount > 0
            GROUP BY p.store_id, sub_cat
            ORDER BY p.store_id, amount DESC
        """)
        cat_rows = _dictfetchall(cur)

    store_top_cats = defaultdict(list)
    for r in cat_rows:
        sid = r['store_id']
        if len(store_top_cats[sid]) < 4:
            store_top_cats[sid].append({
                'name': _cat_name(r['sub_cat']),
                'amount': float(r['amount'] or 0),
            })

    # 3-1) 스토어별 최근 13개월 판매 상품 수 (DISTINCT seller_code)
    with connections['joacham'].cursor() as cur:
        cur.execute("""
            SELECT p.store_id,
                   COUNT(DISTINCT o.product_seller_code) as recent_sold_products
            FROM orders_order o
            JOIN myproduct.smartstore_product p
                ON o.product_seller_code = p.seller_management_code
            WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)
              AND o.site_name = '04.스마트스토어'
            GROUP BY p.store_id
        """)
        recent_sold_map = {r['store_id']: int(r['recent_sold_products'] or 0) for r in _dictfetchall(cur)}

    # 4) 사업자별 그룹핑 + all_stores
    biz_map = defaultdict(lambda: {
        'code': '', 'name': '', 'store_ids': [], 'store_names': [],
        'total_revenue': 0, 'total_orders': 0, 'total_profit': 0,
        'total_products': 0, 'sold_products': 0, 'recent_sold_products': 0,
    })
    biz_cat_agg = defaultdict(lambda: defaultdict(float))

    totals = {
        'total_revenue': 0, 'total_orders': 0, 'total_cost': 0,
        'total_profit': 0, 'total_products': 0, 'sold_products': 0,
    }

    all_stores = []

    for sid, info in stores_map.items():
        biz_code, biz_name = _parse_business_code(info.get('memo', ''))
        b = biz_map[biz_code]
        b['code'] = biz_code
        b['name'] = biz_name
        b['store_ids'].append(sid)
        b['store_names'].append(info['store_name'])

        ps = product_stats.get(sid, {})
        tp = int(ps.get('total_products', 0) or 0)
        sp = int(ps.get('sold_products', 0) or 0)
        rsp = recent_sold_map.get(sid, 0)
        b['total_products'] += tp
        b['sold_products'] += sp
        b['recent_sold_products'] += rsp
        totals['total_products'] += tp
        totals['sold_products'] += sp

        ss = sales_by_store.get(sid, {})
        rev = float(ss.get('revenue', 0) or 0)
        settle = float(ss.get('settle', 0) or 0)
        cost = float(ss.get('cost', 0) or 0)
        orders = int(ss.get('order_count', 0) or 0)
        profit = settle - cost

        b['total_revenue'] += rev
        b['total_orders'] += orders
        b['total_profit'] += profit
        totals['total_revenue'] += rev
        totals['total_orders'] += orders
        totals['total_cost'] += cost
        totals['total_profit'] += profit

        # aggregate categories for business
        for cat in store_top_cats.get(sid, []):
            biz_cat_agg[biz_code][cat['name']] += cat['amount']

        # all_stores entry
        all_stores.append({
            'id': sid,
            'store_name': info['store_name'],
            'memo': info.get('memo', ''),
            'revenue': rev,
            'orders': orders,
            'profit': profit,
            'total_products': tp,
            'sold_products': sp,
            'recent_sold_products': rsp,
            'top_categories': store_top_cats.get(sid, []),
        })

    # add top_categories to each business
    for biz_code, b in biz_map.items():
        cats = biz_cat_agg.get(biz_code, {})
        b['top_categories'] = sorted(
            [{'name': n, 'amount': a} for n, a in cats.items()],
            key=lambda x: -x['amount'],
        )[:4]

    businesses = sorted(biz_map.values(), key=lambda x: x['code'])
    all_stores.sort(key=lambda x: (x.get('memo', ''), x['id']))

    # 4) Top 판매상품 (전체 스토어, 상위 50개)
    all_store_ids = list(stores_map.keys())
    top_products = _get_top_products(all_store_ids, start_date, end_date, limit=50, stores_map=stores_map)

    return {'totals': totals, 'businesses': businesses, 'all_stores': all_stores, 'top_products': top_products}


def _calc_3month_period():
    """매월 2일 기준 직전 3개 완전월 기간 계산.
    예: 4/16 → 1/1~3/31, 5/1 → 12/1~2/28, 5/2 → 2/1~4/30"""
    today = date.today()
    if today.day >= 2:
        # 직전 3개월: (month-3)~(month-1)
        end_last = today.replace(day=1) - timedelta(days=1)  # 전월 말일
        start_first = date(
            end_last.year if end_last.month > 2 else end_last.year - 1,
            end_last.month - 2 if end_last.month > 2 else end_last.month + 10,
            1,
        )
    else:
        # 당월 2일 전: (month-4)~(month-2)
        prev = today.replace(day=1) - timedelta(days=1)       # 전월 말일
        end_last = prev.replace(day=1) - timedelta(days=1)    # 전전월 말일
        start_first = date(
            end_last.year if end_last.month > 2 else end_last.year - 1,
            end_last.month - 2 if end_last.month > 2 else end_last.month + 10,
            1,
        )

    start_date = start_first.strftime('%Y-%m-%d')
    end_date = end_last.strftime('%Y-%m-%d')
    period_label = f"{start_first.month}~{end_last.month}월"
    return start_date, end_date, period_label


def _determine_limit(amount, orders, ratio):
    """거래액 OR 판매건 + 비중 조건으로 등록한도 결정"""
    for t_amt, t_ord, t_ratio, t_limit in REGISTRATION_LIMIT_TIERS:
        if t_ratio == 0:
            return t_limit  # 기본 한도
        if ratio >= t_ratio and (amount >= t_amt or orders >= t_ord):
            return t_limit
    return 1000


def _next_tier(current_limit):
    """현재 한도보다 한 단계 위 tier 반환 (없으면 None)"""
    limits = [t[3] for t in REGISTRATION_LIMIT_TIERS]
    limits.sort()
    for lim in limits:
        if lim > current_limit:
            # 해당 한도의 tier 찾기
            for t_amt, t_ord, t_ratio, t_limit in REGISTRATION_LIMIT_TIERS:
                if t_limit == lim:
                    return {'amount': t_amt, 'orders': t_ord, 'ratio': t_ratio, 'limit': t_limit}
    return None


def get_registration_limits():
    """24개 스토어별 상품등록한도 지표 계산"""

    stores_map = _get_stores_map()
    start_date, end_date, period_label = _calc_3month_period()

    # 1) 3개월 주문건수 + 거래액
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT p.store_id,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.payment_price), 0) as transaction_amount
            FROM orders_order o
            JOIN myproduct.smartstore_product p
                ON o.product_seller_code = p.seller_management_code
            WHERE {where_sql}
            GROUP BY p.store_id
        """, params)
        sales_3m = {r['store_id']: r for r in _dictfetchall(cur)}

    # 2) 13개월 판매상품수
    with connections['joacham'].cursor() as cur:
        cur.execute("""
            SELECT p.store_id,
                   COUNT(DISTINCT o.product_seller_code) as recent_sold_products
            FROM orders_order o
            JOIN myproduct.smartstore_product p
                ON o.product_seller_code = p.seller_management_code
            WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 13 MONTH)
              AND o.site_name = '04.스마트스토어'
            GROUP BY p.store_id
        """)
        recent_sold_map = {r['store_id']: int(r['recent_sold_products'] or 0) for r in _dictfetchall(cur)}

    # 3) 현재 상품수 (판매중/대기/품절 — 한도에 포함되는 상태)
    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT p.store_id,
                   COUNT(*) as total_products
            FROM smartstore_product p
            JOIN smartstoreIdList s ON s.id = p.store_id AND s.is_active=1
            GROUP BY p.store_id
        """)
        product_counts = {r['store_id']: int(r['total_products'] or 0) for r in _dictfetchall(cur)}

    # 4) 스토어별 한도 계산
    stores_result = []
    for sid, info in stores_map.items():
        s3 = sales_3m.get(sid, {})
        amount = float(s3.get('transaction_amount', 0) or 0)
        orders = int(s3.get('order_count', 0) or 0)
        recent_sold = recent_sold_map.get(sid, 0)
        total_prods = product_counts.get(sid, 0)

        # 판매상품비중 (소수점 이하 버림)
        ratio = int(recent_sold / total_prods * 100) if total_prods > 0 else 0

        current_limit = _determine_limit(amount, orders, ratio)
        nt = _next_tier(current_limit)

        stores_result.append({
            'store_id': sid,
            'store_name': info['store_name'],
            'transaction_amount': amount,
            'order_count': orders,
            'recent_sold_products': recent_sold,
            'total_products': total_prods,
            'sales_ratio': ratio,
            'current_limit': current_limit,
            'next_limit': nt['limit'] if nt else None,
            'needed_amount': max(0, nt['amount'] - amount) if nt else None,
            'needed_orders': max(0, nt['orders'] - orders) if nt else None,
            'period_label': period_label,
        })

    stores_result.sort(key=lambda x: (-x['current_limit'], -x['transaction_amount']))

    tiers = [
        {'amount': t[0], 'orders': t[1], 'ratio': t[2], 'limit': t[3]}
        for t in REGISTRATION_LIMIT_TIERS
    ]

    return {
        'stores': stores_result,
        'tiers': tiers,
        'period_label': period_label,
        'calculated_at': date.today().isoformat(),
    }


def get_store_detail(store_id, start_date=None, end_date=None, period='monthly'):
    """단일 스토어 상세: summary, trend, categories, top_products"""

    stores_map = _get_stores_map()
    store_info = stores_map.get(store_id, {'id': store_id, 'store_name': '?', 'memo': '', 'store_url': ''})

    store_filter, store_params = _store_filter_sql([store_id])

    # ── summary ──
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            WHERE {where_sql} {store_filter}
        """, params + store_params)
        s = _dictfetchall(cur)[0]

    rev = float(s['revenue'] or 0)
    settle = float(s['settle'] or 0)
    cost = float(s['cost'] or 0)

    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as total, SUM(CASE WHEN all_order_count > 0 THEN 1 ELSE 0 END) as sold
            FROM smartstore_product WHERE store_id = %s
        """, [store_id])
        pr = _dictfetchall(cur)[0]

    summary = {
        'revenue': rev, 'orders': int(s['order_count'] or 0),
        'profit': settle - cost,
        'products': int(pr['total'] or 0), 'sold_products': int(pr['sold'] or 0),
    }

    # ── trend ──
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)
    pe = _period_expr(period)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT {pe} as period,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            WHERE {where_sql} {store_filter}
            GROUP BY period ORDER BY period
        """, params + store_params)
        trend = _dictfetchall(cur)

    for r in trend:
        r['revenue'] = float(r['revenue'] or 0)
        r['settle'] = float(r['settle'] or 0)
        r['cost'] = float(r['cost'] or 0)
        r['profit'] = r['settle'] - r['cost']
        r['order_count'] = int(r['order_count'] or 0)
        r['qty'] = int(r['qty'] or 0)

    # ── categories (3-level tree) ──
    categories = _get_category_tree([store_id])

    # ── top products (with product URL + status) ──
    top_products = _get_top_products([store_id], start_date, end_date)

    return {
        'store': {'id': store_id, 'store_name': store_info['store_name'], 'memo': store_info.get('memo', '')},
        'summary': summary,
        'trend': trend,
        'categories': categories,
        'top_products': top_products,
    }


def get_business_detail(code, start_date=None, end_date=None, period='monthly'):
    """사업자 상세: 소속 스토어별 매출 + 합산 trend/categories/top_products"""

    stores_map = _get_stores_map()
    store_ids = _store_ids_for_business(code)

    if not store_ids:
        return {'code': code, 'name': '?', 'stores': [], 'trend': [], 'categories': [], 'top_products': []}

    _, biz_name = _parse_business_code(
        next((s.get('memo', '') for sid, s in stores_map.items() if sid in store_ids), '')
    )

    # ── 스토어별 개별 매출 ──
    store_filter, store_params = _store_filter_sql(store_ids)
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT p.store_id,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            JOIN myproduct.smartstore_product p
                ON o.product_seller_code = p.seller_management_code
            WHERE {where_sql} AND p.store_id IN ({','.join(['%s']*len(store_ids))})
            GROUP BY p.store_id
        """, params + store_ids)
        store_sales = {r['store_id']: r for r in _dictfetchall(cur)}

    stores_detail = []
    for sid in store_ids:
        info = stores_map.get(sid, {})
        ss = store_sales.get(sid, {})
        rev = float(ss.get('revenue', 0) or 0)
        settle = float(ss.get('settle', 0) or 0)
        cost = float(ss.get('cost', 0) or 0)
        stores_detail.append({
            'id': sid,
            'store_name': info.get('store_name', '?'),
            'memo': info.get('memo', ''),
            'revenue': rev,
            'orders': int(ss.get('order_count', 0) or 0),
            'profit': settle - cost,
        })

    # ── 합산 trend ──
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    where_sql = ' AND '.join(where)
    pe = _period_expr(period)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT {pe} as period,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            WHERE {where_sql} {store_filter}
            GROUP BY period ORDER BY period
        """, params + store_params)
        trend = _dictfetchall(cur)

    for r in trend:
        r['revenue'] = float(r['revenue'] or 0)
        r['settle'] = float(r['settle'] or 0)
        r['cost'] = float(r['cost'] or 0)
        r['profit'] = r['settle'] - r['cost']
        r['order_count'] = int(r['order_count'] or 0)
        r['qty'] = int(r['qty'] or 0)

    # ── categories (3-level tree) ──
    categories = _get_category_tree(store_ids)

    # ── top products (with product URL + status) ──
    top_products = _get_top_products(store_ids, start_date, end_date)

    return {
        'code': code,
        'name': biz_name,
        'stores': stores_detail,
        'trend': trend,
        'categories': categories,
        'top_products': top_products,
    }


# ══════════════════════════════════════════════════════════
# 내부 함수
# ══════════════════════════════════════════════════════════

def _get_category_tree(store_ids):
    """3단계 카테고리 트리: [{id, name, ..., children: [{...}]}]"""
    if not store_ids:
        return []
    ph = ','.join(['%s'] * len(store_ids))
    with connections['myproduct'].cursor() as cur:
        cur.execute(f"""
            SELECT
                SUBSTRING_INDEX(category_id, '>', 1) as cat1,
                CASE WHEN category_id LIKE '%%>%%'
                     THEN SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 2), '>', -1)
                     ELSE NULL END as cat2,
                CASE WHEN category_id LIKE '%%>%%>%%'
                     THEN SUBSTRING_INDEX(SUBSTRING_INDEX(category_id, '>', 3), '>', -1)
                     ELSE NULL END as cat3,
                COUNT(*) as product_count,
                SUM(CASE WHEN all_order_count > 0 THEN 1 ELSE 0 END) as sold_count,
                COALESCE(SUM(total_order_qty), 0) as total_qty,
                COALESCE(SUM(total_order_amount), 0) as total_amount
            FROM smartstore_product
            WHERE store_id IN ({ph}) AND category_id IS NOT NULL AND category_id != ''
            GROUP BY cat1, cat2, cat3
            ORDER BY total_amount DESC
        """, list(store_ids))
        rows = _dictfetchall(cur)

    # Build tree
    tree = {}  # cat1_id -> node
    for r in rows:
        c1 = r['cat1']
        c2 = r['cat2']
        c3 = r['cat3']
        pc = int(r['product_count'] or 0)
        sc = int(r['sold_count'] or 0)
        qty = int(r['total_qty'] or 0)
        amt = float(r['total_amount'] or 0)

        # Level 1
        if c1 not in tree:
            tree[c1] = {
                'id': c1, 'name': _cat_name(c1),
                'product_count': 0, 'sold_count': 0, 'total_qty': 0, 'total_amount': 0,
                '_children': {},
            }
        n1 = tree[c1]
        n1['product_count'] += pc
        n1['sold_count'] += sc
        n1['total_qty'] += qty
        n1['total_amount'] += amt

        if not c2:
            continue

        # Level 2
        if c2 not in n1['_children']:
            n1['_children'][c2] = {
                'id': c2, 'name': _cat_name(c2),
                'product_count': 0, 'sold_count': 0, 'total_qty': 0, 'total_amount': 0,
                '_children': {},
            }
        n2 = n1['_children'][c2]
        n2['product_count'] += pc
        n2['sold_count'] += sc
        n2['total_qty'] += qty
        n2['total_amount'] += amt

        if not c3:
            continue

        # Level 3
        if c3 not in n2['_children']:
            n2['_children'][c3] = {
                'id': c3, 'name': _cat_name(c3),
                'product_count': 0, 'sold_count': 0, 'total_qty': 0, 'total_amount': 0,
            }
        n3 = n2['_children'][c3]
        n3['product_count'] += pc
        n3['sold_count'] += sc
        n3['total_qty'] += qty
        n3['total_amount'] += amt

    # Convert to list + sort by total_amount DESC
    def _to_list(nodes_dict):
        result = []
        for node in nodes_dict.values():
            out = {
                'id': node['id'], 'name': node['name'],
                'product_count': node['product_count'],
                'sold_count': node['sold_count'],
                'total_qty': node['total_qty'],
                'total_amount': node['total_amount'],
            }
            children = node.get('_children')
            if children:
                out['children'] = _to_list(children)
            result.append(out)
        result.sort(key=lambda x: -x['total_amount'])
        return result

    return _to_list(tree)


def _get_top_products(store_ids, start_date=None, end_date=None, limit=20, stores_map=None):
    """Top 판매상품 + 스마트스토어 상품 URL/판매상태/스토어명"""
    where, params = _base_where()
    _add_date_filter(where, params, start_date, end_date)
    store_filter, store_params = _store_filter_sql(store_ids)
    where_sql = ' AND '.join(where)

    with connections['joacham'].cursor() as cur:
        cur.execute(f"""
            SELECT o.product_seller_code as seller_code,
                   MAX(o.product_name) as product_name,
                   COUNT(*) as order_count,
                   COALESCE(SUM(o.quantity), 0) as qty,
                   COALESCE(SUM(o.payment_price), 0) as revenue,
                   COALESCE(SUM(o.settlement_price), 0) as settle,
                   COALESCE(SUM({COST_EXPR}), 0) as cost
            FROM orders_order o
            WHERE {where_sql} {store_filter}
            GROUP BY o.product_seller_code
            ORDER BY revenue DESC
            LIMIT %s
        """, params + store_params + [limit])
        rows = _dictfetchall(cur)

    # Batch lookup product details
    seller_codes = [r['seller_code'] for r in rows if r.get('seller_code')]
    product_map = {}
    if seller_codes:
        ph = ','.join(['%s'] * len(seller_codes))
        with connections['myproduct'].cursor() as cur:
            cur.execute(f"""
                SELECT p.seller_management_code,
                       p.channel_product_no,
                       p.status_type,
                       p.store_id,
                       s.store_url,
                       s.store_name
                FROM smartstore_product p
                LEFT JOIN smartstoreIdList s ON s.id = p.store_id
                WHERE p.seller_management_code IN ({ph})
            """, seller_codes)
            for pr in _dictfetchall(cur):
                product_map[pr['seller_management_code']] = pr

    for r in rows:
        r['revenue'] = float(r['revenue'] or 0)
        r['cost'] = float(r['cost'] or 0)
        r['profit'] = float(r.get('settle', 0) or 0) - r['cost']
        r['order_count'] = int(r['order_count'] or 0)
        r['qty'] = int(r['qty'] or 0)
        r.pop('settle', None)

        # Add product URL + status + store_name + channel_product_no
        pinfo = product_map.get(r.get('seller_code', ''))
        r['channel_product_no'] = pinfo.get('channel_product_no') if pinfo else None
        if pinfo and pinfo.get('channel_product_no') and pinfo.get('store_url'):
            r['product_url'] = f"https://smartstore.naver.com/{pinfo['store_url']}/products/{pinfo['channel_product_no']}"
        else:
            r['product_url'] = None
        if pinfo and pinfo.get('status_type'):
            r['status'] = STATUS_NAMES.get(pinfo['status_type'], pinfo['status_type'])
            r['status_type'] = pinfo['status_type']
        else:
            r['status'] = None
            r['status_type'] = None
        # store_name
        if pinfo and pinfo.get('store_name'):
            r['store_name'] = pinfo['store_name']
        elif pinfo and pinfo.get('store_id') and stores_map:
            si = stores_map.get(pinfo['store_id'])
            r['store_name'] = si['store_name'] if si else None
        else:
            r['store_name'] = None

    return rows


# ══════════════════════════════════════════════════════════
# 카테고리 동기화
# ══════════════════════════════════════════════════════════

def sync_category_names():
    """네이버 커머스 API로 카테고리명 수집 → naver_category 테이블 UPSERT"""
    # 1) 모든 category_id 세그먼트 수집
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT DISTINCT category_id FROM smartstore_product "
            "WHERE category_id IS NOT NULL AND category_id != ''"
        )
        all_paths = [r[0] for r in cur.fetchall()]

    all_ids = set()
    for path in all_paths:
        segments = path.split('>')
        for seg in segments:
            seg = seg.strip()
            if seg:
                all_ids.add(seg)

    # 2) 이미 캐시된 것 제외
    with connections['myproduct'].cursor() as cur:
        cur.execute("SELECT category_id FROM naver_category")
        existing = {r[0] for r in cur.fetchall()}

    missing = all_ids - existing
    if not missing:
        return {'synced': 0, 'total': len(existing), 'message': '이미 전부 동기화됨'}

    # 3) 아무 스토어의 API 키로 토큰 발급
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT commerce_api_key, commerce_secret_key FROM smartstoreIdList "
            "WHERE is_active=1 AND commerce_api_key IS NOT NULL AND commerce_api_key != '' LIMIT 1"
        )
        row = cur.fetchone()
    if not row:
        return {'error': 'API 키 없음'}

    api_key, api_secret = row[0], row[1]
    token = _get_access_token(api_key, api_secret)
    headers = {'Authorization': f'Bearer {token}'}

    synced = 0
    errors = 0
    batch_count = 0
    for cat_id in sorted(missing):
        # Refresh token every 500 requests
        if batch_count > 0 and batch_count % 500 == 0:
            try:
                token = _get_access_token(api_key, api_secret)
                headers = {'Authorization': f'Bearer {token}'}
            except Exception:
                pass
        batch_count += 1
        try:
            resp = requests.get(
                f'https://api.commerce.naver.com/external/v1/categories/{cat_id}',
                headers=headers, timeout=10,
            )
            if resp.status_code == 200:
                d = resp.json()
                name = d.get('name', cat_id)
                # wholeCategoryName: "생활/건강>공구" → parse parent
                whole = d.get('wholeCategoryName', '')
                parts = whole.split('>') if whole else []
                parent = None
                level = len(parts) if parts else 1
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "INSERT INTO naver_category (category_id, parent_id, name, level) "
                        "VALUES (%s, %s, %s, %s) "
                        "ON DUPLICATE KEY UPDATE name=VALUES(name), parent_id=VALUES(parent_id), level=VALUES(level)",
                        [cat_id, str(parent) if parent else None, name, level],
                    )
                synced += 1
            else:
                errors += 1
        except Exception as e:
            logger.warning('Category sync error for %s: %s', cat_id, e)
            errors += 1
        time.sleep(0.05)

    # 캐시 초기화
    global _cat_name_cache
    _cat_name_cache = {}

    return {'synced': synced, 'errors': errors, 'total': len(existing) + synced}
