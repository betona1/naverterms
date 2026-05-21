"""
Stage 1: SmartStore 상품속성 디스커버리 (n=100, JSON/HTML/PNG dump only — DB 저장 X)

흐름:
  - 2025-04-01 이후 판매된 SKU에서 카테고리 다양성 우선으로 N개 샘플
  - 로그인 그룹(=같은 사업자) 단위로 1회 로그인 → 스토어별 W코드 처리
  - 각 W코드: 검색 → 수정 진입 → DOM 덤프 → 취소
  - 산출: backend/exports/attr_discovery/{run_ts}/

사용:
  python3 attr_discovery.py --limit 100
  python3 attr_discovery.py --limit 3 --stores netkjy@hanmail.net   # 1개 로그인 빠른 테스트
"""
import os
import sys
import json
import time
import random
import argparse
import traceback
from decimal import Decimal
from datetime import datetime, date


def _json_default(o):
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)


def _dump(obj, fp):
    json.dump(obj, fp, ensure_ascii=False, indent=2, default=_json_default)

import django

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections

from smartstore.store_collector import (
    _create_driver, _login, _close_popups, _switch_store,
    _get_store_list, _ensure_display, _get_display_env,
    _safe_quit_driver, _xtype, _xkey,
)

VALID_ORDER_STATUSES = (
    '고객주문', '신규주문', '배송준비', '입금확인', '배송준비중',
    '배송중', '배송완료', '거래완료', '오더완료',
)
SMARTSTORE_SITE = '04.스마트스토어'
START_DATE = '2025-04-01'

PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"
EDIT_URL_FMT = "https://sell.smartstore.naver.com/#/products/{}"


JS_EXTRACT = r"""
return (function(){
  function txt(el){ return ((el && (el.innerText || el.textContent)) || '').trim(); }
  function getLabel(el){
    if (el.id) {
      const lbl = document.querySelector('label[for="'+CSS.escape(el.id)+'"]');
      if (lbl) return txt(lbl);
    }
    let p = el.closest('label'); if (p) return txt(p);
    p = el.closest('.form-group, [class*="form-group"], [class*="row-form"], [class*="seller-form"], li, tr, dl');
    if (p) {
      const lab = p.querySelector('label, .label, .field-name, .form-name, dt, [class*="title"]');
      if (lab) {
        const t = txt(lab);
        if (t && t.length < 200) return t;
      }
    }
    return '';
  }
  function nearestSection(el){
    let cur = el;
    while (cur && cur.tagName !== 'BODY') {
      const head = cur.querySelector ? cur.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .panel-heading, :scope > .panel-title, :scope > .seller-section-title, :scope > [class*="section-title"]') : null;
      if (head) {
        const t = txt(head);
        if (t && t.length < 80) return t;
      }
      cur = cur.parentElement;
    }
    return '';
  }
  const out = {
    url: location.href,
    title: document.title,
    fields: [],
    sectionTexts: [],
    categoryText: null,
    bodyTextLen: (document.body.innerText||'').length,
  };

  // Section headings (top-level, for orientation)
  document.querySelectorAll('h1, h2, h3, h4, [class*="section-title"], .panel-title, .panel-heading').forEach(h => {
    const t = txt(h);
    if (t && t.length < 80) out.sectionTexts.push(t);
  });

  // Try category breadcrumb
  const allTextNodes = document.querySelectorAll('*');
  for (const e of allTextNodes) {
    if (!e.children || e.children.length === 0) continue;
    const t = (e.innerText || '').trim();
    if (t && t.length < 200 && t.includes('>') && /(잡화|패션|식품|디지털|가구|화장품|스포츠|육아|문구|건강|반려|디지털|뷰티)/.test(t)) {
      out.categoryText = t; break;
    }
  }

  const seen = new Set();
  document.querySelectorAll('input, select, textarea').forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.type === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // skip invisible
      return;
    }
    const tag = el.tagName.toLowerCase();
    const f = {
      tag: tag,
      type: el.type || tag,
      name: el.name || '',
      id: el.id || '',
      label: getLabel(el),
      section: nearestSection(el),
      placeholder: el.placeholder || '',
      disabled: !!el.disabled,
      readonly: !!el.readOnly,
    };
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      f.checked = !!el.checked;
      f.value = el.value || '';
    } else {
      f.value = el.value || '';
    }
    if (tag === 'select') {
      f.options = Array.from(el.options).map(o => ({
        value: o.value, text: (o.text || '').trim(), selected: !!o.selected
      }));
    }
    out.fields.push(f);
  });

  // 추가속성/상품속성 영역의 클릭 가능한 항목 (ul li 등 비-form UI)
  const clickables = [];
  document.querySelectorAll('[ng-click], [class*="attr"], [class*="Attr"]').forEach(el => {
    const t = txt(el);
    if (!t || t.length > 80) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const cls = (el.className || '').toString();
    const active = /selected|active|on\b/i.test(cls);
    clickables.push({
      tag: el.tagName.toLowerCase(),
      class: cls,
      text: t,
      active: active,
      ngClick: el.getAttribute('ng-click') || '',
    });
  });
  out.clickables = clickables.slice(0, 500);

  return out;
})();
"""


