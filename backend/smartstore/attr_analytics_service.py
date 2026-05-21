"""
SmartStore 상품속성 분석 서비스 (Stage A/B/C 크롤 결과 조회).

읽기 전용 쿼리만 제공 — 데이터 적재는 api_attr_crawl.py / search_quality_crawl.py 가 담당.
"""
from django.db import connections


def _dictfetchall(cursor):
    cols = [c[0] for c in cursor.description]
    return [dict(zip(cols, r)) for r in cursor.fetchall()]


def get_stats():
    """상단 카드용 종합 통계."""
    out = {}
    with connections['myproduct'].cursor() as c:
        c.execute("SELECT COUNT(DISTINCT seller_management_code), COUNT(*) FROM smartstore_attr_crawl_log WHERE status='ok'")
        r = c.fetchone()
        out['attr_skus'] = r[0] or 0
        out['attr_crawl_rows'] = r[1] or 0

        c.execute("SELECT COUNT(*), SUM(is_standard=1), SUM(is_standard=0) FROM smartstore_product_tag")
        r = c.fetchone()
        out['tag_rows'] = r[0] or 0
        out['tag_standard'] = r[1] or 0
        out['tag_freeform'] = r[2] or 0

        c.execute("SELECT COUNT(*) FROM smartstore_product_attr_value")
        out['attr_value_rows'] = c.fetchone()[0] or 0

        c.execute("SELECT COUNT(DISTINCT category_id), COUNT(*) FROM smartstore_category_attr_schema")
        r = c.fetchone()
        out['categories'] = r[0] or 0
        out['schema_rows'] = r[1] or 0

        c.execute("SELECT COUNT(DISTINCT seller_management_code), COUNT(*), SUM(needs_review) FROM smartstore_product_search_quality")
        r = c.fetchone()
        out['quality_skus'] = r[0] or 0
        out['quality_rows'] = r[1] or 0
        out['quality_review'] = r[2] or 0

    return out


