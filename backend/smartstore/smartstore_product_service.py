import time
import base64
import logging
from datetime import datetime

import bcrypt
import requests
from django.db import connections

logger = logging.getLogger(__name__)

NAVER_TOKEN_URL = 'https://api.commerce.naver.com/external/v1/oauth2/token'
NAVER_PRODUCTS_URL = 'https://api.commerce.naver.com/external/v1/products/search'


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _serialize_row(row):
    for key in ('synced_at', 'created_at', 'updated_at'):
        if row.get(key) and isinstance(row[key], datetime):
            row[key] = row[key].isoformat()
    return row


def _get_access_token(client_id, client_secret):
    """네이버 커머스 API OAuth2 토큰 발급 (bcrypt 서명)"""
    timestamp = int(time.time() * 1000)
    password = f'{client_id}_{timestamp}'
    hashed = bcrypt.hashpw(password.encode('utf-8'), client_secret.encode('utf-8'))
    signature = base64.b64encode(hashed).decode('utf-8')

    resp = requests.post(NAVER_TOKEN_URL, data={
        'client_id': client_id,
        'timestamp': timestamp,
        'client_secret_sign': signature,
        'grant_type': 'client_credentials',
        'type': 'SELF',
    }, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data['access_token']


def _fetch_products_page(token, page=1, size=100):
    """네이버 커머스 상품 검색 API 호출 (1페이지)"""
    headers = {'Authorization': f'Bearer {token}'}
    body = {
        'page': page,
        'size': size,
    }
    resp = requests.post(NAVER_PRODUCTS_URL, json=body, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_all_products_from_naver(client_id, client_secret):
    """전체 상품 페이징 수집"""
    token = _get_access_token(client_id, client_secret)
    all_products = []
    page = 1
    size = 100
    while True:
        data = _fetch_products_page(token, page, size)
        contents = data.get('contents', [])
        if not contents:
            break
        all_products.extend(contents)
        total_pages = data.get('totalPages', 1)
        if page >= total_pages:
            break
        page += 1
    return all_products


def sync_products(store_pk):
    """DB의 store 정보로 API 호출 → UPSERT → 결과 반환"""
    # store 조회
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT id, store_name, commerce_api_key, commerce_secret_key "
            "FROM smartstoreIdList WHERE id=%s",
            [store_pk],
        )
        rows = _dictfetchall(cur)
        if not rows:
            return {'error': '상점을 찾을 수 없습니다.'}
        store = rows[0]

    api_key = store.get('commerce_api_key')
    secret_key = store.get('commerce_secret_key')
    if not api_key or not secret_key:
        return {'error': 'API 키가 등록되지 않았습니다.'}

    try:
        products = fetch_all_products_from_naver(api_key, secret_key)
    except Exception as e:
        logger.exception('Naver API error for store %s', store_pk)
        return {'error': f'네이버 API 오류: {str(e)}'}

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    upserted = 0

    with connections['myproduct'].cursor() as cur:
        for p in products:
            origin_no = p.get('originProductNo')
            if not origin_no:
                continue

            # channelProducts[0] 에서 상세 정보 추출
            cp = {}
            channel_list = p.get('channelProducts', [])
            if channel_list:
                cp = channel_list[0]

            channel_no = cp.get('channelProductNo')
            name = (cp.get('name') or p.get('name') or '')[:500]
            sale_price = cp.get('salePrice', 0) or 0
            stock_qty = cp.get('stockQuantity', 0) or 0
            status = cp.get('statusType', '')
            display_status = cp.get('channelProductDisplayStatusType', '')
            mgmt_code = cp.get('sellerManagementCode', '') or ''
            category_id = cp.get('wholeCategoryId', '') or cp.get('categoryId', '') or ''

            # 대표 이미지
            image_url = ''
            rep_img = cp.get('representativeImage')
            if isinstance(rep_img, dict):
                image_url = rep_img.get('url', '')

            cur.execute("""
                INSERT INTO smartstore_product
                    (store_id, origin_product_no, channel_product_no, name,
                     sale_price, stock_quantity, status_type,
                     channel_product_display_status_type,
                     seller_management_code, category_id, product_image_url,
                     synced_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    channel_product_no=VALUES(channel_product_no),
                    name=VALUES(name),
                    sale_price=VALUES(sale_price),
                    stock_quantity=VALUES(stock_quantity),
                    status_type=VALUES(status_type),
                    channel_product_display_status_type=VALUES(channel_product_display_status_type),
                    seller_management_code=VALUES(seller_management_code),
                    category_id=VALUES(category_id),
                    product_image_url=VALUES(product_image_url),
                    synced_at=VALUES(synced_at)
            """, [
                store_pk, origin_no, channel_no, name,
                sale_price, stock_qty, status, display_status,
                mgmt_code, category_id, image_url, now,
            ])
            upserted += 1

    return {
        'synced': upserted,
        'total_from_api': len(products),
        'store_name': store['store_name'],
        'synced_at': now,
    }


SORT_COLUMNS = {
    'sale_price': 'p.sale_price',
    'stock': 'p.stock_quantity',
    'order_amount': 'p.all_order_amount',
    'order_qty': 'p.all_order_qty',
}


def get_products(store_pk, page=1, per_page=50, status=None, search=None,
                 ownerclan_soldout=None, is_focus=None, has_orders=None,
                 sort_by=None, sort_dir=None):
    """DB에서 상품 목록 조회 (페이지네이션, 필터, 정렬). store_pk=0이면 전체상점."""
    from . import smartstore_order_service
    sold_codes = smartstore_order_service.get_sold_seller_codes()

    all_stores = (store_pk == 0)
    where = []
    params = []

    if not all_stores:
        where.append('p.store_id = %s')
        params.append(store_pk)
    if status:
        where.append('p.status_type = %s')
        params.append(status)
    if search:
        where.append('(p.name LIKE %s OR p.seller_management_code LIKE %s)')
        like = f'%{search}%'
        params.extend([like, like])
    if ownerclan_soldout is not None:
        where.append('p.ownerclan_soldout = %s')
        params.append(int(ownerclan_soldout))
    if is_focus is not None:
        where.append('p.is_focus = %s')
        params.append(int(is_focus))
    if has_orders is not None:
        if not sold_codes:
            return {'items': [], 'total': 0, 'page': page, 'per_page': per_page, 'total_pages': 0}
        sold_list = list(sold_codes)
        sold_ph = ','.join(['%s'] * len(sold_list))
        where.append(f'p.seller_management_code IN ({sold_ph})')
        params.extend(sold_list)

    where_sql = ' AND '.join(where) if where else '1=1'
    offset = (page - 1) * per_page

    # 정렬
    col = SORT_COLUMNS.get(sort_by or '')
    direction = 'ASC' if sort_dir == 'asc' else 'DESC'
    order_sql = f'{col} {direction}, p.origin_product_no DESC' if col else 'p.origin_product_no DESC'

    with connections['myproduct'].cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM smartstore_product p WHERE {where_sql}", params)
        total = cur.fetchone()[0]

        if all_stores:
            cur.execute(
                f"SELECT p.*, s.store_name FROM smartstore_product p "
                f"JOIN smartstoreIdList s ON s.id = p.store_id "
                f"WHERE {where_sql} "
                f"ORDER BY {order_sql} LIMIT %s OFFSET %s",
                params + [per_page, offset],
            )
        else:
            cur.execute(
                f"SELECT p.* FROM smartstore_product p WHERE {where_sql} "
                f"ORDER BY {order_sql} LIMIT %s OFFSET %s",
                params + [per_page, offset],
            )
        rows = [_serialize_row(r) for r in _dictfetchall(cur)]

    for row in rows:
        code = row.get('seller_management_code') or ''
        row['has_orders'] = code != '' and code in sold_codes

    return {
        'items': rows,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page if total > 0 else 0,
    }


def get_product_stats(store_pk):
    """상태별 개수 통계. store_pk=0이면 전체상점 통합."""
    from . import smartstore_order_service
    sold_codes = smartstore_order_service.get_sold_seller_codes()

    with connections['myproduct'].cursor() as cur:
        if store_pk:
            cur.execute(
                "SELECT status_type, COUNT(*) as cnt "
                "FROM smartstore_product WHERE store_id=%s GROUP BY status_type",
                [store_pk],
            )
        else:
            cur.execute(
                "SELECT status_type, COUNT(*) as cnt "
                "FROM smartstore_product GROUP BY status_type"
            )
        status_rows = _dictfetchall(cur)

        if store_pk:
            cur.execute(
                "SELECT MAX(synced_at) as last_synced FROM smartstore_product WHERE store_id=%s",
                [store_pk],
            )
        else:
            cur.execute(
                "SELECT MAX(synced_at) as last_synced FROM smartstore_product"
            )
        synced_row = _dictfetchall(cur)
        last_synced = synced_row[0]['last_synced'] if synced_row else None

        # 판매된 상품 수 (주문 1건 이상)
        sold_count = 0
        if sold_codes:
            sold_list = list(sold_codes)
            sold_ph = ','.join(['%s'] * len(sold_list))
            if store_pk:
                cur.execute(
                    f"SELECT COUNT(*) FROM smartstore_product "
                    f"WHERE store_id = %s AND seller_management_code IN ({sold_ph})",
                    [store_pk] + sold_list,
                )
            else:
                cur.execute(
                    f"SELECT COUNT(*) FROM smartstore_product "
                    f"WHERE seller_management_code IN ({sold_ph})",
                    sold_list,
                )
            sold_count = cur.fetchone()[0]

    stats = {}
    total = 0
    for r in status_rows:
        st = r['status_type'] or 'UNKNOWN'
        stats[st] = r['cnt']
        total += r['cnt']

    result = {
        'total': total,
        'by_status': stats,
        'sold_count': sold_count,
        'last_synced_at': last_synced.isoformat() if last_synced and isinstance(last_synced, datetime) else (last_synced or None),
    }
    return result


def get_products_for_export(store_ids=None, statuses=None, w_only=False):
    """엑셀 내보내기용 전체 상품 조회 (상점명 JOIN, 페이지네이션 없음)"""
    where = ['1=1']
    params = []

    if store_ids:
        placeholders = ','.join(['%s'] * len(store_ids))
        where.append(f'p.store_id IN ({placeholders})')
        params.extend(store_ids)

    if statuses:
        placeholders = ','.join(['%s'] * len(statuses))
        where.append(f'p.status_type IN ({placeholders})')
        params.extend(statuses)

    if w_only:
        where.append("p.seller_management_code LIKE 'W%%'")

    where_sql = ' AND '.join(where)

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT s.store_name, p.origin_product_no, p.channel_product_no, "
            f"p.name, p.sale_price, p.stock_quantity, p.status_type, "
            f"p.channel_product_display_status_type, p.seller_management_code, "
            f"p.category_id, p.synced_at "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON s.id = p.store_id "
            f"WHERE {where_sql} "
            f"ORDER BY s.store_name, p.origin_product_no DESC",
            params,
        )
        return _dictfetchall(cur)


