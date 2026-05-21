# purchase_crawler.py — UC 구매수 추적 크롤러
import os
import json
import time
import random
import threading
import undetected_chromedriver as uc

if not os.environ.get('DISPLAY'):
    os.environ['DISPLAY'] = ':0'

CHROME_BIN = '/home/joacham/.local/share/google-chrome/chrome'

# ── 전역 상태 (uc_crawler와 독립) ──
_state = {
    'running': False,
    'targets': [],
    'current_target': None,
    'idx': 0,
    'total': 0,
    'completed': 0,
    'logs': [],
    'error': None,
}
_lock = threading.Lock()
_cancel = threading.Event()


def _log(msg):
    with _lock:
        _state['logs'].append({'t': int(time.time() * 1000), 'msg': msg})
        if len(_state['logs']) > 300:
            _state['logs'] = _state['logs'][-200:]
    print(f'[PC] {msg}')


def get_status(log_since=0):
    with _lock:
        return {
            'running': _state['running'],
            'current': _state['current_target'],
            'idx': _state['idx'] + 1,
            'total': _state['total'],
            'completed': _state['completed'],
            'logs': [l for i, l in enumerate(_state['logs']) if i >= log_since],
            'error': _state['error'],
        }


def stop():
    _cancel.set()
    _log('중지 요청')


# ══════════════════════════════════════════
# __NEXT_DATA__ 에서 purchaseCnt 추출
# ══════════════════════════════════════════

def _find_purchase_data(data, depth=0):
    """__NEXT_DATA__에서 purchaseCnt 재귀 탐색"""
    if not data or depth > 15:
        return None

    if isinstance(data, dict):
        if 'purchaseCnt' in data:
            pc = data['purchaseCnt']
            if isinstance(pc, str):
                pc = int(pc) if pc.isdigit() else 0
            return {
                'purchase_count': pc,
                'review_count': _int(data.get('reviewCount') or data.get('totalReviewCount') or data.get('reviewCountSum')),
                'keep_count': _int(data.get('keepCnt') or data.get('keepCount')),
                'price': _int(data.get('price') or data.get('lowPrice') or data.get('salePrice')),
            }
        for v in data.values():
            if isinstance(v, (dict, list)):
                r = _find_purchase_data(v, depth + 1)
                if r:
                    return r

    elif isinstance(data, list):
        for item in data:
            if isinstance(item, (dict, list)):
                r = _find_purchase_data(item, depth + 1)
                if r:
                    return r

    return None


def _int(val):
    if val is None:
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return int(val)
    if isinstance(val, str):
        val = val.replace(',', '').strip()
        return int(val) if val.isdigit() else None
    return None


def _extract_detail_data(driver):
    """상품 상세 페이지에서 __NEXT_DATA__ 파싱"""
    try:
        raw = driver.execute_script(
            "var e=document.getElementById('__NEXT_DATA__');"
            "return e?e.textContent:null;"
        )
        if not raw:
            return None
        data = json.loads(raw)
        return _find_purchase_data(data)
    except Exception as e:
        _log(f'  __NEXT_DATA__ 오류: {e}')
    return None


def _extract_dom_purchase(driver):
    """DOM에서 구매건수 텍스트 직접 파싱 (fallback)"""
    try:
        text = driver.execute_script("""
        var els = document.querySelectorAll('[class*="purchase"], [class*="buy"], [class*="order"]');
        for (var el of els) {
            var t = el.textContent || '';
            if (t.indexOf('구매') >= 0) return t;
        }
        var all = document.body.innerText;
        var m = all.match(/구매\\s*([\\d,]+)\\s*건/);
        if (m) return m[0];
        m = all.match(/([\\d,]+)\\s*명이\\s*구매/);
        if (m) return m[0];
        return null;
        """)
        if text:
            import re
            nums = re.findall(r'[\d,]+', text)
            if nums:
                return int(nums[0].replace(',', ''))
    except Exception:
        pass
    return None


# ══════════════════════════════════════════
# 메인 크롤링
# ══════════════════════════════════════════

def _safe_get(driver, url):
    """페이지 이동 — 타임아웃 시에도 __NEXT_DATA__ 추출 시도 가능"""
    from selenium.common.exceptions import TimeoutException
    try:
        driver.get(url)
        return True
    except TimeoutException:
        _log(f'  페이지 로드 타임아웃 (데이터 추출 시도)')
        try:
            driver.execute_script('window.stop();')
        except Exception:
            pass
        return True  # 타임아웃이어도 __NEXT_DATA__는 이미 있을 수 있음
    except Exception as e:
        _log(f'  URL 이동실패: {e}')
        return False