def list_products(page=1, per_page=50, search='', store_id=None, needs_review=None, has_quality=None):
    """W코드 기준 상품 목록 (속성/태그/품질 요약 포함)."""
    where = ["l.status='ok'"]
    params = []
    if search:
        where.append("(l.seller_management_code LIKE %s OR l.category_text LIKE %s)")
        params.extend([f'%{search}%', f'%{search}%'])
    if store_id:
        where.append("l.store_id = %s")
        params.append(store_id)
    if has_quality == 1:
        where.append("EXISTS (SELECT 1 FROM smartstore_product_search_quality q WHERE q.seller_management_code=l.seller_management_code AND q.store_id=l.store_id)")
    if needs_review == 1:
        where.append("EXISTS (SELECT 1 FROM smartstore_product_search_quality q WHERE q.seller_management_code=l.seller_management_code AND q.store_id=l.store_id AND q.needs_review=1)")

    where_sql = ' AND '.join(where)
    offset = max(0, (page - 1) * per_page)

    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT COUNT(*) FROM smartstore_attr_crawl_log l WHERE {where_sql}
        """, params)
        total = c.fetchone()[0] or 0

        c.execute(f"""
            SELECT
                l.seller_management_code, l.origin_product_no, l.channel_product_no,
                l.category_id, l.category_text, l.store_id, l.crawled_at,
                p.name, p.sale_price, p.stock_quantity, s.store_name,
                (SELECT COUNT(*) FROM smartstore_product_tag t
                  WHERE t.seller_management_code=l.seller_management_code AND t.store_id=l.store_id) AS tag_count,
                (SELECT COUNT(*) FROM smartstore_product_attr_value v
                  WHERE v.seller_management_code=l.seller_management_code AND v.store_id=l.store_id
                    AND v.section='상품속성') AS attr_count,
                (SELECT SUM(needs_review) FROM smartstore_product_search_quality q
                  WHERE q.seller_management_code=l.seller_management_code AND q.store_id=l.store_id) AS review_count,
                (SELECT COUNT(*) FROM smartstore_product_search_quality q
                  WHERE q.seller_management_code=l.seller_management_code AND q.store_id=l.store_id) AS quality_done
            FROM smartstore_attr_crawl_log l
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = l.seller_management_code
                 AND p.store_id=l.store_id
            LEFT JOIN smartstoreIdList s ON s.id=l.store_id
            WHERE {where_sql}
            ORDER BY l.crawled_at DESC
            LIMIT %s OFFSET %s
        """, params + [per_page, offset])
        rows = _dictfetchall(c)

    for r in rows:
        if r.get('crawled_at'):
            r['crawled_at'] = r['crawled_at'].strftime('%Y-%m-%d %H:%M:%S')
        # 카테고리 텍스트 정리
        ct = r.get('category_text') or ''
        if ct.startswith('선택한 카테고리 :'):
            ct = ct.replace('선택한 카테고리 :', '').strip()
        r['category_text'] = ct

    return {'items': rows, 'total': total, 'page': page, 'per_page': per_page,
            'total_pages': (total + per_page - 1) // per_page}


def get_product_detail(seller_code, store_id=None):
    """단일 W코드 모든 데이터 (모달용)."""
    where = ['seller_management_code=%s']
    params = [seller_code]
    if store_id is not None:
        where.append('store_id=%s')
        params.append(store_id)

    with connections['myproduct'].cursor() as c:
        # 기본 정보
        c.execute(f"""
            SELECT l.seller_management_code, l.origin_product_no, l.channel_product_no,
                   l.category_id, l.category_text, l.store_id, l.crawled_at,
                   p.name, p.sale_price, p.stock_quantity, s.store_name
            FROM smartstore_attr_crawl_log l
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = l.seller_management_code
                 AND p.store_id=l.store_id
            LEFT JOIN smartstoreIdList s ON s.id=l.store_id
            WHERE l.{' AND l.'.join(where)}
            ORDER BY l.crawled_at DESC LIMIT 1
        """, params)
        rows = _dictfetchall(c)
        if not rows:
            return None
        info = rows[0]
        if info.get('crawled_at'):
            info['crawled_at'] = info['crawled_at'].strftime('%Y-%m-%d %H:%M:%S')
        ct = info.get('category_text') or ''
        if ct.startswith('선택한 카테고리 :'):
            ct = ct.replace('선택한 카테고리 :', '').strip()
        info['category_text'] = ct

        actual_store_id = info['store_id']

        # 태그
        c.execute("""
            SELECT position, tag, search_volume, search_volume_label, is_standard, tag_raw
            FROM smartstore_product_tag
            WHERE seller_management_code=%s AND store_id=%s
            ORDER BY position
        """, [seller_code, actual_store_id])
        tags = _dictfetchall(c)

        # 속성값 (검색설정/검색정보/상품속성 분리)
        c.execute("""
            SELECT section, attr_label, attr_type, value_text, value_bool, value_number, is_recommended
            FROM smartstore_product_attr_value
            WHERE seller_management_code=%s AND store_id=%s
            ORDER BY section, attr_label
        """, [seller_code, actual_store_id])
        attrs = _dictfetchall(c)
        for a in attrs:
            if a.get('value_number') is not None:
                a['value_number'] = float(a['value_number'])

        attrs_by_section = {}
        for a in attrs:
            attrs_by_section.setdefault(a.get('section') or '기타', []).append(a)

        # 검색품질
        c.execute("""
            SELECT item_name, result_text, status, needs_review, input_count, applied_count, crawled_at
            FROM smartstore_product_search_quality
            WHERE seller_management_code=%s AND store_id=%s
            ORDER BY FIELD(item_name, '상품명','카테고리','브랜드','제조사','속성','태그')
        """, [seller_code, actual_store_id])
        quality = _dictfetchall(c)
        for q in quality:
            if q.get('crawled_at'):
                q['crawled_at'] = q['crawled_at'].strftime('%Y-%m-%d %H:%M:%S')

    # SS 어드민 스타일: 상품속성 섹션을 attribute_seq 별로 그룹화 + 라벨/옵션 매핑
    attr_groups = _build_attribute_groups(seller_code, actual_store_id, info.get('category_id'))

    return {
        'info': info,
        'tags': tags,
        'attrs_by_section': attrs_by_section,
        'attribute_groups': attr_groups,
        'quality': quality,
    }


def _build_attribute_groups(seller_code, store_id, category_id):
    """상품속성 섹션을 SS 어드민 스타일 (attribute_seq 그룹 + 모든 옵션 + 체크) 로 변환."""
    with connections['myproduct'].cursor() as c:
        # 1. 이 상품의 선택된 (attribute_seq, attribute_value_seq) pairs
        c.execute("""
            SELECT attr_label, value_text
            FROM smartstore_product_attr_value
            WHERE seller_management_code=%s AND store_id=%s AND section='상품속성'
        """, [seller_code, store_id])
        selected_pairs = set()
        seqs_set = set()
        for label, val in c.fetchall():
            if label and label.startswith('attr#'):
                try:
                    aseq = int(label[5:])
                except ValueError:
                    continue
                seqs_set.add(aseq)
                try:
                    avseq = int(val) if val else 0
                except (TypeError, ValueError):
                    avseq = 0
                if avseq:
                    selected_pairs.add((aseq, avseq))

        if not seqs_set:
            return []

        # 2. 라벨 매핑 (선택값 + 같은 카테고리 스키마의 다른 옵션)
        seqs = sorted(seqs_set)
        ph = ','.join(['%s'] * len(seqs))
        c.execute(f"""
            SELECT attribute_seq, attribute_value_seq, attribute_name, attribute_value_text,
                   attribute_classification_type, attribute_value_color, exposure_order,
                   attribute_kind_type, attribute_type, source
            FROM smartstore_attr_label_map
            WHERE attribute_seq IN ({ph})
            ORDER BY attribute_seq, exposure_order, attribute_value_seq
        """, seqs)
        rows = _dictfetchall(c)

    groups = {}
    for r in rows:
        aseq = r['attribute_seq']
        if aseq not in groups:
            groups[aseq] = {
                'attribute_seq': aseq,
                'attribute_name': r['attribute_name'],
                'classification_type': r['attribute_classification_type'],
                'attribute_kind_type': r['attribute_kind_type'],
                'attribute_type': r['attribute_type'],
                'source': r['source'],
                'values': [],
            }
        if r['attribute_value_seq']:
            groups[aseq]['values'].append({
                'seq': r['attribute_value_seq'],
                'text': r['attribute_value_text'],
                'color': r['attribute_value_color'],
                'order': r['exposure_order'],
                'selected': (aseq, r['attribute_value_seq']) in selected_pairs,
            })

    # 라벨이 없는 attribute_seq (label_map 미수집) 도 fallback 표시
    for aseq in seqs_set:
        if aseq not in groups:
            picked_avseqs = [pair[1] for pair in selected_pairs if pair[0] == aseq]
            groups[aseq] = {
                'attribute_seq': aseq,
                'attribute_name': f'attr#{aseq}',
                'classification_type': None,
                'attribute_kind_type': None,
                'attribute_type': None,
                'source': None,
                'values': [
                    {'seq': v, 'text': str(v), 'color': None, 'order': 0, 'selected': True}
                    for v in picked_avseqs
                ],
            }

    # 정렬: 선택된 값이 있는 것 먼저, 그 다음 attribute_name
    out = list(groups.values())
    out.sort(key=lambda g: (
        0 if any(v['selected'] for v in g['values']) else 1,
        g['attribute_name'] or '',
    ))
    return out


def top_tags(limit=30, by='count', category_id=None):
    """인기 태그 (빈도 또는 search_volume 기준)."""
    where = []
    params = []
    if category_id:
        where.append('category_id LIKE %s')
        params.append(f'{category_id}%')

    if by == 'volume':
        where.append('search_volume IS NOT NULL')
        order = 'ORDER BY MAX(search_volume) DESC'
        select_extra = ', MAX(search_volume) AS sv, MAX(is_standard) AS std'
    else:
        order = 'ORDER BY cnt DESC'
        select_extra = ', MAX(search_volume) AS sv, MAX(is_standard) AS std'

    where_sql = (' WHERE ' + ' AND '.join(where)) if where else ''

    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT tag, COUNT(*) AS cnt {select_extra}
            FROM smartstore_product_tag
            {where_sql}
            GROUP BY tag
            {order}
            LIMIT %s
        """, params + [limit])
        return _dictfetchall(c)


