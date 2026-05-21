"""
Stage 2: 카테고리별 상품속성 스키마 UI 크롤.

목적: API에서 받은 attributeSeq/attributeValueSeq → 라벨 매핑 (예: 10011015 → "소재", 10904155 → "면")

흐름 (안정성 우선 — chrome-per-product):
  1. 카테고리별로 1개 표본 상품 선정 (API 크롤로 OK 처리된 것 중)
  2. 카테고리당: chrome 시작 → 로그인 → 스토어 전환 → edit URL 직접 진입
     → JS로 Angular scope에서 categoryAttribute/attributeValue 메타 추출
     → chrome 종료
  3. smartstore_category_attr_schema 의 attr#NNN 라벨을 실제 라벨로 UPDATE

사용:
  python3 category_schema_crawl.py --limit 5                  # 검증
  python3 category_schema_crawl.py --login-id <id>             # 한 로그인만
  python3 category_schema_crawl.py                             # 전체
"""
import os
import sys
import json
import time
import random
import argparse
import traceback
from datetime import datetime

import django

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections

from smartstore.store_collector import (
    _create_driver, _login, _close_popups, _switch_store,
    _get_store_list, _ensure_display, _get_display_env,
    _safe_quit_driver, _xtype,
)


PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"
EDIT_URL_FMT = "https://sell.smartstore.naver.com/#/products/edit/{}"


# Angular scope에서 카테고리 속성 메타 추출
JS_EXTRACT_CATEGORY_ATTR = r"""
return (function(){
  function getScope(el){
    try { return angular.element(el).scope(); } catch(e){ return null; }
  }
  // walk parent scopes via $parent chain
  function findInScope(sc, props){
    let cur = sc;
    while (cur){
      for (const p of props){
        if (cur[p] !== undefined) return {found: cur[p], owner: cur};
      }
      cur = cur.$parent;
      if (!cur || cur === cur.$root) {
        if (cur) {
          for (const p of props){
            if (cur[p] !== undefined) return {found: cur[p], owner: cur};
          }
        }
        break;
      }
    }
    return null;
  }
  const inputs = document.querySelectorAll('input[type="checkbox"][data-checklist-value="attributeValue"]');
  const out = {found: inputs.length, attrs: [], scopeKeysSample: null, scopeProto: null};
  if (!inputs.length) return out;

  // 첫 input의 scope 키들 (진단용)
  const firstScope = getScope(inputs[0]);
  if (firstScope) {
    try {
      out.scopeKeysSample = Object.keys(firstScope).slice(0, 30);
      // walk parents
      let p = firstScope.$parent;
      const parents = [];
      let depth = 0;
      while (p && depth < 8){
        parents.push(Object.keys(p).filter(k=>!k.startsWith('$')).slice(0, 10));
        p = p.$parent;
        depth++;
      }
      out.parentScopeKeys = parents;
    } catch(e) { out.scopeErr = String(e); }
  }

  const groups = new Map();
  inputs.forEach(inp => {
    const sc = getScope(inp);
    if (!sc) return;
    const caRes = findInScope(sc, ['categoryAttribute']);
    const avRes = findInScope(sc, ['attributeValue']);
    if (!caRes || !avRes) return;
    const ca = caRes.found;
    const av = avRes.found;
    if (!ca || !av || !ca.attribute) return;
    const aid = ca.attribute.id;
    if (!groups.has(aid)) {
      groups.set(aid, {
        attribute_seq: aid,
        attribute_name: ca.attribute.name || '',
        is_required: !!ca.isRequired,
        is_related: !!ca.isRelated,
        values: [],
      });
    }
    groups.get(aid).values.push({
      value_seq: av.attributeValueSeq,
      value_label: av.value || '',
      is_recommended: !!av.isRecommend,
      checked: !!sc.checked,
    });
  });
  out.attrs = Array.from(groups.values());

  // 카테고리 정보
  try {
    const root = angular.element(document.body).scope();
    if (root && root.vm) {
      const cat = (root.vm.product||{}).category;
      if (cat) { out.category_id = cat.id; out.category_text = cat.wholeCategoryName; }
    }
  } catch(e) {}

  return out;
})();
"""


