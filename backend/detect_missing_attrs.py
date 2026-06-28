"""
빈 속성 detection — 카테고리 스키마 vs 상품 실제 비교 후 차이를 DB 적재.

흐름:
  1. smartstore_attr_crawl_log (status='ok') 의 모든 SKU 순회
  2. 각 SKU 의 category_id 에 대해 smartstore_category_attribute 에서 스키마 조회
  3. 그 SKU 의 smartstore_product_attr_value (section='상품속성') 와 비교
  4. 스키마에는 있으나 실제 안 채워진 (attribute_seq) 들을 smartstore_product_missing_attrs 에 INSERT

사용:
  python3 detect_missing_attrs.py            # 전체
  python3 detect_missing_attrs.py --limit 100  # 검증
  python3 detect_missing_attrs.py --reset    # 기존 missing_attrs 비우고 재구축
"""
import os, sys, json, argparse
from datetime import datetime
import django

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections


def reset_table():
    with connections['myproduct'].cursor() as c:
        c.execute('TRUNCATE TABLE smartstore_product_missing_attrs')
    print('[reset] smartstore_product_missing_attrs cleared')


def build_value_index(category_ids):
    """카테고리별 (attribute_seq, attribute_name) + 후보 값 리스트."""
    if not category_ids:
        return {}, {}
    ph = ','.join(['%s'] * len(category_ids))
    schema = {}  # cat_id → [(attr_seq, name, ktype, atype, ctype)]
    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT category_id, attribute_seq,
                   attribute_kind_type, attribute_type, attribute_classification_type
            FROM smartstore_category_attribute
            WHERE category_id IN ({ph})
        """, list(category_ids))
        rows = c.fetchall()
    if not rows:
        return {}, {}

    aseqs = list({r[1] for r in rows})
    # attribute name + values
    aph = ','.join(['%s'] * len(aseqs))
    name_map = {}
    values_map = {}  # aseq → [{seq, text, color, order}]
    with connections['myproduct'].cursor() as c:
        c.execute(f"""
            SELECT attribute_seq, attribute_value_seq, attribute_name,
                   attribute_value_text, attribute_value_color, exposure_order
            FROM smartstore_attr_label_map
            WHERE attribute_seq IN ({aph})
            ORDER BY attribute_seq, exposure_order, attribute_value_seq
        """, aseqs)
        for aseq, avseq, name, text, color, order in c.fetchall():
            if not name_map.get(aseq):
                name_map[aseq] = name
            if avseq:
                values_map.setdefault(aseq, []).append({
                    'seq': avseq, 'text': text or '', 'color': color, 'order': order or 0,
                })

    for cat_id, aseq, ktype, atype, ctype in rows:
        schema.setdefault(cat_id, []).append({
            'attribute_seq': aseq, 'attribute_name': name_map.get(aseq, f'attr#{aseq}'),
            'kind_type': ktype, 'type': atype, 'classification_type': ctype,
            'values': values_map.get(aseq, []),
        })
    return schema, name_map


def fetch_set_attrs(seller_code, store_id):
    """이 SKU 가 이미 선택한 attribute_seq 집합."""
    out = set()
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT attr_label FROM smartstore_product_attr_value
            WHERE seller_management_code=%s AND store_id=%s AND section='상품속성'
        """, [seller_code, store_id])
        for (label,) in c.fetchall():
            if label and label.startswith('attr#'):
                try:
                    out.add(int(label[5:]))
                except ValueError:
                    pass
    return out


def detect(args):
    if args.reset:
        reset_table()

    now = datetime.now()
    # 1) 모든 OK SKU 순회 — chunk 단위로
    with connections['myproduct'].cursor() as c:
        sql = """
            SELECT seller_management_code, store_id, category_id
            FROM smartstore_attr_crawl_log
            WHERE status='ok' AND category_id IS NOT NULL AND category_id<>''
        """
        params = []
        if getattr(args, 'store', None):
            sql += ' AND store_id=%s'
            params.append(int(args.store))
        if args.limit:
            sql += f' LIMIT {int(args.limit)}'
        c.execute(sql, params)
        all_skus = c.fetchall()

    # category_id 풀패스 → leaf 변환 (스키마는 leaf 키)
    def _leaf(cat):
        return cat.split('>')[-1] if cat else cat
    all_skus = [(s[0], s[1], _leaf(s[2])) for s in all_skus]

    print(f'[detect] OK SKU 수: {len(all_skus):,}')
    if not all_skus:
        return

    # 2) 카테고리별로 스키마 미리 조회 (캐시) — leaf 기준
    cat_ids = sorted({s[2] for s in all_skus})
    print(f'[detect] 고유 카테고리(leaf): {len(cat_ids):,} → 스키마 캐싱')
    schema_cache, _ = build_value_index(cat_ids)
    print(f'[detect] 스키마 매핑된 카테고리: {len(schema_cache):,}')

    # 3) SKU 별 비교 + INSERT
    inserts = 0
    skus_with_missing = 0
    no_schema = 0
    by_category = 0
    batch = []

    for i, (seller, sid, cat) in enumerate(all_skus, 1):
        attrs = schema_cache.get(cat)
        if not attrs:
            no_schema += 1
            continue
        set_seqs = fetch_set_attrs(seller, sid)
        missing_for_sku = 0
        for sa in attrs:
            if sa['attribute_seq'] in set_seqs:
                continue
            # 후보값 추출 (max 50)
            candidates = sa['values'][:50]
            recommended_seq = None
            recommended_text = None
            if len(candidates) == 1:
                recommended_seq = candidates[0]['seq']
                recommended_text = candidates[0]['text']
            batch.append([
                seller, sid, cat, sa['attribute_seq'], sa['attribute_name'],
                sa['kind_type'], sa['type'], sa['classification_type'],
                len(candidates),
                json.dumps(candidates, ensure_ascii=False),
                recommended_seq, recommended_text,
                'pending',
                now,
            ])
            missing_for_sku += 1
        if missing_for_sku > 0:
            skus_with_missing += 1
            inserts += missing_for_sku
        if len(batch) >= 1000:
            _flush(batch)
            batch.clear()
        if i % 5000 == 0:
            print(f'  [{i}/{len(all_skus)}] inserts={inserts:,} skus_with_missing={skus_with_missing:,}')

    if batch:
        _flush(batch)

    print(f'\n=== DONE ===')
    print(f'전체 SKU: {len(all_skus):,}')
    print(f'스키마 없는 SKU (제외): {no_schema:,}')
    print(f'빈 속성 발견 SKU: {skus_with_missing:,}')
    print(f'미선택 (attribute_seq) 합계: {inserts:,}')


def _flush(batch):
    with connections['myproduct'].cursor() as c:
        c.executemany("""
            INSERT INTO smartstore_product_missing_attrs
              (seller_management_code, store_id, category_id, attribute_seq, attribute_name,
               attribute_kind_type, attribute_type, classification_type,
               candidate_count, candidate_values_json,
               recommended_value_seq, recommended_value_text, status, detected_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
              attribute_name=VALUES(attribute_name),
              candidate_count=VALUES(candidate_count),
              candidate_values_json=VALUES(candidate_values_json),
              recommended_value_seq=VALUES(recommended_value_seq),
              recommended_value_text=VALUES(recommended_value_text),
              detected_at=VALUES(detected_at)
        """, batch)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--store', type=int, default=0)
    ap.add_argument('--reset', action='store_true')
    args = ap.parse_args()
    detect(args)