def quality_issues(limit=200):
    """검색품질 점검필요 항목 리스트."""
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT q.seller_management_code, q.store_id, s.store_name,
                   GROUP_CONCAT(q.item_name ORDER BY FIELD(q.item_name,'상품명','카테고리','브랜드','제조사','속성','태그') SEPARATOR ',') AS issues,
                   COUNT(*) AS issue_count,
                   p.name AS product_name, q.category_id
            FROM smartstore_product_search_quality q
            LEFT JOIN smartstoreIdList s ON s.id=q.store_id
            LEFT JOIN smartstore_product p
              ON p.seller_management_code COLLATE utf8mb4_unicode_ci = q.seller_management_code
                 AND p.store_id=q.store_id
            WHERE q.needs_review=1
            GROUP BY q.seller_management_code, q.store_id
            ORDER BY issue_count DESC, q.seller_management_code
            LIMIT %s
        """, [limit])
        return _dictfetchall(c)


def top_attributes(limit=200, section=None, category_id=None):
    """속성 라벨별 사용 통계 (어떤 속성을 몇 개 SKU가 채웠는지)."""
    where = []
    params = []
    if section:
        where.append("v.section=%s")
        params.append(section)
    if category_id:
        where.append("""EXISTS (
            SELECT 1 FROM smartstore_attr_crawl_log l
            WHERE l.seller_management_code=v.seller_management_code
              AND l.store_id=v.store_id
              AND l.category_id LIKE %s
        )""")
        params.append(f'{category_id}%')
    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''

    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT
              v.section, v.attr_label, v.attr_type,
              COUNT(*) AS use_count,
              COUNT(DISTINCT CONCAT(v.seller_management_code,'|',v.store_id)) AS sku_count,
              COUNT(DISTINCT COALESCE(
                v.value_text,
                CAST(v.value_number AS CHAR),
                CAST(v.value_bool AS CHAR)
              )) AS distinct_values,
              SUM(v.is_recommended) AS recommended_count,
              SUM(CASE WHEN v.value_bool=1 THEN 1 ELSE 0 END) AS true_count,
              SUM(CASE WHEN v.value_bool=0 THEN 1 ELSE 0 END) AS false_count,
              MAX(lm.attribute_name) AS resolved_label
            FROM smartstore_product_attr_value v
            LEFT JOIN smartstore_attr_label_map lm
              ON lm.attribute_value_seq=0
             AND v.attr_label LIKE 'attr#%%'
             AND lm.attribute_seq = CAST(SUBSTRING(v.attr_label, 6) AS UNSIGNED)
            {where_sql}
            GROUP BY v.section, v.attr_label, v.attr_type
            ORDER BY sku_count DESC, use_count DESC
            LIMIT %s
        """, params + [limit])
        return _dictfetchall(c)


