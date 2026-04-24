import json
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
    for key in ('synced_at', 'created_at', 'updated_at', 'last_change_detected_at', 'restock_at'):
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


SYNC_TRACK_FIELDS = {
    'name': 'name',
    'sale_price': 'sale_price',
    'stock_quantity': 'stock_quantity',
    'status_type': 'status_type',
    'channel_product_display_status_type': 'channel_product_display_status_type',
    'seller_management_code': 'seller_management_code',
    'category_id': 'category_id',
}


def sync_products(store_pk):
    """DB의 store 정보로 API 호출 → UPSERT → 결과 반환 (변경 로그 기록)"""
    import time as _time
    start_time = _time.time()

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

    # 기존 상품 스냅샷 (변경 감지용) — origin_product_no 글로벌 유니크이므로 전체 조회
    existing = {}
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT origin_product_no, name, sale_price, stock_quantity, "
            "status_type, channel_product_display_status_type, "
            "seller_management_code, category_id, store_id "
            "FROM smartstore_product",
        )
        for r in cur.fetchall():
            existing[r[0]] = {
                'name': r[1] or '', 'sale_price': r[2] or 0,
                'stock_quantity': r[3] or 0, 'status_type': r[4] or '',
                'channel_product_display_status_type': r[5] or '',
                'seller_management_code': r[6] or '', 'category_id': r[7] or '',
                'store_id': r[8],
            }

    # 동기화 세션 로그 생성
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "INSERT INTO smartstore_sync_log (store_id, store_name, started_at) VALUES (%s, %s, %s)",
            [store_pk, store['store_name'], now],
        )
        sync_log_id = cur.lastrowid

    upserted = 0
    new_count = 0
    skipped = 0
    changes = []

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

            # Search API 추가 필드
            discount_price = cp.get('discountedPrice', 0) or 0
            mobile_discounted_price = cp.get('mobileDiscountedPrice', 0) or 0
            delivery_attr_type = cp.get('deliveryAttributeType', '') or ''
            delivery_fee = cp.get('deliveryFee', 0) or 0
            return_fee = cp.get('returnFee', 0) or 0
            exchange_fee = cp.get('exchangeFee', 0) or 0
            manufacturer_name = (cp.get('manufacturerName', '') or '')[:200]
            brand_name = (cp.get('brandName', '') or '')[:200]
            model_name = (cp.get('modelName', '') or '')[:200]
            naver_reg = 'Y' if cp.get('knowledgeShoppingProductRegistration') else 'N'
            sale_start_date = cp.get('saleStartDate', '') or ''
            sale_end_date = cp.get('saleEndDate', '') or ''
            whole_cat_name = (cp.get('wholeCategoryName', '') or '')[:500]
            reg_date = cp.get('regDate', '') or ''
            modified_date = cp.get('modifiedDate', '') or ''

            # sellerTags → JSON 문자열
            seller_tags_raw = cp.get('sellerTags') or []
            seller_tags = json.dumps(seller_tags_raw, ensure_ascii=False) if seller_tags_raw else None

            # 대표 이미지
            image_url = ''
            rep_img = cp.get('representativeImage')
            if isinstance(rep_img, dict):
                image_url = rep_img.get('url', '')

            # 변경 감지
            new_vals = {
                'name': name, 'sale_price': sale_price,
                'stock_quantity': stock_qty, 'status_type': status,
                'channel_product_display_status_type': display_status,
                'seller_management_code': mgmt_code, 'category_id': category_id,
            }
            old = existing.get(origin_no)
            if old is None:
                new_count += 1
            elif old.get('store_id') == store_pk:
                # 같은 store의 기존 상품만 변경 감지
                for field, new_val in new_vals.items():
                    old_val = old.get(field, '')
                    if str(old_val) != str(new_val):
                        changes.append((
                            sync_log_id, origin_no, mgmt_code, field,
                            str(old_val)[:500], str(new_val)[:500], now,
                        ))
            else:
                # 다른 store에서 이미 등록된 상품 → skip (중복)
                skipped += 1
                continue

            cur.execute("""
                INSERT INTO smartstore_product
                    (store_id, origin_product_no, channel_product_no, name,
                     sale_price, discount_price, mobile_discounted_price,
                     stock_quantity, status_type,
                     channel_product_display_status_type,
                     seller_management_code, category_id,
                     delivery_fee_type, basic_delivery_fee,
                     return_delivery_fee, exchange_delivery_fee,
                     manufacturer, brand_name, model_name,
                     naver_shopping_registered,
                     sale_start_date, sale_end_date,
                     whole_category_name, seller_tags,
                     registered_at, last_modified_at,
                     product_image_url, synced_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    channel_product_no=VALUES(channel_product_no),
                    name=VALUES(name),
                    sale_price=VALUES(sale_price),
                    discount_price=VALUES(discount_price),
                    mobile_discounted_price=VALUES(mobile_discounted_price),
                    stock_quantity=VALUES(stock_quantity),
                    status_type=VALUES(status_type),
                    channel_product_display_status_type=VALUES(channel_product_display_status_type),
                    seller_management_code=VALUES(seller_management_code),
                    category_id=VALUES(category_id),
                    delivery_fee_type=VALUES(delivery_fee_type),
                    basic_delivery_fee=VALUES(basic_delivery_fee),
                    return_delivery_fee=VALUES(return_delivery_fee),
                    exchange_delivery_fee=VALUES(exchange_delivery_fee),
                    manufacturer=VALUES(manufacturer),
                    brand_name=VALUES(brand_name),
                    model_name=VALUES(model_name),
                    naver_shopping_registered=VALUES(naver_shopping_registered),
                    sale_start_date=VALUES(sale_start_date),
                    sale_end_date=VALUES(sale_end_date),
                    whole_category_name=VALUES(whole_category_name),
                    seller_tags=VALUES(seller_tags),
                    registered_at=VALUES(registered_at),
                    last_modified_at=VALUES(last_modified_at),
                    product_image_url=VALUES(product_image_url),
                    synced_at=VALUES(synced_at)
            """, [
                store_pk, origin_no, channel_no, name,
                sale_price, discount_price, mobile_discounted_price,
                stock_qty, status, display_status,
                mgmt_code, category_id,
                delivery_attr_type, delivery_fee,
                return_fee, exchange_fee,
                manufacturer_name, brand_name, model_name,
                naver_reg,
                sale_start_date, sale_end_date,
                whole_cat_name, seller_tags,
                reg_date, modified_date,
                image_url, now,
            ])
            upserted += 1

    # 변경 로그 일괄 삽입
    if changes:
        with connections['myproduct'].cursor() as cur:
            cur.executemany(
                "INSERT INTO smartstore_sync_change "
                "(sync_log_id, origin_product_no, seller_management_code, "
                "field_name, old_value, new_value, changed_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                changes,
            )

    # 세션 로그 업데이트
    elapsed = round(_time.time() - start_time, 1)
    completed_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    changed_products = len(set(c[1] for c in changes))
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "UPDATE smartstore_sync_log SET total_from_api=%s, upserted=%s, "
            "new_count=%s, changed_count=%s, elapsed_sec=%s, completed_at=%s "
            "WHERE id=%s",
            [len(products), upserted, new_count, changed_products, elapsed, completed_at, sync_log_id],
        )

    return {
        'synced': upserted,
        'total_from_api': len(products),
        'store_name': store['store_name'],
        'synced_at': now,
        'new_count': new_count,
        'skipped': skipped,
        'changed_count': changed_products,
        'change_details': len(changes),
    }


