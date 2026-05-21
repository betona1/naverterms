"""
스마트스토어 상품수집 (브라우저 자동화)

셀러센터 로그인 → 상품관리 → 전체 → 엑셀일괄작업 → 상품목록다운로드 → CSV 파싱 → DB
- Xvfb + selenium + xdotool (ai100 VAT 크롤러 패턴)
- 복수 스토어: _gnb_nav 드롭다운 전환
- 백그라운드 쓰레드 (uc_crawler.py 패턴)
"""
import os
import csv
import time
import signal
import shutil
import subprocess
import threading
import tempfile
from datetime import datetime

from django.db import connections

# ── Chrome / Display 설정 ──

def _find_chrome():
    candidates = [
        os.path.expanduser('~/.local/share/google-chrome/chrome'),
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return 'google-chrome'


def _find_chromedriver():
    candidates = [
        os.path.expanduser('~/.local/bin/chromedriver'),
        '/usr/bin/chromedriver',
        '/usr/local/bin/chromedriver',
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return 'chromedriver'


CHROME_BIN = os.environ.get('CHROME_BIN') or _find_chrome()
LOGIN_URL = "https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F%23%2Flogin-callback"
PRODUCT_LIST_URL = "https://sell.smartstore.naver.com/#/products/origin-list?listTab=ALL"

_display = None

# ── 전역 상태 ──

_state = {
    'running': False,
    'store_name': None,
    'store_idx': 0,
    'total_stores': 0,
    'phase': 'idle',
    'progress_pct': 0,
    'logs': [],
    'error': None,
    'last_result': None,
    'csv_files': {},
}
_lock = threading.Lock()
_cancel = threading.Event()


def _log(msg):
    with _lock:
        _state['logs'].append({'t': int(time.time() * 1000), 'msg': msg})
        if len(_state['logs']) > 500:
            _state['logs'] = _state['logs'][-300:]
    print(f'[Collect] {msg}')


def get_status():
    with _lock:
        return {
            'running': _state['running'],
            'store_name': _state['store_name'],
            'store_idx': _state['store_idx'],
            'total_stores': _state['total_stores'],
            'phase': _state['phase'],
            'progress_pct': _state['progress_pct'],
            'logs': list(_state['logs']),
            'error': _state['error'],
            'last_result': _state['last_result'],
            'csv_files': dict(_state['csv_files']),
        }


def get_csv_file(store_name):
    with _lock:
        return _state['csv_files'].get(store_name)


def stop():
    _cancel.set()
    _log('중지 요청됨')


def start(store_ids=None):
    with _lock:
        if _state['running']:
            return False, '이미 수집 중입니다.'
        _state['running'] = True
        _state['phase'] = 'init'
        _state['store_idx'] = 0
        _state['total_stores'] = 0
        _state['progress_pct'] = 0
        _state['logs'] = []
        _state['error'] = None
        _state['last_result'] = None
        _state['csv_files'] = {}

    _cancel.clear()
    t = threading.Thread(target=_collect, args=(store_ids,), daemon=True)
    t.start()
    return True, '수집 시작'


# ── Xvfb / Driver ──

def _ensure_display():
    global _display
    if _display is not None:
        return

    # 기존 DISPLAY 환경변수 확인
    existing = os.environ.get('DISPLAY')
    if existing:
        result = subprocess.run(
            ['xdpyinfo'],
            env={**os.environ, 'DISPLAY': existing},
            capture_output=True, timeout=5,
        )
        if result.returncode == 0:
            return

    # /tmp/.X11-unix 에서 사용 가능한 기존 디스플레이 찾기
    x11_dir = '/tmp/.X11-unix'
    if os.path.isdir(x11_dir):
        for f in sorted(os.listdir(x11_dir)):
            if f.startswith('X'):
                disp = f':' + f[1:]
                result = subprocess.run(
                    ['xdpyinfo'],
                    env={**os.environ, 'DISPLAY': disp},
                    capture_output=True, timeout=3,
                )
                if result.returncode == 0:
                    os.environ['DISPLAY'] = disp
                    _log(f'기존 디스플레이 사용: {disp}')
                    return

    # 새 가상 디스플레이 생성
    try:
        from pyvirtualdisplay import Display
        _display = Display(visible=0, size=(1920, 1080))
        _display.start()
        _log(f'새 Xvfb 디스플레이 생성: {os.environ.get("DISPLAY")}')
    except Exception as e:
        _log(f'Xvfb 시작 실패: {e}')
        os.environ.setdefault('DISPLAY', ':0')


def _get_display_env():
    return os.environ.get('DISPLAY', ':0')


def _create_driver(download_dir):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options

    _ensure_display()

    opts = Options()
    opts.binary_location = CHROME_BIN
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-crash-reporter')
    opts.add_argument('--disable-breakpad')
    opts.add_argument('--disable-blink-features=AutomationControlled')
    opts.add_argument('--window-size=1920,1080')

    prefs = {
        'download.default_directory': download_dir,
        'download.prompt_for_download': False,
        'download.directory_upgrade': True,
        'safebrowsing.enabled': False,
    }
    opts.add_experimental_option('prefs', prefs)

    chromedriver_path = _find_chromedriver()
    service = Service(executable_path=chromedriver_path)
    driver = webdriver.Chrome(service=service, options=opts)
    driver.implicitly_wait(10)

    driver.execute_cdp_cmd('Page.setDownloadBehavior', {
        'behavior': 'allow',
        'downloadPath': download_dir,
    })
    return driver


def _safe_quit_driver(driver):
    if driver is None:
        return
    pids_to_kill = set()
    try:
        cd_pid = driver.service.process.pid
        pids_to_kill.add(cd_pid)
        out = subprocess.check_output(['pgrep', '-P', str(cd_pid)], text=True, stderr=subprocess.DEVNULL)
        for line in out.strip().split('\n'):
            if line.strip():
                pids_to_kill.add(int(line.strip()))
    except Exception:
        pass
    try:
        driver.quit()
    except Exception:
        pass
    time.sleep(0.3)
    for pid in pids_to_kill:
        try:
            os.kill(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass


# ── xdotool 입력 ──

def _xtype(text, display_env):
    env = {**os.environ, 'DISPLAY': display_env}
    subprocess.run(['xclip', '-selection', 'clipboard'],
                   input=text.encode(), check=True, env=env)
    subprocess.run(['xdotool', 'key', 'ctrl+v'], env=env)


def _xkey(key, display_env):
    env = {**os.environ, 'DISPLAY': display_env}
    subprocess.run(['xdotool', 'key', key], env=env)


# ── 로그인 / 스토어 전환 ──

def _login(driver, login_id, login_pw, display_env):
    from selenium.webdriver.common.by import By

    _log(f'로그인 시도: {login_id}')
    with _lock:
        _state['phase'] = 'login'

    driver.get(LOGIN_URL)
    time.sleep(3)

    try:
        id_input = driver.find_element(By.XPATH, '//input[@type="text"]')
        id_input.click()
        time.sleep(0.3)
        _xtype(login_id, display_env)
        time.sleep(0.3)

        pw_input = driver.find_element(By.XPATH, '//input[@type="password"]')
        pw_input.click()
        time.sleep(0.3)
        _xtype(login_pw, display_env)
        time.sleep(0.3)

        _xkey('Return', display_env)
        time.sleep(8)
    except Exception as e:
        _log(f'로그인 입력 실패: {e}')
        return False

    if 'sell.smartstore' in driver.current_url:
        _log('로그인 성공')
        return True

    _log(f'로그인 실패 - URL: {driver.current_url}')
    return False


def _get_store_list(driver):
    from selenium.webdriver.common.by import By

    stores = []
    try:
        store_btn = driver.find_element(By.XPATH, '//*[@id="_gnb_nav"]/ul/li[2]/a')
        store_btn.click()
        time.sleep(3)

        items = driver.find_elements(By.CSS_SELECTOR, 'span[class*="text-title"]')
        for item in items:
            display_name = item.text.strip()
            if display_name:
                clean = display_name.replace('스마트스토어', '').replace('주식회사 ', '').replace('주식회사', '').strip()
                stores.append((display_name, clean))

        try:
            _xkey('Escape', _get_display_env())
        except:
            pass
        time.sleep(1)
    except Exception as e:
        _log(f'스토어 목록 조회 실패: {e}')
    return stores


def _switch_store(driver, target_store_name):
    from selenium.webdriver.common.by import By

    try:
        # 먼저 팝업/모달 닫기
        _close_popups(driver)
        time.sleep(1)

        # 모달이 남아있으면 JS로 강제 제거
        driver.execute_script("""
            document.querySelectorAll('.modal, [uib-modal-window]').forEach(function(el) {
                el.remove();
            });
            document.querySelectorAll('.modal-backdrop').forEach(function(el) {
                el.remove();
            });
        """)
        time.sleep(0.5)

        store_btn = driver.find_element(By.XPATH, '//*[@id="_gnb_nav"]/ul/li[2]/a')
        driver.execute_script("arguments[0].click();", store_btn)
        time.sleep(3)

        items = driver.find_elements(By.CSS_SELECTOR, 'span[class*="text-title"]')
        for item in items:
            if target_store_name in item.text.strip() or item.text.strip() in target_store_name:
                driver.execute_script("arguments[0].click();", item)
                time.sleep(5)
                _close_popups(driver)
                _log(f'스토어 전환: {target_store_name}')
                return True

        _log(f'스토어 "{target_store_name}" 못 찾음')
        try:
            _xkey('Escape', _get_display_env())
        except:
            pass
        return False
    except Exception as e:
        _log(f'스토어 전환 오류: {e}')
        return False


def _close_popups(driver):
    from selenium.webdriver.common.by import By

    # implicit wait 임시 비활성화 (find_elements가 10초씩 대기하는 것 방지)
    driver.implicitly_wait(0)
    time.sleep(0.5)
    close_xpaths = [
        '//button[text()="닫기"]',
        '//button[contains(text(),"닫기")]',
        '//span[text()="하루동안 보지 않기"]/../..//button',
        '//button[contains(@class,"close")]',
        '//button[contains(@class,"_close")]',
    ]
    for xpath in close_xpaths:
        try:
            buttons = driver.find_elements(By.XPATH, xpath)
            for btn in buttons:
                try:
                    driver.execute_script("arguments[0].click();", btn)
                    time.sleep(0.3)
                except:
                    pass
        except:
            pass
    # implicit wait 복원
    driver.implicitly_wait(10)


# ── 상품 다운로드 ──

def _download_product_csv(driver, download_dir):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    with _lock:
        _state['phase'] = 'navigate'

    driver.get(PRODUCT_LIST_URL)
    time.sleep(8)
    _close_popups(driver)

    # 상품 목록 페이지 로딩 대기 (seller-content 내 테이블/리스트 존재 확인)
    wait = WebDriverWait(driver, 30)
    try:
        wait.until(EC.presence_of_element_located((By.ID, 'seller-content')))
        time.sleep(3)
    except:
        _log('seller-content 로딩 타임아웃')

    # "전체" 탭 클릭 (모든 상태 포함 — seller-content 내 상품 상태 탭)
    _log('전체 탭 클릭')
    clicked = False

    # 상품 목록 내 상태 탭 디버깅
    try:
        # seller-content 내부에서만 검색 (GNB 제외)
        seller = driver.find_element(By.ID, 'seller-content')
        inner_tabs = seller.find_elements(By.CSS_SELECTOR, 'ul li a, ul li button')
        tab_texts = []
        for tab in inner_tabs:
            txt = tab.text.strip()
            if txt and len(txt) < 20:
                tab_texts.append(txt)
        if tab_texts:
            _log(f'  seller-content 탭: {tab_texts[:10]}')

        # "전체" + "건" 포함 탭 클릭 (상태 필터 탭: "전체\n9756건")
        for tab in inner_tabs:
            txt = tab.text.strip()
            if '전체' in txt and '건' in txt:
                driver.execute_script("arguments[0].click();", tab)
                clicked = True
                _log(f'  전체 탭 클릭 성공: "{txt.replace(chr(10), " ")}"')
                time.sleep(5)
                break
    except Exception as e:
        _log(f'  seller-content 탭 검색 실패: {e}')

    # 방법2: strong 태그 내 "전체" (이전 성공 패턴)
    if not clicked:
        try:
            seller = driver.find_element(By.ID, 'seller-content')
            strongs = seller.find_elements(By.TAG_NAME, 'strong')
            for s in strongs:
                txt = s.text.strip()
                if '전체' in txt and len(txt) < 15:
                    driver.execute_script("arguments[0].click();", s)
                    clicked = True
                    _log(f'  전체 탭 클릭 성공 (strong): "{txt}"')
                    time.sleep(5)
                    break
        except:
            pass

    # 방법3: 첫 번째 li a (상태 탭에서 첫 번째가 보통 전체)
    if not clicked:
        try:
            seller = driver.find_element(By.ID, 'seller-content')
            # ui-view 내부의 ul/li 구조
            lis = seller.find_elements(By.CSS_SELECTOR, 'ui-view ul li a')
            if lis:
                first_tab = lis[0]
                driver.execute_script("arguments[0].click();", first_tab)
                clicked = True
                _log(f'  첫 번째 ui-view 탭 클릭: "{first_tab.text.strip()}"')
                time.sleep(5)
        except:
            pass

    if not clicked:
        _log('전체 탭 클릭 실패 - 판매중만 다운로드될 수 있음')

    with _lock:
        _state['phase'] = 'download'

    # "엑셀 일괄작업" 드롭다운 클릭
    _log('엑셀 일괄작업 클릭')
    excel_clicked = False

    # 방법1: 텍스트 기반 (가장 안정적)
    try:
        btns = driver.find_elements(By.XPATH,
            '//*[contains(text(), "엑셀") and contains(text(), "일괄")]')
        if not btns:
            btns = driver.find_elements(By.XPATH, '//*[contains(text(), "엑셀")]')
        for btn in btns:
            tag = btn.tag_name.lower()
            txt = btn.text.strip()
            # 너무 긴 텍스트(컨테이너) 제외
            if len(txt) > 30:
                continue
            _log(f'  엑셀 버튼 발견: "{txt}" <{tag}>')
            driver.execute_script("arguments[0].click();", btn)
            excel_clicked = True
            time.sleep(2)
            break
    except:
        pass

    # 방법2: 기존 XPath
    if not excel_clicked:
        try:
            dropdown = wait.until(EC.element_to_be_clickable((
                By.XPATH, '//*[@id="seller-content"]/ui-view/div[3]/ui-view[2]/div[1]/div[1]/div[2]/div/div/div[3]/div[1]'
            )))
            driver.execute_script("arguments[0].click();", dropdown)
            excel_clicked = True
            time.sleep(2)
        except:
            pass

    if not excel_clicked:
        _log('엑셀 일괄작업 버튼 못 찾음')
        return None

    # "상품목록 다운로드" 클릭
    _log('상품목록 다운로드 클릭')
    dl_clicked = False

    # 방법1: 텍스트 기반
    try:
        time.sleep(1)
        options = driver.find_elements(By.XPATH,
            '//*[contains(text(), "상품목록") and contains(text(), "다운로드")]')
        if not options:
            options = driver.find_elements(By.XPATH,
                '//*[contains(text(), "상품목록 다운로드")]')
        for opt in options:
            txt = opt.text.strip()
            if len(txt) > 30:
                continue
            driver.execute_script("arguments[0].click();", opt)
            dl_clicked = True
            time.sleep(2)
            break
    except:
        pass

    # 방법2: option class
    if not dl_clicked:
        try:
            option = wait.until(EC.element_to_be_clickable((
                By.XPATH, '//div[contains(@class, "option") and contains(text(), "상품목록")]'
            )))
            driver.execute_script("arguments[0].click();", option)
            dl_clicked = True
            time.sleep(2)
        except:
            pass

    if not dl_clicked:
        _log('상품목록 다운로드 옵션 못 찾음')
        return None

    # 다운로드 진행률 대기
    _log('다운로드 대기 중...')
    csv_path = _wait_for_download(driver, download_dir, timeout=600)
    return csv_path


def _wait_for_download(driver, download_dir, timeout=600):
    from selenium.webdriver.common.by import By

    start_time = time.time()
    last_pct = 0

    while time.time() - start_time < timeout:
        if _cancel.is_set():
            return None

        # 페이지 내 진행률 확인
        try:
            progress_el = driver.find_element(
                By.XPATH, '//*[@id="main-body"]/div[2]/div/div/div[2]/div/div/div/div')
            text = progress_el.text.strip()
            if '%' in text:
                import re
                m = re.search(r'(\d+)%', text)
                if m:
                    pct = int(m.group(1))
                    if pct != last_pct:
                        last_pct = pct
                        with _lock:
                            _state['progress_pct'] = pct
                        if pct % 20 == 0:
                            _log(f'다운로드 진행: {pct}%')
                    if pct >= 100:
                        time.sleep(3)
                        break
        except:
            pass

        # 파일 시스템 확인
        files = [f for f in os.listdir(download_dir)
                 if f.endswith('.csv') and not f.endswith('.crdownload')]
        if files:
            time.sleep(2)  # 쓰기 완료 대기
            filepath = os.path.join(download_dir, files[0])
            _log(f'CSV 파일 감지: {files[0]}')
            return filepath

        time.sleep(2)

    # 타임아웃이어도 파일 있으면 반환
    files = [f for f in os.listdir(download_dir)
             if f.endswith('.csv') and not f.endswith('.crdownload')]
    if files:
        return os.path.join(download_dir, files[0])

    _log('다운로드 타임아웃')
    return None


# ── CSV 파싱 ──

def _parse_csv(file_path):
    """CSV 파싱 → [{column: value, ...}, ...]"""
    rows = []

    # 인코딩 감지
    for encoding in ['utf-8-sig', 'euc-kr', 'cp949', 'utf-8']:
        try:
            with open(file_path, 'r', encoding=encoding) as f:
                reader = csv.DictReader(f)
                for row in reader:
                    rows.append(row)
            _log(f'CSV 파싱 완료: {len(rows)}행 (encoding={encoding})')
            return rows
        except (UnicodeDecodeError, UnicodeError):
            rows = []
            continue

    _log(f'CSV 인코딩 감지 실패: {file_path}')
    return []


# ── DB 저장 ──

STATUS_MAP = {
    '판매중': 'SALE',
    '판매중지': 'SUSPENSION',
    '품절': 'OUTOFSTOCK',
    '삭제': 'DELETE',
    '판매대기': 'WAIT',
}


def _save_to_db(store_pk, store_name, rows):
    """smartstore_product 테이블에 CSV 데이터 UPDATE (기존 API 상품만, 새 상품 생성 안함)"""
    if not rows:
        return 0

    saved = 0
    with connections['myproduct'].cursor() as cur:
        for row in rows:
            # 기준키: 상품번호(스마트스토어) = origin_product_no
            opn = (row.get('상품번호(스마트스토어)') or row.get('상품번호') or '').strip()
            if not opn:
                continue

            name = (row.get('상품명') or '').strip()
            # CSV "할인가" = 실제 판매가(API salePrice), "판매가" = 할인 전 원가
            sale_price = _parse_price(row.get('할인가', '0') or row.get('판매가', '0'))
            discount_price = _parse_price(row.get('판매가', '0'))
            seller_discount = _parse_price(row.get('판매자할인', '0'))
            status_raw = (row.get('판매상태') or row.get('상품상태') or '').strip()
            status_type = STATUS_MAP.get(status_raw, status_raw)
            display_status = (row.get('전시상태') or '').strip()
            seller_code = (row.get('판매자상품코드') or row.get('판매자 관리코드') or '').strip()
            channel_no = (row.get('네이버쇼핑상품번호(스마트스토어)') or row.get('채널상품번호') or '').strip()
            group_no = (row.get('그룹상품번호') or '').strip()
            stock = _parse_int(row.get('재고수량', '0'))

            # 배송 정보
            delivery_fee_type = (row.get('배송비유형') or '').strip()
            basic_delivery_fee = _parse_price(row.get('기본배송비', '0'))
            return_delivery_fee = _parse_price(row.get('반품배송비', '0'))
            exchange_delivery_fee = _parse_price(row.get('교환배송비', '0'))
            bundle_delivery = (row.get('묶음배송') or '').strip()

            # 카테고리
            category1 = (row.get('대분류') or '').strip()
            category2 = (row.get('중분류') or '').strip()
            category3 = (row.get('소분류') or '').strip()
            category4 = (row.get('세분류') or '').strip()

            # 상품 정보
            manufacturer = (row.get('제조사명') or '').strip()
            brand_name = (row.get('브랜드명') or '').strip()
            model_name = (row.get('모델명') or '').strip()
            naver_shopping_reg = (row.get('네이버쇼핑 등록(스마트스토어)') or '').strip()
            seller_barcode = (row.get('판매자바코드') or '').strip()
            internal_code1 = (row.get('판매자 내부코드1') or '').strip()
            internal_code2 = (row.get('판매자 내부코드2') or '').strip()
            image_url = (row.get('대표이미지 URL') or '').strip()
            registered_at = (row.get('상품등록일') or '').strip()
            last_modified_at = (row.get('최종수정일') or '').strip()

            # 옵션/추가상품 (텍스트)
            options = (row.get('옵션') or '').strip() or None
            additional_products = (row.get('추가상품') or '').strip() or None

            # UPDATE만 (API가 만든 기존 상품만 업데이트, 새 상품 INSERT 안함)
            cur.execute("""
                UPDATE smartstore_product SET
                    channel_product_no = %s,
                    group_product_no = %s,
                    discount_price = %s,
                    seller_discount = %s,
                    display_status = %s,
                    stock_quantity = %s,
                    options = %s,
                    additional_products = %s,
                    delivery_fee_type = %s,
                    basic_delivery_fee = %s,
                    return_delivery_fee = %s,
                    exchange_delivery_fee = %s,
                    bundle_delivery = %s,
                    category1 = %s,
                    category2 = %s,
                    category3 = %s,
                    category4 = %s,
                    manufacturer = %s,
                    brand_name = %s,
                    model_name = %s,
                    naver_shopping_registered = %s,
                    seller_barcode = %s,
                    internal_code1 = %s,
                    internal_code2 = %s,
                    product_image_url = %s,
                    registered_at = %s,
                    last_modified_at = %s,
                    updated_at = NOW()
                WHERE channel_product_no = %s
            """, [
                channel_no or None, group_no or None,
                discount_price, seller_discount,
                display_status, stock,
                options, additional_products,
                delivery_fee_type, basic_delivery_fee, return_delivery_fee,
                exchange_delivery_fee, bundle_delivery,
                category1, category2, category3, category4,
                manufacturer, brand_name, model_name,
                naver_shopping_reg, seller_barcode,
                internal_code1, internal_code2, image_url,
                registered_at or None, last_modified_at or None,
                opn,
            ])
            if cur.rowcount > 0:
                saved += 1

    _log(f'[{store_name}] DB 저장: {saved}건')
    return saved


def _save_collect_log(store_pk, store_name, login_id, total_products, csv_path, error=None):
    """수집 결과를 store_collect_log 테이블에 저장"""
    try:
        with connections['myproduct'].cursor() as cur:
            cur.execute("""
                INSERT INTO store_collect_log
                    (store_id, store_name, login_id, total_products,
                     csv_file_path, status, error_msg, completed_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
            """, [store_pk, store_name, login_id, total_products,
                  csv_path, 'error' if error else 'success', error])
    except Exception as e:
        _log(f'로그 DB 저장 실패: {e}')


def get_collect_logs(limit=20):
    """최근 수집 로그 조회"""
    with connections['myproduct'].cursor() as cur:
        cur.execute("""
            SELECT id, store_id, store_name, login_id, total_products,
                   csv_file_path, status, error_msg, completed_at
            FROM store_collect_log
            ORDER BY id DESC
            LIMIT %s
        """, [limit])
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
    return [dict(zip(cols, r)) for r in rows]


def _parse_price(s):
    import re
    cleaned = re.sub(r'[^\d]', '', str(s).strip())
    return int(cleaned) if cleaned else 0


def _parse_int(s):
    import re
    cleaned = re.sub(r'[^\d\-]', '', str(s).strip())
    return int(cleaned) if cleaned else 0


# ── 메인 수집 쓰레드 ──

def _collect(store_ids):
    """메인 수집 함수 (백그라운드 쓰레드)"""
    driver = None
    try:
        # DB에서 스토어 목록 조회
        stores = _get_stores_from_db(store_ids)
        if not stores:
            _log('수집할 스토어가 없습니다.')
            with _lock:
                _state['error'] = '수집할 스토어가 없습니다.'
            return

        # 로그인 그룹핑 (같은 store_id로 묶기)
        login_groups = _group_stores_by_login(stores)
        total_stores = sum(len(g['stores']) for g in login_groups.values())
        with _lock:
            _state['total_stores'] = total_stores

        _log(f'총 {total_stores}개 스토어 ({len(login_groups)}개 로그인 그룹)')

        # 디스플레이 먼저 확보
        _ensure_display()

        results = {}
        store_idx = 0
        display_env = _get_display_env()

        for login_id, group in login_groups.items():
            if _cancel.is_set():
                break

            password = group['password']
            group_stores = group['stores']

            # 스토어별 다운로드 디렉토리
            download_base = f'/tmp/naverterms_collect/{login_id}_{int(time.time())}'
            os.makedirs(download_base, exist_ok=True)

            # 드라이버 생성 + 로그인
            download_dir = download_base
            driver = _create_driver(download_dir)

            if not _login(driver, login_id, password, display_env):
                _log(f'로그인 실패 → {len(group_stores)}개 스토어 스킵')
                _safe_quit_driver(driver)
                driver = None
                store_idx += len(group_stores)
                with _lock:
                    _state['store_idx'] = store_idx
                continue

            _close_popups(driver)

            # 드롭다운 스토어 목록 확인 (복수 아이디 계정 감지)
            dropdown_stores = _get_store_list(driver)
            if dropdown_stores and len(dropdown_stores) > 1:
                _log(f'드롭다운 스토어: {[s[1] for s in dropdown_stores]}')

            # 각 스토어 수집
            for i, store_info in enumerate(group_stores):
                if _cancel.is_set():
                    break

                store_pk = store_info['pk']
                store_name = store_info['store_name']
                store_idx += 1

                with _lock:
                    _state['store_idx'] = store_idx
                    _state['store_name'] = store_name
                    _state['progress_pct'] = 0

                _log(f'\n=== [{store_idx}/{total_stores}] {store_name} ===')

                # 복수 아이디 그룹: 항상 스토어 전환 (기본 스토어가 다를 수 있음)
                if len(dropdown_stores) > 1:
                    if not _switch_store(driver, store_name):
                        results[store_name] = {'synced': 0, 'error': '스토어 전환 실패'}
                        continue

                # 스토어별 다운로드 디렉토리
                store_dl_dir = os.path.join(download_base, store_name.replace('/', '_'))
                os.makedirs(store_dl_dir, exist_ok=True)

                # CDP로 다운로드 경로 변경
                try:
                    driver.execute_cdp_cmd('Page.setDownloadBehavior', {
                        'behavior': 'allow',
                        'downloadPath': store_dl_dir,
                    })
                except:
                    pass

                # 상품 CSV 다운로드
                csv_path = _download_product_csv(driver, store_dl_dir)
                if not csv_path:
                    results[store_name] = {'synced': 0, 'error': '다운로드 실패'}
                    _save_collect_log(store_pk, store_name, login_id, 0, None, '다운로드 실패')
                    continue

                # CSV 파싱
                with _lock:
                    _state['phase'] = 'parse'
                rows = _parse_csv(csv_path)
                if not rows:
                    results[store_name] = {'synced': 0, 'error': 'CSV 파싱 실패'}
                    _save_collect_log(store_pk, store_name, login_id, 0, csv_path, 'CSV 파싱 실패')
                    continue

                # DB 저장
                with _lock:
                    _state['phase'] = 'save'
                synced = _save_to_db(store_pk, store_name, rows)
                results[store_name] = {'synced': synced, 'file': csv_path}

                # CSV 파일 경로 저장 (다운로드용)
                with _lock:
                    _state['csv_files'][store_name] = csv_path

                # 수집 로그 DB 저장
                _save_collect_log(store_pk, store_name, login_id, synced, csv_path)

            # 드라이버 종료
            _safe_quit_driver(driver)
            driver = None

        # 완료
        with _lock:
            _state['last_result'] = results
            _state['phase'] = 'done'

        _log(f'\n수집 완료: {len(results)}개 스토어')
        for name, r in results.items():
            if 'error' in r:
                _log(f'  {name}: 실패 ({r["error"]})')
            else:
                _log(f'  {name}: {r["synced"]}건 저장')

    except Exception as e:
        _log(f'수집 오류: {e}')
        with _lock:
            _state['error'] = str(e)
    finally:
        if driver:
            _safe_quit_driver(driver)
        with _lock:
            _state['running'] = False
            if _state['phase'] != 'done':
                _state['phase'] = 'error' if _state['error'] else 'done'


def _get_stores_from_db(store_ids=None):
    """smartstoreIdList에서 스토어 목록 조회"""
    with connections['myproduct'].cursor() as cur:
        if store_ids:
            placeholders = ','.join(['%s'] * len(store_ids))
            cur.execute(f"""
                SELECT id, store_id, store_pw, store_name
                FROM smartstoreIdList
                WHERE id IN ({placeholders})
                ORDER BY id
            """, store_ids)
        else:
            cur.execute("""
                SELECT id, store_id, store_pw, store_name
                FROM smartstoreIdList
                ORDER BY id
            """)
        rows = cur.fetchall()

    return [{'pk': r[0], 'login_id': r[1], 'login_pw': r[2], 'store_name': r[3]} for r in rows]


def _group_stores_by_login(stores):
    """login_id(이메일)별로 그룹핑 → {email: {password, stores: [...]}}"""
    groups = {}
    for s in stores:
        login = s['login_id']
        if login not in groups:
            groups[login] = {
                'password': s['login_pw'],
                'stores': [],
            }
        groups[login]['stores'].append({
            'pk': s['pk'],
            'store_name': s['store_name'],
        })
    return groups
