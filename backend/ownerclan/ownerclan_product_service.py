import io
import os
import csv
import sys
import subprocess
import tempfile
import zipfile
import logging
from datetime import datetime

import openpyxl
from django.conf import settings
from django.db import connections

logger = logging.getLogger(__name__)

DB = 'ads'

# 엑셀 컬럼 인덱스 (0-based) → DB 필드명 매핑
EXCEL_COL_MAP = {
    0: 'seller_code1',
    1: 'seller_code2',
    # 2 = product_code (별도 처리)
    3: 'category_code',
    4: 'category_name',
    5: 'market_category',
    6: 'product_name',
    7: 'market_product_name',
    8: 'ownerclan_price',
    9: 'consumer_price',
    10: 'market_price',
    11: 'shipping_fee',
    12: 'shipping_type',
    13: 'min_qty',
    14: 'max_qty',
    15: 'company_notice',
    16: 'special_notice',
    17: 'option1_name',
    18: 'option1_values',
    19: 'option2_name',
    20: 'option2_values',
    21: 'combined_option',
    22: 'product_attribute',
    23: 'product_grade',
    24: 'tax_type',
    25: 'compliance',
    26: 'age_restriction',
    27: 'return_possible',
    28: 'image_large',
    29: 'image_medium',
    30: 'image_small',
    31: 'manufacturer',
    32: 'brand',
    33: 'model_name',
    34: 'origin',
    35: 'keywords',
    36: 'registered_at',
    37: 'modified_at',
    38: 'header_text',
    39: 'detail_html',
    40: 'notice_code',
    41: 'notice_category',
    42: 'notice_info',
    43: 'notice_html',
    44: 'market_gmarket',
    45: 'market_auction',
    46: 'market_11st',
    47: 'market_coupang',
    48: 'market_smartstore',
    49: 'market_promo',
    50: 'market_gift',
    51: 'certification_type',
    52: 'certification_info',
    53: 'return_fee',
    54: 'independent_option',
    55: 'combined_option_detail',
}

INT_FIELDS = {
    'ownerclan_price', 'consumer_price', 'market_price',
    'shipping_fee', 'min_qty', 'max_qty', 'return_fee',
}

DATETIME_FIELDS = {'registered_at', 'modified_at'}

TRACKABLE_FIELDS = list(EXCEL_COL_MAP.values())


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _safe_str(val):
    if val is None:
        return ''
    return str(val).strip()


def _safe_int(val):
    if val is None:
        return 0
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return 0


def _safe_datetime(val):
    if val is None or val == '':
        return None
    if isinstance(val, datetime):
        return val
    s = str(val).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _parse_excel_row(row_values):
    data = {}
    for col_idx, field_name in EXCEL_COL_MAP.items():
        raw = row_values[col_idx] if col_idx < len(row_values) else None
        if field_name in INT_FIELDS:
            data[field_name] = _safe_int(raw)
        elif field_name in DATETIME_FIELDS:
            data[field_name] = _safe_datetime(raw)
        else:
            data[field_name] = _safe_str(raw)
    return data


def _field_changed(old_val, new_val, field_name):
    if field_name in INT_FIELDS:
        return _safe_int(old_val) != _safe_int(new_val)
    if field_name in DATETIME_FIELDS:
        a = _safe_datetime(old_val)
        b = _safe_datetime(new_val)
        if a and b:
            return a.strftime('%Y-%m-%d %H:%M:%S') != b.strftime('%Y-%m-%d %H:%M:%S')
        return (a is None) != (b is None)
    return _safe_str(old_val) != _safe_str(new_val)


