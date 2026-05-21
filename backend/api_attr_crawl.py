"""
Stage 1 (API): SmartStore 상품 데이터 대량 크롤.

수집 데이터 (네이버 커머스 API):
  - 검색태그: seoInfo.sellerTags[] (text + code)
  - PageTitle / MetaDescription: seoInfo
  - 상품속성 ID: detailAttribute.productAttributes[]
  - 브랜드/제조사/모델/카탈로그: naverShoppingSearchInfo
  - 카테고리: leafCategoryId

저장 (기존 테이블):
  - smartstore_product_tag
  - smartstore_product_attr_value
  - smartstore_category_attr_schema  (속성 ID 누적, 라벨은 UI 크롤 후 보강)
  - smartstore_attr_crawl_log

사용:
  python3 api_attr_crawl.py --limit 10
  python3 api_attr_crawl.py --since-sold 2025-04-01
  python3 api_attr_crawl.py --login-id netkjy@hanmail.net
  python3 api_attr_crawl.py                                # 전체 SALE
"""
import os
import sys
import time
import json
import argparse
import hashlib
import traceback
from datetime import datetime
from decimal import Decimal

import django
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections

from smartstore.smartstore_product_service import _get_access_token


VALID_ORDER_STATUSES = (
    '고객주문', '신규주문', '배송준비', '입금확인', '배송준비중',
    '배송중', '배송완료', '거래완료', '오더완료',
)
SMARTSTORE_SITE = '04.스마트스토어'

API_BASE = 'https://api.commerce.naver.com'
PRODUCT_DETAIL_URL = API_BASE + '/external/v2/products/origin-products/{}'


def _attr_key(category_id, label, type_):
    base = f'{category_id}|{type_}|{label}'.encode('utf-8')
    return hashlib.sha1(base).hexdigest()[:32]


def select_targets(args):
    """크롤 대상 W코드 선택."""
    if args.retry_failed:
        # crawl_log에서 fail인 (seller_code, store_id) 조합만 재시도
        items = []
        with connections['myproduct'].cursor() as c:
            c.execute("""
                SELECT DISTINCT l.seller_management_code, l.store_id
                FROM smartstore_attr_crawl_log l
                WHERE l.status='fail'
                  AND NOT EXISTS (
                      SELECT 1 FROM smartstore_attr_crawl_log l2
                      WHERE l2.seller_management_code=l.seller_management_code
                        AND l2.store_id=l.store_id
                        AND l2.status='ok'
                  )
            """)
            fail_keys = c.fetchall()
            if not fail_keys:
                return []
            for sc, sid in fail_keys:
                c.execute("""SELECT p.seller_management_code, p.origin_product_no, p.channel_product_no,
                                    p.category_id, p.store_id, p.name,
                                    s.store_id AS login_id, s.commerce_api_key, s.commerce_secret_key, s.store_name
                             FROM smartstore_product p JOIN smartstoreIdList s ON s.id=p.store_id
                             WHERE p.seller_management_code=%s AND p.store_id=%s LIMIT 1""", [sc, sid])
                cols = [c.description[i][0] for i in range(len(c.description))]
                row = c.fetchone()
                if row:
                    items.append(dict(zip(cols, row)))
        return items

    where = ["p.status_type = 'SALE'", "s.is_active = 1",
             "s.commerce_api_key IS NOT NULL", "s.commerce_api_key <> ''"]
    params = []

    if args.login_id:
        ids = [x.strip() for x in args.login_id.split(',') if x.strip()]
        if ids:
            ph = ','.join(['%s'] * len(ids))
            where.append(f"s.store_id IN ({ph})")
            params.extend(ids)

    if args.store_id:
        sids = [int(x.strip()) for x in args.store_id.split(',') if x.strip()]
        if sids:
            ph = ','.join(['%s'] * len(sids))
            where.append(f"s.id IN ({ph})")
            params.extend(sids)

    if args.skip_done:
        where.append("""NOT EXISTS (
            SELECT 1 FROM smartstore_attr_crawl_log l
            WHERE l.seller_management_code = p.seller_management_code COLLATE utf8mb4_general_ci
              AND l.store_id=p.store_id
              AND l.status='ok'
        )""")

    if args.since_sold:
        # joacham.orders_order에서 since_sold 이후 판매된 W코드만
        with connections['joacham'].cursor() as c:
            status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
            c.execute(f"""
                SELECT DISTINCT product_seller_code
                FROM orders_order
                WHERE site_name = %s
                  AND order_date >= %s
                  AND order_status IN ({status_ph})
                  AND product_seller_code IS NOT NULL AND product_seller_code <> ''
            """, [SMARTSTORE_SITE, args.since_sold, *VALID_ORDER_STATUSES])
            sold_codes = [r[0] for r in c.fetchall()]
        if not sold_codes:
            return []
        # 청크 단위로 IN 조건
        items = []
        chunk = 1000
        with connections['myproduct'].cursor() as c:
            for i in range(0, len(sold_codes), chunk):
                sub = sold_codes[i:i + chunk]
                ph = ','.join(['%s'] * len(sub))
                w = list(where) + [f"p.seller_management_code IN ({ph})"]
                c.execute(
                    f"""
                    SELECT p.seller_management_code, p.origin_product_no, p.channel_product_no,
                           p.category_id, p.store_id, p.name,
                           s.store_id AS login_id, s.commerce_api_key, s.commerce_secret_key,
                           s.store_name
                    FROM smartstore_product p
                    JOIN smartstoreIdList s ON s.id = p.store_id
                    WHERE {' AND '.join(w)}
                    """,
                    params + sub,
                )
                cols = [c.description[i][0] for i in range(len(c.description))]
                for r in c.fetchall():
                    items.append(dict(zip(cols, r)))
        if args.limit:
            items = items[:args.limit]
        return items

    # since-sold 없으면 전체 SALE
    sql = f"""
        SELECT p.seller_management_code, p.origin_product_no, p.channel_product_no,
               p.category_id, p.store_id, p.name,
               s.store_id AS login_id, s.commerce_api_key, s.commerce_secret_key,
               s.store_name
        FROM smartstore_product p
        JOIN smartstoreIdList s ON s.id = p.store_id
        WHERE {' AND '.join(where)}
    """
    if args.limit:
        sql += f' LIMIT {int(args.limit)}'
    items = []
    with connections['myproduct'].cursor() as c:
        c.execute(sql, params)
        cols = [c.description[i][0] for i in range(len(c.description))]
        for r in c.fetchall():
            items.append(dict(zip(cols, r)))
    return items