def get_w_codes(store_ids=None, statuses=None):
    """W로 시작하는 seller_management_code만 추출"""
    where = ["p.seller_management_code LIKE 'W%%'"]
    params = []

    if store_ids:
        placeholders = ','.join(['%s'] * len(store_ids))
        where.append(f'p.store_id IN ({placeholders})')
        params.extend(store_ids)

    if statuses:
        placeholders = ','.join(['%s'] * len(statuses))
        where.append(f'p.status_type IN ({placeholders})')
        params.extend(statuses)

    where_sql = ' AND '.join(where)

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT DISTINCT p.seller_management_code "
            f"FROM smartstore_product p "
            f"WHERE {where_sql} "
            f"ORDER BY p.seller_management_code",
            params,
        )
        return [r['seller_management_code'] for r in _dictfetchall(cur)]


def _get_suspend_targets(product_ids, select_all=False, filters=None):
    """체크한 상품의 W코드 → 전 상점에서 SALE + ownerclan_soldout=1 대상 조회"""
    filters = filters or {}

    with connections['myproduct'].cursor() as cur:
        # 1. product_ids 또는 select_all 기반으로 W코드 수집
        if select_all:
            where = []
            params = []
            f_store_id = filters.get('store_id', 0)
            if f_store_id:
                where.append('store_id = %s')
                params.append(f_store_id)
            if filters.get('status'):
                where.append('status_type = %s')
                params.append(filters['status'])
            if filters.get('search'):
                where.append('(name LIKE %s OR seller_management_code LIKE %s)')
                like = f"%{filters['search']}%"
                params.extend([like, like])
            if filters.get('ownerclan_soldout') is not None:
                where.append('ownerclan_soldout = %s')
                params.append(int(filters['ownerclan_soldout']))
            where.append("seller_management_code LIKE 'W%%'")
            where_sql = ' AND '.join(where)
            cur.execute(
                f"SELECT DISTINCT seller_management_code FROM smartstore_product "
                f"WHERE {where_sql}",
                params,
            )
        else:
            if not product_ids:
                return [], []
            placeholders = ','.join(['%s'] * len(product_ids))
            cur.execute(
                f"SELECT DISTINCT seller_management_code FROM smartstore_product "
                f"WHERE id IN ({placeholders}) AND seller_management_code LIKE 'W%%'",
                product_ids,
            )
        w_codes = [r[0] for r in cur.fetchall() if r[0]]
        if not w_codes:
            return [], w_codes

        # 2. 해당 W코드로 전 상점에서 SALE + ownerclan_soldout=1 검색
        placeholders = ','.join(['%s'] * len(w_codes))
        cur.execute(
            f"SELECT p.id, p.store_id, p.origin_product_no, p.name, "
            f"p.seller_management_code, p.status_type, s.store_name, "
            f"s.commerce_api_key, s.commerce_secret_key "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON s.id = p.store_id "
            f"WHERE p.seller_management_code IN ({placeholders}) "
            f"AND p.status_type = 'SALE' AND p.ownerclan_soldout = 1",
            w_codes,
        )
        targets = _dictfetchall(cur)

    return targets, w_codes