def upload_excel_async(uploaded_file):
    suffix = '.zip' if uploaded_file.name.lower().endswith('.zip') else '.xlsx'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix='ownerclan_')
    for chunk in uploaded_file.chunks():
        tmp.write(chunk)
    tmp.close()

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with connections[DB].cursor() as cur:
        cur.execute(
            "INSERT INTO lohas_task (task_type, status, input_data, result_data, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            ['ownerclan_upload', 'pending',
             '{"file_path": "%s", "filename": "%s"}' % (tmp.name, uploaded_file.name),
             '{}', now, now],
        )
        task_id = cur.lastrowid

    manage_py = os.path.join(settings.BASE_DIR, 'manage.py')
    proc = subprocess.Popen(
        [sys.executable, manage_py, 'ownerclan_upload', str(task_id)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    with connections[DB].cursor() as cur:
        cur.execute("UPDATE lohas_task SET pid=%s WHERE id=%s", [proc.pid, task_id])

    return {'task_id': task_id, 'status': 'pending'}


def get_upload_task(task_id):
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT id, task_type, status, input_data, result_data, pid, created_at, updated_at "
            "FROM lohas_task WHERE id=%s", [task_id])
        rows = _dictfetchall(cur)
        if not rows:
            return None
        row = rows[0]
        # result_data / input_data 는 JSON 텍스트일 수 있음
        import json
        for k in ('input_data', 'result_data'):
            if isinstance(row[k], str):
                try:
                    row[k] = json.loads(row[k])
                except (json.JSONDecodeError, TypeError):
                    pass
        return row


def check_running_task():
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT id FROM lohas_task WHERE task_type='ownerclan_upload' AND status IN ('pending','running') LIMIT 1"
        )
        row = cur.fetchone()
        return row[0] if row else None


def upload_csv_status(uploaded_file):
    content = uploaded_file.read()
    for enc in ('euc-kr', 'utf-8', 'cp949'):
        try:
            text = content.decode(enc, errors='replace')
            break
        except Exception:
            continue
    else:
        text = content.decode('utf-8', errors='replace')

    reader = csv.reader(io.StringIO(text))
    next(reader, None)
    next(reader, None)

    STATUS_MAP = {
        '품절': 2, '단종': 3, '유통금지': 3,
        '옵션 품절': 2, '옵션 단종': 3,
        '재입고': 1, '옵션 재입고': 1,
    }

    updated = 0
    with connections[DB].cursor() as cur:
        for row in reader:
            if len(row) < 8:
                continue
            code = row[1].strip()
            status_text = row[7].strip()
            if not code:
                continue
            sale_status = STATUS_MAP.get(status_text)
            if sale_status is not None:
                cur.execute(
                    "UPDATE ownerclan_product SET sale_status=%s WHERE product_code=%s",
                    [sale_status, code],
                )
                if cur.rowcount > 0:
                    updated += 1

    return {'updated': updated}


def sync_products(product_ids=None):
    fields = list(EXCEL_COL_MAP.values())
    set_parts = [f"orig_{f} = {f}" for f in fields]
    set_parts.append("is_synced = 1")
    set_parts.append("synced_at = %s")
    now = datetime.now()

    with connections[DB].cursor() as cur:
        if product_ids:
            placeholders = ','.join(['%s'] * len(product_ids))
            cur.execute(
                f"UPDATE ownerclan_product SET {', '.join(set_parts)} "
                f"WHERE id IN ({placeholders})",
                [now] + product_ids,
            )
        else:
            cur.execute(
                f"UPDATE ownerclan_product SET {', '.join(set_parts)} "
                f"WHERE is_synced = 0",
                [now],
            )
        count = cur.rowcount
    return {'synced': count}


def _changed_field_condition(field_name):
    if field_name in INT_FIELDS:
        return f"COALESCE({field_name},0) != COALESCE(orig_{field_name},0)"
    elif field_name in DATETIME_FIELDS:
        return f"COALESCE(CAST({field_name} AS CHAR),'') != COALESCE(CAST(orig_{field_name} AS CHAR),'')"
    else:
        return f"COALESCE({field_name},'') != COALESCE(orig_{field_name},'')"