SORT_COLUMNS = {
    'sale_price': 'p.sale_price',
    'stock': 'p.stock_quantity',
    'order_amount': 'p.all_order_amount',
    'order_qty': 'p.all_order_qty',
    'ss_order_amount': 'p.total_order_amount',
}


def get_products(store_pk, page=1, per_page=50, status=None, search=None,
                 ownerclan_soldout=None, is_focus=None, has_orders=None,
                 sort_by=None, sort_dir=None, min_ss_amount=None,
                 has_changes=None, reverse_margin=None, restock_unchecked=None,
                 no_master=None):
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
        # 여러 ���드 입력 지원: 엔터/공백/쉼표 구분
        import re
        tokens = [t.strip() for t in re.split(r'[\s,\n\r]+', search) if t.strip()]
        if len(tokens) > 1:
            ph = ','.join(['%s'] * len(tokens))
            where.append(f'p.seller_management_code IN ({ph})')
            params.extend(tokens)
        else:
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
    if min_ss_amount is not None:
        where.append('p.total_order_amount >= %s')
        params.append(int(min_ss_amount))
    if has_changes is not None:
        if has_changes == 2:
            where.append('p.status_mismatch = 1')
        elif has_changes == 3:
            where.append('p.has_pending_changes = 1')
        else:
            where.append('(p.has_pending_changes = 1 OR p.status_mismatch = 1)')
    if reverse_margin is not None:
        where.append('p.master_price > 0 AND ROUND(p.sale_price * 0.93) < p.master_price')
    if restock_unchecked is not None:
        where.append('p.restock_checked = 0 AND p.restock_at IS NOT NULL')
    if no_master is not None:
        where.append(
            "p.seller_management_code LIKE 'W%%' AND "
            "NOT EXISTS (SELECT 1 FROM ads.ownerclan_product WHERE product_code = p.seller_management_code)"
        )

    where_sql = ' AND '.join(where) if where else '1=1'
    offset = (page - 1) * per_page

    # 정렬
    col = SORT_COLUMNS.get(sort_by or '')
    direction = 'ASC' if sort_dir == 'asc' else 'DESC'
    order_sql = f'{col} {direction}, p.origin_product_no DESC' if col else 'p.origin_product_no DESC'

    with connections['myproduct'].cursor() as cur:
        if all_stores:
            cur.execute(
                f"SELECT COUNT(*) FROM smartstore_product p "
                f"JOIN smartstoreIdList s ON s.id = p.store_id "
                f"WHERE {where_sql}", params)
        else:
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
    """상태별 개수 통계. store_pk=0이면 전체상점 통합 (smartstoreIdList에 존재하는 상점만)."""
    with connections['myproduct'].cursor() as cur:
        if store_pk:
            cur.execute(
                "SELECT p.status_type, COUNT(*) as cnt "
                "FROM smartstore_product p WHERE p.store_id=%s GROUP BY p.status_type",
                [store_pk],
            )
        else:
            cur.execute(
                "SELECT p.status_type, COUNT(*) as cnt "
                "FROM smartstore_product p "
                "JOIN smartstoreIdList s ON s.id = p.store_id "
                "GROUP BY p.status_type"
            )
        status_rows = _dictfetchall(cur)

        if store_pk:
            cur.execute(
                "SELECT MAX(p.synced_at) as last_synced FROM smartstore_product p WHERE p.store_id=%s",
                [store_pk],
            )
        else:
            cur.execute(
                "SELECT MAX(p.synced_at) as last_synced "
                "FROM smartstore_product p "
                "JOIN smartstoreIdList s ON s.id = p.store_id"
            )
        synced_row = _dictfetchall(cur)
        last_synced = synced_row[0]['last_synced'] if synced_row else None

        # 전체사이트 판매된 상품 (all_order_count > 0) — 상태별
        if store_pk:
            store_where = 'p.store_id = %s AND '
            store_params = [store_pk]
            sold_from = 'smartstore_product p'
        else:
            store_where = ''
            store_params = []
            sold_from = 'smartstore_product p JOIN smartstoreIdList s ON s.id = p.store_id'

        cur.execute(
            f"SELECT COALESCE(p.status_type,'UNKNOWN') as st, COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.all_order_count > 0 GROUP BY st",
            store_params,
        )
        all_sold_by_status = {}
        all_sold_count = 0
        for row in cur.fetchall():
            all_sold_by_status[row[0]] = row[1]
            all_sold_count += row[1]

        # 스마트스토어만 판매된 상품 (total_order_count > 0) — 상태별
        cur.execute(
            f"SELECT COALESCE(p.status_type,'UNKNOWN') as st, COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.total_order_count > 0 GROUP BY st",
            store_params,
        )
        ss_sold_by_status = {}
        ss_sold_count = 0
        for row in cur.fetchall():
            ss_sold_by_status[row[0]] = row[1]
            ss_sold_count += row[1]

    stats = {}
    total = 0
    for r in status_rows:
        st = r['status_type'] or 'UNKNOWN'
        stats[st] = r['cnt']
        total += r['cnt']

    # 수정사항 건수
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}(p.has_pending_changes = 1 OR p.status_mismatch = 1)",
            store_params,
        )
        changes_count = cur.fetchone()[0]
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.status_mismatch = 1",
            store_params,
        )
        status_mismatch_count = cur.fetchone()[0]
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.has_pending_changes = 1",
            store_params,
        )
        field_changes_count = cur.fetchone()[0]
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.master_price > 0 AND ROUND(p.sale_price * 0.93) < p.master_price",
            store_params,
        )
        reverse_margin_count = cur.fetchone()[0]
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.restock_checked = 0 AND p.restock_at IS NOT NULL",
            store_params,
        )
        restock_unchecked_count = cur.fetchone()[0]
        cur.execute(
            f"SELECT COUNT(*) FROM {sold_from} "
            f"WHERE {store_where}p.seller_management_code LIKE 'W%%' AND "
            f"NOT EXISTS (SELECT 1 FROM ads.ownerclan_product WHERE product_code = p.seller_management_code)",
            store_params,
        )
        no_master_count = cur.fetchone()[0]

    result = {
        'total': total,
        'by_status': stats,
        'sold_count': all_sold_count,
        'ss_sold_count': ss_sold_count,
        'sold_by_status': all_sold_by_status,
        'ss_sold_by_status': ss_sold_by_status,
        'changes_count': changes_count,
        'status_mismatch_count': status_mismatch_count,
        'field_changes_count': field_changes_count,
        'reverse_margin_count': reverse_margin_count,
        'restock_unchecked_count': restock_unchecked_count,
        'no_master_count': no_master_count,
        'last_synced_at': last_synced.isoformat() if last_synced and isinstance(last_synced, datetime) else (last_synced or None),
    }
    return result


def get_sync_logs(store_id=0, limit=50):
    """동기화 로그 조회"""
    where = []
    params = []
    if store_id:
        where.append('l.store_id = %s')
        params.append(store_id)
    where_sql = ' AND '.join(where) if where else '1=1'
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT l.*, "
            f"(SELECT COUNT(*) FROM smartstore_sync_change c WHERE c.sync_log_id = l.id) as total_changes "
            f"FROM smartstore_sync_log l WHERE {where_sql} "
            f"ORDER BY l.id DESC LIMIT %s",
            params + [limit],
        )
        rows = _dictfetchall(cur)
    for r in rows:
        for k in ('started_at', 'completed_at'):
            if r.get(k) and isinstance(r[k], datetime):
                r[k] = r[k].isoformat()
        if r.get('elapsed_sec'):
            from decimal import Decimal
            r['elapsed_sec'] = float(r['elapsed_sec'])
    return rows