def _crawl(target_list, headless=False):
    driver = None
    try:
        _log('Chrome 시작 (구매수 추적)...')
        options = uc.ChromeOptions()
        options.add_argument('--window-size=1920,1080')
        options.add_argument('--disable-gpu')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-crash-reporter')
    opts.add_argument('--disable-breakpad')
        options.page_load_strategy = 'eager'

        driver = uc.Chrome(
            options=options,
            browser_executable_path=CHROME_BIN,
            headless=headless,
            version_main=145,
        )
        driver.set_page_load_timeout(30)
        _log('Chrome OK')

        for i, target in enumerate(target_list):
            if _cancel.is_set():
                break

            with _lock:
                _state['idx'] = i
                _state['current_target'] = target.product_name

            nv_mid = target.nv_mid
            _log(f'──── [{i + 1}/{len(target_list)}] "{target.product_name}" (nvMid={nv_mid})')

            urls_to_try = [
                f'https://search.shopping.naver.com/catalog/{nv_mid}',
                f'https://search.shopping.naver.com/products/{nv_mid}',
            ]

            result = None
            dom_purchase = None

            for url in urls_to_try:
                if not _safe_get(driver, url):
                    continue

                try:
                    time.sleep(3 + random.random() * 2)

                    # IP 차단 감지
                    blocked = driver.execute_script(
                        "return !!document.querySelector('.content_error')"
                    )
                    if blocked:
                        _log('  IP 차단 감지 — 30초 대기')
                        time.sleep(30 + random.random() * 30)
                        if not _safe_get(driver, url):
                            continue
                        time.sleep(4 + random.random() * 2)

                    # __NEXT_DATA__ 추출 (최대 5회)
                    for attempt in range(5):
                        result = _extract_detail_data(driver)
                        if result and result.get('purchase_count') is not None:
                            break
                        time.sleep(1)

                    # DOM fallback
                    if not result or result.get('purchase_count') is None:
                        dom_purchase = _extract_dom_purchase(driver)

                    if result and result.get('purchase_count') is not None:
                        break
                    if dom_purchase is not None:
                        break

                except Exception as e:
                    _log(f'  추출오류: {e}')

            # DB 저장
            from .models import NaverPurchaseHistory

            if result and result.get('purchase_count') is not None:
                NaverPurchaseHistory.objects.create(
                    target=target,
                    purchase_count=result['purchase_count'],
                    review_count=result.get('review_count'),
                    keep_count=result.get('keep_count'),
                    price=result.get('price'),
                    crawl_success=True,
                )
                _log(f'  ★ 구매수={result["purchase_count"]} 리뷰={result.get("review_count")} 찜={result.get("keep_count")} 가격={result.get("price")}')
            elif dom_purchase is not None:
                NaverPurchaseHistory.objects.create(
                    target=target,
                    purchase_count=dom_purchase,
                    crawl_success=True,
                )
                _log(f'  ★ 구매수={dom_purchase} (DOM 추출)')
            else:
                NaverPurchaseHistory.objects.create(
                    target=target,
                    crawl_success=False,
                    error_message='purchaseCnt 추출 실패',
                )
                _log(f'  ✗ 데이터 추출 실패')

            with _lock:
                _state['completed'] = i + 1

            # 타겟 간 딜레이
            if i < len(target_list) - 1 and not _cancel.is_set():
                delay = 3 + random.random() * 4
                _log(f'  {delay:.0f}초 대기')
                time.sleep(delay)

        if _cancel.is_set():
            _log('구매수 추적 중지됨')
        else:
            _log('★ 구매수 추적 완료!')

    except Exception as e:
        _log(f'오류: {e}')
        with _lock:
            _state['error'] = str(e)
    finally:
        if driver:
            try:
                driver.quit()
                _log('Chrome 종료')
            except Exception:
                pass
        with _lock:
            _state['running'] = False


def start(targets, headless=True):
    """구매수 추적 시작 (백그라운드 스레드)"""
    with _lock:
        if _state['running']:
            return False, '이미 실행중'
        _state.update({
            'running': True,
            'targets': [t.product_name for t in targets],
            'current_target': None,
            'idx': 0,
            'total': len(targets),
            'completed': 0,
            'logs': [],
            'error': None,
        })

    _cancel.clear()
    thread = threading.Thread(target=_crawl, args=(list(targets), headless), daemon=True)
    thread.start()
    return True, 'started'
