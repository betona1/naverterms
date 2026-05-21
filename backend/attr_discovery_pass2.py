"""
Stage 2: 1차 크롤로 적재된 W코드들에 대한 추가 데이터 수집.

처리 대상(per 상품):
  (a) 검색태그 expanded view 캡처 — 메뉴토글 클릭 → chip 텍스트(# 태그 (숫자) ×) 추출
      → smartstore_product_tag.search_volume / tag_raw / search_volume_label / is_standard 채움
  (b) 검색품질 체크 버튼 클릭 → 모달 결과 추출
      → smartstore_product_search_quality 적재

진입은 직접 URL: https://sell.smartstore.naver.com/#/products/edit/{channel_no}
스토어 전환은 1차 크롤과 동일 (드롭다운).

사용:
  python3 attr_discovery_pass2.py            # 1차에서 ok 처리된 모든 W코드
  python3 attr_discovery_pass2.py --limit 5  # 디버깅용
  python3 attr_discovery_pass2.py --stores netkjy@hanmail.net
"""
import os
import re
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
    _safe_quit_driver, _xtype, _xkey,
)


EDIT_URL_FMT = "https://sell.smartstore.naver.com/#/products/edit/{}"
PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"


# ── 검색태그 expanded view 추출 (메뉴토글 클릭 → chip 텍스트) ──
JS_OPEN_TAG_PANEL = r"""
return (function(){
  const sec = document.querySelector('#anchor-tag');
  if (!sec) return {ok:false, reason:'no_anchor_tag'};
  const toggle = sec.querySelector('.set-option a.btn');
  if (!toggle) return {ok:false, reason:'no_toggle'};
  // 이미 펼쳐졌는지 확인 후 없으면 클릭
  const wasOpen = toggle.classList.contains('active');
  if (!wasOpen) toggle.click();
  return {ok:true, wasOpen: wasOpen};
})();
"""

JS_EXTRACT_TAGS = r"""
return (function(){
  function txt(el){ return ((el && (el.innerText || el.textContent)) || '').trim(); }
  const sec = document.querySelector('#anchor-tag');
  if (!sec) return {ok:false, reason:'no_anchor_tag'};
  // 펼친 상태에서 chip이 li/span으로 나타남. set-option 제외하고 inner-content 영역에서 chip 수집
  const chips = [];
  // chip 후보: ng-repeat="tag in vm.searchTags" 같은 패턴
  // 여러 후보 시도
  const candidates = [
    'li[class*="tag"]',
    'span.tag-item',
    '[ng-repeat*="tag"]',
    '.tagit-choice',
    '.input-tag .tag',
    '.tag-input li',
  ];
  let nodes = [];
  for (const sel of candidates) {
    nodes = sec.querySelectorAll(sel);
    if (nodes.length > 0) break;
  }
  // 위 셀렉터가 모두 실패하면, anchor-tag 영역의 모든 li/span을 텍스트로 검사
  if (!nodes.length) {
    nodes = Array.from(sec.querySelectorAll('li, span'))
      .filter(n => /^#\s.+/.test(txt(n)) || /×/.test(txt(n)));
  }

  Array.from(nodes).forEach(n => {
    const t = txt(n);
    if (!t) return;
    chips.push({
      text: t,
      class: (n.className || '').toString(),
      tag: n.tagName.toLowerCase(),
    });
  });

  return {ok:true, count: chips.length, chips: chips, sectionHtml: sec.outerHTML.slice(0, 20000)};
})();
"""


def parse_chip_text(s):
    """'# 저소음 (15128) ×' → ('저소음', 15128, raw, is_standard)
       '# 미니멀시계 ×' → ('미니멀시계', None, raw, False)
    """
    raw = s.strip()
    if not raw:
        return None
    # leading '#' 또는 한글hash
    m = re.match(r'^#\s*(.+?)\s*(?:\((\d+)\))?\s*[×x✕✖]?\s*$', raw)
    if not m:
        return None
    name = m.group(1).strip()
    num = m.group(2)
    return {
        'tag': name,
        'search_volume': int(num) if num else None,
        'search_volume_label': str(num) if num else '숫자없음',
        'is_standard': bool(num),
        'tag_raw': raw,
    }


# ── 검색품질 체크 버튼 클릭 + 모달 추출 ──
# XPath는 사용자 제공 받으면 plug-in. 우선 generic fallback.

JS_CLICK_QUALITY_BUTTON = r"""
return (function(){
  // 버튼 텍스트로 찾기
  const btns = Array.from(document.querySelectorAll('button, a'));
  for (const b of btns) {
    const t = (b.innerText||b.textContent||'').trim();
    if (t === '검색품질 체크' || t === '검색품질체크' || t.includes('검색품질')) {
      const r = b.getBoundingClientRect();
      if (r.width===0 && r.height===0) continue;
      b.click();
      return {ok:true, text:t};
    }
  }
  return {ok:false, reason:'button_not_found'};
})();
"""

