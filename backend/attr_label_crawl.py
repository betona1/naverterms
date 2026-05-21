"""
Attribute label crawler — leafCategoryId 별로 어드민 SPA 의 두 endpoint 를 호출해
attributeSeq/attributeValueSeq → 한글라벨 매핑을 수집.

흐름:
  1. Selenium 으로 한 번 로그인
  2. 모든 unique leafCategoryId 에 대해 in-browser fetch:
     - /api/category-attribute/attribute-group?leafCategoryId=...
     - /api/product/shared/attributes?attributeKindType=STD_OPTION&leafCategoryId=...
     - /api/product/shared/attributes?attributeKindType=PRODUCT&leafCategoryId=...
  3. 결과를 smartstore_attr_label_map 에 UPSERT
  4. 카테고리당 처리 결과를 smartstore_attr_label_crawl_log 에 기록

사용:
  python3 attr_label_crawl.py                    # 전체 (미수집/실패 카테고리만)
  python3 attr_label_crawl.py --force            # 전체 강제 재수집
  python3 attr_label_crawl.py --limit 5          # 검증
  python3 attr_label_crawl.py --category 50000568  # 단일 카테고리
"""
import os, sys, json, time, argparse, traceback
from datetime import datetime

import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections
from smartstore.store_collector import (
    _create_driver, _login, _close_popups, _switch_store,
    _get_store_list, _ensure_display, _get_display_env, _safe_quit_driver,
)


JS_FETCH = r"""
const cb = arguments[arguments.length - 1];
const leaf = arguments[0];
const ag = '/api/category-attribute/attribute-group?leafCategoryId=' + leaf;
const std = '/api/product/shared/attributes?attributeKindType=STD_OPTION&leafCategoryId=' + leaf;
const prod = '/api/product/shared/attributes?attributeKindType=PRODUCT&leafCategoryId=' + leaf;

async function fetchJson(url) {
  try {
    const r = await fetch(url, {credentials: 'include', headers: {'Accept': 'application/json'}});
    if (!r.ok) return {__http: r.status};
    return await r.json();
  } catch (e) {
    return {__error: String(e)};
  }
}

Promise.all([fetchJson(ag), fetchJson(std), fetchJson(prod)])
  .then(([a, s, p]) => cb({attribute_group: a, std_option: s, product: p}))
  .catch(e => cb({__error: String(e)}));
"""


def upsert_label(c, row, now):
    c.execute("""
        INSERT INTO smartstore_attr_label_map
        (attribute_seq, attribute_value_seq, attribute_name, attribute_value_text,
         attribute_classification_type, attribute_kind_type, attribute_type,
         exposure_order, service_usable, attribute_value_color, source,
         first_category_id, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          attribute_name=VALUES(attribute_name),
          attribute_value_text=COALESCE(VALUES(attribute_value_text), attribute_value_text),
          attribute_classification_type=VALUES(attribute_classification_type),
          attribute_kind_type=COALESCE(VALUES(attribute_kind_type), attribute_kind_type),
          attribute_type=COALESCE(VALUES(attribute_type), attribute_type),
          exposure_order=VALUES(exposure_order),
          service_usable=VALUES(service_usable),
          attribute_value_color=COALESCE(VALUES(attribute_value_color), attribute_value_color),
          source=VALUES(source),
          updated_at=VALUES(updated_at)
    """, row + [now])


def parse_attribute_group(data, cat_id, now):
    """category-attribute/attribute-group 응답 파싱.
    반환: (label_rows, value_count, category_links)
      label_rows: smartstore_attr_label_map 적재용
      category_links: smartstore_category_attribute 적재용 [(attribute_seq, ktype, atype, ctype, is_required, recommend_order, source)]
    """
    rows = []
    cat_links = []
    if not isinstance(data, list):
        return rows, 0, cat_links
    for entry in data:
        attr = entry.get('attribute') or {}
        aseq = attr.get('id')
        aname = attr.get('attributeName') or ''
        if aseq is None or not aname:
            continue
        ctype = attr.get('attributeClassificationType')
        ktype = attr.get('attributeKindType')
        atype = attr.get('attributeType')
        is_required = 1 if entry.get('isRequired') else 0
        recommend_order = entry.get('recommendComponentExposureOrder') or attr.get('recommendComponentExposureOrder') or 0

        cat_links.append([aseq, ktype, atype, ctype, is_required, recommend_order, 'attribute-group'])

        # header row (attribute_value_seq=0)
        rows.append([
            aseq, 0, aname, None,
            ctype, ktype, atype,
            0, 1, None, 'attribute-group', cat_id,
        ])

        for av in (attr.get('attributeValues') or []):
            avseq = av.get('attributeValueSeq')
            if avseq is None:
                continue
            text = av.get('attributeValueText') or av.get('minAttributeValue') or ''
            color = (av.get('attributeValueColor') or {}).get('value') or None
            rows.append([
                aseq, avseq, aname, text,
                ctype, ktype, atype,
                av.get('exposureOrder') or 0,
                1 if av.get('serviceUsable') else 0,
                color, 'attribute-group', cat_id,
            ])
    return rows, sum(1 for r in rows if r[1] != 0), cat_links


