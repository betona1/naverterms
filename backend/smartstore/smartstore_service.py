from django.db import connections


def _dictfetchall(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _serialize_row(row):
    for key in ('created_at', 'updated_at'):
        if row.get(key):
            row[key] = row[key].isoformat()
    return row


def get_stores(include_inactive=False):
    with connections['myproduct'].cursor() as cur:
        if include_inactive:
            cur.execute("SELECT * FROM smartstoreIdList ORDER BY id")
        else:
            cur.execute("SELECT * FROM smartstoreIdList WHERE is_active=1 ORDER BY id")
        return [_serialize_row(r) for r in _dictfetchall(cur)]


def get_store(pk):
    with connections['myproduct'].cursor() as cur:
        cur.execute("SELECT * FROM smartstoreIdList WHERE id=%s", [pk])
        rows = _dictfetchall(cur)
        if not rows:
            return None
        return _serialize_row(rows[0])


def create_store(data):
    fields = ['store_id', 'store_pw', 'store_name']
    values = [data['store_id'], data['store_pw'], data['store_name']]

    for opt in ('store_url', 'commerce_api_key', 'commerce_secret_key', 'memo'):
        if data.get(opt) is not None:
            fields.append(opt)
            values.append(data[opt])

    placeholders = ', '.join(['%s'] * len(values))
    cols = ', '.join(fields)

    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"INSERT INTO smartstoreIdList ({cols}) VALUES ({placeholders})",
            values,
        )
        new_id = cur.lastrowid
    return get_store(new_id)


def update_store(pk, data):
    sets = []
    values = []
    for field in ('store_id', 'store_pw', 'store_name', 'store_url',
                  'commerce_api_key', 'commerce_secret_key', 'is_active', 'memo'):
        if field in data:
            sets.append(f"{field}=%s")
            values.append(data[field])

    if not sets:
        return get_store(pk)

    values.append(pk)
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            f"UPDATE smartstoreIdList SET {', '.join(sets)} WHERE id=%s",
            values,
        )
    return get_store(pk)


def deactivate_store(pk):
    with connections['myproduct'].cursor() as cur:
        cur.execute(
            "UPDATE smartstoreIdList SET is_active=0 WHERE id=%s",
            [pk],
        )
        return cur.rowcount > 0


def delete_store(pk):
    with connections['myproduct'].cursor() as cur:
        cur.execute("DELETE FROM smartstore_product WHERE store_id=%s", [pk])
        cur.execute("DELETE FROM smartstoreIdList WHERE id=%s", [pk])
        return cur.rowcount > 0


def bulk_create_stores(rows):
    created = 0
    updated = 0
    skipped = 0
    errors = []
    for i, row in enumerate(rows):
        if not row.get('store_id'):
            errors.append(f"{i+2}행: store_id 누락")
            continue
        try:
            # store_url만 업데이트하는 경우 (store_pw/store_name 없이)
            if row.get('store_url') and (not row.get('store_pw') or not row.get('store_name')):
                with connections['myproduct'].cursor() as cur:
                    cur.execute(
                        "UPDATE smartstoreIdList SET store_url=%s WHERE store_id=%s",
                        [row['store_url'], row['store_id']],
                    )
                    if cur.rowcount > 0:
                        updated += 1
                    else:
                        errors.append(f"{i+2}행: store_id '{row['store_id']}' 없음")
                continue
            if not row.get('store_pw') or not row.get('store_name'):
                errors.append(f"{i+2}행: 필수값(store_id, store_pw, store_name) 누락")
                continue
            create_store(row)
            created += 1
        except Exception as e:
            if 'Duplicate' in str(e):
                # 중복이면 store_url 업데이트 시도
                if row.get('store_url'):
                    try:
                        with connections['myproduct'].cursor() as cur:
                            cur.execute(
                                "UPDATE smartstoreIdList SET store_url=%s WHERE store_id=%s",
                                [row['store_url'], row['store_id']],
                            )
                        updated += 1
                    except Exception:
                        skipped += 1
                else:
                    skipped += 1
            else:
                errors.append(f"{i+2}행: {str(e)}")
    return {'created': created, 'updated': updated, 'skipped': skipped, 'errors': errors}
