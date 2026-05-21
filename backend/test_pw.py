#!/usr/bin/env python3
"""Playwright-based purchase count extraction test"""
import json, sys, time
sys.stdout.reconfigure(line_buffering=True)

from playwright.sync_api import sync_playwright

CHROME_BIN = '/home/joacham/.local/share/google-chrome/chrome'

print('Starting Playwright...')
pw = sync_playwright().start()

browser = pw.chromium.launch(
    executable_path=CHROME_BIN,
    headless=True,
    args=['--no-sandbox', '--disable-dev-shm-usage'],
)
page = browser.new_page()
print('Browser OK')

nvmids = ['85657186892', '83464507300']

for nvmid in nvmids:
    url = f'https://search.shopping.naver.com/catalog/{nvmid}'
    print(f'\n=== nvMid={nvmid} ===')
    print(f'GET {url}')

    t0 = time.time()
    try:
        page.goto(url, timeout=20000, wait_until='domcontentloaded')
        print(f'Loaded in {time.time()-t0:.1f}s')
    except Exception as e:
        print(f'Timeout/Error after {time.time()-t0:.1f}s: {str(e)[:80]}')

    time.sleep(2)

    # __NEXT_DATA__ 추출
    try:
        nd_el = page.query_selector('#__NEXT_DATA__')
        if nd_el:
            raw = nd_el.text_content()
            data = json.loads(raw)
            def find_all(d, key, depth=0):
                if depth > 15: return []
                r = []
                if isinstance(d, dict):
                    if key in d: r.append(d[key])
                    for v in d.values():
                        if isinstance(v, (dict, list)):
                            r.extend(find_all(v, key, depth + 1))
                elif isinstance(d, list):
                    for item in d:
                        if isinstance(item, (dict, list)):
                            r.extend(find_all(item, key, depth + 1))
                return r

            for f in ['purchaseCnt', 'reviewCount', 'keepCnt',
                       'totalReviewCount', 'lowPrice', 'price', 'mallName']:
                vals = find_all(data, f)
                if vals:
                    print(f'  {f}: {[str(v)[:50] for v in vals[:3]]}')
        else:
            title = page.title()
            body = page.text_content('body') or ''
            print(f'  No __NEXT_DATA__, title={title}')
            print(f'  body: {body[:200]}')
    except Exception as e:
        print(f'  Extract error: {e}')

    time.sleep(2)

browser.close()
pw.stop()
print('\nDONE')
