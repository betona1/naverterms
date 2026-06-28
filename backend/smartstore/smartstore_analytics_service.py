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
            "SELECT id, store_id, store_name, store_url, memo FROM smartstoreIdList WHERE is_active=1 ORDER BY memo, id"
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


def _norm_store_name(name):
    """끝자리 숫자/공백 무시한 정규화 (조아마미1 == 조아마미)."""
    return re.sub(r'\d+$', '', (name or '').strip())


def _load_policy_snapshots():
    """최신 정책 스냅샷 로드.
    반환: (by_pk, by_login_name) — store_pk 매칭 + (login_id, 정규화이름) 폴백 매칭."""
    by_pk = {}
    by_login_name = {}
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute("SHOW TABLES LIKE 'smartstore_seller_policy_snapshot'")
            if not cur.fetchone():
                return by_pk, by_login_name
            # 스토어별(store_pk 또는 login+name) 최신 1건
            cur.execute("""
                SELECT t.store_pk, t.login_id, t.store_name, t.sale_limit_count, t.applied_ymd,
                       t.cumulation_sale_amount, t.cumulation_sale_count,
                       t.monthly_sale_active_ratio, t.sale_active_ratio,
                       t.product_count_90d_avg, t.sale_product_count_400d,
                       t.captured_date
                FROM smartstore_seller_policy_snapshot t
                JOIN (
                    SELECT login_id, store_name, MAX(captured_date) md
                    FROM smartstore_seller_policy_snapshot
                    WHERE sale_limit_count IS NOT NULL
                    GROUP BY login_id, store_name
                ) m ON m.login_id = t.login_id AND m.store_name = t.store_name
                   AND m.md = t.captured_date
                WHERE t.sale_limit_count IS NOT NULL
            """)
            for r in _dictfetchall(cur):
                if r['store_pk'] is not None:
                    by_pk[r['store_pk']] = r
                key = (r['login_id'], _norm_store_name(r['store_name']))
                by_login_name.setdefault(key, r)
    except Exception:
        pass
    return by_pk, by_login_name


def _load_policy_history():
    """스토어별 평균등록상품수(90일) 시계열 — (date, avg_reg, monthly_ratio).
    반환: (by_pk, by_login_name) 각 값은 날짜순 정렬 리스트."""
    by_pk = defaultdict(list)
    by_login_name = defaultdict(list)
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute("SHOW TABLES LIKE 'smartstore_seller_policy_snapshot'")
            if not cur.fetchone():
                return {}, {}
            cur.execute("""
                SELECT store_pk, login_id, store_name, captured_date,
                       product_count_90d_avg, monthly_sale_active_ratio
                FROM smartstore_seller_policy_snapshot
                WHERE sale_limit_count IS NOT NULL AND product_count_90d_avg IS NOT NULL
                ORDER BY captured_date
            """)
            for r in _dictfetchall(cur):
                pt = (r['captured_date'], int(r['product_count_90d_avg']),
                      float(r['monthly_sale_active_ratio']) if r['monthly_sale_active_ratio'] is not None else None)
                if r['store_pk'] is not None:
                    by_pk[r['store_pk']].append(pt)
                by_login_name[(r['login_id'], _norm_store_name(r['store_name']))].append(pt)
    except Exception:
        pass
    return by_pk, by_login_name


def _linfit_slope(xs, ys):
    """일별 기울기 (최소제곱). 데이터 부족/수직이면 None."""
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / den