def get_sync_log_changes(sync_log_id, limit=500):
    """동기화 세션의 변경 상세"""
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT field_name, COUNT(*) as cnt FROM smartstore_sync_change "
            "WHERE sync_log_id = %s GROUP BY field_name ORDER BY cnt DESC",
            [sync_log_id],
        )
        summary = _dictfetchall(cur)
        cur.execute(
            "SELECT * FROM smartstore_sync_change "
            "WHERE sync_log_id = %s ORDER BY id LIMIT %s",
            [sync_log_id, limit],
        )
        changes = _dictfetchall(cur)
    for c in changes:
        if c.get('changed_at') and isinstance(c['changed_at'], datetime):
            c['changed_at'] = c['changed_at'].isoformat()
    return {'summary': summary, 'changes': changes}


def get_products_for_export(store_ids=None, statuses=None, w_only=False,
                            search=None, has_orders=False, is_focus=False,
                            sort_by=None, sort_dir=None):
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

    if search:
        import re
        tokens = [t.strip() for t in re.split(r'[\s,\n\r]+', search) if t.strip()]
        if len(tokens) > 1:
            ph = ','.join(['%s'] * len(tokens))
            where.append(f'p.seller_management_code IN ({ph})')
            params.extend(tokens)
        else:
            where.append('(p.name LIKE %s OR p.seller_management_code LIKE %s)')
            like = f'%{search}%'
            params.extend([like, like])

    if has_orders:
        from . import smartstore_order_service
        sold_codes = smartstore_order_service.get_sold_seller_codes()
        if not sold_codes:
            return []
        sold_list = list(sold_codes)
        sold_ph = ','.join(['%s'] * len(sold_list))
        where.append(f'p.seller_management_code IN ({sold_ph})')
        params.extend(sold_list)

    if is_focus:
        where.append('p.is_focus = 1')

    where_sql = ' AND '.join(where)

    col = SORT_COLUMNS.get(sort_by or '')
    direction = 'ASC' if sort_dir == 'asc' else 'DESC'
    order_sql = f'{col} {direction}, p.origin_product_no DESC' if col else 's.store_name, p.origin_product_no DESC'

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT s.store_name, p.origin_product_no, p.channel_product_no, "
            f"p.name, p.sale_price, p.stock_quantity, p.status_type, "
            f"p.channel_product_display_status_type, p.seller_management_code, "
            f"p.category_id, p.all_order_count, p.total_order_count, "
            f"p.all_order_amount, p.total_order_amount, "
            f"p.all_order_qty, p.total_order_qty, p.synced_at "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON s.id = p.store_id "
            f"WHERE {where_sql} "
            f"ORDER BY {order_sql}",
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


def get_orphan_w_codes(store_ids=None):
    """W코드 중 ads.ownerclan_product에 존재하지 않는 코드 추출"""
    where = ["p.seller_management_code LIKE 'W%%'"]
    params = []

    if store_ids:
        placeholders = ','.join(['%s'] * len(store_ids))
        where.append(f'p.store_id IN ({placeholders})')
        params.extend(store_ids)

    where.append(
        "NOT EXISTS (SELECT 1 FROM ads.ownerclan_product WHERE product_code = p.seller_management_code)"
    )
    where_sql = ' AND '.join(where)

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT DISTINCT p.seller_management_code "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON s.id = p.store_id "
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


def _change_product_status(origin_product_no, token, status='SUSPENSION'):
    """네이버 API로 상품 상태를 변경 (GET→수정→PUT)"""
    url = f'https://api.commerce.naver.com/external/v2/products/origin-products/{origin_product_no}'
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }
    # 1. 상품 조회
    get_resp = requests.get(url, headers=headers, timeout=10)
    get_resp.raise_for_status()
    product = get_resp.json()['originProduct']

    # 2. statusType 변경
    product['statusType'] = status

    # 3. 검증 실패 방지: sellerTags 제거 (금지어 포함 시 PUT 실패)
    detail = product.get('detailAttribute', {})
    seo = detail.get('seoInfo', {})
    if 'sellerTags' in seo:
        del seo['sellerTags']

    # 4. PUT (첫 시도)
    put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=10)
    if put_resp.status_code == 400:
        # 검증 실패 시 문제 필드 추가 제거 후 재시도
        inv = put_resp.json().get('invalidInputs', [])
        for item in inv:
            field = item.get('name', '')
            # originProduct.xxx.yyy.zzz → product[xxx][yyy] 에서 zzz 삭제
            parts = field.replace('originProduct.', '').split('.')
            obj = product
            for p in parts[:-1]:
                obj = obj.get(p, {}) if isinstance(obj, dict) else {}
            if isinstance(obj, dict) and parts[-1] in obj:
                del obj[parts[-1]]
        put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=10)

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


def _reactivate_store_batch(sid, group):
    """단일 상점의 상품들을 SALE로 전환 (스레드 워커)"""
    results = {'success': 0, 'errors': []}

    if not group['api_key'] or not group['secret_key']:
        for item in group['items']:
            results['errors'].append({
                'origin_product_no': item['origin_product_no'],
                'error': 'API 키 미등록',
            })
        return results

    try:
        token = _get_access_token(group['api_key'], group['secret_key'])
    except Exception as e:
        for item in group['items']:
            results['errors'].append({
                'origin_product_no': item['origin_product_no'],
                'error': f'토큰 발급 실패: {str(e)}',
            })
        return results

    for item in group['items']:
        try:
            _change_product_status(item['origin_product_no'], token, status='SALE')
            # 가격변동 + 역마진 체크
            price_changed = 1 if item.get('price_changed') else 0
            reverse_margin = 1 if item.get('reverse_margin') else 0
            with connections['myproduct'].cursor() as cur:
                cur.execute(
                    "UPDATE smartstore_product SET status_type='SALE', "
                    "restock_at=NOW(), restock_checked=0, "
                    "restock_price_changed=%s, restock_reverse_margin=%s "
                    "WHERE id=%s",
                    [price_changed, reverse_margin, item['id']],
                )
            results['success'] += 1
            flag = ''
            if price_changed:
                flag += ' [가격변동]'
            if reverse_margin:
                flag += ' [역마진]'
            logger.info(f'[REACTIVATE] {item["seller_management_code"]} -> SALE{flag}')
        except Exception as e:
            results['errors'].append({
                'origin_product_no': item['origin_product_no'],
                'error': str(e),
            })
            logger.warning(f'[REACTIVATE] 실패 {item["seller_management_code"]}: {e}')
        time.sleep(0.3)

    return results