def out_dir(run_ts):
    base = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'exports', 'attr_discovery', run_ts,
    )
    os.makedirs(os.path.join(base, 'per_code'), exist_ok=True)
    return base


def select_sample(limit, login_filter=None):
    """2025-04+ 판매상품 중 카테고리 다양성 우선 N개 픽."""
    status_ph = ','.join(['%s'] * len(VALID_ORDER_STATUSES))
    with connections['joacham'].cursor() as c:
        c.execute(
            f"""
            SELECT product_seller_code, SUM(payment_price) amt
            FROM orders_order
            WHERE site_name=%s AND order_date>=%s
              AND order_status IN ({status_ph})
              AND product_seller_code IS NOT NULL AND product_seller_code<>''
            GROUP BY product_seller_code
            """,
            [SMARTSTORE_SITE, START_DATE, *VALID_ORDER_STATUSES],
        )
        sold = dict(c.fetchall())
    if not sold:
        return []

    codes = list(sold.keys())
    items = []
    chunk = 1000
    with connections['myproduct'].cursor() as c:
        for i in range(0, len(codes), chunk):
            sub = codes[i:i + chunk]
            ph = ','.join(['%s'] * len(sub))
            c.execute(
                f"""
                SELECT p.seller_management_code, p.origin_product_no, p.channel_product_no,
                       p.name, p.category_id, p.status_type, p.store_id,
                       s.store_name, s.store_id AS login_id, s.store_pw
                FROM smartstore_product p
                JOIN smartstoreIdList s ON s.id=p.store_id
                WHERE p.seller_management_code IN ({ph})
                  AND p.status_type='SALE'
                  AND s.is_active=1
                """,
                sub,
            )
            for r in c.fetchall():
                if login_filter and r[8] not in login_filter:
                    continue
                items.append({
                    'seller_code': r[0], 'origin_no': r[1], 'channel_no': r[2],
                    'name': r[3], 'category_id': r[4], 'status_type': r[5],
                    'store_pk': r[6], 'store_name': r[7],
                    'login_id': r[8], 'login_pw': r[9],
                    'amount': sold.get(r[0], 0) or 0,
                })

    by_cat = {}
    for it in items:
        by_cat.setdefault(it['category_id'] or '_unknown', []).append(it)
    for v in by_cat.values():
        v.sort(key=lambda x: -(x['amount'] or 0))

    selected = []
    while len(selected) < limit and any(by_cat.values()):
        for cat in list(by_cat):
            if not by_cat[cat]:
                del by_cat[cat]
                continue
            selected.append(by_cat[cat].pop(0))
            if len(selected) >= limit:
                break

    selected.sort(key=lambda x: (x['login_id'], x['store_name']))
    return selected[:limit]


def group_by_login(items):
    g = {}
    for it in items:
        key = it['login_id']
        if key not in g:
            g[key] = {'login_id': key, 'pw': it['login_pw'], 'items': []}
        g[key]['items'].append(it)
    return g


def _click_cancel_or_leave(driver):
    """수정 페이지 → 목록으로 이탈. 변경 없으니 보통 그대로 빠져나감."""
    from selenium.webdriver.common.by import By

    driver.implicitly_wait(0)
    try:
        # 1) "취소" 버튼
        for xp in [
            '//button[normalize-space(text())="취소"]',
            '//a[normalize-space(text())="취소"]',
            '//button[contains(text(),"목록")]',
            '//a[contains(text(),"목록")]',
        ]:
            try:
                els = driver.find_elements(By.XPATH, xp)
                for e in els:
                    if e.is_displayed() and e.is_enabled():
                        driver.execute_script("arguments[0].click();", e)
                        time.sleep(1)
                        break
                else:
                    continue
                break
            except Exception:
                pass

        # 2) 확인 모달 → 예/확인/나가기
        time.sleep(1)
        for xp in [
            '//button[normalize-space(text())="예"]',
            '//button[normalize-space(text())="확인"]',
            '//button[contains(text(),"나가")]',
        ]:
            try:
                els = driver.find_elements(By.XPATH, xp)
                for e in els:
                    if e.is_displayed():
                        driver.execute_script("arguments[0].click();", e)
                        time.sleep(0.5)
                        break
            except Exception:
                pass
    finally:
        driver.implicitly_wait(10)