def _project_3pct_eta(series, reg_target, total_prods, monthly_ratio):
    """평균등록상품수(90일) 추세로 3% 도달 예상시점 추정.
    반환 dict: trend_points, avg_slope_per_day, eta_days, eta_date, status."""
    out = {'trend_points': len(series), 'avg_slope_per_day': None,
           'eta_days': None, 'eta_date': None, 'status': 'collecting'}
    if not series or reg_target is None:
        return out
    latest_date, latest_avg, _ = series[-1]
    # 이미 3% 충족
    if monthly_ratio is not None and monthly_ratio >= 3.0:
        out['status'] = 'met'
        out['eta_days'] = 0
        return out
    # 현재 등록수가 목표보다 많으면 대기로는 불가 (추가 감축 필요)
    if total_prods > reg_target:
        out['status'] = 'need_reduce'
        return out
    # 추세 외삽 (2점 이상)
    if len(series) >= 2:
        x0 = series[0][0]
        xs = [(d - x0).days for d, _, _ in series]
        ys = [a for _, a, _ in series]
        slope = _linfit_slope(xs, ys)
        out['avg_slope_per_day'] = round(slope, 2) if slope is not None else None
        if slope is not None and slope < 0 and latest_avg > reg_target:
            days = (latest_avg - reg_target) / (-slope)
            days = max(1, min(int(round(days)), 90))  # 0~90일 클램프 (90일이면 완전 수렴)
            out['eta_days'] = days
            out['eta_date'] = (latest_date + timedelta(days=days)).isoformat()
            out['status'] = 'projected'
            return out
        if slope is not None and slope >= 0:
            out['status'] = 'no_decline'
            return out
    # 데이터 부족 (1점) — 현재 등록수가 목표 이하면 수렴 시 도달 예상
    out['status'] = 'collecting'
    return out


def get_policy_trend(store_id=None):
    """정책 스냅샷 시계열 — store_id 지정 시 해당 스토어, 아니면 전체 스토어별."""
    stores_map = _get_stores_map()
    targets = [store_id] if store_id else list(stores_map.keys())
    result = []
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute("SHOW TABLES LIKE 'smartstore_seller_policy_snapshot'")
            if not cur.fetchone():
                return {'stores': []}
            for sid in targets:
                info = stores_map.get(sid)
                if not info:
                    continue
                cur.execute("""
                    SELECT captured_date, sale_limit_count, product_count_90d_avg,
                           sale_product_count_400d, monthly_sale_active_ratio, sale_active_ratio
                    FROM smartstore_seller_policy_snapshot
                    WHERE (store_pk=%s OR (login_id=%s AND store_name=%s))
                      AND sale_limit_count IS NOT NULL
                    ORDER BY captured_date
                """, [sid, info.get('store_id'), info['store_name']])
                rows = _dictfetchall(cur)
                if not rows:
                    continue
                result.append({
                    'store_id': sid,
                    'store_name': info['store_name'],
                    'points': [{
                        'date': r['captured_date'].isoformat(),
                        'limit': r['sale_limit_count'],
                        'avg_reg': r['product_count_90d_avg'],
                        'sold': r['sale_product_count_400d'],
                        'monthly_ratio': float(r['monthly_sale_active_ratio']) if r['monthly_sale_active_ratio'] is not None else None,
                        'daily_ratio': float(r['sale_active_ratio']) if r['sale_active_ratio'] is not None else None,
                    } for r in rows],
                })
    except Exception:
        pass
    return {'stores': result}


