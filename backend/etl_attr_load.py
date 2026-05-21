"""
attr_discovery 결과(manifest.json + per_code/*.html) → DB 적재 ETL.

흐름:
  1. manifest.json 로드 (JSON 추출 결과)
  2. 각 W코드(seller_management_code)에 대해:
     - smartstore_attr_crawl_log INSERT (이력)
     - 추출된 fields → 테이블 A(category_attr_schema) UPSERT + 테이블 B(product_attr_value) UPSERT
     - 저장된 HTML 파싱 → 검색태그/PageTitle/Meta → 테이블 T + 테이블 B
  3. 통계 출력

사용:
  python3 etl_attr_load.py /path/to/run_dir
  python3 etl_attr_load.py             # 가장 최근 run_dir 자동 선택
"""
import os
import re
import sys
import json
import glob
import hashlib
from datetime import datetime
from decimal import Decimal

import django

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections


RECOMMEND_TOKENS = ('추천',)
HELP_TOKENS = ('도움말',)


def latest_run_dir():
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'exports', 'attr_discovery')
    runs = sorted([d for d in os.listdir(base) if not d.startswith('probe_')])
    return os.path.join(base, runs[-1]) if runs else None


def clean_label(raw):
    if not raw:
        return '', False
    s = raw.replace('\xa0', ' ').strip()
    is_rec = False
    # 후행 토큰 제거
    for tok in RECOMMEND_TOKENS:
        if s.endswith(tok):
            s = s[:-len(tok)].rstrip()
            is_rec = True
    for tok in HELP_TOKENS:
        if tok in s:
            s = s.replace(tok, '').strip()
    s = re.sub(r'\s+', ' ', s).strip()
    return s, is_rec


def make_attr_key(category_id, label, type_):
    base = f'{category_id}|{type_}|{label}'.encode('utf-8')
    return hashlib.sha1(base).hexdigest()[:32]


def parse_number(text):
    if text is None:
        return None
    if isinstance(text, (int, float, Decimal)):
        return Decimal(str(text))
    s = str(text).strip().replace(',', '')
    if not s:
        return None
    m = re.search(r'-?\d+(?:\.\d+)?', s)
    if not m:
        return None
    try:
        return Decimal(m.group(0))
    except Exception:
        return None


def parse_tags_pagetitle_meta(html):
    """저장된 HTML #anchor-tag 영역에서 태그/PageTitle/Meta 추출.

    원문 set-option 형식: '태그(t1,t2,...,t10) / Page Title(...) / Meta Description(...)<a class=...>'
    set-option div 경계를 anchor로 잡아 파싱 (괄호/숫자/공백 모두 보존).
    """
    out = {'tags': [], 'tags_raw': None, 'page_title': None, 'meta_description': None}

    # 1) anchor-tag 섹션 내부의 set-option div 추출
    m_section = re.search(
        r'id="anchor-tag".*?<div class="set-option"[^>]*>(.*?)<a class="btn',
        html, re.DOTALL,
    )
    if not m_section:
        # fallback: set-option 단독
        m_section = re.search(r'<div class="set-option"[^>]*>([^<]+태그\([^<]+)</div>', html)
    if not m_section:
        return out

    inner = m_section.group(1)
    # HTML entity / 태그 잔여 제거
    inner = re.sub(r'<[^>]+>', '', inner)
    inner = inner.replace('&nbsp;', ' ').replace('&amp;', '&').strip()

    # 2) 'Page Title(' 와 'Meta Description(' 위치를 anchor로 잡고 그 사이를 파싱
    pt_idx = inner.find('Page Title(')
    md_idx = inner.find('Meta Description(')

    # 태그 영역: '태그('부터 'Page Title(' 직전까지 (구분자 ' / ')
    if inner.startswith('태그(') and pt_idx > 0:
        tag_section = inner[3:pt_idx].rstrip()      # '태그(' 3글자 제거
        # 끝의 ') / ' 제거
        tag_section = re.sub(r'\)\s*/\s*$', '', tag_section)
        out['tags_raw'] = tag_section
        if tag_section:
            out['tags'] = [t.strip() for t in tag_section.split(',') if t.strip()]

    # Page Title 영역
    if pt_idx >= 0:
        pt_start = pt_idx + len('Page Title(')
        if md_idx > pt_idx:
            pt_section = inner[pt_start:md_idx]
            pt_section = re.sub(r'\)\s*/\s*$', '', pt_section).strip()
        else:
            pt_section = inner[pt_start:].rstrip(')').strip()
        out['page_title'] = pt_section or None

    # Meta Description 영역
    if md_idx >= 0:
        md_section = inner[md_idx + len('Meta Description('):].rstrip()
        # 끝의 ')' 제거
        md_section = re.sub(r'\)\s*$', '', md_section).strip()
        out['meta_description'] = md_section or None

    return out


