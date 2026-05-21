"""
빈 속성 검토 + 일괄 등록 서비스.

워크플로우:
  1. UI 에서 속성별 missing SKU 개수 + 후보값 보기
  2. 사용자가 (속성, 값) 선택 → 해당 SKU 일괄 등록
  3. Commerce API PUT 으로 productAttributes 갱신
  4. status='registered' 마킹
"""
import json
import time
from datetime import datetime
from django.db import connections


def _dictfetchall(cursor):
    cols = [c[0] for c in cursor.description]
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


def get_summary():
    """대시보드 통계."""
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT
              COUNT(*) AS total_missing,
              COUNT(DISTINCT seller_management_code) AS skus_with_missing,
              COUNT(DISTINCT attribute_seq) AS unique_attrs,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='registered' THEN 1 ELSE 0 END) AS registered,
              SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN status='reviewed' THEN 1 ELSE 0 END) AS reviewed,
              SUM(CASE WHEN candidate_count=1 AND status='pending' THEN 1 ELSE 0 END) AS auto_candidates
            FROM smartstore_product_missing_attrs
        """)
        return _dictfetchall(c)[0]


def list_attributes(page=1, per_page=50, search='', kind='all', status='pending', sort='count'):
    """속성별 그룹 — 빈 SKU 가 많은 순서. 사전계산 summary 사용.
    kind: 'all' | 'opt' (옵션 1+) | 'auto' (옵션 1개) | 'free' (옵션 0개)
    status: 'all' | 'pending' | 'registered' | 'reviewed' | 'skipped'
    """
    where = ['1=1']
    params = []
    # status 는 정렬 기준에 맞춰 사용 — pending 면 pending_skus>0 만, etc.
    if status == 'pending':
        where.append('pending_skus > 0')
    elif status == 'registered':
        where.append('registered_skus > 0')
    if search:
        where.append('attribute_name LIKE %s')
        params.append(f'%{search}%')
    if kind == 'opt':
        where.append('candidate_count >= 1')
    elif kind == 'auto':
        where.append('candidate_count = 1')
    elif kind == 'free':
        where.append('candidate_count = 0')

    where_sql = 'WHERE ' + ' AND '.join(where)
    sort_col = {'count': 'pending_skus', 'total': 'total_skus', 'name': 'attribute_name'}.get(sort, 'pending_skus')
    sort_dir = 'ASC' if sort == 'name' else 'DESC'
    offset = max(0, (page - 1) * per_page)

    with connections['myproduct'].cursor() as c:
        c.execute(f"SELECT COUNT(*) FROM smartstore_attr_missing_summary {where_sql}", params)
        total = c.fetchone()[0]

        c.execute(f"""
            SELECT attribute_seq, attribute_name,
                   attribute_kind_type AS kind_type,
                   attribute_type AS attr_type,
                   classification_type AS cls_type,
                   candidate_count, candidate_values_json,
                   total_skus AS missing_skus,
                   pending_skus, registered_skus, needs_manual_skus, failed_skus,
                   recommended_value_seq, recommended_value_text
            FROM smartstore_attr_missing_summary
            {where_sql}
            ORDER BY {sort_col} {sort_dir}
            LIMIT %s OFFSET %s
        """, params + [per_page, offset])
        rows = _dictfetchall(c)

    for r in rows:
        try:
            r['candidate_values'] = json.loads(r.pop('candidate_values_json') or '[]')
        except Exception:
            r['candidate_values'] = []

    return {'items': rows, 'total': total, 'page': page, 'per_page': per_page,
            'total_pages': (total + per_page - 1) // per_page}


def refresh_attr_summary():
    """smartstore_attr_missing_summary 재계산."""
    with connections['myproduct'].cursor() as c:
        c.execute("DELETE FROM smartstore_attr_missing_summary")
        c.execute("""
            INSERT INTO smartstore_attr_missing_summary
              (attribute_seq, attribute_name, attribute_kind_type, attribute_type, classification_type,
               candidate_count, candidate_values_json, recommended_value_seq, recommended_value_text,
               total_skus, pending_skus, registered_skus, needs_manual_skus, failed_skus)
            SELECT
              attribute_seq,
              MAX(attribute_name),
              MAX(attribute_kind_type),
              MAX(attribute_type),
              MAX(classification_type),
              MAX(candidate_count),
              MAX(candidate_values_json),
              MAX(recommended_value_seq),
              MAX(recommended_value_text),
              COUNT(*),
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status='registered' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status='needs_manual' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END)
            FROM smartstore_product_missing_attrs
            GROUP BY attribute_seq
        """)
        c.execute("SELECT COUNT(*) FROM smartstore_attr_missing_summary")
        return c.fetchone()[0]


def list_skus_for_attribute(attribute_seq, page=1, per_page=100, store_id=None, category_id=None,
                             status='pending', search=''):
    """특정 속성의 빈 SKU 리스트."""
    where = ['m.attribute_seq=%s']
    params = [attribute_seq]
    if status != 'all':
        where.append('m.status=%s')
        params.append(status)
    if store_id:
        where.append('m.store_id=%s')
        params.append(int(store_id))
    if category_id:
        where.append('m.category_id=%s')
        params.append(category_id)
    if search:
        where.append('m.seller_management_code LIKE %s')
        params.append(f'%{search}%')

    where_sql = ' AND '.join(where)
    offset = max(0, (page - 1) * per_page)

    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT COUNT(*) FROM smartstore_product_missing_attrs m WHERE {where_sql}
        """, params)
        total = c.fetchone()[0]

        # 카테고리별 분포 (현재 필터 기준)
        c.execute(f"""
            SELECT m.category_id, COUNT(*) AS cnt
            FROM smartstore_product_missing_attrs m
            WHERE {where_sql}
            GROUP BY m.category_id
            ORDER BY cnt DESC
            LIMIT 50
        """, params)
        by_cat = _dictfetchall(c)

        c.execute(f"""
            SELECT m.seller_management_code, m.store_id, m.category_id,
                   m.status, m.detected_at,
                   p.name AS product_name, p.sale_price, p.origin_product_no, p.channel_product_no,
                   s.store_name
            FROM smartstore_product_missing_attrs m
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = m.seller_management_code
                 AND p.store_id=m.store_id
            LEFT JOIN smartstoreIdList s ON s.id=m.store_id
            WHERE {where_sql}
            ORDER BY m.category_id, m.store_id, m.seller_management_code
            LIMIT %s OFFSET %s
        """, params + [per_page, offset])
        rows = _dictfetchall(c)

    for r in rows:
        if r.get('detected_at'):
            r['detected_at'] = r['detected_at'].strftime('%Y-%m-%d %H:%M:%S')

    return {'items': rows, 'total': total, 'page': page, 'per_page': per_page,
            'total_pages': (total + per_page - 1) // per_page,
            'by_category': by_cat}