def preview_suspend(product_ids, select_all=False, filters=None):
    """체크한 상품의 W코드 → 전 상점에서 SALE+ownerclan_soldout=1 매칭 건수"""
    targets, w_codes = _get_suspend_targets(product_ids, select_all, filters)

    by_store = {}
    for t in targets:
        name = t['store_name']
        if name not in by_store:
            by_store[name] = 0
        by_store[name] += 1

    return {
        'total_count': len(targets),
        'by_store': [{'store_name': k, 'count': v} for k, v in by_store.items()],
        'w_codes': w_codes,
    }


def _change_product_status(origin_product_no, token):
    """네이버 API로 상품 상태를 SUSPENSION으로 변경 (GET→수정→PUT)"""
    url = f'https://api.commerce.naver.com/external/v2/products/origin-products/{origin_product_no}'
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }
    # 1. 상품 조회
    get_resp = requests.get(url, headers=headers, timeout=30)
    get_resp.raise_for_status()
    product = get_resp.json()['originProduct']

    # 2. statusType만 변경
    product['statusType'] = 'SUSPENSION'

    # 3. PUT
    put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=30)
    put_resp.raise_for_status()
    return put_resp.json()


def suspend_products(product_ids, select_all=False, filters=None):
    """실제 품절처리: 네이버 API 호출 + DB 업데이트"""
    targets, _ = _get_suspend_targets(product_ids, select_all, filters)
    if not targets:
        return {'success_count': 0, 'fail_count': 0, 'errors': []}

    # 상점별로 그룹핑
    store_groups = {}
    for t in targets:
        sid = t['store_id']
        if sid not in store_groups:
            store_groups[sid] = {
                'api_key': t['commerce_api_key'],
                'secret_key': t['commerce_secret_key'],
                'token': None,
                'items': [],
            }
        store_groups[sid]['items'].append(t)

    success_count = 0
    errors = []

    for sid, group in store_groups.items():
        if not group['api_key'] or not group['secret_key']:
            for item in group['items']:
                errors.append({
                    'origin_product_no': item['origin_product_no'],
                    'error': 'API 키 미등록',
                })
            continue

        try:
            token = _get_access_token(group['api_key'], group['secret_key'])
        except Exception as e:
            for item in group['items']:
                errors.append({
                    'origin_product_no': item['origin_product_no'],
                    'error': f'토큰 발급 실패: {str(e)}',
                })
            continue

        for item in group['items']:
            try:
                _change_product_status(item['origin_product_no'], token)
                # DB 업데이트
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "UPDATE smartstore_product SET status_type='SUSPENSION' WHERE id=%s",
                        [item['id']],
                    )
                success_count += 1
            except Exception as e:
                errors.append({
                    'origin_product_no': item['origin_product_no'],
                    'error': str(e),
                })
            time.sleep(1)  # Rate limit: GET+PUT = 2req per product

    return {
        'success_count': success_count,
        'fail_count': len(errors),
        'errors': errors,
    }