def get_store_id(login_id, store_name, _cache={}):
    key = (login_id, store_name)
    if key in _cache:
        return _cache[key]
    with connections['myproduct'].cursor() as c:
        c.execute(
            "SELECT id FROM smartstoreIdList WHERE store_id=%s AND store_name=%s LIMIT 1",
            [login_id, store_name],
        )
        r = c.fetchone()
    _cache[key] = r[0] if r else None
    return _cache[key]


def upsert_schema(c, row):
    c.execute(
        """
        INSERT INTO smartstore_category_attr_schema
          (category_id, category_text, section, attr_key, attr_label, attr_type,
           options_json, unit, is_recommended, is_required,
           first_seen_at, last_seen_at, sample_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          category_text  = VALUES(category_text),
          section        = COALESCE(VALUES(section), section),
          attr_label     = VALUES(attr_label),
          attr_type      = VALUES(attr_type),
          options_json   = VALUES(options_json),
          unit           = COALESCE(VALUES(unit), unit),
          is_recommended = GREATEST(is_recommended, VALUES(is_recommended)),
          last_seen_at   = VALUES(last_seen_at),
          sample_count   = sample_count + 1
        """,
        row,
    )


def upsert_value(c, row):
    c.execute(
        """
        INSERT INTO smartstore_product_attr_value
          (seller_management_code, origin_product_no, channel_product_no,
           category_id, store_id, section, attr_key, attr_label, attr_type,
           value_text, value_bool, value_number, value_unit,
           is_extra, is_recommended, crawled_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          origin_product_no  = VALUES(origin_product_no),
          channel_product_no = VALUES(channel_product_no),
          category_id        = VALUES(category_id),
          store_id           = VALUES(store_id),
          section            = VALUES(section),
          attr_label         = VALUES(attr_label),
          attr_type          = VALUES(attr_type),
          value_text         = VALUES(value_text),
          value_bool         = VALUES(value_bool),
          value_number       = VALUES(value_number),
          value_unit         = VALUES(value_unit),
          is_extra           = VALUES(is_extra),
          is_recommended     = VALUES(is_recommended),
          crawled_at         = VALUES(crawled_at)
        """,
        row,
    )


def upsert_tag(c, row):
    c.execute(
        """
        INSERT INTO smartstore_product_tag
          (seller_management_code, category_id, store_id, tag, position, crawled_at)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          category_id = VALUES(category_id),
          store_id    = VALUES(store_id),
          position    = VALUES(position),
          crawled_at  = VALUES(crawled_at)
        """,
        row,
    )