def reactivate_products(w_codes):
    """품절→판매중 전환: 네이버 API로 SALE 상태 변경 + DB 업데이트.
    상점별 병렬 처리 (ThreadPoolExecutor)로 고속 전환.
    w_codes: seller_management_code(W코드) 리스트"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not w_codes:
        return {'success': 0, 'fail': 0, 'errors': [], 'skipped': 0}

    # SUSPENSION 상태인 상품만 대상 (+ 가격 정보 포함)
    placeholders = ','.join(['%s'] * len(w_codes))
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"SELECT p.id, p.origin_product_no, p.store_id, p.seller_management_code, "
            f"p.status_type, p.sale_price, p.master_price, "
            f"s.commerce_api_key, s.commerce_secret_key "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON s.id = p.store_id "
            f"WHERE p.seller_management_code IN ({placeholders}) "
            f"AND p.status_type = 'SUSPENSION'",
            list(w_codes),
        )
        targets = _dictfetchall(cur)

    # 오너클랜 최신 가격 조회
    oc_prices = {}
    if targets:
        target_codes = [t['seller_management_code'] for t in targets]
        tc_ph = ','.join(['%s'] * len(target_codes))
        with connections['ads'].cursor() as cur:
            cur.execute(
                f"SELECT product_code, ownerclan_price, orig_ownerclan_price "
                f"FROM ownerclan_product WHERE product_code IN ({tc_ph})",
                target_codes,
            )
            for r in cur.fetchall():
                oc_prices[r[0]] = {'price': r[1], 'orig_price': r[2]}

    # 각 상품에 가격변동/역마진 플래그 추가
    for t in targets:
        wcode = t['seller_management_code']
        oc = oc_prices.get(wcode, {})
        oc_price = oc.get('price', 0) or 0
        oc_orig = oc.get('orig_price', 0) or 0
        t['price_changed'] = (oc_price != oc_orig) if oc_price else False
        settle = round((t.get('sale_price') or 0) * 0.93)
        t['reverse_margin'] = (settle < oc_price) if oc_price > 0 else False

    if not targets:
        return {'success': 0, 'fail': 0, 'errors': [], 'skipped': len(w_codes)}

    # 상점별 그룹핑
    store_groups = {}
    for t in targets:
        sid = t['store_id']
        if sid not in store_groups:
            store_groups[sid] = {
                'api_key': t['commerce_api_key'],
                'secret_key': t['commerce_secret_key'],
                'items': [],
            }
        store_groups[sid]['items'].append(t)

    success = 0
    errors = []

    # 재입고 통계 사전 집계
    price_changed_count = sum(1 for t in targets if t.get('price_changed'))
    reverse_margin_count = sum(1 for t in targets if t.get('reverse_margin'))

    # 상점별 병렬 처리 (최대 8스레드)
    with ThreadPoolExecutor(max_workers=min(8, len(store_groups))) as pool:
        futures = {
            pool.submit(_reactivate_store_batch, sid, group): sid
            for sid, group in store_groups.items()
        }
        for future in as_completed(futures):
            result = future.result()
            success += result['success']
            errors.extend(result['errors'])

    return {
        'success': success,
        'fail': len(errors),
        'errors': errors[:50],
        'skipped': len(w_codes) - len(targets),
        'price_changed': price_changed_count,
        'reverse_margin': reverse_margin_count,
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


def toggle_restock_checked(product_ids, checked=1):
    """재입고 확인 토글 (벌크)"""
    if not product_ids:
        return {'updated': 0}
    placeholders = ','.join(['%s'] * len(product_ids))
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"UPDATE smartstore_product SET restock_checked = %s WHERE id IN ({placeholders})",
            [int(checked)] + list(product_ids),
        )
        return {'updated': cur.rowcount}


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


STATUS_MAP = {
    'SALE': 1, 'SUSPENSION': 2, 'OUTOFSTOCK': 2,
    'CLOSE': 3, 'PROHIBITION': 3, 'UNADMISSION': 3,
}


def refresh_master_tracking(store_pk=0):
    """마스터(오너클랜) 변경 추적 컬럼을 최신 상태로 갱신.
    임시 테이블 + JOIN UPDATE로 단일 쿼리 처리 (236K 행도 수초 내 완료)."""

    # 1. 마스터 데이터 로드 (ads DB)
    with connections['ads'].cursor() as cur:
        cur.execute(
            "SELECT product_code, sale_status, ownerclan_price, market_price, "
            "shipping_fee, LEFT(product_name, 500), "
            "ownerclan_price - orig_ownerclan_price "
            "FROM ownerclan_product"
        )
        master_rows = cur.fetchall()

    # 2. 변경 로그 요약 로드 (ads DB)
    with connections['ads'].cursor() as cur:
        cur.execute(
            "SELECT product_code, GROUP_CONCAT(DISTINCT change_group), "
            "COUNT(*), MAX(detected_at) "
            "FROM product_change_log WHERE is_applied = 0 GROUP BY product_code"
        )
        change_rows = cur.fetchall()

    change_map = {r[0]: r for r in change_rows}

    # 3. 임시 테이블 생성 + INSERT + JOIN UPDATE (myproduct DB)
    with connections['myproduct'].cursor() as cur:
        cur.execute("DROP TEMPORARY TABLE IF EXISTS _tmp_master_tracking")
        cur.execute("""
            CREATE TEMPORARY TABLE _tmp_master_tracking (
                wcode VARCHAR(50) COLLATE utf8mb4_general_ci PRIMARY KEY,
                m_price INT, m_market_price INT, m_shipping INT,
                m_name VARCHAR(500), m_sale_status TINYINT, m_pdiff INT,
                has_pending TINYINT DEFAULT 0, pgroups VARCHAR(200) DEFAULT '',
                pcount INT DEFAULT 0, last_dt DATETIME NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """)

        # 배치 INSERT
        batch = []
        for r in master_rows:
            wcode = r[0]
            chg = change_map.get(wcode)
            batch.append((
                wcode, r[2], r[3], r[4], r[5], r[1], r[6] or 0,
                1 if chg else 0,
                chg[1] if chg else '',
                chg[2] if chg else 0,
                chg[3] if chg else None,
            ))
            if len(batch) >= 5000:
                cur.executemany(
                    "INSERT INTO _tmp_master_tracking VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    batch,
                )
                batch = []
        if batch:
            cur.executemany(
                "INSERT INTO _tmp_master_tracking VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                batch,
            )

        # JOIN UPDATE — 매칭되는 행만 한 번에 갱신
        store_cond = ' AND p.store_id = %s' if store_pk else ''
        store_params = [store_pk] if store_pk else []

        cur.execute(
            "UPDATE smartstore_product p "
            "JOIN _tmp_master_tracking t ON p.seller_management_code COLLATE utf8mb4_general_ci = t.wcode "
            "SET p.master_price = t.m_price, p.master_market_price = t.m_market_price, "
            "    p.master_shipping_fee = t.m_shipping, p.master_product_name = t.m_name, "
            "    p.master_sale_status = t.m_sale_status, p.price_diff = t.m_pdiff, "
            "    p.status_mismatch = CASE "
            "        WHEN t.m_sale_status = 1 AND p.status_type = 'SALE' THEN 0 "
            "        WHEN t.m_sale_status = 2 AND p.status_type IN ('SUSPENSION','OUTOFSTOCK') THEN 0 "
            "        WHEN t.m_sale_status = 3 AND p.status_type IN ('CLOSE','PROHIBITION','UNADMISSION') THEN 0 "
            "        ELSE 1 END, "
            "    p.has_pending_changes = t.has_pending, "
            "    p.pending_change_groups = t.pgroups, "
            "    p.pending_change_count = t.pcount, "
            "    p.last_change_detected_at = t.last_dt"
            f"{store_cond}",
            store_params,
        )
        updated = cur.rowcount

        cur.execute("DROP TEMPORARY TABLE IF EXISTS _tmp_master_tracking")

    logger.info('[TRACKING] Refreshed %d rows (store=%s)', updated, store_pk or 'all')
    return updated


# ── 상세페이지 크롤링 ──

NAVER_PRODUCT_DETAIL_URL = 'https://api.commerce.naver.com/external/v2/products/origin-products/{}'


def fetch_product_detail(origin_product_no, token):
    """단일 상품 상세 정보 전체 조회 (Detail API v2)"""
    url = NAVER_PRODUCT_DETAIL_URL.format(origin_product_no)
    resp = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    op = data.get('originProduct', {})
    da = op.get('detailAttribute', {})

    # 원산지
    oai = da.get('originAreaInfo', {})
    # A/S
    asi = da.get('afterServiceInfo', {})
    # 네이버쇼핑 검색정보
    nssi = da.get('naverShoppingSearchInfo', {})
    # 옵션
    oi = da.get('optionInfo', {})
    # 배송
    di = op.get('deliveryInfo', {})

    return {
        'detail_content': op.get('detailContent', ''),
        'origin_area_code': oai.get('originAreaCode', ''),
        'origin_area_content': oai.get('content', ''),
        'after_service_tel': asi.get('tel') or '',
        'after_service_guide': (asi.get('guide') or '')[:500],
        'tax_type': da.get('taxType', ''),
        'sale_type': op.get('saleType', ''),
        'leaf_category_id': str(op.get('leafCategoryId', '')) if op.get('leafCategoryId') else '',
        'minor_purchasable': 1 if da.get('minorPurchasable') else 0,
        'itself_production': 1 if da.get('itselfProductionProductYn') else 0,
        'product_info_notice': json.dumps(da.get('productInfoProvidedNotice', {}), ensure_ascii=False) if da.get('productInfoProvidedNotice') else None,
        'certification_info': json.dumps(da.get('certificationTargetExcludeContent', {}), ensure_ascii=False) if da.get('certificationTargetExcludeContent') else None,
        'option_info': json.dumps(oi, ensure_ascii=False) if oi else None,
        'matched_catalog_id': str(nssi.get('matchedCatalogId', '')) if nssi.get('matchedCatalogId') else '',
        'delivery_company': (di.get('deliveryCompany', '') or ''),
    }


def fetch_detail_content(origin_product_no, token):
    """단일 상품 상세페이지 HTML 조회 (하위호환)"""
    detail = fetch_product_detail(origin_product_no, token)
    return detail.get('detail_content', '')


def crawl_detail_contents(store_pk=None, limit=100, on_progress=None):
    """상세페이지가 없는 상품들의 detailContent를 API로 가져와 DB에 저장 (단일 스토어)

    Args:
        store_pk: 특정 스토어만 처리 (None이면 전체)
        limit: 한 번에 처리할 최대 상품 수
        on_progress: 콜백 (processed, total)
    Returns:
        {'processed': int, 'updated': int, 'errors': int}
    """
    with connections['myproduct'].cursor() as cur:
        where = "p.detail_content IS NULL"
        params = []
        if store_pk:
            where += " AND p.store_id = %s"
            params.append(store_pk)

        cur.execute(f"""
            SELECT p.origin_product_no, p.store_id, s.commerce_api_key, s.commerce_secret_key
            FROM smartstore_product p
            JOIN smartstoreIdList s ON s.id = p.store_id
            WHERE {where}
              AND s.commerce_api_key IS NOT NULL AND s.commerce_api_key <> ''
            ORDER BY p.origin_product_no
            LIMIT %s
        """, params + [limit])
        targets = cur.fetchall()

    if not targets:
        return {'processed': 0, 'updated': 0, 'errors': 0}

    tokens = {}
    updated = 0
    errors = 0

    for i, (opno, sid, api_key, secret_key) in enumerate(targets):
        try:
            if sid not in tokens:
                tokens[sid] = _get_access_token(api_key, secret_key)
            detail = fetch_product_detail(opno, tokens[sid])
            with connections['myproduct'].cursor() as cur:
                cur.execute(_DETAIL_UPDATE_SQL, [
                    detail['detail_content'],
                    detail['origin_area_code'], detail['origin_area_content'],
                    detail['after_service_tel'], detail['after_service_guide'],
                    detail['tax_type'], detail['sale_type'], detail['leaf_category_id'],
                    detail['minor_purchasable'], detail['itself_production'],
                    detail['product_info_notice'], detail['certification_info'],
                    detail['option_info'], detail['matched_catalog_id'],
                    detail['delivery_company'],
                    opno,
                ])
                updated += 1
        except Exception as e:
            errors += 1
            if '401' in str(e) or 'Unauthorized' in str(e):
                tokens.pop(sid, None)

        if on_progress and (i + 1) % 10 == 0:
            on_progress(i + 1, len(targets))
        time.sleep(0.3)

    return {'processed': len(targets), 'updated': updated, 'errors': errors}


# ── 상세페이지 병렬 크롤링 (24개 스토어 동시) ──

import threading
from concurrent.futures import ThreadPoolExecutor

_detail_lock = threading.Lock()
_detail_state = {
    'running': False,
    'started_at': None,
    'total_stores': 0,
    'completed_stores': 0,
    'total_products': 0,
    'processed': 0,
    'updated': 0,
    'errors': 0,
    'by_store': {},
    'last_report_at': 0,
    'logs': [],
}

DETAIL_REPORT_INTERVAL = 1800  # 30분


def _detail_add_log(msg):
    from datetime import datetime as _dt
    with _detail_lock:
        _detail_state['logs'].append(f'[{_dt.now().strftime("%H:%M:%S")}] {msg}')
        if len(_detail_state['logs']) > 200:
            _detail_state['logs'] = _detail_state['logs'][-200:]


def _detail_send_telegram(msg):
    from django.conf import settings as _settings
    token = getattr(_settings, 'TELEGRAM_BOT_TOKEN', '')
    chat_id = getattr(_settings, 'TELEGRAM_CHAT_ID', '')
    if not token or not chat_id:
        return
    try:
        requests.post(
            f'https://api.telegram.org/bot{token}/sendMessage',
            json={'chat_id': chat_id, 'text': msg, 'parse_mode': 'HTML'},
            timeout=10,
        )
    except Exception:
        pass


def _maybe_send_progress_report():
    """30분마다 중간 리포트 텔레그램 전송."""
    now_ts = time.time()
    with _detail_lock:
        if now_ts - _detail_state['last_report_at'] < DETAIL_REPORT_INTERVAL:
            return
        _detail_state['last_report_at'] = now_ts
        st = dict(_detail_state)

    if not st['started_at']:
        return

    elapsed = now_ts - st['started_at']
    mins = int(elapsed // 60)
    pct = st['processed'] / max(st['total_products'], 1) * 100
    speed = st['processed'] / max(elapsed, 1) * 3600  # 시간당
    remain = (st['total_products'] - st['processed']) / max(speed, 1) * 60 if speed > 0 else 0

    lines = [
        '<b>상세 크롤링 중간 리포트</b>',
        f'{st["processed"]:,} / {st["total_products"]:,} ({pct:.1f}%)',
        f'업데이트: {st["updated"]:,} | 에러: {st["errors"]:,}',
        f'스토어: {st["completed_stores"]}/{st["total_stores"]} 완료',
        f'경과: {mins}분 | 속도: {speed:,.0f}/시간',
        f'남은 예상: {remain:.0f}분',
    ]

    # 완료된 스토어 요약
    done = {k: v for k, v in st['by_store'].items() if v.get('done')}
    if done:
        lines.append('')
        for s, v in sorted(done.items(), key=lambda x: -x[1].get('updated', 0)):
            lines.append(f'  {s}: {v["updated"]:,}/{v["total"]:,}')

    _detail_send_telegram('\n'.join(lines))


_DETAIL_UPDATE_SQL = """
    UPDATE smartstore_product SET
        detail_content = %s,
        origin_area_code = %s, origin_area_content = %s,
        after_service_tel = %s, after_service_guide = %s,
        tax_type = %s, sale_type = %s, leaf_category_id = %s,
        minor_purchasable = %s, itself_production = %s,
        product_info_notice = %s, certification_info = %s,
        option_info = %s, matched_catalog_id = %s, delivery_company = %s
    WHERE origin_product_no = %s
"""


def _crawl_store_details(store_pk, store_name, api_key, secret_key, batch_size=0):
    """단일 스토어의 상세페이지를 순차적으로 크롤링 (스레드에서 실행)
    batch_size=0이면 전수 크롤링."""
    import pymysql as _pymysql

    conn = _pymysql.connect(
        host='192.168.219.200', user='root',
        password=_get_db_password(), database='myproduct',
        connect_timeout=10, read_timeout=30, write_timeout=30,
    )
    conn.autocommit(True)
    cur = conn.cursor()

    # 상세페이지 없는 상품 조회
    limit_clause = f'LIMIT {batch_size}' if batch_size > 0 else ''
    cur.execute(f"""
        SELECT origin_product_no FROM smartstore_product
        WHERE store_id = %s AND detail_content IS NULL
        ORDER BY origin_product_no
        {limit_clause}
    """, [store_pk])
    products = [r[0] for r in cur.fetchall()]

    if not products:
        conn.close()
        with _detail_lock:
            _detail_state['completed_stores'] += 1
            _detail_state['by_store'][store_name] = {'total': 0, 'updated': 0, 'errors': 0, 'done': True}
        _detail_add_log(f'[{store_name}] 크롤링할 상품 없음')
        return {'store': store_name, 'total': 0, 'updated': 0, 'errors': 0}

    _detail_add_log(f'[{store_name}] 시작: {len(products):,}개')
    with _detail_lock:
        _detail_state['by_store'][store_name] = {'total': len(products), 'updated': 0, 'errors': 0, 'done': False}

    token = None
    updated = 0
    errs = 0
    consecutive_errors = 0

    for i, opno in enumerate(products):
        if not _detail_state['running']:
            _detail_add_log(f'[{store_name}] 중지됨 ({i}/{len(products)})')
            break

        for attempt in range(4):
            try:
                if token is None:
                    token = _get_access_token(api_key, secret_key)
                detail = fetch_product_detail(opno, token)
                cur.execute(_DETAIL_UPDATE_SQL, [
                    detail['detail_content'],
                    detail['origin_area_code'], detail['origin_area_content'],
                    detail['after_service_tel'], detail['after_service_guide'],
                    detail['tax_type'], detail['sale_type'], detail['leaf_category_id'],
                    detail['minor_purchasable'], detail['itself_production'],
                    detail['product_info_notice'], detail['certification_info'],
                    detail['option_info'], detail['matched_catalog_id'],
                    detail['delivery_company'],
                    opno,
                ])
                updated += 1
                consecutive_errors = 0
                break
            except requests.exceptions.HTTPError as e:
                if e.response is not None and e.response.status_code == 429:
                    wait = max(int(e.response.headers.get('Retry-After', 10)), 5 * (attempt + 1))
                    _detail_add_log(f'[{store_name}] 429 rate limit, {wait}초 대기')
                    time.sleep(wait)
                    token = None
                    continue
                elif e.response is not None and e.response.status_code in (401, 403):
                    token = None
                    if attempt < 3:
                        time.sleep(1)
                        continue
                    errs += 1
                    consecutive_errors += 1
                    break
                elif e.response is not None and e.response.status_code == 404:
                    # 상품 삭제됨 — skip
                    errs += 1
                    break
                else:
                    errs += 1
                    consecutive_errors += 1
                    break
            except Exception:
                errs += 1
                consecutive_errors += 1
                if '401' in str(type) or 'Unauthorized' in str(type):
                    token = None
                break

        with _detail_lock:
            _detail_state['processed'] += 1
            _detail_state['by_store'][store_name]['updated'] = updated
            _detail_state['by_store'][store_name]['errors'] = errs

        # 로그: 500건마다
        if (i + 1) % 500 == 0:
            _detail_add_log(f'[{store_name}] {i+1:,}/{len(products):,} (OK {updated}, ERR {errs})')

        # 30분 리포트 체크
        _maybe_send_progress_report()

        # 연속 에러 10회면 토큰 리셋 후 대기
        if consecutive_errors >= 10:
            _detail_add_log(f'[{store_name}] 연속 에러 {consecutive_errors}회, 30초 대기')
            time.sleep(30)
            token = None
            consecutive_errors = 0

        time.sleep(0.2)

    conn.close()

    with _detail_lock:
        _detail_state['completed_stores'] += 1
        _detail_state['updated'] += updated
        _detail_state['errors'] += errs
        _detail_state['by_store'][store_name]['done'] = True

    _detail_add_log(f'[{store_name}] 완료: {updated:,}/{len(products):,} (에러 {errs})')
    return {'store': store_name, 'total': len(products), 'updated': updated, 'errors': errs}


def _get_db_password():
    """Django settings에서 DB 비밀번호 가져오기"""
    from django.conf import settings
    return settings.DATABASES.get('myproduct', {}).get('PASSWORD', '')


def start_detail_crawl(batch_size=0):
    """전체 스토어 상세페이지 병렬 크롤링 시작 (batch_size=0이면 전수)"""
    with _detail_lock:
        if _detail_state['running']:
            return {'ok': False, 'message': '이미 실행 중'}

    # API 키가 있는 스토어 목록
    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT s.id, s.store_name, s.commerce_api_key, s.commerce_secret_key,
                   COUNT(p.id) as need_count
            FROM smartstoreIdList s
            JOIN smartstore_product p ON p.store_id = s.id AND p.detail_content IS NULL
            WHERE s.is_active = 1
              AND s.commerce_api_key IS NOT NULL AND s.commerce_api_key <> ''
            GROUP BY s.id
            HAVING need_count > 0
            ORDER BY s.store_name
        """)
        stores = cur.fetchall()

    if not stores:
        return {'ok': False, 'message': '크롤링할 상품 없음'}

    total_products = sum(r[4] for r in stores)

    with _detail_lock:
        _detail_state.update({
            'running': True,
            'started_at': time.time(),
            'total_stores': len(stores),
            'completed_stores': 0,
            'total_products': total_products,
            'processed': 0,
            'updated': 0,
            'errors': 0,
            'by_store': {},
            'last_report_at': time.time(),
            'logs': [],
        })

    _detail_add_log(f'상세 크롤링 시작: {len(stores)}개 스토어, {total_products:,}건')
    _detail_send_telegram(
        f'<b>상세 크롤링 시작</b>\n'
        f'{len(stores)}개 스토어 병렬 | {total_products:,}건\n'
        f'예상: {total_products * 0.2 / len(stores) / 60:.0f}분'
    )

    def _run():
        try:
            with ThreadPoolExecutor(max_workers=min(len(stores), 24)) as pool:
                futures = []
                for sid, name, api_key, secret_key, _ in stores:
                    f = pool.submit(_crawl_store_details, sid, name, api_key, secret_key, batch_size)
                    futures.append(f)
                for f in futures:
                    f.result()
        finally:
            with _detail_lock:
                _detail_state['running'] = False
                st = dict(_detail_state)

            # 완료 리포트
            elapsed = time.time() - (st.get('started_at') or time.time())
            mins = int(elapsed // 60)
            lines = [
                '<b>상세 크롤링 완료</b>',
                '',
                f'처리: {st["processed"]:,} / {st["total_products"]:,}',
                f'업데이트: {st["updated"]:,} | 에러: {st["errors"]:,}',
                f'소요: {mins}분',
                '',
            ]
            for s, v in sorted(st.get('by_store', {}).items(), key=lambda x: -x[1].get('updated', 0)):
                mark = 'O' if v.get('done') else 'X'
                lines.append(f'  [{mark}] {s}: {v.get("updated", 0):,}/{v.get("total", 0):,}')
            _detail_send_telegram('\n'.join(lines))
            _detail_add_log(f'전체 완료: {st["updated"]:,}/{st["processed"]:,} ({mins}분)')

    threading.Thread(target=_run, daemon=True).start()
    return {'ok': True, 'message': f'{len(stores)}개 스토어 병렬 크롤링 시작 ({total_products:,}건)'}


def stop_detail_crawl():
    with _detail_lock:
        _detail_state['running'] = False


def get_detail_crawl_status():
    with _detail_lock:
        st = dict(_detail_state)
        st['logs'] = list(st.get('logs', []))
        st['by_store'] = dict(st.get('by_store', {}))
    total = max(st.get('total_products', 0), 1)
    processed = st.get('processed', 0)
    st['progress_pct'] = round(processed / total * 100, 1) if total else 0
    elapsed = 0
    if st.get('started_at'):
        elapsed = time.time() - st['started_at']
    st['elapsed'] = round(elapsed, 1)
    return st


# ── 상품 편집 ──

NAVER_IMAGE_UPLOAD_URL = 'https://api.commerce.naver.com/external/v1/product-images/upload'


def _get_store_credentials(store_id):
    """store_id → (api_key, secret_key, store_name) 조회"""
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT commerce_api_key, commerce_secret_key, store_name "
            "FROM smartstoreIdList WHERE id=%s", [store_id]
        )
        rows = _dictfetchall(cur)
    if not rows:
        return None, None, None
    r = rows[0]
    return r.get('commerce_api_key'), r.get('commerce_secret_key'), r.get('store_name')