def select_targets(args):
    """카테고리당 1개 표본 상품 선정 (API 크롤 OK된 것 중)."""
    where = ["l.status='ok'", "l.channel_product_no IS NOT NULL", "l.channel_product_no<>''",
             "l.category_id IS NOT NULL", "l.category_id<>''"]
    params = []
    if args.login_id:
        ids = [x.strip() for x in args.login_id.split(',') if x.strip()]
        if ids:
            ph = ','.join(['%s'] * len(ids))
            where.append(f"s.store_id IN ({ph})")
            params.extend(ids)

    # 실제 속성이 있는 카테고리만 (attr#NNN row가 schema에 있는 것)
    # 카테고리당 1행을 row-coherent하게 — 해당 카테고리의 OK 상품 중 productAttributes가 있는 것 우선
    sql = f"""
        SELECT l.category_id, l.seller_management_code, l.origin_product_no, l.channel_product_no,
               l.store_id, s.store_id AS login_id, s.store_pw, s.store_name
        FROM smartstore_attr_crawl_log l
        JOIN smartstoreIdList s ON s.id = l.store_id
        JOIN (
            -- 실제 속성이 있는 상품 중 카테고리당 가장 최신 1건
            SELECT v.category_id, MAX(l2.id) AS max_id
            FROM smartstore_product_attr_value v
            JOIN smartstore_attr_crawl_log l2
              ON l2.seller_management_code = v.seller_management_code
             AND l2.store_id = v.store_id
            WHERE v.attr_label LIKE 'attr#%%'
              AND l2.status='ok'
              AND l2.channel_product_no IS NOT NULL AND l2.channel_product_no<>''
            GROUP BY v.category_id
        ) m ON l.id = m.max_id
        WHERE {' AND '.join(where)}
        ORDER BY l.category_id
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


def search_and_click_edit(driver, seller_code, display_env):
    """list 페이지에서 W코드 검색 → 첫 결과 수정 클릭. 단일 사용."""
    from selenium.webdriver.common.by import By

    driver.get(PRODUCT_LIST_URL)
    time.sleep(6)
    _close_popups(driver)
    time.sleep(2)

    # 판매자상품코드 라디오
    try:
        radio = driver.find_element(By.XPATH, '//input[@name="searchKeywordType" and @value="SELLER_CODE"]')
        driver.execute_script("arguments[0].click();", radio)
        time.sleep(0.4)
    except Exception as e:
        return False, f'radio: {e}'

    # textarea 입력
    try:
        ta = driver.find_element(By.XPATH, '//textarea[contains(@class,"textarea-vertical")]')
        driver.execute_script("""
            const el = arguments[0];
            const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            desc.set.call(el, '');
            el.dispatchEvent(new Event('input', {bubbles:true}));
        """, ta)
        ta.click()
        time.sleep(0.3)
        _xtype(seller_code, display_env)
        time.sleep(0.5)
    except Exception as e:
        return False, f'textarea: {e}'

    # 검색 버튼
    try:
        btn = None
        for e in driver.find_elements(By.XPATH, '//button[contains(@class,"btn-primary") and normalize-space(.)="검색"]'):
            if e.is_displayed():
                btn = e; break
        if not btn:
            return False, 'search_btn_not_found'
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(4)
    except Exception as e:
        return False, f'search_click: {e}'

    # 수정 버튼 클릭 → 새 탭
    try:
        edits = driver.find_elements(By.XPATH, '//div[contains(@class,"ag-row")]//button[normalize-space(.)="수정"]')
        if not edits:
            edits = driver.find_elements(By.XPATH, '//button[contains(@class,"btn-xs") and normalize-space(.)="수정"]')
        target = next((e for e in edits if e.is_displayed()), None)
        if not target:
            return False, 'edit_btn_not_found'

        before = set(driver.window_handles)
        driver.execute_script("arguments[0].click();", target)
        time.sleep(6)
        after = set(driver.window_handles)
        new = list(after - before)
        if new:
            driver.switch_to.window(new[0])
            time.sleep(7)
            _close_popups(driver)
            time.sleep(2)
        return True, None
    except Exception as e:
        return False, f'edit_click: {e}'


def extract_one_category(category_id, item, display_env):
    """1개 상품 chrome 세션으로 카테고리 속성 메타 추출 (search-click 흐름)."""
    download_dir = f'/tmp/category_schema_crawl/{category_id}_{int(time.time())}'
    os.makedirs(download_dir, exist_ok=True)

    driver = None
    try:
        driver = _create_driver(download_dir)
        if not _login(driver, item['login_id'], item['store_pw'], display_env):
            return {'ok': False, 'err': 'login_failed'}
        _close_popups(driver)
        time.sleep(2)

        # 다중 스토어 처리
        dropdown = _get_store_list(driver)
        if dropdown and len(dropdown) > 1:
            if not _switch_store(driver, item['store_name']):
                return {'ok': False, 'err': 'store_switch_failed'}
            time.sleep(2)

        # 검색 → 수정 클릭
        ok, err = search_and_click_edit(driver, item['seller_management_code'], display_env)
        if not ok:
            return {'ok': False, 'err': err or 'search_click_failed'}

        # 상품속성 영역 렌더 대기 (lazy component)
        # checkbox가 등장할 때까지 최대 25초 폴링
        appeared = False
        for _ in range(25):
            try:
                cnt = driver.execute_script(
                    "return document.querySelectorAll('input[type=\"checkbox\"][data-checklist-value=\"attributeValue\"]').length"
                )
                if cnt and cnt > 0:
                    appeared = True
                    break
            except Exception:
                pass
            time.sleep(1)
        if not appeared:
            # 페이지 안에서 상품속성 anchor로 스크롤(컴포넌트 lazy-load 대비)
            try:
                driver.execute_script("""
                    const el = document.querySelector('#anchor-product-attribute');
                    if (el) el.scrollIntoView({behavior:'instant', block:'start'});
                """)
                time.sleep(5)
            except Exception:
                pass
        # 추가 안정화
        time.sleep(2)

        # JS 추출
        result = driver.execute_script(JS_EXTRACT_CATEGORY_ATTR)
        if not result:
            return {'ok': False, 'err': 'js_returned_null'}
        if not result.get('attrs'):
            # 진단용 HTML 저장
            try:
                dump_dir = '/tmp/category_schema_crawl/_diag'
                os.makedirs(dump_dir, exist_ok=True)
                cat_safe = category_id.replace('>', '_')
                with open(f'{dump_dir}/{cat_safe}.html', 'w', encoding='utf-8') as f:
                    f.write(driver.page_source[:500_000])
                with open(f'{dump_dir}/{cat_safe}.json', 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False, indent=2, default=str)
            except Exception:
                pass
            return {'ok': False, 'err': f'no_attrs (found={result.get("found", 0)})', 'diag': result}
        return {'ok': True, 'data': result}
    except Exception as e:
        return {'ok': False, 'err': str(e)[:200], 'trace': traceback.format_exc()[:500]}
    finally:
        try:
            _safe_quit_driver(driver)
        except Exception:
            pass


def save_to_db(category_id, item, data, now):
    """추출된 카테고리 속성 메타 → smartstore_category_attr_schema 적재.

    - attr#NNN attr_label을 실제 attribute_name 으로 UPDATE
    - 누락된 attribute가 있으면 INSERT (옵션 정보까지)
    """
    attrs = data.get('attrs') or []
    upd_count = 0
    ins_count = 0
    val_label_count = 0

    with connections['myproduct'].cursor() as c:
        for a in attrs:
            aseq = a.get('attribute_seq')
            aname = (a.get('attribute_name') or '').strip()
            if aseq is None:
                continue

            old_label = f'attr#{aseq}'
            new_label = aname or old_label

            # smartstore_category_attr_schema의 attr_key는 sha1(cat_id|type|label)
            # API 크롤은 label='attr#NNN' 으로 저장 → 그 row를 찾아 attr_label만 UPDATE
            c.execute("""
                UPDATE smartstore_category_attr_schema
                SET attr_label = %s,
                    options_json = %s,
                    is_required = %s,
                    last_seen_at = %s
                WHERE category_id = %s AND attr_label = %s
            """, [
                new_label,
                json.dumps([{
                    'value_seq': v.get('value_seq'),
                    'value_label': v.get('value_label'),
                    'is_recommended': v.get('is_recommended'),
                } for v in (a.get('values') or [])], ensure_ascii=False),
                1 if a.get('is_required') else 0,
                now,
                category_id, old_label,
            ])
            if c.rowcount > 0:
                upd_count += c.rowcount

            # value별 별도 row도 추가 (분석 편의)
            for v in (a.get('values') or []):
                vseq = v.get('value_seq')
                vlabel = (v.get('value_label') or '').strip()
                if vseq is None or not vlabel:
                    continue
                # 새로운 attr_key (label = aname / vlabel) 로도 누적
                # smartstore_category_attr_schema 에 (cat, "value:{aname}:{vlabel}") 형태로 추가
                import hashlib
                attr_key = hashlib.sha1(f'{category_id}|select-one|valueOf|{aseq}|{vseq}'.encode('utf-8')).hexdigest()[:32]
                c.execute("""
                    INSERT INTO smartstore_category_attr_schema
                      (category_id, category_text, section, attr_key, attr_label, attr_type,
                       options_json, unit, is_recommended, is_required,
                       first_seen_at, last_seen_at, sample_count)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                      attr_label = VALUES(attr_label),
                      options_json = VALUES(options_json),
                      is_recommended = VALUES(is_recommended),
                      last_seen_at = VALUES(last_seen_at),
                      sample_count = sample_count + 1
                """, [
                    category_id, data.get('category_text') or '',
                    '상품속성',
                    attr_key,
                    f'{aname}:{vlabel}' if aname else vlabel,
                    'value',
                    json.dumps({'attribute_seq': aseq, 'attribute_value_seq': vseq, 'attribute_name': aname}, ensure_ascii=False),
                    None,
                    1 if v.get('is_recommended') else 0,
                    1 if a.get('is_required') else 0,
                    now, now, 1,
                ])
                val_label_count += 1

    return {'upd': upd_count, 'val': val_label_count}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--login-id', default='')
    args = ap.parse_args()

    targets = select_targets(args)
    print(f'[Schema] 카테고리 {len(targets):,}개 크롤')
    if not targets:
        return

    _ensure_display()
    display_env = _get_display_env()

    now = datetime.now()
    ok = fail = 0
    upd_total = val_total = 0
    start = time.time()

    for idx, item in enumerate(targets, 1):
        cat = item['category_id']
        t0 = time.time()
        result = extract_one_category(cat, item, display_env)
        dt = time.time() - t0
        if result.get('ok'):
            stats = save_to_db(cat, item, result['data'], datetime.now())
            ok += 1
            upd_total += stats['upd']
            val_total += stats['val']
            elapsed = time.time() - start
            rate = (ok + fail) / max(elapsed, 0.001)
            eta = (len(targets) - ok - fail) / max(rate, 0.001)
            n_attrs = len(result['data'].get('attrs') or [])
            print(f'  [{idx}/{len(targets)}] cat={cat} OK attrs={n_attrs} upd={stats["upd"]} val={stats["val"]} {dt:.1f}s | {rate:.2f}/s ETA={eta/60:.1f}분')
        else:
            fail += 1
            print(f'  [{idx}/{len(targets)}] cat={cat} FAIL {result.get("err","")[:60]} {dt:.1f}s')

        time.sleep(random.uniform(0.5, 1.5))

    print(f'\n=== DONE === 총 {len(targets)} / OK {ok} / FAIL {fail}')
    print(f'스키마 라벨 UPDATE: {upd_total}  값 row: {val_total}')


if __name__ == '__main__':
    main()
