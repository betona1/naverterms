"""
Stage C: 검색품질 체크 결과 UI 크롤.

대상: 2025-04-01 이후 판매된 SALE 상품 (3,257 W코드)

흐름:
  1. 로그인 → 스토어 전환 → list 페이지
  2. 판매자상품코드 검색 → 첫 결과 "수정" 클릭 → 새 탭(edit page)
  3. edit 페이지에서 "검색품질 체크" 버튼 클릭 → 모달 등장
  4. 모달 표 6행(상품명/카테고리/브랜드/제조사/속성/태그) 파싱
  5. smartstore_product_search_quality 적재
  6. 모달 닫기 → 새 탭 닫기 → list 페이지 복귀 → 다음 상품
  7. 연속 실패 시: chrome 재시작 (다른 로그인 또는 같은 로그인 새 세션)

사용:
  python3 search_quality_crawl.py --limit 3
  python3 search_quality_crawl.py --login-id netkjy@hanmail.net
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


VALID_ORDER_STATUSES = (
    '고객주문', '신규주문', '배송준비', '입금확인', '배송준비중',
    '배송중', '배송완료', '거래완료', '오더완료',
)
SMARTSTORE_SITE = '04.스마트스토어'
PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"


# ── 검색품질 체크 버튼 클릭 ──
JS_CLICK_QUALITY_BUTTON = r"""
return (function(){
  // edit 페이지 우상단 또는 본문 안에 있는 "검색품질 체크" 버튼 찾기
  const btns = Array.from(document.querySelectorAll('button, a'));
  for (const b of btns) {
    const t = ((b.innerText||b.textContent)||'').trim();
    if (t === '검색품질 체크' || t === '검색품질체크' || t.includes('검색품질')) {
      const r = b.getBoundingClientRect();
      if (r.width===0 && r.height===0) continue;
      b.scrollIntoView({block:'center'});
      b.click();
      return {ok: true, text: t};
    }
  }
  return {ok: false};
})();
"""

# ── 모달에서 결과 추출 ──
JS_EXTRACT_QUALITY_MODAL = r"""
return (function(){
  function txt(el){ return ((el && (el.innerText || el.textContent)) || '').trim(); }
  // uib-modal-window 또는 .modal.in 또는 .modal-dialog
  let modal = document.querySelector('[uib-modal-window]')
              || document.querySelector('.modal.in')
              || document.querySelector('[class*="modal"][class*="open"]')
              || document.querySelector('.modal-dialog');
  if (!modal) return {ok: false, reason: 'no_modal'};
  const html = modal.outerHTML.slice(0, 80000);
  // 표 행
  const rows = [];
  modal.querySelectorAll('tr').forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th, td')).map(c => txt(c));
    if (cells.length >= 2) rows.push(cells);
  });
  // dt/dd
  const dl = [];
  modal.querySelectorAll('dt').forEach(dt => {
    const dd = dt.nextElementSibling;
    dl.push([txt(dt), dd ? txt(dd) : '']);
  });
  // li 목록 (모달이 표 아니라 list형이면)
  const lis = [];
  modal.querySelectorAll('li').forEach(li => {
    const t = txt(li);
    if (t && t.length < 300) lis.push(t);
  });
  return {ok: true, rows: rows, dl: dl, lis: lis, modalText: txt(modal).slice(0, 10000), html: html};
})();
"""

JS_CLOSE_MODAL = r"""
return (function(){
  const modal = document.querySelector('[uib-modal-window], .modal.in, .modal-dialog');
  if (!modal) return {ok: true, reason: 'no_modal'};
  const closeCandidates = [];
  modal.querySelectorAll('button, a, span').forEach(b => {
    const t = ((b.innerText||b.textContent)||'').trim();
    const cls = (b.className||'').toLowerCase();
    if (t === '닫기' || t === '확인' || t === '×' || t === 'X' || cls.includes('close')) {
      const r = b.getBoundingClientRect();
      if (r.width>0 || r.height>0) closeCandidates.push(b);
    }
  });
  for (const b of closeCandidates) {
    try { b.click(); return {ok: true, text: ((b.innerText||b.textContent)||'').trim()}; } catch(e){}
  }
  return {ok: false};
})();
"""


def parse_quality_result(modal_data):
    """모달 데이터에서 6항목 파싱 (상품명/카테고리/브랜드/제조사/속성/태그).

    모달 표 형식 추정:
      [['항목', '결과', '상태'], ['상품명', '체크항목 1건', '점검필요'], ...]
    """
    import re
    items = []
    rows = modal_data.get('rows') or []
    for r in rows:
        if len(r) < 2:
            continue
        name = (r[0] or '').strip()
        result = (r[1] or '').strip()
        status = (r[2] or '').strip() if len(r) > 2 else ''
        if not name or name in ('항목', '점검 항목'):
            continue
        if name not in ('상품명', '카테고리', '브랜드', '제조사', '속성', '태그'):
            continue

        ic = re.search(r'입력\s*(\d+)\s*건', result)
        ac = re.search(r'검색\s*적용\s*(\d+)\s*건', result)
        items.append({
            'item_name': name,
            'result_text': result[:500],
            'status': status[:32],
            'needs_review': 1 if '점검필요' in status else 0,
            'input_count': int(ic.group(1)) if ic else None,
            'applied_count': int(ac.group(1)) if ac else None,
            'raw': r,
        })
    return items


def select_targets(args):
    where = ["p.status_type='SALE'", "s.is_active=1",
             "p.channel_product_no IS NOT NULL", "p.channel_product_no<>''"]
    params = []
    if args.login_id:
        ids = [x.strip() for x in args.login_id.split(',') if x.strip()]
        if ids:
            ph = ','.join(['%s'] * len(ids))
            where.append(f"s.store_id IN ({ph})")
            params.extend(ids)

    # 2025-04-01 이후 판매된 W코드 조회
    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    with connections['joacham'].cursor() as c:
        c.execute(f"""
            SELECT DISTINCT product_seller_code FROM orders_order
            WHERE site_name=%s AND order_date>='2025-04-01'
              AND order_status IN ({status_ph})
              AND product_seller_code IS NOT NULL AND product_seller_code<>''
        """, [SMARTSTORE_SITE, *VALID_ORDER_STATUSES])
        sold_codes = [r[0] for r in c.fetchall()]
    if not sold_codes:
        return []

    # 청크별 IN 조건
    items = []
    chunk = 1000
    with connections['myproduct'].cursor() as c:
        for i in range(0, len(sold_codes), chunk):
            sub = sold_codes[i:i + chunk]
            ph = ','.join(['%s'] * len(sub))
            w = list(where) + [f"p.seller_management_code IN ({ph})"]
            sql = f"""
                SELECT p.seller_management_code, p.origin_product_no, p.channel_product_no,
                       p.category_id, p.store_id,
                       s.store_id AS login_id, s.store_pw, s.store_name
                FROM smartstore_product p
                JOIN smartstoreIdList s ON s.id=p.store_id
                WHERE {' AND '.join(w)}
            """
            c.execute(sql, params + sub)
            cols = [c.description[i][0] for i in range(len(c.description))]
            for r in c.fetchall():
                items.append(dict(zip(cols, r)))
    if args.limit:
        items = items[:args.limit]
    # 같은 store에 모인 것끼리 그룹핑 (스토어 전환 최소화)
    items.sort(key=lambda x: (x['login_id'], x['store_name']))
    return items


def search_and_click_edit(driver, seller_code, display_env):
    from selenium.webdriver.common.by import By
    driver.get(PRODUCT_LIST_URL)
    time.sleep(6)
    _close_popups(driver)
    time.sleep(2)
    try:
        radio = driver.find_element(By.XPATH, '//input[@name="searchKeywordType" and @value="SELLER_CODE"]')
        driver.execute_script("arguments[0].click();", radio)
        time.sleep(0.4)
        ta = driver.find_element(By.XPATH, '//textarea[contains(@class,"textarea-vertical")]')
        driver.execute_script("""
            const el = arguments[0];
            const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            desc.set.call(el, ''); el.dispatchEvent(new Event('input', {bubbles:true}));
        """, ta)
        ta.click(); time.sleep(0.3); _xtype(seller_code, display_env); time.sleep(0.5)
        btn = next((e for e in driver.find_elements(By.XPATH,
            '//button[contains(@class,"btn-primary") and normalize-space(.)="검색"]') if e.is_displayed()), None)
        if not btn: return False, 'search_btn_not_found', None
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(4)

        edits = driver.find_elements(By.XPATH, '//div[contains(@class,"ag-row")]//button[normalize-space(.)="수정"]')
        if not edits:
            edits = driver.find_elements(By.XPATH, '//button[contains(@class,"btn-xs") and normalize-space(.)="수정"]')
        target = next((e for e in edits if e.is_displayed()), None)
        if not target: return False, 'edit_btn_not_found', None

        before = set(driver.window_handles)
        driver.execute_script("arguments[0].click();", target)
        time.sleep(6)
        after = set(driver.window_handles)
        new = list(after - before)
        if new:
            list_h = driver.current_window_handle
            driver.switch_to.window(new[0])
            time.sleep(7)
            _close_popups(driver)
            time.sleep(2)
            return True, None, list_h
        return True, 'same_tab', driver.current_window_handle
    except Exception as e:
        return False, f'exception: {e}', None


def click_quality_check(driver):
    """검색품질 체크 버튼 → 모달 추출."""
    try:
        clicked = driver.execute_script(JS_CLICK_QUALITY_BUTTON)
        if not clicked.get('ok'):
            return None, 'btn_not_found'
        time.sleep(3)
        modal = driver.execute_script(JS_EXTRACT_QUALITY_MODAL)
        if not modal.get('ok'):
            return None, 'modal_extract_failed'
        # 닫기
        try:
            driver.execute_script(JS_CLOSE_MODAL)
            time.sleep(1)
        except Exception:
            pass
        return modal, None
    except Exception as e:
        return None, f'exc: {e}'


def save_quality(item, modal_data, now):
    """모달 결과 → smartstore_product_search_quality."""
    items = parse_quality_result(modal_data)
    if not items:
        return 0
    seller_code = item['seller_management_code']
    with connections['myproduct'].cursor() as c:
        for r in items:
            c.execute("""
                INSERT INTO smartstore_product_search_quality
                  (seller_management_code, origin_product_no, channel_product_no,
                   category_id, store_id, item_name, result_text, status,
                   needs_review, input_count, applied_count, raw_json, crawled_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  result_text   = VALUES(result_text),
                  status        = VALUES(status),
                  needs_review  = VALUES(needs_review),
                  input_count   = VALUES(input_count),
                  applied_count = VALUES(applied_count),
                  crawled_at    = VALUES(crawled_at)
            """, [
                seller_code, item.get('origin_product_no'), item.get('channel_product_no'),
                item.get('category_id'), item.get('store_id'),
                r['item_name'], r['result_text'], r['status'],
                r['needs_review'], r['input_count'], r['applied_count'],
                json.dumps(r, ensure_ascii=False), now,
            ])
    return len(items)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--login-id', default='')
    ap.add_argument('--max-per-session', type=int, default=10,
                    help='chrome 1세션에서 처리할 최대 상품수 (실패 누적시 재시작)')
    ap.add_argument('--print-every', type=int, default=20)
    args = ap.parse_args()

    targets = select_targets(args)
    print(f'[Quality] 대상 {len(targets)}개')
    if not targets:
        return

    _ensure_display()
    display_env = _get_display_env()

    by_login = {}
    for it in targets:
        by_login.setdefault(it['login_id'], []).append(it)

    now = datetime.now()
    ok = fail = 0
    quality_rows = 0
    start = time.time()

    for lid, group in by_login.items():
        idx = 0
        consecutive_fail = 0
        driver = None
        current_store = None
        login_pw = group[0]['store_pw']

        # session-by-session
        while idx < len(group):
            if driver is None:
                download_dir = f'/tmp/quality_crawl/{lid}_{int(time.time())}'
                os.makedirs(download_dir, exist_ok=True)
                driver = _create_driver(download_dir)
                if not _login(driver, lid, login_pw, display_env):
                    print(f'[FAIL] 로그인 실패 {lid}')
                    _safe_quit_driver(driver); driver = None
                    break
                _close_popups(driver); time.sleep(2)
                # multi-store 감지
                dropdown = _get_store_list(driver)
                multi = bool(dropdown and len(dropdown) > 1)
                consecutive_fail = 0

            item = group[idx]
            t0 = time.time()
            try:
                # 스토어 전환
                if multi and item['store_name'] != current_store:
                    if not _switch_store(driver, item['store_name']):
                        print(f'  [{idx+1}/{len(group)}] {item["seller_management_code"]} SKIP store_switch')
                        idx += 1; consecutive_fail += 1
                        if consecutive_fail >= 3:
                            _safe_quit_driver(driver); driver = None; consecutive_fail = 0
                        continue
                    current_store = item['store_name']; time.sleep(2)
                elif not multi:
                    current_store = item['store_name']

                # 검색→수정
                ok_nav, err, list_h = search_and_click_edit(driver, item['seller_management_code'], display_env)
                if not ok_nav:
                    fail += 1; consecutive_fail += 1
                    print(f'  [{idx+1}/{len(group)}] {item["seller_management_code"]} FAIL nav: {err}')
                    # 새 탭 정리
                    if len(driver.window_handles) > 1:
                        try:
                            for h in driver.window_handles:
                                if h != driver.window_handles[0]:
                                    driver.switch_to.window(h); driver.close()
                            driver.switch_to.window(driver.window_handles[0])
                        except Exception:
                            pass
                    idx += 1
                    if consecutive_fail >= 3:
                        _safe_quit_driver(driver); driver = None; consecutive_fail = 0
                    continue

                # 검색품질 체크
                modal, qerr = click_quality_check(driver)
                if modal:
                    n = save_quality(item, modal, datetime.now())
                    quality_rows += n
                    ok += 1; consecutive_fail = 0
                    if (idx+1) % args.print_every == 0 or idx == 0:
                        elapsed = time.time() - start
                        rate = (ok+fail) / max(elapsed, 0.001)
                        eta = (len(targets) - ok - fail) / max(rate, 0.001)
                        print(f'  [{idx+1}/{len(group)}] {item["seller_management_code"]} OK rows={n} {time.time()-t0:.1f}s | {rate:.2f}/s ETA={eta/60:.1f}분')
                else:
                    fail += 1; consecutive_fail += 1
                    print(f'  [{idx+1}/{len(group)}] {item["seller_management_code"]} FAIL quality: {qerr}')

                # 새 탭 닫기 → list
                try:
                    if list_h and len(driver.window_handles) > 1:
                        if driver.current_window_handle != list_h:
                            driver.close()
                            driver.switch_to.window(list_h)
                    time.sleep(1)
                except Exception:
                    pass

            except Exception as e:
                fail += 1; consecutive_fail += 1
                print(f'  [{idx+1}/{len(group)}] {item["seller_management_code"]} EXC: {e}')

            idx += 1
            time.sleep(random.uniform(1.0, 2.5))

            # max_per_session 도달 또는 연속 실패 → chrome 재시작
            if (idx > 0 and idx % args.max_per_session == 0) or consecutive_fail >= 3:
                _safe_quit_driver(driver); driver = None; consecutive_fail = 0
                current_store = None
                time.sleep(2)

        if driver:
            _safe_quit_driver(driver)

    elapsed = time.time() - start
    print(f'\n=== DONE === 총 {len(targets)} / OK {ok} / FAIL {fail}  품질 row {quality_rows}')
    print(f'경과: {elapsed/60:.1f}분')


if __name__ == '__main__':
    main()