def goto_list_page(driver):
    """상품목록 페이지로 이동 (항상 강제 reload — 폼 상태 초기화)."""
    driver.get(PRODUCT_LIST_URL)
    time.sleep(5)
    _close_popups(driver)
    time.sleep(2)
    return driver.current_url


def navigate_direct_edit(driver, channel_no, seller_code):
    """채널상품번호로 수정 페이지 직접 진입.

    SPA 라우팅 stale state 방지를 위해:
      1) 일단 dashboard로 이동 (Angular state clear)
      2) edit URL 이동
      3) refresh로 강제 full reload
      4) channel_no가 URL에 포함됐는지 검증
    """
    res = {'ok': False, 'mode': 'direct', 'url': '', 'list_handle': driver.current_window_handle, 'edit_handle': None}
    if not channel_no:
        res['err'] = 'no_channel_no'
        return res

    try:
        url = EDIT_URL_FMT.format(channel_no)
        # 단순 직접 URL — 매 iteration 호출 전에 store re-switch로 dashboard 경유 보장됨
        driver.get(url)
        time.sleep(8.0)
        _close_popups(driver)
        time.sleep(1.5)

        cur = driver.current_url
        if str(channel_no) not in cur:
            res['err'] = f'no_channel_in_url_{cur[-80:]}'
            return res

        # 3) fresh data 검증
        match_check = driver.execute_script("""
            const target = arguments[0];
            const all = document.querySelectorAll('input, [class*="product-no"], [class*="productNo"]');
            for (const el of all) {
                const v = (el.value || el.innerText || el.textContent || '').toString();
                if (v.includes(target)) return {found: true, el: el.tagName + '.' + (el.className||'').slice(0,30)};
            }
            return {found: false};
        """, str(channel_no))

        ic = driver.execute_script("return document.querySelectorAll('input,select,textarea').length")
        if ic < 10:
            time.sleep(3)
            ic = driver.execute_script("return document.querySelectorAll('input,select,textarea').length")
        if ic < 10:
            res['err'] = f'too_few_fields_{ic}'
            return res

        res['url'] = cur
        res['mode'] = 'direct'
        res['match_check'] = match_check
        res['field_count_pre'] = ic
        res['ok'] = True
    except Exception as e:
        res['err'] = f'navigate: {e}'
    return res


def search_and_open_edit(driver, seller_code, display_env):
    """판매자상품코드 검색 → 첫 결과 수정 클릭 → (새 탭/같은 탭) 진입.

    return: dict { ok, mode('new_tab'|'same_tab'|'fail'), url, list_handle, edit_handle }
    """
    from selenium.webdriver.common.by import By

    res = {'ok': False, 'mode': 'fail', 'url': '', 'list_handle': driver.current_window_handle, 'edit_handle': None}

    goto_list_page(driver)

    # 1) 판매자상품코드 라디오 체크
    try:
        radio = driver.find_element(By.XPATH, '//input[@name="searchKeywordType" and @value="SELLER_CODE"]')
        driver.execute_script("arguments[0].click();", radio)
        time.sleep(0.4)
    except Exception as e:
        res['err'] = f'radio: {e}'
        return res

    # 2) 검색어 textarea 클리어 후 입력
    try:
        ta = driver.find_element(By.XPATH, '//textarea[contains(@class,"textarea-vertical")]')
        # 기존 값 제거 (Angular 모델까지)
        driver.execute_script("""
            const el = arguments[0];
            const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            desc.set.call(el, '');
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
        """, ta)
        ta.click()
        time.sleep(0.3)
        _xtype(seller_code, display_env)
        time.sleep(0.4)
    except Exception as e:
        res['err'] = f'textarea: {e}'
        return res

    # 3) 검색 버튼 클릭
    try:
        btn = None
        for xp in [
            '//button[contains(@class,"btn-primary") and normalize-space(.)="검색"]',
            '//button[normalize-space(.)="검색"]',
        ]:
            els = driver.find_elements(By.XPATH, xp)
            for e in els:
                if e.is_displayed():
                    btn = e
                    break
            if btn:
                break
        if not btn:
            res['err'] = 'search_btn_not_found'
            return res
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(3.5)
    except Exception as e:
        res['err'] = f'search_click: {e}'
        return res

    # 4) 결과 첫 행의 수정 버튼
    try:
        edits = driver.find_elements(
            By.XPATH,
            '//div[contains(@class,"ag-row")]//button[normalize-space(.)="수정"]'
        )
        if not edits:
            edits = driver.find_elements(By.XPATH, '//button[contains(@class,"btn-xs") and normalize-space(.)="수정"]')
        # 화면에 보이는 첫 버튼
        target = None
        for e in edits:
            try:
                if e.is_displayed():
                    target = e
                    break
            except Exception:
                pass
        if not target:
            res['err'] = 'no_edit_button'
            return res

        handles_before = set(driver.window_handles)
        driver.execute_script("arguments[0].click();", target)
        time.sleep(5)

        handles_after = set(driver.window_handles)
        new = list(handles_after - handles_before)
        if new:
            driver.switch_to.window(new[0])
            time.sleep(5)
            res['mode'] = 'new_tab'
            res['edit_handle'] = new[0]
        else:
            res['mode'] = 'same_tab'
        _close_popups(driver)
        time.sleep(3)
        res['url'] = driver.current_url
        res['ok'] = True
        return res
    except Exception as e:
        res['err'] = f'edit_click: {e}'
        return res