JS_EXTRACT_QUALITY_MODAL = r"""
return (function(){
  function txt(el){ return ((el && (el.innerText || el.textContent)) || '').trim(); }
  // 모달: uib-modal-window 또는 .modal-dialog
  const modal = document.querySelector('[uib-modal-window], .modal.in, .modal-dialog');
  if (!modal) return {ok:false, reason:'no_modal'};
  const html = modal.outerHTML.slice(0, 50000);
  // 표 형식 추출
  const rows = [];
  modal.querySelectorAll('tr').forEach(tr => {
    const tds = Array.from(tr.querySelectorAll('td, th')).map(c => txt(c));
    if (tds.length >= 2) rows.push(tds);
  });
  // 비표 형식: dt/dd
  const dl = [];
  modal.querySelectorAll('dt').forEach(dt => {
    const dd = dt.nextElementSibling;
    dl.push([txt(dt), dd ? txt(dd) : '']);
  });
  return {ok:true, rows: rows, dl: dl, html: html, modalText: txt(modal).slice(0, 10000)};
})();
"""

JS_CLOSE_MODAL = r"""
return (function(){
  // 닫기 버튼 클릭 (X 또는 닫기/확인)
  const xpaths_text = ['닫기','확인','X','×'];
  const buttons = Array.from(document.querySelectorAll('button, a'));
  for (const b of buttons) {
    const t = (b.innerText||b.textContent||'').trim();
    const cls = (b.className||'').toLowerCase();
    if (xpaths_text.includes(t) || cls.includes('close')) {
      const r = b.getBoundingClientRect();
      if (r.width===0 && r.height===0) continue;
      const inModal = b.closest('[uib-modal-window], .modal.in, .modal-dialog');
      if (inModal) {
        b.click();
        return {ok:true, text:t};
      }
    }
  }
  return {ok:false};
})();
"""


def parse_quality_rows(rows):
    """모달 행 [['상품명','체크항목 1건','점검필요'], ...] → DB row 형식."""
    items = []
    for r in rows:
        if len(r) < 2:
            continue
        name = (r[0] or '').strip()
        result = (r[1] or '').strip()
        status = (r[2] or '').strip() if len(r) > 2 else ''
        if not name or name in ('항목', '점검 항목'):
            continue
        # input_count, applied_count 파싱
        ic = re.search(r'입력\s*(\d+)\s*건', result)
        ac = re.search(r'검색\s*적용\s*(\d+)\s*건', result)
        items.append({
            'item_name': name,
            'result_text': result[:500],
            'status': status[:32],
            'needs_review': 1 if '점검필요' in status else 0,
            'input_count': int(ic.group(1)) if ic else None,
            'applied_count': int(ac.group(1)) if ac else None,
        })
    return items


def select_targets(limit, login_filter):
    """1차 크롤에서 ok 처리된 W코드만 대상."""
    sql = """
        SELECT DISTINCT l.seller_management_code, l.origin_product_no, l.channel_product_no,
               l.category_id, l.store_id, s.store_id AS login_id, s.store_pw, s.store_name
        FROM smartstore_attr_crawl_log l
        JOIN smartstoreIdList s ON s.id = l.store_id
        WHERE l.status = 'ok'
          AND l.channel_product_no IS NOT NULL AND l.channel_product_no <> ''
        ORDER BY l.crawled_at DESC
    """
    items = []
    with connections['myproduct'].cursor() as c:
        c.execute(sql)
        for r in c.fetchall():
            if login_filter and r[5] not in login_filter:
                continue
            items.append({
                'seller_code': r[0], 'origin_no': r[1], 'channel_no': r[2],
                'category_id': r[3], 'store_pk': r[4],
                'login_id': r[5], 'login_pw': r[6], 'store_name': r[7],
            })
            if limit and len(items) >= limit:
                break
    return items


def group_by_login(items):
    g = {}
    for it in items:
        key = it['login_id']
        if key not in g:
            g[key] = {'login_id': key, 'pw': it['login_pw'], 'items': []}
        g[key]['items'].append(it)
    return g


def process_one(driver, item, display_env, log):
    seller_code = item['seller_code']
    channel_no = item['channel_no']
    cat_id = item['category_id']
    store_id = item['store_pk']
    out = {'tags': None, 'quality': None, 'errors': []}

    try:
        driver.get(EDIT_URL_FMT.format(channel_no))
        time.sleep(6)
        _close_popups(driver)
        time.sleep(2)
    except Exception as e:
        out['errors'].append(f'navigate: {e}')
        return out

    # (a) 태그 패널 펼치기
    try:
        opened = driver.execute_script(JS_OPEN_TAG_PANEL)
        time.sleep(1.5)
        # chip 추출
        if opened and opened.get('ok'):
            tags_data = driver.execute_script(JS_EXTRACT_TAGS)
            if tags_data and tags_data.get('ok'):
                chips = []
                for c in tags_data.get('chips') or []:
                    parsed = parse_chip_text(c.get('text', ''))
                    if parsed:
                        chips.append(parsed)
                out['tags'] = chips
        else:
            out['errors'].append(f'tag_panel: {opened}')
    except Exception as e:
        out['errors'].append(f'tag_extract: {e}')

    # (b) 검색품질 체크
    try:
        clicked = driver.execute_script(JS_CLICK_QUALITY_BUTTON)
        if clicked and clicked.get('ok'):
            time.sleep(3)
            modal = driver.execute_script(JS_EXTRACT_QUALITY_MODAL)
            if modal and modal.get('ok'):
                rows = parse_quality_rows(modal.get('rows') or [])
                out['quality'] = {'rows': rows, 'raw': modal}
            else:
                out['errors'].append(f'quality_modal: {modal}')
            # 닫기
            try:
                driver.execute_script(JS_CLOSE_MODAL)
                time.sleep(1)
            except Exception:
                pass
        else:
            out['errors'].append(f'quality_button: {clicked}')
    except Exception as e:
        out['errors'].append(f'quality: {e}')

    # 적재
    try:
        write_to_db(seller_code, item, out)
    except Exception as e:
        out['errors'].append(f'db_write: {e}')

    return out