def fetch_one(token, origin_no, max_retries=4):
    """Commerce API로 상품 상세 조회. 429/5xx 에 대해 지수 백오프 재시도."""
    url = PRODUCT_DETAIL_URL.format(origin_no)
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=30)
        except Exception as e:
            last_err = f'request_exc: {e}'
            if attempt < max_retries:
                time.sleep(min(60, 2 ** attempt))
                continue
            return None, last_err

        if r.status_code == 200:
            try:
                return r.json(), None
            except Exception as e:
                return None, f'json_decode: {e}'

        # 429 (rate limit) / 5xx → 백오프 + 재시도
        if r.status_code == 429 or 500 <= r.status_code < 600:
            retry_after = r.headers.get('Retry-After')
            if retry_after and retry_after.isdigit():
                wait = min(60, int(retry_after))
            else:
                wait = min(60, 2 ** (attempt + 2))   # 4s, 8s, 16s, 32s
            last_err = f'http_{r.status_code}_retry_in_{wait}s'
            if attempt < max_retries:
                time.sleep(wait)
                continue
            return None, f'http_{r.status_code}: {r.text[:160]}'

        # 4xx (재시도 무의미)
        return None, f'http_{r.status_code}: {r.text[:160]}'
    return None, last_err or 'unknown'


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
          options_json   = COALESCE(VALUES(options_json), options_json),
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
          (seller_management_code, category_id, store_id, tag, position,
           search_volume, tag_raw, is_standard, search_volume_label, crawled_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          category_id          = VALUES(category_id),
          store_id             = VALUES(store_id),
          position             = VALUES(position),
          search_volume        = VALUES(search_volume),
          tag_raw              = VALUES(tag_raw),
          is_standard          = VALUES(is_standard),
          search_volume_label  = VALUES(search_volume_label),
          crawled_at           = VALUES(crawled_at)
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


def process_one(item, data, now):
    """API 응답을 DB 5개 테이블에 적재."""
    seller_code = item['seller_management_code']
    op_no = item['origin_product_no']
    ch_no = item['channel_product_no']
    cat_id = item['category_id'] or ''
    store_id = item['store_id']

    op = (data or {}).get('originProduct', {}) or {}
    da = op.get('detailAttribute', {}) or {}
    seo = da.get('seoInfo', {}) or {}
    nssi = da.get('naverShoppingSearchInfo', {}) or {}
    pa = da.get('productAttributes', []) or []
    leaf_cat = str(op.get('leafCategoryId') or '')
    cat_text = ''  # 라벨은 별도 카테고리 API에서. 일단 비움
    name = op.get('name') or item['name'] or ''
    sale_price = op.get('salePrice')
    stock = op.get('stockQuantity')

    counts = {'tag': 0, 'attr_value': 0}

    with connections['myproduct'].cursor() as c:
        # === 1) 검색태그 ===
        tags = seo.get('sellerTags') or []
        for pos, t in enumerate(tags, 1):
            text = (t.get('text') or '').strip()
            if not text:
                continue
            code = t.get('code')
            tag_raw = f'# {text}' + (f' ({code})' if code is not None else '')
            label = str(code) if code is not None else '숫자없음'
            upsert_tag(c, [
                seller_code, cat_id, store_id, text, pos,
                int(code) if code is not None else None,
                tag_raw,
                1 if code is not None else 0,
                label,
                now,
            ])
            counts['tag'] += 1

        # === 2) PageTitle / MetaDescription / SellerTags 원문 ===
        seo_items = [
            ('PageTitle', seo.get('pageTitle'), '검색설정'),
            ('MetaDescription', seo.get('metaDescription'), '검색설정'),
            ('검색태그(원문)', ','.join((t.get('text') or '') for t in tags), '검색설정'),
            ('브랜드명', nssi.get('brandName'), '검색정보'),
            ('제조사명', nssi.get('manufacturerName'), '검색정보'),
            ('모델명', nssi.get('modelName'), '검색정보'),
            ('catalogMatchingYn', '1' if nssi.get('catalogMatchingYn') else '0', '검색정보'),
            ('matchedCatalogId', str(nssi.get('matchedCatalogId') or ''), '검색정보'),
            ('판매가', str(sale_price) if sale_price is not None else None, '상품주요정보'),
            ('재고수량', str(stock) if stock is not None else None, '상품주요정보'),
            ('상품명', name, '상품주요정보'),
        ]
        for label, val, section in seo_items:
            if val is None or val == '':
                continue
            attr_key = _attr_key(cat_id, label, 'text')
            upsert_schema(c, [
                cat_id, cat_text, section, attr_key, label, 'text',
                None, None, 0, 0, now, now, 1,
            ])
            value_number = None
            try:
                if label in ('판매가', '재고수량'):
                    value_number = Decimal(val)
            except Exception:
                pass
            upsert_value(c, [
                seller_code, op_no, ch_no, cat_id, store_id, section,
                attr_key, label, 'text',
                val, None, value_number, None,
                0, 0, now,
            ])
            counts['attr_value'] += 1

        # === 3) 상품속성 (attributeSeq → attributeValueSeq) ===
        for p in pa:
            aseq = p.get('attributeSeq')
            avseq = p.get('attributeValueSeq')
            if aseq is None:
                continue
            label = f'attr#{aseq}'                       # 라벨은 추후 UI 크롤로 보강
            attr_key = _attr_key(cat_id, label, 'select-one')
            upsert_schema(c, [
                cat_id, cat_text, '상품속성', attr_key, label, 'select-one',
                None, None, 0, 0, now, now, 1,
            ])
            upsert_value(c, [
                seller_code, op_no, ch_no, cat_id, store_id, '상품속성',
                attr_key, label, 'select-one',
                str(avseq) if avseq is not None else None,
                None, None, None,
                0, 0, now,
            ])
            counts['attr_value'] += 1

        # === 4) 크롤 로그 ===
        insert_log(c, [
            seller_code, op_no, ch_no, leaf_cat or cat_id, cat_text,
            store_id, 'ok',
            counts['attr_value'], counts['tag'],
            json.dumps({
                'tags': tags,
                'pageTitle': seo.get('pageTitle'),
                'metaDescription': seo.get('metaDescription'),
                'productAttributes': pa,
                'naverShoppingSearchInfo': nssi,
                'leafCategoryId': leaf_cat,
            }, ensure_ascii=False)[:1_000_000],
            None, '', '', now,
        ])

    return counts


def insert_log_fail(item, error, now):
    with connections['myproduct'].cursor() as c:
        insert_log(c, [
            item['seller_management_code'], item['origin_product_no'], item['channel_product_no'],
            item['category_id'], '', item['store_id'], 'fail',
            0, 0, None, None, '', (error or '')[:500], now,
        ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--login-id', default='', help='특정 로그인 ID로 한정')
    ap.add_argument('--store-id', default='', help='특정 store_id 로 한정 (콤마 구분, smartstoreIdList.id)')
    ap.add_argument('--since-sold', default='', help='이 날짜 이후 판매된 상품만 (예: 2025-04-01)')
    ap.add_argument('--sleep-ms', type=int, default=200, help='요청 간 대기 (ms)')
    ap.add_argument('--retry-failed', action='store_true', help='crawl_log fail row만 재시도')
    ap.add_argument('--skip-done', action='store_true', help='이미 OK 처리된 SKU 제외 (전체 크롤 시 권장)')
    ap.add_argument('--print-every', type=int, default=20)
    args = ap.parse_args()

    items = select_targets(args)
    print(f'[Crawl] 대상 {len(items):,}개')
    if not items:
        return

    # store별 그룹핑 (토큰을 api_key 단위로 캐싱)
    by_store = {}
    for it in items:
        key = it['commerce_api_key']
        by_store.setdefault(key, {'login': it['login_id'], 'store': it['store_name'],
                                   'secret': it['commerce_secret_key'], 'items': []})
        by_store[key]['items'].append(it)
    print(f'[Crawl] 스토어 {len(by_store)}개 그룹')

    now = datetime.now()
    total_ok = total_fail = 0
    total_tags = total_attrs = 0
    start = time.time()

    for api_key, group in by_store.items():
        try:
            token = _get_access_token(api_key, group['secret'])
        except Exception as e:
            print(f'[FAIL] 토큰 발급 실패 {group["store"]}: {e}')
            for it in group['items']:
                insert_log_fail(it, f'token_error: {e}', now)
                total_fail += 1
            continue

        items_g = group['items']
        print(f'\n=== {group["store"]} (login={group["login"]}, {len(items_g):,}개) ===')
        for idx, item in enumerate(items_g, 1):
            try:
                data, err = fetch_one(token, item['origin_product_no'])
                # 토큰 만료 (401) 감지 → 재발급 후 1회 재시도
                if err and ('http_401' in err or 'GW.AUTHN' in err):
                    try:
                        token = _get_access_token(api_key, group['secret'])
                        print(f'  [token refresh] {group["store"]}')
                        data, err = fetch_one(token, item['origin_product_no'])
                    except Exception as e2:
                        err = f'token_refresh_failed: {e2}'
                if err:
                    insert_log_fail(item, err, datetime.now())
                    total_fail += 1
                    if idx % args.print_every == 0 or idx == 1:
                        print(f'  [{idx}/{len(items_g)}] {item["seller_management_code"]} FAIL {err[:60]}')
                    continue
                counts = process_one(item, data, datetime.now())
                total_ok += 1
                total_tags += counts['tag']
                total_attrs += counts['attr_value']
                if idx % args.print_every == 0 or idx == 1:
                    elapsed = time.time() - start
                    rate = (total_ok + total_fail) / max(elapsed, 0.001)
                    eta = (len(items) - total_ok - total_fail) / max(rate, 0.001)
                    print(f'  [{idx}/{len(items_g)}] {item["seller_management_code"]} OK tags={counts["tag"]} attr={counts["attr_value"]}  | {rate:.1f}/s ETA={eta/60:.1f}분')
            except Exception as e:
                insert_log_fail(item, str(e)[:300], datetime.now())
                total_fail += 1
                print(f'  [{idx}/{len(items_g)}] {item["seller_management_code"]} EXC: {e}')

            if args.sleep_ms > 0:
                time.sleep(args.sleep_ms / 1000.0)

    elapsed = time.time() - start
    print(f'\n=== DONE === 총 {len(items):,}개 / OK {total_ok:,} / FAIL {total_fail:,}')
    print(f'태그 row: {total_tags:,}  속성 row: {total_attrs:,}')
    print(f'경과: {elapsed/60:.1f}분  ({(total_ok+total_fail)/max(elapsed,0.001):.1f}건/s)')


if __name__ == '__main__':
    main()