def get_registration_limits():
    """24개 스토어별 상품등록한도 지표 — 네이버 API 실제값 우선, 미수집은 추정값."""

    stores_map = _get_stores_map()
    start_date, end_date, period_label = _calc_3month_period()
    snaps_by_pk, snaps_by_login_name = _load_policy_snapshots()
    hist_by_pk, hist_by_login_name = _load_policy_history()

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

        # 네이버 API 실제값 우선 (store_pk → login+정규화이름 폴백) — 없으면 추정 tier
        snap = snaps_by_pk.get(sid)
        if snap is None:
            snap = snaps_by_login_name.get((info.get('store_id'), _norm_store_name(info['store_name'])))
        if snap and snap.get('sale_limit_count') is not None:
            current_limit = int(snap['sale_limit_count'])
            limit_source = 'api'
        else:
            current_limit = _determine_limit(amount, orders, ratio)
            limit_source = 'estimate'
        nt = _next_tier(current_limit)

        # 원본 사업자명 (memo 02비트마인드2 → 비트마인드)
        _, biz_name = _parse_business_code(info.get('memo'))

        # 판매상품비중(이번달) — 3% 미만이면 기본 1,000개 한도
        monthly_ratio = float(snap['monthly_sale_active_ratio']) if snap and snap.get('monthly_sale_active_ratio') is not None else None

        # 비중 3% 도달 목표: 평균등록상품수 ≤ 판매상품수 / 0.03
        api_sold = int(snap['sale_product_count_400d']) if snap and snap.get('sale_product_count_400d') is not None else None
        api_avg_reg = int(snap['product_count_90d_avg']) if snap and snap.get('product_count_90d_avg') is not None else None
        reg_target_3pct = round(api_sold / 0.03) if api_sold else None     # 평균등록 이 이하면 3% 충족
        # 90일 평균을 목표 이하로 낮추려면 줄여야 할 양 (후행지표 기준)
        reg_reduce_avg = max(0, api_avg_reg - reg_target_3pct) if (api_avg_reg is not None and reg_target_3pct is not None) else None
        # 현재 등록수(우리 DB)가 이미 목표 이하면 90일 평균 반영 시 자동 도달 예상
        reg_current_ok = (reg_target_3pct is not None and total_prods <= reg_target_3pct)

        # 90일 평균 추세로 3% 도달 예상시점
        series = hist_by_pk.get(sid) or hist_by_login_name.get(
            (info.get('store_id'), _norm_store_name(info['store_name']))) or []
        eta = _project_3pct_eta(series, reg_target_3pct, total_prods, monthly_ratio)

        stores_result.append({
            'store_id': sid,
            'store_name': info['store_name'],
            'login_id': info.get('store_id'),       # 원본 로그인 아이디
            'business_name': biz_name,              # 원본 사업자명
            'transaction_amount': amount,
            'order_count': orders,
            'recent_sold_products': recent_sold,
            'total_products': total_prods,
            'sales_ratio': ratio,
            'current_limit': current_limit,
            'limit_source': limit_source,
            'next_limit': nt['limit'] if nt else None,
            'needed_amount': max(0, nt['amount'] - amount) if nt else None,
            'needed_orders': max(0, nt['orders'] - orders) if nt else None,
            'period_label': period_label,
            # ── 네이버 API 실제값 (limit_source=='api' 일 때 유효) ──
            'applied_ymd': snap.get('applied_ymd') if snap else None,
            'api_sale_amount': int(snap['cumulation_sale_amount']) if snap and snap.get('cumulation_sale_amount') is not None else None,
            'api_sale_count': int(snap['cumulation_sale_count']) if snap and snap.get('cumulation_sale_count') is not None else None,
            'api_monthly_ratio': monthly_ratio,
            'api_daily_ratio': float(snap['sale_active_ratio']) if snap and snap.get('sale_active_ratio') is not None else None,
            'api_90d_avg': int(snap['product_count_90d_avg']) if snap and snap.get('product_count_90d_avg') is not None else None,
            'api_sale_product_count': api_sold,
            'ratio_ok': (monthly_ratio is not None and monthly_ratio >= 3.0),
            'reg_target_3pct': reg_target_3pct,       # 3% 도달 목표 평균등록수
            'reg_reduce_avg': reg_reduce_avg,         # 90일평균 기준 줄여야 할 양
            'reg_current_ok': reg_current_ok,         # 현재 등록수가 이미 목표 이하
            # ── 90일 평균 추세 → 3% 도달 예상시점 ──
            'trend_points': eta['trend_points'],      # 보유 스냅샷 일수
            'avg_slope_per_day': eta['avg_slope_per_day'],  # 평균등록 일별 변화량
            'eta_days': eta['eta_days'],              # 3% 도달까지 예상 일수
            'eta_date': eta['eta_date'],              # 예상 도달 날짜
            'eta_status': eta['status'],              # met/projected/collecting/need_reduce/no_decline
            'captured_date': snap['captured_date'].isoformat() if snap and snap.get('captured_date') else None,
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