def list_skus(page=1, per_page=50, search='', store_id=None, status='pending',
              category_id=None, category_text=None):
    """상품별 — 각 SKU 가 가진 빈 속성 개수 (precomputed summary 사용)."""
    where = ['1=1']
    params = []
    # status='pending' 이면 pending_count > 0 으로 필터
    if status == 'pending':
        where.append('m.pending_count > 0')
    elif status == 'registered':
        where.append('m.registered_count > 0')
    if store_id:
        where.append('m.store_id=%s')
        params.append(int(store_id))
    if category_id:
        where.append('m.category_id=%s')
        params.append(category_id)
    if search:
        where.append('(m.seller_management_code LIKE %s)')
        params.append(f'%{search}%')

    where_sql = 'WHERE ' + ' AND '.join(where)
    offset = max(0, (page - 1) * per_page)

    with connections['myproduct'].cursor() as c:
        c.execute(f"SELECT COUNT(*) FROM smartstore_sku_missing_summary m {where_sql}", params)
        total = c.fetchone()[0]

        c.execute(f"""
            SELECT m.seller_management_code, m.store_id, m.category_id,
                   m.missing_count, m.auto_count, m.free_count,
                   m.registered_count, m.pending_count
            FROM smartstore_sku_missing_summary m
            {where_sql}
            ORDER BY m.missing_count DESC
            LIMIT %s OFFSET %s
        """, params + [per_page, offset])
        rows = _dictfetchall(c)

        if not rows:
            return {'items': [], 'total': total, 'page': page, 'per_page': per_page,
                    'total_pages': (total + per_page - 1) // per_page}

        # 결과 SKU 에만 product / category_text 보강
        keys = [(r['seller_management_code'], r['store_id']) for r in rows]
        prod_ph = ' OR '.join(['(p.seller_management_code COLLATE utf8mb4_unicode_ci=%s AND p.store_id=%s)'] * len(keys))
        prod_params = [v for k in keys for v in k]
        c.execute(f"""
            SELECT p.seller_management_code, p.store_id, p.name, p.sale_price,
                   p.origin_product_no, p.channel_product_no, s.store_name
            FROM smartstore_product p
            LEFT JOIN smartstoreIdList s ON s.id=p.store_id
            WHERE {prod_ph}
        """, prod_params)
        pmap = {(r['seller_management_code'], r['store_id']): r for r in _dictfetchall(c)}

        log_ph = ' OR '.join(['(l.seller_management_code=%s AND l.store_id=%s)'] * len(keys))
        c.execute(f"""
            SELECT l.seller_management_code, l.store_id, MAX(l.category_text) AS category_text
            FROM smartstore_attr_crawl_log l
            WHERE {log_ph}
            GROUP BY l.seller_management_code, l.store_id
        """, prod_params)
        cmap = {(r['seller_management_code'], r['store_id']): (r['category_text'] or '')
                for r in _dictfetchall(c)}

        for r in rows:
            k = (r['seller_management_code'], r['store_id'])
            pinfo = pmap.get(k, {})
            r['product_name'] = pinfo.get('name')
            r['sale_price'] = pinfo.get('sale_price')
            r['origin_product_no'] = pinfo.get('origin_product_no')
            r['channel_product_no'] = pinfo.get('channel_product_no')
            r['store_name'] = pinfo.get('store_name')
            ct = cmap.get(k, '')
            if ct.startswith('선택한 카테고리 :'):
                ct = ct.replace('선택한 카테고리 :', '').strip()
            r['category_text'] = ct

    return {'items': rows, 'total': total, 'page': page, 'per_page': per_page,
            'total_pages': (total + per_page - 1) // per_page}


def get_missing_for_sku(seller_management_code, store_id):
    """단일 SKU 의 빈 속성 리스트 (모달용)."""
    with connections['myproduct'].cursor() as c:
        # 기본 정보
        c.execute("""
            SELECT m.seller_management_code, m.store_id, m.category_id,
                   p.name, p.sale_price, p.origin_product_no, p.channel_product_no, s.store_name
            FROM smartstore_product_missing_attrs m
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = m.seller_management_code
                 AND p.store_id=m.store_id
            LEFT JOIN smartstoreIdList s ON s.id=m.store_id
            WHERE m.seller_management_code=%s AND m.store_id=%s
            LIMIT 1
        """, [seller_management_code, store_id])
        info_rows = _dictfetchall(c)
        info = info_rows[0] if info_rows else None

        # 빈 속성 + 후보값
        c.execute("""
            SELECT attribute_seq, attribute_name, attribute_kind_type, attribute_type,
                   classification_type, candidate_count, candidate_values_json,
                   recommended_value_seq, recommended_value_text,
                   status, registered_value_seq, registered_value_text
            FROM smartstore_product_missing_attrs
            WHERE seller_management_code=%s AND store_id=%s
            ORDER BY candidate_count, attribute_name
        """, [seller_management_code, store_id])
        attrs = _dictfetchall(c)
        for a in attrs:
            try:
                a['candidate_values'] = json.loads(a.pop('candidate_values_json') or '[]')
            except Exception:
                a['candidate_values'] = []

    return {'info': info, 'missing_attrs': attrs}


def register_for_sku(seller_management_code, store_id, selections, dry_run=False):
    """단일 SKU 에 여러 (attribute_seq, value_seq) 한 번에 등록.
    selections: [{attribute_seq, value_seq, value_text}]
    """
    from .smartstore_product_service import _get_access_token
    import requests

    with connections['myproduct'].cursor() as c:
        c.execute("""SELECT s.commerce_api_key, s.commerce_secret_key, p.origin_product_no
                     FROM smartstore_product p
                     JOIN smartstoreIdList s ON s.id=p.store_id
                     WHERE p.seller_management_code=%s AND p.store_id=%s LIMIT 1""",
                  [seller_management_code, store_id])
        row = c.fetchone()
    if not row:
        return {'ok': False, 'error': 'SKU not found'}
    api_key, secret, opno = row
    if not opno:
        return {'ok': False, 'error': 'no origin_product_no'}

    try:
        token = _get_access_token(api_key, secret)
    except Exception as e:
        return {'ok': False, 'error': f'token: {e}'}

    url = f'https://api.commerce.naver.com/external/v2/products/origin-products/{opno}'
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

    # GET (429 백오프)
    product = None
    for attempt in range(5):
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code == 429:
            time.sleep(min(30, 2 ** (attempt + 2)))
            continue
        if r.status_code == 401:
            try:
                token = _get_access_token(api_key, secret)
                headers['Authorization'] = f'Bearer {token}'
                continue
            except Exception as e:
                return {'ok': False, 'error': f'token refresh: {e}'}
        if r.status_code == 200:
            product = r.json()['originProduct']
        else:
            return {'ok': False, 'error': f'GET {r.status_code}: {r.text[:200]}'}
        break
    if not product:
        return {'ok': False, 'error': 'GET failed'}

    # productAttributes 수정
    detail = product.setdefault('detailAttribute', {})
    pa = detail.setdefault('productAttributes', []) or []
    # 1) 기존 항목 중 attributeRealValue 누락된 경우 → label_map 에서 복원 (DELETE 아님)
    needs_lookup = []
    for p in pa:
        aseq = p.get('attributeSeq')
        avseq = p.get('attributeValueSeq')
        if aseq and avseq and not p.get('attributeRealValue'):
            needs_lookup.append((aseq, avseq))
    if needs_lookup:
        with connections['myproduct'].cursor() as c:
            ph = ' OR '.join(['(attribute_seq=%s AND attribute_value_seq=%s)'] * len(needs_lookup))
            params_lk = [v for k in needs_lookup for v in k]
            c.execute(f"""
                SELECT attribute_seq, attribute_value_seq, attribute_value_text
                FROM smartstore_attr_label_map
                WHERE {ph}
            """, params_lk)
            text_map = {(r[0], r[1]): r[2] for r in c.fetchall()}
        for p in pa:
            aseq = p.get('attributeSeq')
            avseq = p.get('attributeValueSeq')
            if aseq and avseq and not p.get('attributeRealValue'):
                t = text_map.get((aseq, avseq))
                if t:
                    p['attributeRealValue'] = t
    # 2) 우리가 추가할 attribute_seq 와 겹치는 기존 항목 제거 (선택은 새로운 값으로 갱신)
    sel_map = {}  # aseq → {value_seq, value_text}
    for s in selections:
        aseq = int(s['attribute_seq'])
        sel_map[aseq] = {
            'value_seq': int(s['value_seq']) if s.get('value_seq') else 0,
            'value_text': s.get('value_text', '') or '',
        }
    pa = [p for p in pa if p.get('attributeSeq') not in sel_map]
    # 3) 새 항목 추가
    #    - 픽리스트 (value_seq>0): attributeValueSeq 만 — API 가 valueText 자동 매핑
    #    - 자유입력 (value_seq=0): attributeValueSeq=0 + attributeRealValue 필수
    for aseq, sv in sel_map.items():
        item = {'attributeSeq': aseq}
        if sv['value_seq']:
            item['attributeValueSeq'] = sv['value_seq']
        else:
            item['attributeValueSeq'] = 0
            if sv['value_text']:
                item['attributeRealValue'] = sv['value_text']
        pa.append(item)
    detail['productAttributes'] = pa

    # sellerTags 제거
    seo = detail.get('seoInfo', {})
    if seo and 'sellerTags' in seo:
        del seo['sellerTags']

    # statusType 정규화 — PUT 은 OUTOFSTOCK/SUSPENSION 등 거부, SALE 만 허용 (실제 상태는 변경되지 않음)
    if product.get('statusType') and product['statusType'] != 'SALE':
        product['statusType'] = 'SALE'

    if dry_run:
        return {'ok': True, 'dry_run': True, 'attrs_set': len(sel_map)}

    # 변경 전 상태 백업
    before_pa = list(detail.get('productAttributes', []))
    # 위에서 이미 수정한 후라 detail 의 pa 는 새로운 상태
    after_pa = list(pa)
    added_pa = [{'attributeSeq': k, 'attributeValueSeq': v} for k, v in sel_map.items()]
    now = datetime.now()
    with connections['myproduct'].cursor() as c:
        c.execute("""
            INSERT INTO smartstore_attr_change_log
            (seller_management_code, store_id, origin_product_no,
             before_attrs_json, after_attrs_json, added_attrs_json,
             source, status, changed_at)
            VALUES (%s,%s,%s,%s,%s,%s,'auto_register','pending',%s)
        """, [seller_management_code, store_id, opno,
              json.dumps([p for p in before_pa if p.get('attributeSeq') in sel_map], ensure_ascii=False),
              json.dumps(after_pa, ensure_ascii=False),
              json.dumps(added_pa, ensure_ascii=False),
              now])
        change_id = c.lastrowid

    # 우리가 add 한 attribute_seq 들 (보존 대상)
    new_aseqs = set(sel_map.keys())

    # PUT
    import re as _re
    rejected_aseqs = set()  # 우리가 add 했지만 API 가 거부한 attribute_seq (range-format 등)
    for attempt in range(5):
        r = requests.put(url, json={'originProduct': product}, headers=headers, timeout=30)
        if r.status_code == 429:
            time.sleep(min(30, 2 ** (attempt + 2)))
            continue
        if r.status_code == 400:
            try:
                inv = r.json().get('invalidInputs', [])
            except Exception:
                inv = []
            handled = False
            # 1) productAttributes[N].xxx — 인덱스별 처리
            #    - 새로 add 한 건이면 → realValue NotEmpty/numberAndPointAndTilde 유형은 등록 불가 → 드롭 & 표기
            #    - 새로 add 가 아니면 → 기존 broken legacy → 드롭 (보존 시도해도 못 살림)
            bad_items = []  # list of (idx, type)
            for item in inv:
                field = item.get('name', '')
                err_type = item.get('type', '')
                m = _re.search(r'productAttributes\[(\d+)\]', field)
                if m:
                    bad_items.append((int(m.group(1)), err_type))
            if bad_items:
                pa = detail.get('productAttributes', [])
                bad_idxs = {i for i, _ in bad_items}
                kept = []
                for i, p in enumerate(pa):
                    if i in bad_idxs:
                        aseq = p.get('attributeSeq')
                        if aseq in new_aseqs:
                            rejected_aseqs.add(aseq)
                        continue
                    kept.append(p)
                # rejected_aseqs 는 new_aseqs 에서도 빼서 다음 retry 에서 안 등록되게
                new_aseqs = new_aseqs - rejected_aseqs
                detail['productAttributes'] = kept
                handled = True
            # 2) Required.product.unitPriceYn — unitCapacity.unitPriceYn False 로 셋 (Boolean)
            for item in inv:
                etype = item.get('type', '')
                if 'unitPriceYn' in etype or 'unitPriceYn' in item.get('name', ''):
                    uc = detail.setdefault('unitCapacity', {})
                    if isinstance(uc, dict):
                        uc['unitPriceYn'] = False
                        handled = True
            # 3) 일반 dict path 필드 (statusType 등) 제거
            for item in inv:
                field = item.get('name', '')
                if 'productAttributes[' in field:
                    continue
                if 'unitPriceYn' in item.get('type', '') or 'unitPriceYn' in field:
                    continue
                parts = field.replace('originProduct.', '').split('.')
                obj = product
                for p_part in parts[:-1]:
                    obj = obj.get(p_part, {}) if isinstance(obj, dict) else {}
                if isinstance(obj, dict) and parts[-1] in obj:
                    del obj[parts[-1]]
                    handled = True
            if not handled:
                break  # 더 시도해도 안 풀림
            continue
        break
    if not (200 <= r.status_code < 300):
        with connections['myproduct'].cursor() as c:
            c.execute("UPDATE smartstore_attr_change_log SET status='failed', error_msg=%s WHERE id=%s",
                      [f'PUT {r.status_code}: {r.text[:300]}', change_id])
        return {'ok': False, 'error': f'PUT {r.status_code}: {r.text[:200]}'}

    # DB 마킹 — rejected_aseqs (range-format API 가 거부) 는 'fail' 로 표기
    registered_count = 0
    affected_aseqs = []
    with connections['myproduct'].cursor() as c:
        for s in selections:
            aseq = int(s['attribute_seq'])
            if aseq in rejected_aseqs:
                c.execute("""
                    UPDATE smartstore_product_missing_attrs
                    SET status='fail',
                        last_error='API rejected (NotEmpty/format) - needs manual numeric value',
                        registered_at=%s
                    WHERE seller_management_code=%s AND store_id=%s AND attribute_seq=%s
                """, [now, seller_management_code, store_id, aseq])
            else:
                c.execute("""
                    UPDATE smartstore_product_missing_attrs
                    SET status='registered', registered_value_seq=%s,
                        registered_value_text=%s, registered_at=%s
                    WHERE seller_management_code=%s AND store_id=%s AND attribute_seq=%s
                """, [s['value_seq'], s.get('value_text'), now,
                      seller_management_code, store_id, aseq])
                registered_count += 1
            affected_aseqs.append(aseq)
        c.execute("UPDATE smartstore_attr_change_log SET status='ok' WHERE id=%s", [change_id])

        # SKU summary 갱신 (해당 SKU 의 카운트 재계산)
        c.execute("""
            UPDATE smartstore_sku_missing_summary AS s
              JOIN (
                SELECT seller_management_code, store_id,
                       COUNT(*) AS missing_count,
                       SUM(CASE WHEN candidate_count=1 AND status='pending' THEN 1 ELSE 0 END) AS auto_count,
                       SUM(CASE WHEN candidate_count=0 THEN 1 ELSE 0 END) AS free_count,
                       SUM(CASE WHEN status='registered' THEN 1 ELSE 0 END) AS registered_count,
                       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count
                FROM smartstore_product_missing_attrs
                WHERE seller_management_code=%s AND store_id=%s
                GROUP BY seller_management_code, store_id
              ) t
              ON s.seller_management_code=t.seller_management_code AND s.store_id=t.store_id
            SET s.missing_count=t.missing_count, s.auto_count=t.auto_count,
                s.free_count=t.free_count, s.registered_count=t.registered_count,
                s.pending_count=t.pending_count
        """, [seller_management_code, store_id])

        # Attribute summary 갱신 (영향 attr_seq 별 재계산)
        for aseq in set(affected_aseqs):
            c.execute("""
                UPDATE smartstore_attr_missing_summary AS s
                  JOIN (
                    SELECT attribute_seq,
                           COUNT(*) AS total_skus,
                           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_skus,
                           SUM(CASE WHEN status='registered' THEN 1 ELSE 0 END) AS registered_skus,
                           SUM(CASE WHEN status='needs_manual' THEN 1 ELSE 0 END) AS needs_manual_skus,
                           SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) AS failed_skus
                    FROM smartstore_product_missing_attrs
                    WHERE attribute_seq=%s
                    GROUP BY attribute_seq
                  ) t
                  ON s.attribute_seq=t.attribute_seq
                SET s.total_skus=t.total_skus, s.pending_skus=t.pending_skus,
                    s.registered_skus=t.registered_skus,
                    s.needs_manual_skus=t.needs_manual_skus,
                    s.failed_skus=t.failed_skus
            """, [aseq])

    return {'ok': True, 'attrs_set': registered_count, 'rejected': len(rejected_aseqs)}


def get_attribute_detail(attribute_seq):
    """단일 속성의 후보값 + 카테고리 분포."""
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT attribute_value_seq, attribute_value_text, attribute_value_color, exposure_order
            FROM smartstore_attr_label_map
            WHERE attribute_seq=%s AND attribute_value_seq>0
            ORDER BY exposure_order, attribute_value_seq
        """, [attribute_seq])
        candidates = _dictfetchall(c)

        c.execute("""
            SELECT category_id, COUNT(*) AS missing_skus
            FROM smartstore_product_missing_attrs
            WHERE attribute_seq=%s AND status='pending'
            GROUP BY category_id
            ORDER BY missing_skus DESC
            LIMIT 30
        """, [attribute_seq])
        by_cat = _dictfetchall(c)

    return {'candidates': candidates, 'by_category': by_cat}


def mark_status(seller_codes_with_store, attribute_seq, status, value_seq=None, value_text=None):
    """상태 변경 (skipped/reviewed 등 — 등록은 register_bulk 별도)."""
    if not seller_codes_with_store:
        return {'updated': 0}
    now = datetime.now()
    sets = ["status=%s", "reviewed_at=%s"]
    params_base = [status, now]
    if value_seq is not None:
        sets.append("registered_value_seq=%s")
        params_base.append(value_seq)
    if value_text is not None:
        sets.append("registered_value_text=%s")
        params_base.append(value_text)

    updated = 0
    with connections['myproduct'].cursor() as c:
        for seller, sid in seller_codes_with_store:
            c.execute(
                f"UPDATE smartstore_product_missing_attrs SET {', '.join(sets)} "
                f"WHERE seller_management_code=%s AND store_id=%s AND attribute_seq=%s",
                params_base + [seller, sid, attribute_seq],
            )
            updated += c.rowcount
    return {'updated': updated}


def register_bulk(skus, attribute_seq, value_seq, value_text=None, dry_run=False):
    """일괄 등록 — register_for_sku 위임 (statusType/unitPriceYn 등 동일 처리).
    skus: [{seller_management_code, store_id, origin_product_no}]
    """
    results = {'ok': 0, 'fail': 0, 'errors': [], 'updated_skus': []}
    selections = [{'attribute_seq': attribute_seq, 'value_seq': value_seq, 'value_text': value_text or ''}]
    for sku in skus:
        seller = sku['seller_management_code']
        sid = sku['store_id']
        try:
            r = register_for_sku(seller, sid, selections, dry_run=dry_run)
        except Exception as e:
            r = {'ok': False, 'error': f'exc: {e}'}
        if r.get('ok'):
            if r.get('rejected', 0) > 0 and r.get('attrs_set', 0) == 0:
                results['fail'] += 1
                results['errors'].append(f'{seller}: API rejected (range/format)')
            else:
                results['ok'] += 1
                results['updated_skus'].append({'seller': seller, 'opno': sku.get('origin_product_no')})
        else:
            results['fail'] += 1
            results['errors'].append(f'{seller}: {r.get("error","?")[:150]}')
        time.sleep(0.3)  # rate-limit
    return results


def register_filtered(attribute_seq, value_seq, value_text=None,
                      store_id=None, category_id=None, search='',
                      max_skus=2000, dry_run=False):
    """필터 매칭되는 모든 SKU 에 대해 일괄 등록 (페이지네이션 없음).
    안전장치: max_skus 한도 초과시 거부.
    """
    where = ['m.attribute_seq=%s', "m.status='pending'"]
    params = [attribute_seq]
    if store_id:
        where.append('m.store_id=%s')
        params.append(int(store_id))
    if category_id:
        where.append('m.category_id=%s')
        params.append(category_id)
    if search:
        where.append('m.seller_management_code LIKE %s')
        params.append(f'%{search}%')

    where_sql = ' AND '.join(where)

    with connections['myproduct'].cursor() as c:
        c.execute(f"SELECT COUNT(*) FROM smartstore_product_missing_attrs m WHERE {where_sql}", params)
        total = c.fetchone()[0]
        if total > max_skus:
            return {'ok': 0, 'fail': 0, 'errors': [f'too many SKUs: {total} > max {max_skus}'],
                    'total_matched': total, 'aborted': True}
        if total == 0:
            return {'ok': 0, 'fail': 0, 'errors': [], 'total_matched': 0, 'aborted': False}

        c.execute(f"""
            SELECT m.seller_management_code, m.store_id, p.origin_product_no
            FROM smartstore_product_missing_attrs m
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = m.seller_management_code
                 AND p.store_id = m.store_id
            WHERE {where_sql}
              AND p.origin_product_no IS NOT NULL
            ORDER BY m.category_id, m.store_id, m.seller_management_code
        """, params)
        skus = [{'seller_management_code': r[0], 'store_id': r[1], 'origin_product_no': r[2]}
                for r in c.fetchall()]

    if not skus:
        return {'ok': 0, 'fail': 0, 'errors': ['no SKUs with origin_product_no'],
                'total_matched': total, 'aborted': False}

    res = register_bulk(skus, attribute_seq, value_seq, value_text=value_text, dry_run=dry_run)
    res['total_matched'] = len(skus)
    res['aborted'] = False
    return res
