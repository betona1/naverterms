# uc_crawler.py — UC (undetected-chromedriver) 네이버쇼핑 크롤러
import os
import json
import time
import random
import threading
import urllib.parse
import undetected_chromedriver as uc
from django.utils import timezone

# DISPLAY 설정 (Xvfb)
if not os.environ.get('DISPLAY'):
    os.environ['DISPLAY'] = ':0'

TAB_ORDER = ['total', 'model', 'checkout']
TAB_NAME = {'total': '전체', 'model': '가격비교', 'checkout': '네이버페이'}
CHROME_BIN = '/home/joacham/.local/share/google-chrome/chrome'

# ── 전역 상태 ──
_state = {
    'running': False,
    'keywords': [],
    'current_keyword': None,
    'current_tab': None,
    'kw_idx': 0,
    'total_keywords': 0,
    'completed_tabs': 0,
    'total_tabs': 0,
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
    print(f'[UC] {msg}')


def get_status():
    with _lock:
        return {
            'running': _state['running'],
            'keyword': _state['current_keyword'],
            'kwIdx': _state['kw_idx'] + 1,
            'total': _state['total_keywords'],
            'done': _state['kw_idx'] if not _state['running'] else max(0, _state['kw_idx']),
            'steps': _state['completed_tabs'],
            'totalSteps': _state['total_tabs'],
            'captchaPaused': False,
            'logs': list(_state['logs']),
            'error': _state['error'],
        }


def get_logs_since(since_idx):
    with _lock:
        return [l for i, l in enumerate(_state['logs']) if i >= since_idx]


def stop():
    _cancel.set()
    _log('중지 요청')


# ══════════════════════════════════════════
# 데이터 추출
# ══════════════════════════════════════════

def _find_sr(data, depth=0):
    """JSON에서 shoppingResult 찾기"""
    if not data or not isinstance(data, (dict, list)) or depth > 12:
        return None
    if isinstance(data, dict):
        if 'shoppingResult' in data and isinstance(data['shoppingResult'].get('products'), list):
            return data['shoppingResult']
        if 'products' in data and isinstance(data['products'], list) and data['products']:
            p = data['products'][0]
            if isinstance(p, dict) and ('productName' in p or 'productTitle' in p or 'mallName' in p):
                return data
    items = data if isinstance(data, list) else (data.values() if isinstance(data, dict) else [])
    for v in items:
        if isinstance(v, (dict, list)):
            r = _find_sr(v, depth + 1)
            if r:
                return r
    return None


def _extract_next_data(driver):
    """__NEXT_DATA__ 에서 상품 추출"""
    try:
        raw = driver.execute_script(
            "var e=document.getElementById('__NEXT_DATA__');"
            "return e?e.textContent:null;"
        )
        if not raw:
            return None
        data = json.loads(raw)
        pp = data.get('props', {}).get('pageProps')
        if not pp:
            return None

        for target in [pp.get('initialState'), pp.get('dehydratedState'),
                       pp.get('compositeList'), pp]:
            if not target:
                continue
            sr = _find_sr(target)
            if sr:
                return sr
            if isinstance(target, dict) and 'queries' in target:
                for q in target.get('queries', []):
                    sr2 = _find_sr((q.get('state') or {}).get('data'))
                    if sr2:
                        return sr2
    except Exception as e:
        _log(f'  __NEXT_DATA__ 오류: {e}')
    return None


def _extract_cdp(driver):
    """CDP 네트워크 로그에서 상품 추출 (fallback)"""
    try:
        logs = driver.get_log('performance')
        for entry in reversed(logs):
            msg = json.loads(entry['message'])['message']
            if msg['method'] != 'Network.responseReceived':
                continue
            url = msg['params']['response']['url']
            if '/search' not in url or 'query=' not in url:
                continue
            if msg['params']['response']['status'] != 200:
                continue
            try:
                rid = msg['params']['requestId']
                body = driver.execute_cdp_cmd('Network.getResponseBody', {'requestId': rid})
                data = json.loads(body.get('body', '{}'))
                sr = _find_sr(data)
                if sr and sr.get('products'):
                    return sr
            except Exception:
                continue
    except Exception:
        pass
    return None


def _click_exact_search(driver):
    """'만 검색' 버튼 클릭"""
    try:
        return driver.execute_script("""
        var btns = document.querySelectorAll('a, button');
        for (var b of btns) {
            var t = (b.textContent || '').trim();
            if (t.indexOf('만 검색') >= 0 || t.indexOf('만검색') >= 0) {
                b.click(); return true;
            }
        }
        return false;
        """)
    except Exception:
        return False


# ══════════════════════════════════════════
# DB 저장
# ══════════════════════════════════════════

def _save(keyword_text, tab_type, sr):
    from .models import NaverKeyword, NaverSearchSnapshot

    products = sr.get('products', [])[:40]
    total = sr.get('total', 0)
    terms = sr.get('terms', [])
    term_count = sr.get('termCount', 0)
    query = sr.get('query', keyword_text)

    kw, _ = NaverKeyword.objects.get_or_create(keyword=query or keyword_text)
    kw.last_searched_at = timezone.now()

    if terms:
        kw.terms = terms
        kw.term_count = term_count or len(terms)

    if tab_type == 'total':
        kw.total_count = total
    elif tab_type == 'checkout':
        kw.naverpay_count = total
    elif tab_type == 'model':
        kw.price_compare_count = total
    kw.save()

    NaverSearchSnapshot.objects.create(
        keyword=kw, tab_type=tab_type,
        products=products, total=total,
    )
    _log(f'  [{TAB_NAME[tab_type]}] 저장OK — {len(products)}개 total={total}')
    return True


# ══════════════════════════════════════════
# 메인 크롤링
# ══════════════════════════════════════════

def _crawl(keywords, headless=False):
    driver = None
    try:
        _log('Chrome 시작...')
        options = uc.ChromeOptions()
        options.add_argument('--window-size=1920,1080')
        options.add_argument('--disable-gpu')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

        driver = uc.Chrome(
            options=options,
            browser_executable_path=CHROME_BIN,
            headless=headless,
            version_main=145,
        )
        _log('Chrome OK')

        with _lock:
            _state['total_tabs'] = len(keywords) * len(TAB_ORDER)

        completed = 0

        for ki, keyword in enumerate(keywords):
            if _cancel.is_set():
                break

            with _lock:
                _state['kw_idx'] = ki
                _state['current_keyword'] = keyword

            _log(f'[{ki + 1}/{len(keywords)}] "{keyword}"')

            for ti, tab in enumerate(TAB_ORDER):
                if _cancel.is_set():
                    break

                with _lock:
                    _state['current_tab'] = tab

                url = (
                    'https://search.shopping.naver.com/search/all?'
                    f'query={urllib.parse.quote(keyword)}&sort=rel&productSet={tab}'
                )
                _log(f'  [{TAB_NAME[tab]}] 이동')

                try:
                    driver.get(url)
                except Exception as e:
                    _log(f'  [{TAB_NAME[tab]}] 이동실패: {e}')
                    completed += 1
                    with _lock:
                        _state['completed_tabs'] = completed
                    continue

                # 페이지 로드 대기
                time.sleep(3 + random.random() * 2)

                # IP 차단 감지
                try:
                    blocked = driver.execute_script(
                        "return !!document.querySelector('.content_error')"
                    )
                    if blocked:
                        _log(f'  ⚠ 네이버 IP 차단 감지 — 잠시 대기 후 재시도')
                        time.sleep(30 + random.random() * 30)
                        driver.get(url)
                        time.sleep(4 + random.random() * 2)
                        blocked2 = driver.execute_script(
                            "return !!document.querySelector('.content_error')"
                        )
                        if blocked2:
                            _log(f'  [{TAB_NAME[tab]}] IP 차단 지속 — 스킵')
                            completed += 1
                            with _lock:
                                _state['completed_tabs'] = completed
                            continue
                except Exception:
                    pass

                # "만 검색" 버튼
                if _click_exact_search(driver):
                    _log(f'  "만 검색" 클릭')
                    time.sleep(3 + random.random())

                # 데이터 추출 (최대 5회)
                sr = None
                for attempt in range(5):
                    sr = _extract_next_data(driver)
                    if sr and sr.get('products'):
                        break
                    time.sleep(1)

                # fallback: CDP
                if not sr or not sr.get('products'):
                    _log(f'  __NEXT_DATA__ 실패 → CDP 시도')
                    sr = _extract_cdp(driver)

                if sr and sr.get('products'):
                    _log(f'  ★ [{TAB_NAME[tab]}] {len(sr["products"])}개 total={sr.get("total", 0)}')
                    try:
                        _save(keyword, tab, sr)
                    except Exception as e:
                        _log(f'  [{TAB_NAME[tab]}] 저장오류: {e}')
                else:
                    _log(f'  [{TAB_NAME[tab]}] 데이터 없음')

                completed += 1
                with _lock:
                    _state['completed_tabs'] = completed

                # 탭 간 딜레이
                if ti < len(TAB_ORDER) - 1:
                    time.sleep(1.5 + random.random() * 2)

            # 키워드 간 딜레이
            if ki < len(keywords) - 1 and not _cancel.is_set():
                delay = 2 + random.random() * 3
                _log(f'  {delay:.0f}초 대기')
                time.sleep(delay)

        if _cancel.is_set():
            _log('크롤링 중지됨')
        else:
            _log('★ 전체 완료!')

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


def start(keywords, headless=False):
    """크롤링 시작 (백그라운드 스레드)"""
    with _lock:
        if _state['running']:
            return False, '이미 실행중'
        _state.update({
            'running': True,
            'keywords': list(keywords),
            'current_keyword': None,
            'current_tab': None,
            'kw_idx': 0,
            'total_keywords': len(keywords),
            'completed_tabs': 0,
            'total_tabs': len(keywords) * 3,
            'logs': [],
            'error': None,
        })

    _cancel.clear()

    thread = threading.Thread(target=_crawl, args=(keywords, headless), daemon=True)
    thread.start()
    return True, 'started'
