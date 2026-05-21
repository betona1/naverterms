"""
Discovery: 어드민 SPA 가 attribute 라벨/값 매핑을 받아오는 XHR endpoint 추적.

흐름:
  1. 로그인 → 스토어 전환 → 상품 검색 → 수정 페이지 진입
  2. CDP performance log 로 모든 XHR 응답 수집
  3. 응답 본문에 attributeSeq, attributeValueSeq 가 들어있는 URL 만 출력
"""
import os, sys, json, time, re, argparse, traceback
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections
from selenium.webdriver.common.by import By
from smartstore.store_collector import (
    _create_driver, _login, _close_popups, _switch_store,
    _get_store_list, _ensure_display, _get_display_env,
    _safe_quit_driver, _xtype,
)


def make_driver_with_logging(download_dir):
    """selenium 표준 드라이버 + performance/network 로깅."""
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options
    from smartstore.store_collector import CHROME_BIN, _find_chromedriver

    os.makedirs(download_dir, exist_ok=True)

    opts = Options()
    opts.binary_location = CHROME_BIN
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-crash-reporter')
    opts.add_argument('--disable-breakpad')
    opts.add_argument('--disable-blink-features=AutomationControlled')
    opts.add_argument('--window-size=1920,1080')
    opts.add_experimental_option('prefs', {'download.default_directory': download_dir})
    # 핵심: performance 로그 활성화
    opts.set_capability('goog:loggingPrefs', {'performance': 'ALL', 'browser': 'ALL'})

    service = Service(executable_path=_find_chromedriver())
    driver = webdriver.Chrome(service=service, options=opts)
    driver.implicitly_wait(10)
    driver.execute_cdp_cmd('Page.setDownloadBehavior', {
        'behavior': 'allow', 'downloadPath': download_dir,
    })
    driver.execute_cdp_cmd('Network.enable', {})
    return driver


def discover(login_id, store_pw, store_name, seller_code, origin_product_no):
    _ensure_display()
    display_env = _get_display_env()
    download_dir = f'/tmp/discover_attr_api/{int(time.time())}'

    driver = None
    try:
        driver = make_driver_with_logging(download_dir)
        if not _login(driver, login_id, store_pw, display_env):
            print('LOGIN FAILED')
            return
        _close_popups(driver)
        time.sleep(2)

        dropdown = _get_store_list(driver)
        if dropdown and len(dropdown) > 1:
            if not _switch_store(driver, store_name):
                print('STORE SWITCH FAILED')
                return
            time.sleep(2)

        # 직접 edit URL 진입 (로그가 새 탭으로 분산되지 않게)
        edit_url = f'https://sell.smartstore.naver.com/#/products/edit/{origin_product_no}'
        print(f'navigating: {edit_url}')
        driver.get(edit_url)
        time.sleep(10)

        # 상품속성 영역 강제 스크롤 (lazy load 트리거)
        try:
            driver.execute_script("""
                const el = document.querySelector('#anchor-product-attribute');
                if (el) el.scrollIntoView({behavior:'instant', block:'start'});
            """)
        except Exception:
            pass
        time.sleep(8)

        # 캡처 (clear 안 함 — 페이지 로드 중 발생한 모든 XHR 보존)
        events = driver.get_log('performance')
        print(f'captured {len(events)} performance events')

        # responseReceived 이벤트만 필터
        candidates = []
        seen_urls = set()
        for ev in events:
            try:
                msg = json.loads(ev['message'])['message']
            except Exception:
                continue
            if msg.get('method') != 'Network.responseReceived':
                continue
            params = msg.get('params', {})
            req_id = params.get('requestId')
            resp = params.get('response', {})
            url = resp.get('url', '')
            # static asset 제외
            if any(url.endswith(ext) for ext in ('.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.html')):
                continue
            ctype = (resp.get('mimeType') or '').lower()
            # JSON 응답만 (XHR)
            if 'json' not in ctype:
                continue
            candidates.append((req_id, url))
            seen_urls.add(url.split('?')[0])

        print(f'json XHR responses: {len(candidates)} ({len(seen_urls)} unique)')
        # body 가져오기
        hits = []
        for req_id, url in candidates:
            try:
                body = driver.execute_cdp_cmd('Network.getResponseBody', {'requestId': req_id})
                txt = body.get('body', '') or ''
            except Exception:
                continue
            score = 0
            for needle in ('attributeSeq', 'attributeValueSeq', 'categoryAttribute', 'attributeValues'):
                if needle in txt:
                    score += 1
            if score:
                hits.append((url, len(txt), score, txt))

        # score 높은 순
        hits.sort(key=lambda x: (-x[2], -x[1]))

        print(f'\n=== HITS (attribute-keyword 포함 응답): {len(hits)} ===')
        for url, ln, score, body in hits[:8]:
            print(f'\n[score={score} len={ln}] {url}')
            print(f'  body sample: {body[:1500]}')

        # full bodies 저장
        out_dir = f'/tmp/discover_attr_api/_capture_{int(time.time())}'
        os.makedirs(out_dir, exist_ok=True)
        for i, (url, ln, score, body) in enumerate(hits[:30]):
            safe = re.sub(r'[^A-Za-z0-9._-]', '_', url)[-100:]
            with open(f'{out_dir}/{i:02d}_{safe}.json', 'w', encoding='utf-8') as f:
                f.write(body)
        print(f'\n전체 hit body: {out_dir}')

        if not hits:
            print('\n=== NO hits. ALL XHR URLs: ===')
            for _, url in candidates[:120]:
                print(' ', url)

    except Exception as e:
        print('ERROR:', e)
        traceback.print_exc()
    finally:
        if driver:
            _safe_quit_driver(driver)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seller-code', default='WDD7059',
                    help='수정페이지로 들어갈 W코드')
    args = ap.parse_args()

    # 해당 W코드 보유 스토어 자동 검색
    with connections['myproduct'].cursor() as c:
        c.execute("""
            SELECT s.store_id, s.store_pw, s.store_name, l.origin_product_no
            FROM smartstore_attr_crawl_log l
            JOIN smartstoreIdList s ON s.id = l.store_id
            WHERE l.seller_management_code=%s AND l.status='ok'
            LIMIT 1
        """, [args.seller_code])
        row = c.fetchone()
    if not row:
        print(f'no store for {args.seller_code}')
        return
    login_id, store_pw, store_name, opno = row
    print(f'using store: {store_name} ({login_id}) opno={opno}')
    discover(login_id, store_pw, store_name, args.seller_code, opno)


if __name__ == '__main__':
    main()
