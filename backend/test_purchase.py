#!/usr/bin/env python3
"""Purchase crawler test v2 - eager strategy + driver.get()"""
import os, time, json, sys
os.environ['DISPLAY'] = ':99'
sys.stdout.reconfigure(line_buffering=True)

import undetected_chromedriver as uc
from selenium.common.exceptions import TimeoutException

CHROME_BIN = '/home/joacham/.local/share/google-chrome/chrome'

print('Starting Chrome (eager)...')
options = uc.ChromeOptions()
options.add_argument('--no-sandbox')
options.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-crash-reporter')
    opts.add_argument('--disable-breakpad')
options.add_argument('--disable-gpu')
options.add_argument('--window-size=1920,1080')
options.page_load_strategy = 'eager'

driver = uc.Chrome(
    options=options,
    browser_executable_path=CHROME_BIN,
    headless=False,
    version_main=145,
    user_data_dir='/home/joacham/projects/naverterms/backend/chrome_profiles/purchase',
)
driver.set_page_load_timeout(20)
print(f'Chrome OK')

url = 'https://search.shopping.naver.com/catalog/85657186892'
print(f'driver.get({url})')

t0 = time.time()
try:
    driver.get(url)
    print(f'Loaded in {time.time()-t0:.1f}s')
except TimeoutException:
    print(f'Timeout after {time.time()-t0:.1f}s (extracting anyway)')
    try:
        driver.execute_script('window.stop();')
    except Exception:
        pass
except Exception as e:
    print(f'Error after {time.time()-t0:.1f}s: {e}')

time.sleep(3)

# Extract data
try:
    raw = driver.execute_script(
        'var e=document.getElementById("__NEXT_DATA__");'
        'return e ? e.textContent : null;'
    )
    if raw:
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
        print('=== FOUND ===')
        for f in ['purchaseCnt', 'reviewCount', 'keepCnt',
                   'totalReviewCount', 'lowPrice', 'mallName', 'productName']:
            vals = find_all(data, f)
            if vals:
                print(f'  {f}: {[str(v)[:50] for v in vals[:3]]}')
        print('SUCCESS')
    else:
        title = driver.execute_script('return document.title || ""')
        body = driver.execute_script('return (document.body||{}).innerText||""')
        url_now = driver.execute_script('return window.location.href')
        print(f'No __NEXT_DATA__')
        print(f'  title: {title}')
        print(f'  url: {url_now}')
        print(f'  body: {body[:200]}')
except Exception as e:
    print(f'Extract error: {e}')

driver.quit()
print('DONE')