def insert_log(c, row):
    c.execute(
        """
        INSERT INTO smartstore_attr_crawl_log
          (seller_management_code, origin_product_no, channel_product_no,
           category_id, category_text, store_id, status, field_count, tag_count,
           raw_json, html_path, url, error, crawled_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        row,
    )


def categorize_section(field_label, current_section):
    """라벨/섹션 텍스트 기반으로 거친 섹션 분류."""
    if not field_label:
        return current_section or '기타'
    if field_label in ('판매가', '재고수량', '품번'):
        return '상품주요정보'
    if field_label in ('네이버쇼핑', '스마트스토어', '스마트스토어전용 상품명 사용'):
        return '검색설정'
    if field_label.startswith('KC') or field_label in (
        '구매대행', '자체제작 상품', '안전기준 준수', '어린이제품 인증',
        '특정 주문자의 요구사항에 맞춰 개별 맞춤제작되는 상품', '특정기간만 할인',
        '원산지 다른 상품 함께 등록',
    ):
        return '인증정보'
    return '상품속성'


def process_record(c, rec, run_dir, now):
    seller_code = rec.get('seller_code') or ''
    if not seller_code:
        return None

    cat_id = rec.get('category_id') or ''
    store_id = get_store_id(rec.get('login_id'), rec.get('store_name'))
    extract = rec.get('extract') or {}
    cat_text = extract.get('categoryText') or ''
    if cat_text.startswith('선택한 카테고리 :'):
        cat_text = cat_text.replace('선택한 카테고리 :', '').strip()
    fields = extract.get('fields') or []

    schema_count = 0
    value_count = 0
    tag_count = 0

    # 속성 파싱
    seen_keys = set()
    for f in fields:
        type_ = f.get('type') or f.get('tag') or ''
        if type_ in ('text', 'tel', 'number', 'textarea', 'checkbox', 'radio', 'select-one', 'select-multiple'):
            label_raw = f.get('label') or ''
            label, is_rec = clean_label(label_raw)
            if not label:
                # 라벨 없으면 placeholder 또는 name 활용
                label = (f.get('placeholder') or '').strip() or (f.get('name') or '').strip()
                if not label:
                    continue

            attr_key = make_attr_key(cat_id, label, type_)
            if attr_key in seen_keys:
                continue
            seen_keys.add(attr_key)

            opts = f.get('options')
            options_json = json.dumps(opts, ensure_ascii=False) if opts else None
            section = categorize_section(label, f.get('section'))

            # 테이블 A
            upsert_schema(c, [
                cat_id, cat_text, section, attr_key, label, type_,
                options_json, None,             # unit (TODO)
                1 if is_rec else 0, 0,
                now, now, 1,
            ])
            schema_count += 1

            # 테이블 B
            value_text = None
            value_bool = None
            value_number = None
            if type_ in ('checkbox', 'radio'):
                value_bool = 1 if f.get('checked') else 0
            elif type_ in ('text', 'tel', 'number', 'textarea'):
                v = (f.get('value') or '').strip()
                value_text = v or None
                if type_ in ('tel', 'number'):
                    value_number = parse_number(v)
            elif type_ in ('select-one', 'select-multiple'):
                if opts:
                    sel = [o for o in opts if o.get('selected')]
                    if sel:
                        value_text = sel[0].get('text') or sel[0].get('value')

            upsert_value(c, [
                seller_code, rec.get('origin_no'), rec.get('channel_no'),
                cat_id, store_id, section, attr_key, label, type_,
                value_text, value_bool, value_number, None,
                0, 1 if is_rec else 0, now,
            ])
            value_count += 1

    # 태그/PageTitle/Meta 파싱 (HTML 사용)
    safe = seller_code.replace('/', '_').replace(' ', '_')
    html_path = os.path.join(run_dir, 'per_code', f'{safe}.html')
    seo = {}
    if os.path.exists(html_path):
        try:
            html = open(html_path, encoding='utf-8').read()
            seo = parse_tags_pagetitle_meta(html)
        except Exception as e:
            print(f'  [WARN] {seller_code} HTML 파싱 실패: {e}')

    # 태그 적재
    for pos, tag in enumerate(seo.get('tags', []) or [], 1):
        if not tag:
            continue
        upsert_tag(c, [seller_code, cat_id, store_id, tag, pos, now])
        tag_count += 1

    # SEO 메타 → 테이블 B에도 한 row씩 (attr_label='검색태그(원문)' 등)
    seo_items = [
        ('검색태그(원문)', seo.get('tags_raw') or ','.join(seo.get('tags') or [])),
        ('PageTitle', seo.get('page_title')),
        ('MetaDescription', seo.get('meta_description')),
    ]
    for label, val in seo_items:
        if not val:
            continue
        attr_key = make_attr_key(cat_id, label, 'text')
        upsert_schema(c, [
            cat_id, cat_text, '검색설정', attr_key, label, 'text',
            None, None, 0, 0, now, now, 1,
        ])
        upsert_value(c, [
            seller_code, rec.get('origin_no'), rec.get('channel_no'),
            cat_id, store_id, '검색설정', attr_key, label, 'text',
            val, None, None, None, 0, 0, now,
        ])

    # 크롤 이력 INSERT
    insert_log(c, [
        seller_code, rec.get('origin_no'), rec.get('channel_no'),
        cat_id, cat_text, store_id,
        'ok' if rec.get('ok') else 'fail',
        len(fields), tag_count,
        json.dumps(extract, ensure_ascii=False)[:1_000_000],   # 안전히 1MB 제한
        html_path if os.path.exists(html_path) else None,
        rec.get('url') or '',
        (rec.get('error') or '')[:500],
        now,
    ])

    return {'schema': schema_count, 'value': value_count, 'tag': tag_count}


def run(run_dir):
    manifest_path = os.path.join(run_dir, 'manifest.json')
    if not os.path.exists(manifest_path):
        print(f'manifest 없음: {manifest_path}')
        return

    manifest = json.load(open(manifest_path))
    results = manifest.get('results') or []
    print(f'[ETL] run_dir={run_dir}  results={len(results)}')

    now = datetime.now()
    total = {'schema': 0, 'value': 0, 'tag': 0, 'ok': 0, 'fail': 0, 'no_extract': 0}

    with connections['myproduct'].cursor() as c:
        for i, rec in enumerate(results, 1):
            try:
                stat = process_record(c, rec, run_dir, now)
                if stat is None:
                    total['no_extract'] += 1
                    continue
                if rec.get('ok'):
                    total['ok'] += 1
                else:
                    total['fail'] += 1
                for k in ('schema', 'value', 'tag'):
                    total[k] += stat[k]
                if i % 20 == 0:
                    print(f'  ... {i}/{len(results)}  ok={total["ok"]} fail={total["fail"]} 누적속성={total["value"]} 태그={total["tag"]}')
            except Exception as e:
                print(f'  [{i}/{len(results)}] {rec.get("seller_code")} ERR: {e}')

    print(f'\n=== ETL DONE ===')
    print(f'  처리: ok={total["ok"]} fail={total["fail"]} no_extract={total["no_extract"]}')
    print(f'  속성 row(테이블 B): {total["value"]:,}')
    print(f'  카테고리 스키마 누적 호출: {total["schema"]:,}')
    print(f'  태그 row(테이블 T): {total["tag"]:,}')

    # 최종 통계
    with connections['myproduct'].cursor() as c:
        c.execute("SELECT COUNT(DISTINCT category_id) FROM smartstore_category_attr_schema")
        cats = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM smartstore_category_attr_schema")
        attrs = c.fetchone()[0]
        c.execute("SELECT COUNT(DISTINCT seller_management_code) FROM smartstore_product_attr_value")
        skus = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM smartstore_product_attr_value")
        vals = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM smartstore_product_tag")
        tags = c.fetchone()[0]
        c.execute("""SELECT category_text, COUNT(*) cnt
                     FROM smartstore_category_attr_schema
                     WHERE category_text IS NOT NULL AND category_text<>''
                     GROUP BY category_text ORDER BY cnt DESC LIMIT 10""")
        top_cats = c.fetchall()

    print(f'\n=== DB 누적 (모든 run 합계) ===')
    print(f'  카테고리 수:   {cats:,}')
    print(f'  속성 정의 수:  {attrs:,}')
    print(f'  처리한 SKU:    {skus:,}')
    print(f'  속성 값 row:   {vals:,}')
    print(f'  태그 row:      {tags:,}')
    print(f'\n  속성 다양성 Top 10 카테고리:')
    for ct, n in top_cats:
        print(f'    {n:4d}  {ct}')


if __name__ == '__main__':
    run_dir = sys.argv[1] if len(sys.argv) > 1 else latest_run_dir()
    if not run_dir:
        print('run_dir not found')
        sys.exit(1)
    run(run_dir)