def write_to_db(seller_code, item, out):
    now = datetime.now()
    cat_id = item['category_id']
    store_id = item['store_pk']

    with connections['myproduct'].cursor() as c:
        # 태그 UPDATE/INSERT
        for pos, ch in enumerate(out.get('tags') or [], 1):
            c.execute(
                """
                INSERT INTO smartstore_product_tag
                  (seller_management_code, category_id, store_id, tag, position,
                   search_volume, tag_raw, is_standard, search_volume_label, crawled_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  position             = VALUES(position),
                  search_volume        = VALUES(search_volume),
                  tag_raw              = VALUES(tag_raw),
                  is_standard          = VALUES(is_standard),
                  search_volume_label  = VALUES(search_volume_label),
                  crawled_at           = VALUES(crawled_at)
                """,
                [seller_code, cat_id, store_id, ch['tag'], pos,
                 ch['search_volume'], ch['tag_raw'],
                 1 if ch['is_standard'] else 0, ch['search_volume_label'], now],
            )

        # 검색품질 UPSERT (item_name 단위)
        if out.get('quality'):
            for row in out['quality']['rows']:
                c.execute(
                    """
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
                    """,
                    [seller_code, item.get('origin_no'), item.get('channel_no'),
                     cat_id, store_id,
                     row['item_name'], row['result_text'], row['status'],
                     row['needs_review'], row['input_count'], row['applied_count'],
                     json.dumps(row, ensure_ascii=False), now],
                )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='0 = 1차 ok된 전체')
    ap.add_argument('--stores', default='', help='쉼표구분 login_id 필터')
    args = ap.parse_args()

    login_filter = [s.strip() for s in args.stores.split(',') if s.strip()] or None

    items = select_targets(args.limit, login_filter)
    if not items:
        print('대상 없음 — 1차 크롤이 적재되지 않았거나 status=ok 가 없음')
        return

    groups = group_by_login(items)
    print(f'[Pass2] 대상 {len(items)}개 / 로그인 그룹 {len(groups)}개')

    _ensure_display()
    display_env = _get_display_env()
    download_dir = '/tmp/naverterms_pass2'
    os.makedirs(download_dir, exist_ok=True)

    def log(msg):
        print(f'[{datetime.now().strftime("%H:%M:%S")}] {msg}', flush=True)

    for lid, group in groups.items():
        log(f'\n=== 로그인: {lid} ({len(group["items"])} items) ===')
        driver = None
        try:
            driver = _create_driver(download_dir)
            if not _login(driver, lid, group['pw'], display_env):
                log(f'[FAIL] 로그인 실패: {lid}')
                continue
            _close_popups(driver)
            time.sleep(2)
            driver.get(PRODUCT_LIST_URL)
            time.sleep(5)
            _close_popups(driver)

            dropdown = _get_store_list(driver)
            multi = bool(dropdown and len(dropdown) > 1)

            current_store = None
            for idx, item in enumerate(group['items'], 1):
                if multi and item['store_name'] != current_store:
                    if not _switch_store(driver, item['store_name']):
                        log(f'[SKIP] 스토어 전환 실패: {item["store_name"]}')
                        continue
                    current_store = item['store_name']
                    time.sleep(2)
                elif current_store is None:
                    current_store = item['store_name']

                t0 = time.time()
                result = process_one(driver, item, display_env, log)
                tn = len(result.get('tags') or [])
                qn = len((result.get('quality') or {}).get('rows') or [])
                err = ' err=' + str(result.get('errors')[:1]) if result.get('errors') else ''
                log(f'  [{idx}/{len(group["items"])}] {item["seller_code"]} cat={item["category_id"][:30]} tags={tn} quality={qn}{err} {time.time()-t0:.1f}s')

                time.sleep(random.uniform(1.5, 3.0))
        except Exception:
            log(traceback.format_exc())
        finally:
            try:
                _safe_quit_driver(driver)
            except Exception:
                pass

        time.sleep(random.uniform(2, 5))

    print('\n=== Pass2 DONE ===')


if __name__ == '__main__':
    main()