def extract_one(driver, item, base_dir, display_env):
    code = item['seller_code']
    rec = {
        'seller_code': code,
        'origin_no': item['origin_no'],
        'channel_no': item['channel_no'],
        'name': item['name'],
        'category_id': item['category_id'],
        'store_name': item['store_name'],
        'login_id': item['login_id'],
        'crawled_at': datetime.now().isoformat(),
    }

    per_dir = os.path.join(base_dir, 'per_code')
    code_safe = code.replace('/', '_').replace(' ', '_')
    list_handle = driver.current_window_handle

    edit_state = None
    try:
        # 직접 URL만 사용 (진단 모드 — fallback 제거)
        ch = item.get('channel_no')
        if ch:
            edit_state = navigate_direct_edit(driver, ch, code)
        else:
            edit_state = search_and_open_edit(driver, code, display_env)
        rec['nav'] = {k: v for k, v in edit_state.items() if k not in ('list_handle', 'edit_handle')}
        if not edit_state.get('ok'):
            rec['ok'] = False
            rec['error'] = edit_state.get('err', 'open_edit_failed')
            # 실패 시에도 HTML 저장 (진단용)
            try:
                with open(os.path.join(per_dir, f'{code_safe}_FAIL.html'), 'w', encoding='utf-8') as f:
                    f.write(driver.page_source[:300_000])
            except Exception:
                pass
            try:
                driver.save_screenshot(os.path.join(per_dir, f'{code_safe}_FAIL.png'))
            except Exception:
                pass
            try:
                rec['fail_url'] = driver.current_url
            except Exception:
                pass
            try:
                with open(os.path.join(per_dir, f'{code_safe}.json'), 'w', encoding='utf-8') as f:
                    _dump(rec, f)
            except Exception:
                pass
            return rec

        rec['url'] = edit_state['url']

        # HTML
        try:
            with open(os.path.join(per_dir, f'{code_safe}.html'), 'w', encoding='utf-8') as f:
                f.write(driver.page_source)
        except Exception as e:
            rec['html_err'] = str(e)

        # PNG
        try:
            driver.save_screenshot(os.path.join(per_dir, f'{code_safe}.png'))
        except Exception as e:
            rec['png_err'] = str(e)

        # JS extract
        try:
            data = driver.execute_script(JS_EXTRACT)
            rec['extract'] = data
            rec['field_count'] = len(data.get('fields', [])) if data else 0
            rec['section_count'] = len(data.get('sectionTexts', [])) if data else 0
        except Exception as e:
            rec['extract_error'] = str(e)
            rec['field_count'] = 0

        rec['ok'] = True
    except Exception as e:
        rec['ok'] = False
        rec['error'] = str(e)
        rec['traceback'] = traceback.format_exc()

    # 정리: 모드별 처리
    try:
        mode = edit_state.get('mode') if edit_state else None
        if mode == 'new_tab':
            try:
                driver.close()
            except Exception:
                pass
            try:
                driver.switch_to.window(list_handle)
            except Exception:
                if driver.window_handles:
                    driver.switch_to.window(driver.window_handles[0])
        elif mode == 'direct':
            # 직접 URL 모드: 다음 상품 진입 시 어차피 driver.get(url) 하므로 정리 불필요
            # 단, 변경되지 않은 폼이라도 SPA 라우터 상 dirty 모달 대비
            try:
                driver.execute_script("window.location.hash = '#/home/dashboard';")
                time.sleep(1)
            except Exception:
                pass
        else:
            _click_cancel_or_leave(driver)
            time.sleep(1)
        _close_popups(driver)
        time.sleep(1)
    except Exception:
        pass

    # JSON
    try:
        with open(os.path.join(per_dir, f'{code_safe}.json'), 'w', encoding='utf-8') as f:
            _dump(rec, f)
    except Exception:
        pass
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=100)
    ap.add_argument('--stores', default='', help='쉼표구분 login_id 필터')
    args = ap.parse_args()

    login_filter = [s.strip() for s in args.stores.split(',') if s.strip()] or None

    run_ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    base_dir = out_dir(run_ts)
    log_path = os.path.join(base_dir, 'progress.log')

    def log(msg):
        line = f'[{datetime.now().strftime("%H:%M:%S")}] {msg}'
        print(line, flush=True)
        try:
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except Exception:
            pass

    log(f'run_ts={run_ts}  base_dir={base_dir}')
    sample = select_sample(args.limit, login_filter=login_filter)
    with open(os.path.join(base_dir, 'selected.json'), 'w', encoding='utf-8') as f:
        _dump(sample, f)
    log(f'샘플: {len(sample)}개')

    if not sample:
        log('샘플이 비어있음 → 종료')
        return

    groups = group_by_login(sample)
    log(f'로그인 그룹: {len(groups)}개')
    for lid, g in groups.items():
        stores_in_group = sorted(set(it['store_name'] for it in g['items']))
        log(f'  - {lid}: {len(g["items"])} items / 스토어 {stores_in_group}')

    _ensure_display()
    display_env = _get_display_env()

    all_results = []
    download_dir = f'/tmp/naverterms_attr_discovery/{run_ts}'
    os.makedirs(download_dir, exist_ok=True)

    for lid, group in groups.items():
        log(f'\n=== 로그인: {lid} ({len(group["items"])} items) ===')
        driver = None
        try:
            driver = _create_driver(download_dir)
            ok = _login(driver, lid, group['pw'], display_env)
            if not ok:
                log(f'[FAIL] 로그인 실패: {lid}')
                continue
            _close_popups(driver)
            time.sleep(2)

            # 먼저 list 페이지로 이동 (드롭다운 감지가 list에서 정상 동작)
            goto_list_page(driver)
            time.sleep(2)

            dropdown = _get_store_list(driver)
            multi = bool(dropdown and len(dropdown) > 1)
            log(f'드롭다운 스토어 수: {len(dropdown) if dropdown else 0}, multi={multi}')

            current_store = None
            for idx, item in enumerate(group['items'], 1):
                if multi and item['store_name'] != current_store:
                    sw_ok = _switch_store(driver, item['store_name'])
                    if not sw_ok:
                        log(f'[SKIP] 스토어 전환 실패: {item["store_name"]} (W={item["seller_code"]})')
                        continue
                    current_store = item['store_name']
                    time.sleep(2)
                    goto_list_page(driver)
                    time.sleep(2)
                elif current_store is None:
                    current_store = item['store_name']

                t0 = time.time()
                rec = extract_one(driver, item, base_dir, display_env)
                all_results.append(rec)
                fc = rec.get('field_count', 0)
                ok_str = 'OK' if rec.get('ok') else f'ERR({rec.get("error", "")[:40]})'
                dt = time.time() - t0
                log(f'  [{idx}/{len(group["items"])}] {item["seller_code"]} cat={item["category_id"]} {ok_str} fields={fc} {dt:.1f}s')

                time.sleep(random.uniform(1.5, 3.5))
        except Exception:
            log(traceback.format_exc())
        finally:
            try:
                _safe_quit_driver(driver)
            except Exception:
                pass

        time.sleep(random.uniform(2, 5))

    manifest = {
        'run_ts': run_ts,
        'limit': args.limit,
        'total': len(all_results),
        'success': sum(1 for r in all_results if r.get('ok')),
        'fail': sum(1 for r in all_results if not r.get('ok')),
        'avg_field_count': (
            sum(r.get('field_count', 0) for r in all_results) / max(1, len(all_results))
        ),
        'results': all_results,
    }
    with open(os.path.join(base_dir, 'manifest.json'), 'w', encoding='utf-8') as f:
        _dump(manifest, f)

    log(f'\n=== DONE === total={manifest["total"]} ok={manifest["success"]} fail={manifest["fail"]} avg_fields={manifest["avg_field_count"]:.1f}')
    log(f'manifest: {os.path.join(base_dir, "manifest.json")}')


if __name__ == '__main__':
    main()