def parse_std_option(data, cat_id, now, source='std-option'):
    """product/shared/attributes 응답 파싱 (STD_OPTION 또는 PRODUCT)."""
    rows = []
    cat_links = []
    if not isinstance(data, list):
        return rows, 0, cat_links
    for entry in data:
        aseq = entry.get('id')
        aname = entry.get('attributeName') or ''
        if aseq is None or not aname:
            continue

        cat_links.append([aseq, None, None, None, 0, 0, source])

        rows.append([
            aseq, 0, aname, None,
            None, None, None,
            0, 1, None, source, cat_id,
        ])

        for av in (entry.get('attributeValues') or []):
            avseq = av.get('attributeValueSeq')
            if avseq is None:
                continue
            text = av.get('attributeValueText') or ''
            color = (av.get('attributeValueColor') or {}).get('value') or None
            rows.append([
                aseq, avseq, aname, text,
                None, None, None,
                av.get('exposureOrder') or 0,
                1 if av.get('serviceUsable') else 0,
                color, source, cat_id,
            ])
    return rows, sum(1 for r in rows if r[1] != 0), cat_links


def select_categories(args):
    where = ["category_id IS NOT NULL", "category_id<>''"]
    params = []
    if args.category:
        return [args.category]
    if args.categories:
        return [x.strip() for x in args.categories.split(',') if x.strip()]
    sql = f"""
        SELECT DISTINCT l.category_id
        FROM smartstore_attr_crawl_log l
        WHERE l.status='ok' AND l.category_id IS NOT NULL AND l.category_id<>''
    """
    if not args.force:
        sql += """
          AND NOT EXISTS (
            SELECT 1 FROM smartstore_attr_label_crawl_log lc
            WHERE lc.category_id=l.category_id AND lc.status='ok'
          )
        """
    sql += " ORDER BY l.category_id"
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    with connections['myproduct'].cursor() as c:
        c.execute(sql, params)
        return [r[0] for r in c.fetchall()]


def crawl_one(driver, cat_id):
    """단일 카테고리 — JS fetch 후 DB 적재."""
    # full_path 인 경우 leaf 만 추출 (예: '50000001>50000185>50000568' → '50000568')
    leaf_id = cat_id.split('>')[-1] if '>' in cat_id else cat_id
    try:
        result = driver.execute_async_script(JS_FETCH, leaf_id)
    except Exception as e:
        return {'ok': False, 'err': f'js_exec: {e}'}
    if not result:
        return {'ok': False, 'err': 'null_result'}
    if result.get('__error'):
        return {'ok': False, 'err': result['__error']}

    ag = result.get('attribute_group')
    std = result.get('std_option')
    prod = result.get('product')

    rows = []
    cat_links = []
    ag_n = std_n = prod_n = 0
    now = datetime.now()

    if isinstance(ag, list):
        r, n, cl = parse_attribute_group(ag, cat_id, now)
        rows.extend(r); ag_n = n; cat_links.extend(cl)
    if isinstance(std, list):
        r, n, cl = parse_std_option(std, cat_id, now, 'std-option')
        rows.extend(r); std_n = n; cat_links.extend(cl)
    if isinstance(prod, list):
        r, n, cl = parse_std_option(prod, cat_id, now, 'product-attr')
        rows.extend(r); prod_n = n; cat_links.extend(cl)

    total = ag_n + std_n + prod_n
    if rows:
        with connections['myproduct'].cursor() as c:
            for row in rows:
                upsert_label(c, row, now)
            # category-attribute 링크 (이 카테고리에 어떤 속성들이 있는지)
            for link in cat_links:
                aseq, ktype, atype, ctype, is_req, rec_ord, src = link
                c.execute("""
                    INSERT INTO smartstore_category_attribute
                    (category_id, attribute_seq, attribute_kind_type, attribute_type,
                     attribute_classification_type, is_required, recommend_order, source, updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                      attribute_kind_type=COALESCE(VALUES(attribute_kind_type), attribute_kind_type),
                      attribute_type=COALESCE(VALUES(attribute_type), attribute_type),
                      attribute_classification_type=COALESCE(VALUES(attribute_classification_type), attribute_classification_type),
                      is_required=GREATEST(is_required, VALUES(is_required)),
                      recommend_order=VALUES(recommend_order),
                      source=VALUES(source), updated_at=VALUES(updated_at)
                """, [cat_id, aseq, ktype, atype, ctype, is_req, rec_ord, src, now])

            c.execute("""
                INSERT INTO smartstore_attr_label_crawl_log
                (category_id, status, ag_count, std_count, total_values, crawled_at)
                VALUES (%s, 'ok', %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  status='ok', ag_count=VALUES(ag_count),
                  std_count=VALUES(std_count)+%s,
                  total_values=VALUES(total_values),
                  error=NULL, crawled_at=VALUES(crawled_at)
            """, [cat_id, ag_n, std_n + prod_n, total, now, 0])
        return {'ok': True, 'ag': ag_n, 'std': std_n, 'prod': prod_n, 'total': total, 'links': len(cat_links)}
    else:
        with connections['myproduct'].cursor() as c:
            c.execute("""
                INSERT INTO smartstore_attr_label_crawl_log
                (category_id, status, ag_count, std_count, total_values, error, crawled_at)
                VALUES (%s, 'empty', 0, 0, 0, %s, %s)
                ON DUPLICATE KEY UPDATE
                  status='empty', error=VALUES(error), crawled_at=VALUES(crawled_at)
            """, [cat_id, 'no values returned', now])
        return {'ok': True, 'total': 0, 'note': 'empty'}