def attribute_values(attr_label, section=None, category_id=None, limit=100):
    """특정 속성의 값 분포 (어떤 값을 몇 SKU가 사용중)."""
    where = ["v.attr_label=%s"]
    params = [attr_label]
    if section:
        where.append("v.section=%s")
        params.append(section)
    if category_id:
        where.append("""EXISTS (
            SELECT 1 FROM smartstore_attr_crawl_log l
            WHERE l.seller_management_code=v.seller_management_code
              AND l.store_id=v.store_id
              AND l.category_id LIKE %s
        )""")
        params.append(f'{category_id}%')

    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT
              COALESCE(
                v.value_text,
                CAST(v.value_number AS CHAR),
                CASE v.value_bool WHEN 1 THEN '✓ 체크' WHEN 0 THEN '– 미체크' END
              ) AS value,
              MAX(lm.attribute_value_text) AS resolved_value,
              v.attr_type,
              COUNT(*) AS cnt,
              COUNT(DISTINCT CONCAT(v.seller_management_code,'|',v.store_id)) AS sku_count,
              SUM(v.is_recommended) AS recommended_count
            FROM smartstore_product_attr_value v
            LEFT JOIN smartstore_attr_label_map lm
              ON v.attr_label LIKE 'attr#%%'
             AND lm.attribute_seq = CAST(SUBSTRING(v.attr_label, 6) AS UNSIGNED)
             AND lm.attribute_value_seq = CAST(v.value_text AS UNSIGNED)
            WHERE {' AND '.join(where)}
            GROUP BY value, resolved_value, v.attr_type
            ORDER BY cnt DESC
            LIMIT %s
        """, params + [limit])
        return _dictfetchall(c)


def category_summary(limit=50):
    """카테고리별 집계."""
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT l.category_id, l.category_text,
                   COUNT(*) AS sku_count,
                   (SELECT COUNT(*) FROM smartstore_category_attr_schema s WHERE s.category_id=l.category_id) AS attr_def_count
            FROM smartstore_attr_crawl_log l
            WHERE l.status='ok' AND l.category_id IS NOT NULL AND l.category_id<>''
            GROUP BY l.category_id, l.category_text
            ORDER BY sku_count DESC
            LIMIT %s
        """, [limit])
        rows = _dictfetchall(c)
    for r in rows:
        ct = r.get('category_text') or ''
        if ct.startswith('선택한 카테고리 :'):
            ct = ct.replace('선택한 카테고리 :', '').strip()
        r['category_text'] = ct
    return rows
