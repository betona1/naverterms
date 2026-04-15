from datetime import datetime, timedelta
from django.db import connections


VALID_ORDER_STATUSES = (
    '고객주문', '신규주문', '배송준비', '입금확인', '배송준비중',
    '배송중', '배송완료', '거래완료', '오더완료',
)

EXCLUDE_SITES = ("", "사무실사입", "전화주문", "문자주문")


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _mask_name(name):
    """개인정보 마스킹: 이종우 → 이*우, 김수 → 김*, A → *"""
    if not name:
        return ''
    name = name.strip()
    if len(name) <= 1:
        return '*'
    if len(name) == 2:
        return name[0] + '*'
    return name[0] + '*' * (len(name) - 2) + name[-1]


def get_product_orders(seller_code=None, product_name=None, start_date=None, end_date=None):
    """상품 관리코드 또는 상품명으로 주문이력 조회 (joacham.orders_order)"""
    if not seller_code and not product_name:
        return {'orders': [], 'summary': _empty_summary(), 'by_site': []}

    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    exclude_ph = ','.join(['%s'] * len(EXCLUDE_SITES))

    where = [
        f'order_status IN ({status_ph})',
        f'site_name NOT IN ({exclude_ph})',
    ]
    params = list(VALID_ORDER_STATUSES) + list(EXCLUDE_SITES)

    if seller_code:
        where.append('product_seller_code = %s')
        params.append(seller_code)
    else:
        where.append('product_name = %s')
        params.append(product_name)

    if start_date and end_date:
        where.append('order_date BETWEEN %s AND %s')
        params.extend([start_date, end_date])
    elif start_date:
        where.append('order_date >= %s')
        params.append(start_date)

    where_sql = ' AND '.join(where)

    sql = f"""
        SELECT
            order_date, site_name, order_status, quantity,
            payment_price, settlement_price, receiver_name,
            order_option, bid_number, product_name, product_seller_code,
            CASE
                WHEN is_owner_updated=1 AND owner_supply_price>0 THEN owner_supply_price
                WHEN is_emp_updated=1 AND emp_total_payment>0 THEN emp_total_payment
                WHEN supply_price>0 THEN supply_price
                ELSE 0
            END AS cost
        FROM orders_order
        WHERE {where_sql}
        ORDER BY
            CASE WHEN site_name = %s THEN 0 ELSE 1 END,
            order_date DESC, id DESC
    """

    with connections['joacham'].cursor() as cur:
        cur.execute(sql, params + [SMARTSTORE_SITE])
        rows = _dictfetchall(cur)

    orders = []
    site_agg = {}  # site_name → {qty, amount, count}
    for r in rows:
        settle = r['settlement_price'] or 0
        cost = r['cost'] or 0
        profit = settle - cost
        qty = r['quantity'] or 0
        payment = r['payment_price'] or 0
        od = r['order_date']
        site = r['site_name'] or ''

        orders.append({
            'order_date': od.strftime('%Y-%m-%d') if hasattr(od, 'strftime') else str(od),
            'site_name': site,
            'order_status': r['order_status'],
            'quantity': qty,
            'payment_price': payment,
            'settlement_price': settle,
            'cost': cost,
            'profit': profit,
            'receiver_name': _mask_name(r['receiver_name']),
            'order_option': r['order_option'] or '',
            'bid_number': r['bid_number'] or '',
            'product_name': r['product_name'] or '',
            'product_seller_code': r['product_seller_code'] or '',
        })

        if site not in site_agg:
            site_agg[site] = {'site_name': site, 'count': 0, 'qty': 0, 'amount': 0}
        site_agg[site]['count'] += 1
        site_agg[site]['qty'] += qty
        site_agg[site]['amount'] += payment

    # 스마트스토어 먼저, 나머지 건수 내림차순
    by_site = sorted(site_agg.values(), key=lambda x: (0 if x['site_name'] == SMARTSTORE_SITE else 1, -x['count']))

    summary = _calc_summary(orders)
    return {'orders': orders, 'summary': summary, 'by_site': by_site}


def _calc_summary(orders):
    count = len(orders)
    total_qty = sum(o['quantity'] for o in orders)
    total_payment = sum(o['payment_price'] for o in orders)
    total_settle = sum(o['settlement_price'] for o in orders)
    total_cost = sum(o['cost'] for o in orders)
    total_profit = sum(o['profit'] for o in orders)
    return {
        'count': count,
        'total_qty': total_qty,
        'total_payment': total_payment,
        'total_settle': total_settle,
        'total_cost': total_cost,
        'total_profit': total_profit,
    }