def _build_where(sale_status=None, is_synced=None, search=None, changed_field=None):
    where = ['1=1']
    params = []
    if sale_status is not None:
        where.append('sale_status = %s')
        params.append(int(sale_status))
    if is_synced is not None:
        where.append('is_synced = %s')
        params.append(int(is_synced))
    if search:
        import re
        codes = [c.strip() for c in re.split(r'[\s,\n\r\t]+', search) if c.strip()]
        if len(codes) > 1:
            ph = ','.join(['%s'] * len(codes))
            where.append(f'product_code IN ({ph})')
            params.extend(codes)
        else:
            where.append('(product_code LIKE %s OR product_name LIKE %s)')
            like = f'%{search}%'
            params.extend([like, like])
    if changed_field:
        if changed_field in TRACKABLE_FIELDS:
            where.append(_changed_field_condition(changed_field))
        elif changed_field == '__any__':
            where.append('is_synced = 0')
    return ' AND '.join(where), params


def get_products(page=1, per_page=50, sale_status=None, is_synced=None, search=None, changed_field=None):
    where_sql, params = _build_where(sale_status, is_synced, search, changed_field)
    offset = (page - 1) * per_page

    with connections[DB].cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM ownerclan_product WHERE {where_sql}", params)
        total = cur.fetchone()[0]

        cur.execute(
            f"SELECT id, product_code, product_name, orig_product_name, "
            f"market_product_name, orig_market_product_name, "
            f"ownerclan_price, orig_ownerclan_price, "
            f"market_price, orig_market_price, "
            f"shipping_fee, orig_shipping_fee, "
            f"return_fee, orig_return_fee, "
            f"image_large, orig_image_large, "
            f"image_small, "
            f"sale_status, is_synced, "
            f"category_name, manufacturer, origin, "
            f"uploaded_at, synced_at, created_at "
            f"FROM ownerclan_product WHERE {where_sql} "
            f"ORDER BY product_code "
            f"LIMIT %s OFFSET %s",
            params + [per_page, offset],
        )
        rows = _dictfetchall(cur)

    for r in rows:
        for k in ('uploaded_at', 'synced_at', 'created_at'):
            if r.get(k) and isinstance(r[k], datetime):
                r[k] = r[k].isoformat()

    return {
        'items': rows,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page if total > 0 else 0,
    }


def get_product_detail(product_id):
    fields = list(EXCEL_COL_MAP.values())
    select_parts = ['id', 'product_code', 'sale_status', 'is_synced',
                     'synced_at', 'uploaded_at', 'created_at', 'updated_at']
    for f in fields:
        select_parts.append(f)
        select_parts.append(f'orig_{f}')

    with connections[DB].cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(select_parts)} FROM ownerclan_product WHERE id=%s",
            [product_id],
        )
        rows = _dictfetchall(cur)
        if not rows:
            return None
        row = rows[0]

    for k, v in row.items():
        if isinstance(v, datetime):
            row[k] = v.isoformat()

    changed_fields = []
    for f in fields:
        if _field_changed(row.get(f'orig_{f}'), row.get(f), f):
            changed_fields.append(f)
    row['changed_fields'] = changed_fields
    return row


def get_stats():
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT "
            "COUNT(*) as total, "
            "SUM(sale_status=1) as selling, "
            "SUM(sale_status=2) as soldout, "
            "SUM(sale_status=3) as discontinued, "
            "SUM(is_synced=0) as changed "
            "FROM ownerclan_product"
        )
        row = _dictfetchall(cur)[0]
    return {k: int(v or 0) for k, v in row.items()}


def get_changed_field_counts():
    counts = {}
    with connections[DB].cursor() as cur:
        for f in TRACKABLE_FIELDS:
            cond = _changed_field_condition(f)
            cur.execute(f"SELECT COUNT(*) FROM ownerclan_product WHERE {cond}")
            cnt = cur.fetchone()[0]
            if cnt > 0:
                counts[f] = cnt
    return counts


def get_products_for_export(sale_status=None, is_synced=None, search=None, changed_field=None):
    where_sql, params = _build_where(sale_status, is_synced, search, changed_field)

    fields = list(EXCEL_COL_MAP.values())
    orig_fields = [f'orig_{f}' for f in fields]

    select_cols = (
        ['product_code', 'sale_status', 'is_synced']
        + fields + orig_fields
        + ['uploaded_at', 'synced_at']
    )

    with connections[DB].cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(select_cols)} "
            f"FROM ownerclan_product WHERE {where_sql} "
            f"ORDER BY product_code",
            params,
        )
        return _dictfetchall(cur)