def login_and_navigate(driver, login_id, store_pw, store_name, display_env):
    if not _login(driver, login_id, store_pw, display_env):
        return False
    _close_popups(driver)
    time.sleep(2)

    dropdown = _get_store_list(driver)
    if dropdown and len(dropdown) > 1:
        if not _switch_store(driver, store_name):
            return False
        time.sleep(2)

    # base SPA 페이지 진입 (cookies/세션 활성화)
    driver.get('https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL')
    time.sleep(5)
    _close_popups(driver)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true', help='이미 OK 처리된 카테고리도 재수집')
    ap.add_argument('--category', help='단일 카테고리만 (테스트)')
    ap.add_argument('--categories', help='쉼표 구분 다중 카테고리 (워커 분산용)')
    ap.add_argument('--categories-file', help='파일에서 카테고리 목록 읽기 (한 줄에 하나)')
    ap.add_argument('--login-id', help='특정 login_id 로 로그인 (기본: 첫 활성 스토어)')
    ap.add_argument('--sleep-ms', type=int, default=400, help='카테고리 간 대기')
    args = ap.parse_args()
    if args.categories_file and not args.categories:
        with open(args.categories_file) as f:
            args.categories = ','.join(line.strip() for line in f if line.strip())

    cats = select_categories(args)
    print(f'[Label] 대상 카테고리 {len(cats)}개')
    if not cats:
        return

    # 활성 스토어로 로그인 (어떤 계정이든 무관 — endpoint는 카테고리 단위)
    with connections['myproduct'].cursor() as c:
        if args.login_id:
            c.execute("""
                SELECT store_id, store_pw, store_name
                FROM smartstoreIdList
                WHERE is_active=1 AND store_id=%s
                ORDER BY id LIMIT 1
            """, [args.login_id])
        else:
            c.execute("""
                SELECT store_id, store_pw, store_name
                FROM smartstoreIdList
                WHERE is_active=1 AND commerce_api_key IS NOT NULL AND commerce_api_key<>''
                ORDER BY id LIMIT 1
            """)
        row = c.fetchone()
    if not row:
        print('no active store available')
        return
    login_id, store_pw, store_name = row

    _ensure_display()
    display_env = _get_display_env()
    download_dir = f'/tmp/attr_label_crawl/{int(time.time())}'

    driver = None
    t0 = time.time()
    ok = fail = empty = 0
    try:
        driver = _create_driver(download_dir)
        driver.set_script_timeout(30)
        if not login_and_navigate(driver, login_id, store_pw, store_name, display_env):
            print('LOGIN/NAVIGATE FAILED')
            return

        for i, cat_id in enumerate(cats, 1):
            try:
                r = crawl_one(driver, cat_id)
            except Exception as e:
                r = {'ok': False, 'err': str(e)[:200]}
            if r.get('ok'):
                if r.get('note') == 'empty':
                    empty += 1
                    print(f'  [{i}/{len(cats)}] cat={cat_id} EMPTY')
                else:
                    ok += 1
                    elapsed = time.time() - t0
                    rate = i / elapsed
                    eta = (len(cats) - i) / rate / 60 if rate > 0 else 0
                    print(f'  [{i}/{len(cats)}] cat={cat_id} OK ag={r.get("ag",0)} std={r.get("std",0)} prod={r.get("prod",0)} total={r.get("total",0)} | {rate:.2f}/s ETA={eta:.1f}분')
            else:
                fail += 1
                err = r.get('err', '?')
                print(f'  [{i}/{len(cats)}] cat={cat_id} FAIL {err}')
                with connections['myproduct'].cursor() as c:
                    c.execute("""
                        INSERT INTO smartstore_attr_label_crawl_log
                        (category_id, status, error, crawled_at)
                        VALUES (%s, 'fail', %s, %s)
                        ON DUPLICATE KEY UPDATE status='fail', error=VALUES(error), crawled_at=VALUES(crawled_at)
                    """, [cat_id, err[:200], datetime.now()])

            time.sleep(args.sleep_ms / 1000)
    finally:
        if driver:
            _safe_quit_driver(driver)

    elapsed = (time.time() - t0) / 60
    print(f'\n=== DONE === OK {ok} / EMPTY {empty} / FAIL {fail}  경과 {elapsed:.1f}분')


if __name__ == '__main__':
    main()