def get_product_full_detail(origin_product_no, store_id):
    """상품 편집용 전체 상세 JSON 조회 (네이버 API v2)"""
    api_key, secret_key, store_name = _get_store_credentials(store_id)
    if not api_key or not secret_key:
        return {'error': 'API 키가 등록되지 않았습니다.'}

    token = _get_access_token(api_key, secret_key)
    url = NAVER_PRODUCT_DETAIL_URL.format(origin_product_no)
    resp = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=30)
    resp.raise_for_status()
    raw = resp.json()

    op = raw.get('originProduct', {})
    da = op.get('detailAttribute', {})
    images = op.get('images', {})
    oai = da.get('originAreaInfo', {})
    asi = da.get('afterServiceInfo', {})
    di = op.get('deliveryInfo', {})
    seo = da.get('seoInfo', {})

    return {
        'origin_product_no': origin_product_no,
        'store_id': store_id,
        'store_name': store_name,
        'name': op.get('name', ''),
        'status_type': op.get('statusType', ''),
        'sale_type': op.get('saleType', ''),
        'sale_price': op.get('salePrice', 0),
        'stock_quantity': op.get('stockQuantity', 0),
        'leaf_category_id': op.get('leafCategoryId', ''),
        'detail_content': op.get('detailContent', ''),
        'representative_image': images.get('representativeImage'),
        'optional_images': images.get('optionalImages', []),
        'origin_area': oai,
        'after_service': asi,
        'delivery_info': di,
        'seller_tags': seo.get('sellerTags', []),
        'tax_type': da.get('taxType', ''),
        'option_info': da.get('optionInfo', {}),
        'product_info_notice': da.get('productInfoProvidedNotice', {}),
    }