def upload_soldout_txt(uploaded_file):
    content = uploaded_file.read()
    for enc in ('utf-8', 'euc-kr', 'cp949'):
        try:
            text = content.decode(enc)
            break
        except Exception:
            continue
    else:
        text = content.decode('utf-8', errors='replace')

    soldout_codes = {line.strip() for line in text.splitlines() if line.strip()}

    with connections[DB].cursor() as cur:
        cur.execute("SELECT product_code FROM ownerclan_product")
        db_codes = {r[0] for r in cur.fetchall()}

    matched = soldout_codes & db_codes
    today = datetime.now().strftime('%Y-%m-%d')

    ownerclan_updated = 0
    batch = list(matched)
    with connections[DB].cursor() as cur:
        for i in range(0, len(batch), 1000):
            chunk = batch[i:i + 1000]
            placeholders = ','.join(['%s'] * len(chunk))
            cur.execute(
                f"UPDATE ownerclan_product SET sale_status=2, modified_at=%s "
                f"WHERE product_code IN ({placeholders}) AND sale_status != 2",
                [today] + chunk,
            )
            ownerclan_updated += cur.rowcount

    smartstore_updated = 0
    with connections['myproduct'].cursor() as cur:
        cur.execute("UPDATE smartstore_product SET ownerclan_soldout=0 WHERE ownerclan_soldout=1")
        for i in range(0, len(batch), 1000):
            chunk = batch[i:i + 1000]
            placeholders = ','.join(['%s'] * len(chunk))
            cur.execute(
                f"UPDATE smartstore_product SET ownerclan_soldout=1 "
                f"WHERE seller_management_code IN ({placeholders})",
                chunk,
            )
            smartstore_updated += cur.rowcount

    return {
        'total_codes': len(soldout_codes),
        'ownerclan_matched': len(matched),
        'ownerclan_updated': ownerclan_updated,
        'smartstore_updated': smartstore_updated,
    }


def activate_suspended_from_task(task_id):
    """업로드 태스크에 포함된 상품 중 판매중지인 것을 판매중(1)으로 변경"""
    import json as _json

    with connections[DB].cursor() as cur:
        cur.execute("SELECT input_data FROM lohas_task WHERE id=%s", [task_id])
        row = cur.fetchone()
        if not row:
            return {'error': 'task not found', 'activated': 0}

        input_data = row[0]
        if isinstance(input_data, str):
            input_data = _json.loads(input_data)

        file_path = input_data.get('file_path', '')
        filename = input_data.get('filename', '')

    # 태스크의 업로드 파일에서 product_code 목록을 다시 읽을 수 없으므로
    # (파일은 이미 삭제됨) DB에서 최근 업로드된 상품 중 판매중지인 것을 직접 갱신
    # uploaded_at이 이 태스크의 시작 이후인 상품 = 이 태스크에서 처리된 상품
    with connections[DB].cursor() as cur:
        cur.execute("SELECT created_at FROM lohas_task WHERE id=%s", [task_id])
        task_row = cur.fetchone()
        if not task_row:
            return {'activated': 0}
        task_created = task_row[0]

        cur.execute(
            "UPDATE ownerclan_product SET sale_status=1 "
            "WHERE sale_status != 1 AND uploaded_at >= %s",
            [task_created],
        )
        activated = cur.rowcount

    return {'activated': activated}


def get_w_codes(sale_status=None, is_synced=None, search=None, changed_field=None):
    where_sql, params = _build_where(sale_status, is_synced, search, changed_field)
    with connections[DB].cursor() as cur:
        cur.execute(
            f"SELECT product_code FROM ownerclan_product "
            f"WHERE {where_sql} ORDER BY product_code",
            params,
        )
        return [row[0] for row in cur.fetchall()]
