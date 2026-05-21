"""
Stage 1a: 상품목록 페이지 DOM 디스커버리.
1회 로그인 → /#/products/origin-list 진입 → HTML+PNG 덤프 +
검색 관련 요소(select/input/button)와 GNB(_gnb_nav) 구조 추출.
"""
import os
import sys
import json
import time
import argparse
from datetime import datetime

import django

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections

from smartstore.store_collector import (
    _create_driver, _login, _close_popups,
    _ensure_display, _get_display_env, _safe_quit_driver,
)


PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"


JS_PROBE = r"""
return (function(){
  function txt(el){ return ((el && (el.innerText || el.textContent)) || '').trim(); }
  function rectVisible(el){
    const r = el.getBoundingClientRect();
    return !(r.width===0 && r.height===0);
  }
  function describe(el){
    if (!el) return null;
    const cls = (el.className || '').toString();
    const id = el.id || '';
    let path = el.tagName.toLowerCase();
    if (id) path += '#' + id;
    if (cls) path += '.' + cls.split(/\s+/).filter(Boolean).slice(0,3).join('.');
    return {
      tag: el.tagName.toLowerCase(),
      id: id,
      class: cls,
      path: path,
      attrs: Array.from(el.attributes||[]).reduce((a,x)=>{a[x.name]=x.value; return a;}, {}),
      text: txt(el).slice(0, 200),
      placeholder: el.placeholder || '',
    };
  }
  function ancestors(el, n){
    const out = []; let c = el && el.parentElement;
    while (c && out.length < n) { out.push(describe(c)); c = c.parentElement; }
    return out;
  }

  const out = {
    url: location.href, title: document.title,
    bodyTextLen: (document.body.innerText||'').length,
    sectionTexts: [],
    selects: [], inputs: [], buttons: [], links: [],
    gnb: null,
    storeDropdownItems: [],
    h1h4: [],
  };

  document.querySelectorAll('h1,h2,h3,h4').forEach(h => {
    const t = txt(h); if (t && t.length<120) out.h1h4.push(t);
  });

  document.querySelectorAll('[class*="section"], [class*="title"], .panel-heading, .panel-title').forEach(h => {
    const t = txt(h); if (t && t.length<60 && t.length>1) out.sectionTexts.push(t);
  });
  out.sectionTexts = Array.from(new Set(out.sectionTexts)).slice(0, 60);

  // SELECTs (검색 구분)
  document.querySelectorAll('select').forEach(sel => {
    if (!rectVisible(sel)) return;
    const opts = Array.from(sel.options).map(o => ({value:o.value, text:(o.text||'').trim(), selected:o.selected}));
    out.selects.push({
      ...describe(sel),
      ancestorPath: ancestors(sel, 4),
      options: opts,
    });
  });

  // INPUTs (검색어)
  document.querySelectorAll('input').forEach(inp => {
    if (inp.type === 'hidden' || !rectVisible(inp)) return;
    if (!['text','search','number',''].includes((inp.type||'').toLowerCase())) return;
    out.inputs.push({
      ...describe(inp),
      type: inp.type,
      ancestorPath: ancestors(inp, 4),
    });
  });

  // BUTTONs containing 검색/조회
  document.querySelectorAll('button, a').forEach(b => {
    if (!rectVisible(b)) return;
    const t = txt(b);
    if (!t) return;
    if (/(검색|조회|찾기|수정|상세|등록|편집)/.test(t) && t.length < 30) {
      out.buttons.push({...describe(b), text: t});
    }
  });

  // 결과 행 후보: 목록 테이블 row의 수정/상세 액션
  document.querySelectorAll('a, button').forEach(a => {
    if (!rectVisible(a)) return;
    const t = txt(a);
    if (t === '수정' || t === '복사' || t === '미리보기') {
      const tr = a.closest('tr, [class*="row"], [class*="list-item"]');
      out.links.push({...describe(a), nearestRow: describe(tr)});
    }
  });

  // GNB
  const gnb = document.querySelector('#_gnb_nav');
  if (gnb) {
    out.gnb = {
      html: gnb.outerHTML.slice(0, 8000),
      itemCount: gnb.querySelectorAll('li').length,
    };
  }

  // 스토어 드롭다운 후보 (이미 열려있지 않으니 click 없이 추정)
  // _gnb_nav > ul > li[2] > a 가 store 버튼이라는 기존 코드의 가정 검증
  if (gnb) {
    const lis = gnb.querySelectorAll(':scope > ul > li');
    out.gnbTopLi = Array.from(lis).map(li => {
      const a = li.querySelector('a');
      return { text: txt(a||li).slice(0,80), href: a ? a.getAttribute('href') : '', html: li.outerHTML.slice(0, 1000) };
    });
  }

  // 페이지 안에 노출돼있는 스토어명 텍스트 후보
  const storeTextHits = [];
  document.querySelectorAll('span, a, div').forEach(e => {
    if (!rectVisible(e)) return;
    const t = txt(e);
    if (t && t.length < 60 && /(스마트스토어|비투나|조아|비트|나인|이로워|이처럼|행원)/.test(t)) {
      storeTextHits.push({...describe(e), text: t});
    }
  });
  out.storeTextHits = storeTextHits.slice(0, 30);

  return out;
})();
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--login', default='netkjy@hanmail.net')
    args = ap.parse_args()

    run_ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    base_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'exports', 'attr_discovery', f'probe_{run_ts}',
    )
    os.makedirs(base_dir, exist_ok=True)

    with connections['myproduct'].cursor() as c:
        c.execute(
            "SELECT store_id, store_pw FROM smartstoreIdList WHERE store_id=%s AND is_active=1 LIMIT 1",
            [args.login],
        )
        r = c.fetchone()
    if not r:
        print(f'로그인 정보 없음: {args.login}')
        return

    login_id, login_pw = r

    print(f'[probe] login={login_id} run_ts={run_ts}')
    _ensure_display()
    display_env = _get_display_env()

    download_dir = f'/tmp/naverterms_probe/{run_ts}'
    os.makedirs(download_dir, exist_ok=True)

    driver = None
    try:
        driver = _create_driver(download_dir)
        ok = _login(driver, login_id, login_pw, display_env)
        if not ok:
            print('[FAIL] 로그인 실패')
            return
        _close_popups(driver)
        time.sleep(2)

        print(f'[probe] 로그인 후 URL: {driver.current_url}')

        # 명시적으로 origin-list로 이동
        driver.get(PRODUCT_LIST_URL)
        time.sleep(8)
        _close_popups(driver)
        time.sleep(3)

        print(f'[probe] origin-list URL: {driver.current_url}')

        # HTML + PNG
        with open(os.path.join(base_dir, 'list.html'), 'w', encoding='utf-8') as f:
            f.write(driver.page_source)
        try:
            driver.save_screenshot(os.path.join(base_dir, 'list.png'))
        except Exception as e:
            print(f'screenshot err: {e}')

        # JS probe
        try:
            data = driver.execute_script(JS_PROBE)
            with open(os.path.join(base_dir, 'list_probe.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f'[probe] list 페이지: selects={len(data.get("selects",[]))} inputs={len(data.get("inputs",[]))} 검색버튼={len(data.get("buttons",[]))} 수정링크={len(data.get("links",[]))}')
            print(f'  sectionTexts(샘플): {data.get("sectionTexts",[])[:10]}')
            print(f'  h1h4: {data.get("h1h4",[])[:10]}')
        except Exception as e:
            print(f'JS probe err: {e}')

        # GNB 드롭다운 열어 store list 확인
        try:
            from selenium.webdriver.common.by import By
            store_btn = driver.find_element(By.XPATH, '//*[@id="_gnb_nav"]/ul/li[2]/a')
            driver.execute_script("arguments[0].click();", store_btn)
            time.sleep(3)
            with open(os.path.join(base_dir, 'gnb_open.html'), 'w', encoding='utf-8') as f:
                f.write(driver.page_source)
            try:
                driver.save_screenshot(os.path.join(base_dir, 'gnb_open.png'))
            except Exception:
                pass

            # 드롭다운 안의 스토어명 후보 추출
            data2 = driver.execute_script(r"""
                const items = [];
                document.querySelectorAll('span, a, li, div').forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width===0 && r.height===0) return;
                    const t = ((el.innerText||el.textContent)||'').trim();
                    if (t && t.length<60 && t.length>1) {
                        const cls = (el.className||'').toString();
                        const id = el.id||'';
                        if (/store|nav|gnb|account/i.test(cls+id) || /(스마트스토어|비투나|조아|비트|나인|이로워|이처럼|행원|나경)/.test(t)) {
                            items.push({tag:el.tagName.toLowerCase(), id:id, class:cls, text:t});
                        }
                    }
                });
                return items.slice(0, 80);
            """)
            with open(os.path.join(base_dir, 'gnb_open_items.json'), 'w', encoding='utf-8') as f:
                json.dump(data2, f, ensure_ascii=False, indent=2)
            print(f'[probe] gnb 드롭다운: {len(data2)} 후보')
            for it in data2[:15]:
                print(f'  - <{it["tag"]} class="{it["class"][:40]}"> {it["text"][:50]}')
        except Exception as e:
            print(f'gnb open err: {e}')

        print(f'\n[probe] DONE → {base_dir}')
    finally:
        try:
            _safe_quit_driver(driver)
        except Exception:
            pass


if __name__ == '__main__':
    main()