def update_product_fields(origin_product_no, store_id, updates):
    """상품 필드 수정 (GET→수정→PUT)
    updates keys: name, detailContent, representativeImage({url})
    """
    api_key, secret_key, _ = _get_store_credentials(store_id)
    if not api_key or not secret_key:
        return {'error': 'API 키가 등록되지 않았습니다.'}

    token = _get_access_token(api_key, secret_key)
    url = NAVER_PRODUCT_DETAIL_URL.format(origin_product_no)
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }

    # 1. GET 현재 상태
    get_resp = requests.get(url, headers=headers, timeout=30)
    get_resp.raise_for_status()
    product = get_resp.json()['originProduct']

    # 2. 필드 적용
    if 'name' in updates:
        product['name'] = updates['name']
    if 'detailContent' in updates:
        product['detailContent'] = updates['detailContent']
    if 'representativeImage' in updates:
        if 'images' not in product:
            product['images'] = {}
        product['images']['representativeImage'] = updates['representativeImage']

    # 3. sellerTags 제거 (금지어 검증 실패 방지)
    detail = product.get('detailAttribute', {})
    seo = detail.get('seoInfo', {})
    if 'sellerTags' in seo:
        del seo['sellerTags']

    # 4. PUT + invalidInputs 재시도
    put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=30)
    if put_resp.status_code == 400:
        inv = put_resp.json().get('invalidInputs', [])
        for item in inv:
            field = item.get('name', '')
            parts = field.replace('originProduct.', '').split('.')
            obj = product
            for p_part in parts[:-1]:
                obj = obj.get(p_part, {}) if isinstance(obj, dict) else {}
            if isinstance(obj, dict) and parts[-1] in obj:
                del obj[parts[-1]]
        put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=30)

    put_resp.raise_for_status()

    # 5. 로컬 DB 동시 업데이트
    db_sets = []
    db_params = []
    if 'name' in updates:
        db_sets.append('name = %s')
        db_params.append(updates['name'][:500])
    if 'detailContent' in updates:
        db_sets.append('detail_content = %s')
        db_params.append(updates['detailContent'])
    if 'representativeImage' in updates:
        img_url = updates['representativeImage'].get('url', '')
        db_sets.append('product_image_url = %s')
        db_params.append(img_url)
    if db_sets:
        db_params.append(origin_product_no)
        with connections['myproduct'].cursor() as cur:
            cur.execute(
                f"UPDATE smartstore_product SET {', '.join(db_sets)} "
                f"WHERE origin_product_no = %s",
                db_params,
            )

    return {'ok': True, 'origin_product_no': origin_product_no}