def _empty_summary():
    return {'count': 0, 'total_qty': 0, 'total_payment': 0, 'total_settle': 0, 'total_cost': 0, 'total_profit': 0}


# ── 판매 코드 캐시 ──

_sold_cache = {'codes': set(), 'ts': 0}

SMARTSTORE_SITE = '04.스마트스토어'


def get_sold_seller_codes():
    """스마트스토어 주문이 1건 이상 있는 product_seller_code 집합 (5분 캐시)"""
    import time as _time
    now = _time.time()
    if now - _sold_cache['ts'] < 300 and _sold_cache['codes']:
        return _sold_cache['codes']

    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    sql = f"""
        SELECT DISTINCT product_seller_code
        FROM orders_order
        WHERE order_status IN ({status_ph})
          AND site_name = %s
          AND product_seller_code IS NOT NULL
          AND product_seller_code != ''
    """
    params = list(VALID_ORDER_STATUSES) + [SMARTSTORE_SITE]
    with connections['joacham'].cursor() as cur:
        cur.execute(sql, params)
        codes = set(r[0] for r in cur.fetchall())

    _sold_cache['codes'] = codes
    _sold_cache['ts'] = now
    return codes


def update_product_sales_summary():
    """joacham.orders_order 집계 → smartstore_product 판매 데이터 업데이트
    total_order_* = 스마트스토어만, all_order_* = 전체 사이트"""
    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    exclude_ph = ','.join(['%s'] * len(EXCLUDE_SITES))

    with connections['joacham'].cursor() as cur:
        # 스마트스토어만
        cur.execute(f"""
            SELECT product_seller_code,
                   COALESCE(SUM(quantity), 0),
                   COALESCE(SUM(payment_price), 0)
            FROM orders_order
            WHERE order_status IN ({status_ph})
              AND site_name = %s
              AND product_seller_code IS NOT NULL AND product_seller_code != ''
            GROUP BY product_seller_code
        """, list(VALID_ORDER_STATUSES) + [SMARTSTORE_SITE])
        ss_rows = {r[0]: (int(r[1]), int(r[2])) for r in cur.fetchall()}

        # 전체 사이트
        cur.execute(f"""
            SELECT product_seller_code,
                   COALESCE(SUM(quantity), 0),
                   COALESCE(SUM(payment_price), 0)
            FROM orders_order
            WHERE order_status IN ({status_ph})
              AND site_name NOT IN ({exclude_ph})
              AND product_seller_code IS NOT NULL AND product_seller_code != ''
            GROUP BY product_seller_code
        """, list(VALID_ORDER_STATUSES) + list(EXCLUDE_SITES))
        all_rows = {r[0]: (int(r[1]), int(r[2])) for r in cur.fetchall()}

    codes = set(ss_rows) | set(all_rows)
    if not codes:
        return 0

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "UPDATE smartstore_product SET total_order_qty=0, total_order_amount=0, "
            "all_order_qty=0, all_order_amount=0 "
            "WHERE total_order_qty>0 OR total_order_amount>0 OR all_order_qty>0 OR all_order_amount>0"
        )
        cur.execute(
            "CREATE TEMPORARY TABLE _tmp_oagg ("
            "code VARCHAR(50) PRIMARY KEY, ss_qty INT, ss_amt INT, all_qty INT, all_amt INT)"
        )
        items = list(codes)
        batch = 1000
        for i in range(0, len(items), batch):
            chunk = items[i:i + batch]
            vals = ','.join(['(%s,%s,%s,%s,%s)'] * len(chunk))
            params = []
            for c in chunk:
                sq, sa = ss_rows.get(c, (0, 0))
                aq, aa = all_rows.get(c, (0, 0))
                params.extend([c, sq, sa, aq, aa])
            cur.execute(f"INSERT INTO _tmp_oagg VALUES {vals}", params)
        cur.execute(
            "UPDATE smartstore_product p JOIN _tmp_oagg t ON p.seller_management_code = t.code "
            "SET p.total_order_qty=t.ss_qty, p.total_order_amount=t.ss_amt, "
            "p.all_order_qty=t.all_qty, p.all_order_amount=t.all_amt"
        )
        updated = cur.rowcount
        cur.execute("DROP TEMPORARY TABLE _tmp_oagg")

    _sold_cache['ts'] = 0
    return updated