def get_all_stores_stats():
    """모든 상점의 통계를 한번에 조회"""
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT store_id, status_type, COUNT(*) as cnt "
            "FROM smartstore_product GROUP BY store_id, status_type"
        )
        status_rows = _dictfetchall(cur)

        cur.execute(
            "SELECT store_id, MAX(synced_at) as last_synced "
            "FROM smartstore_product GROUP BY store_id"
        )
        synced_rows = _dictfetchall(cur)

    synced_map = {}
    for r in synced_rows:
        v = r['last_synced']
        synced_map[r['store_id']] = v.isoformat() if isinstance(v, datetime) else (v or None)

    result = {}
    for r in status_rows:
        sid = r['store_id']
        if sid not in result:
            result[sid] = {'total': 0, 'by_status': {}, 'last_synced_at': synced_map.get(sid)}
        st = r['status_type'] or 'UNKNOWN'
        result[sid]['by_status'][st] = r['cnt']
        result[sid]['total'] += r['cnt']

    return result


def toggle_focus(product_ids, is_focus):
    """상품의 집중관리 상태를 벌크 토글"""
    if not product_ids:
        return {'updated': 0}
    placeholders = ','.join(['%s'] * len(product_ids))
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"UPDATE smartstore_product SET is_focus = %s WHERE id IN ({placeholders})",
            [int(is_focus)] + list(product_ids),
        )
        return {'updated': cur.rowcount}