def zero_margin_update(store_id=0):
    """역마진 상품의 가격을 0마진(수익0)으로 자동 수정
    공식: new_price = ceil(master_price / 0.93 / 10) * 10
    """
    import math

    # 역마진 상품 조회
    with connections['myproduct'].cursor() as cur:
        where = "p.master_price > 0 AND ROUND(p.sale_price * 0.93) < p.master_price AND p.status_type IN ('SALE','SUSPENSION')"
        params = []
        if store_id:
            where += " AND p.store_id = %s"
            params.append(store_id)
        cur.execute(
            f"SELECT p.id, p.origin_product_no, p.sale_price, p.master_price, "
            f"p.name, s.id as store_pk, s.commerce_api_key, s.commerce_secret_key, s.store_name "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON p.store_id = s.id "
            f"WHERE {where} "
            f"ORDER BY p.store_id, p.id",
            params,
        )
        rows = _dictfetchall(cur)

    if not rows:
        return {'total': 0, 'success': 0, 'fail': 0, 'items': []}

    # 가격 계산
    for r in rows:
        new_price = math.ceil(r['master_price'] / 0.93 / 10) * 10
        r['new_price'] = new_price
        r['old_price'] = r['sale_price']
        r['diff'] = new_price - r['sale_price']

    # 미리보기 (preview=True일 때는 호출측에서 items만 사용)
    # 실제 수정: 상점별 그룹핑
    store_groups = {}
    for r in rows:
        sid = r['store_pk']
        if sid not in store_groups:
            store_groups[sid] = {
                'api_key': r['commerce_api_key'],
                'secret_key': r['commerce_secret_key'],
                'store_name': r['store_name'],
                'token': None,
                'items': [],
            }
        store_groups[sid]['items'].append(r)

    # ── 사업자별 병렬 처리 ──
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _process_store_group(sid, group):
        """한 사업자(API키) 내 상품들을 순차 처리"""
        local_results = []
        if not group['api_key'] or not group['secret_key']:
            for item in group['items']:
                local_results.append({
                    'origin_product_no': item['origin_product_no'],
                    'name': item['name'][:30],
                    'old_price': item['old_price'],
                    'new_price': item['new_price'],
                    'ok': False,
                    'error': 'API 키 미등록',
                })
            return local_results

        try:
            token = _get_access_token(group['api_key'], group['secret_key'])
        except Exception as e:
            for item in group['items']:
                local_results.append({
                    'origin_product_no': item['origin_product_no'],
                    'name': item['name'][:30],
                    'old_price': item['old_price'],
                    'new_price': item['new_price'],
                    'ok': False,
                    'error': f'토큰 실패: {str(e)[:50]}',
                })
            return local_results

        for item in group['items']:
            try:
                url = NAVER_PRODUCT_DETAIL_URL.format(item['origin_product_no'])
                headers = {
                    'Authorization': f'Bearer {token}',
                    'Content-Type': 'application/json',
                }
                get_resp = requests.get(url, headers=headers, timeout=15)
                get_resp.raise_for_status()
                product = get_resp.json()['originProduct']

                product['salePrice'] = item['new_price']

                detail_attr = product.get('detailAttribute', {})
                seo = detail_attr.get('seoInfo', {})
                if 'sellerTags' in seo:
                    del seo['sellerTags']

                put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=15)
                if put_resp.status_code == 400:
                    inv = put_resp.json().get('invalidInputs', [])
                    for inv_item in inv:
                        field = inv_item.get('name', '')
                        parts = field.replace('originProduct.', '').split('.')
                        obj = product
                        for p_part in parts[:-1]:
                            obj = obj.get(p_part, {}) if isinstance(obj, dict) else {}
                        if isinstance(obj, dict) and parts[-1] in obj:
                            del obj[parts[-1]]
                    put_resp = requests.put(url, json={'originProduct': product}, headers=headers, timeout=15)

                put_resp.raise_for_status()

                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "UPDATE smartstore_product SET sale_price = %s WHERE id = %s",
                        [item['new_price'], item['id']],
                    )

                local_results.append({
                    'origin_product_no': item['origin_product_no'],
                    'name': item['name'][:30],
                    'old_price': item['old_price'],
                    'new_price': item['new_price'],
                    'ok': True,
                })
            except Exception as e:
                local_results.append({
                    'origin_product_no': item['origin_product_no'],
                    'name': item['name'][:30],
                    'old_price': item['old_price'],
                    'new_price': item['new_price'],
                    'ok': False,
                    'error': str(e)[:100],
                })
        return local_results

    results = []
    with ThreadPoolExecutor(max_workers=min(len(store_groups), 8)) as executor:
        futures = {executor.submit(_process_store_group, sid, group): sid for sid, group in store_groups.items()}
        for future in as_completed(futures):
            results.extend(future.result())

    success = sum(1 for r in results if r.get('ok'))
    fail = sum(1 for r in results if not r.get('ok'))

    # ── 로그 저장 ──
    total_diff = sum(r['diff'] for r in rows)
    log_id = 0
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute(
                "INSERT INTO zero_margin_log (total, success_count, fail_count, total_diff) "
                "VALUES (%s, %s, %s, %s)",
                [len(rows), success, fail, total_diff],
            )
            log_id = cur.lastrowid
            if results:
                cur.executemany(
                    "INSERT INTO zero_margin_log_item "
                    "(log_id, origin_product_no, name, store_name, old_price, new_price, master_price, ok, error_msg) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        (log_id, r['origin_product_no'], r['name'][:200],
                         next((rw['store_name'] for rw in rows if rw['origin_product_no'] == r['origin_product_no']), ''),
                         r['old_price'], r['new_price'],
                         next((rw['master_price'] for rw in rows if rw['origin_product_no'] == r['origin_product_no']), 0),
                         1 if r.get('ok') else 0, r.get('error', '')[:200] or None)
                        for r in results
                    ],
                )
    except Exception:
        pass  # 로그 실패해도 본 결과에 영향 없음

    return {'total': len(rows), 'success': success, 'fail': fail, 'items': results, 'log_id': log_id}


def zero_margin_logs(limit=20):
    """0마진 처리 이력 조회"""
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT id, total, success_count, fail_count, total_diff, created_at "
            "FROM zero_margin_log ORDER BY id DESC LIMIT %s",
            [limit],
        )
        return _dictfetchall(cur)


def zero_margin_log_detail(log_id):
    """0마진 처리 상세 이력"""
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "SELECT origin_product_no, name, store_name, old_price, new_price, "
            "master_price, ok, error_msg "
            "FROM zero_margin_log_item WHERE log_id = %s ORDER BY id",
            [log_id],
        )
        return _dictfetchall(cur)


def zero_margin_preview(store_id=0):
    """역마진 상품 0마진 가격 미리보기"""
    import math

    with connections['myproduct'].cursor() as cur:
        where = "p.master_price > 0 AND ROUND(p.sale_price * 0.93) < p.master_price AND p.status_type IN ('SALE','SUSPENSION')"
        params = []
        if store_id:
            where += " AND p.store_id = %s"
            params.append(store_id)
        cur.execute(
            f"SELECT p.id, p.origin_product_no, p.sale_price, p.master_price, "
            f"p.name, s.store_name "
            f"FROM smartstore_product p "
            f"JOIN smartstoreIdList s ON p.store_id = s.id "
            f"WHERE {where} "
            f"ORDER BY (p.master_price - ROUND(p.sale_price * 0.93)) DESC",
            params,
        )
        rows = _dictfetchall(cur)

    items = []
    for r in rows:
        new_price = math.ceil(r['master_price'] / 0.93 / 10) * 10
        items.append({
            'origin_product_no': r['origin_product_no'],
            'name': r['name'][:40],
            'store_name': r['store_name'],
            'sale_price': r['sale_price'],
            'master_price': r['master_price'],
            'settle': round(r['sale_price'] * 0.93),
            'margin': round(r['sale_price'] * 0.93) - r['master_price'],
            'new_price': new_price,
            'new_margin': round(new_price * 0.93) - r['master_price'],
        })

    return {'count': len(items), 'items': items}


def upload_product_image(store_id, image_file):
    """상품 이미지를 네이버 CDN에 업로드하고 URL 반환"""
    api_key, secret_key, _ = _get_store_credentials(store_id)
    if not api_key or not secret_key:
        return {'error': 'API 키가 등록되지 않았습니다.'}

    token = _get_access_token(api_key, secret_key)
    headers = {'Authorization': f'Bearer {token}'}
    files = {'imageFiles': (image_file.name, image_file.read(), image_file.content_type or 'image/jpeg')}
    resp = requests.post(NAVER_IMAGE_UPLOAD_URL, headers=headers, files=files, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    images = data.get('images', [])
    if not images:
        return {'error': '이미지 업로드 결과가 없습니다.'}
    return {'url': images[0].get('url', '')}
