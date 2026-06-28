"""
아이템스카우트 판매량 자동수집 스크립트
Windows PC에서 실행 — 매일 11시 50분 Task Scheduler로 구동

필요 패키지:
  pip install selenium requests

Chrome 확장프로그램 경로 설정 필요 (EXTENSION_PATH)
"""

import time
import json
import logging
import requests
from datetime import date, datetime
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# ── 설정 ──────────────────────────────────────────────────────────────
SERVER_URL = "http://172.30.1.93:8900/api/naver"

# Chrome 사용자 데이터 디렉토리 (아이템스카우트 확장프로그램이 설치된 프로필)
# 크롬 주소창에 chrome://version 입력 → "프로필 경로" 확인
CHROME_USER_DATA_DIR = r"C:\Users\김세름\AppData\Local\Google\Chrome\User Data"
CHROME_PROFILE = "Default"  # 또는 Profile 1, Profile 2 등

PRODUCTS = [
    {
        "name": "신지몰 상품",
        "url": "https://smartstore.naver.com/sinjimall_store/products/12075197115",
    },
    {
        "name": "집감성 상품",
        "url": "https://smartstore.naver.com/zipgamsung/products/7883890346",
    },
]

LOG_FILE = Path(__file__).parent / "crawler.log"
# ──────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


def make_driver() -> webdriver.Chrome:
    options = Options()
    options.add_argument(f"--user-data-dir={CHROME_USER_DATA_DIR}")
    options.add_argument(f"--profile-directory={CHROME_PROFILE}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1280,900")
    driver = webdriver.Chrome(options=options)
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    })
    return driver


def extract_today_purchase(driver: webdriver.Chrome, url: str) -> int | None:
    log.info(f"페이지 로딩: {url}")
    driver.get(url)

    # 아이템스카우트 확장프로그램이 데이터를 주입할 때까지 대기
    time.sleep(6)

    # 전략 1: 아이템스카우트가 주입하는 요소에서 "오늘" 텍스트 포함 부모 탐색
    try:
        result = driver.execute_script("""
            // 아이템스카우트 주입 요소 탐색
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
                const cls = (el.className || '').toString().toLowerCase();
                const id = (el.id || '').toString().toLowerCase();
                if (cls.includes('itemscout') || id.includes('itemscout') ||
                    cls.includes('is-') || el.hasAttribute('data-is')) {
                    const text = el.innerText || '';
                    if (text.includes('오늘') || text.includes('구매')) {
                        return {found: true, text: text.substring(0, 500), tag: el.tagName, cls: el.className};
                    }
                }
            }

            // 텍스트로 직접 탐색
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const results = [];
            let node;
            while (node = walker.nextNode()) {
                const t = node.textContent.trim();
                if (t.includes('오늘') && t.length < 50) {
                    const parent = node.parentElement;
                    const sibling = parent ? parent.nextElementSibling : null;
                    results.push({
                        text: t,
                        parentText: parent ? parent.innerText.substring(0, 100) : '',
                        siblingText: sibling ? sibling.innerText.substring(0, 100) : '',
                    });
                }
            }
            return {found: false, candidates: results};
        """)
        log.info(f"DOM 탐색 결과: {json.dumps(result, ensure_ascii=False)[:500]}")

        if result and result.get('found'):
            # 텍스트에서 숫자 추출
            import re
            nums = re.findall(r'\d+', result.get('text', ''))
            if nums:
                # "오늘 구매" 다음에 오는 숫자
                text = result['text']
                idx = max(text.find('오늘'), text.find('구매'))
                after = text[idx:]
                after_nums = re.findall(r'\d+', after)
                if after_nums:
                    val = int(after_nums[0])
                    log.info(f"오늘 구매수: {val}")
                    return val
    except Exception as e:
        log.warning(f"전략1 실패: {e}")

    # 전략 2: 특정 CSS 셀렉터 시도 (아이템스카우트 위젯 공통 패턴)
    selectors = [
        "[class*='todayOrder']",
        "[class*='today-order']",
        "[class*='today_order']",
        "[class*='salesCount']",
        "[class*='sale-count']",
        "[class*='purchaseCount']",
    ]
    import re
    for sel in selectors:
        try:
            els = driver.find_elements(By.CSS_SELECTOR, sel)
            for el in els:
                text = el.text.strip()
                nums = re.findall(r'\d+', text)
                if nums:
                    val = int(nums[0])
                    log.info(f"셀렉터 '{sel}' 매칭: {val}")
                    return val
        except Exception:
            continue

    log.warning(f"오늘 구매수를 찾지 못했습니다: {url}")
    log.warning("스크린샷을 저장합니다: debug_screenshot.png")
    try:
        driver.save_screenshot(str(Path(__file__).parent / "debug_screenshot.png"))
    except Exception:
        pass
    return None


def send_to_server(results: list[dict]) -> bool:
    try:
        resp = requests.post(
            f"{SERVER_URL}/itemscout/records/",
            json={"items": results},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            log.info(f"서버 저장 완료: {data['count']}건")
            return True
        else:
            log.error(f"서버 응답 오류: {resp.status_code} {resp.text}")
            return False
    except Exception as e:
        log.error(f"서버 전송 실패: {e}")
        return False


def main():
    log.info("=" * 50)
    log.info(f"아이템스카우트 수집 시작: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    driver = None
    try:
        driver = make_driver()
        today = date.today().isoformat()
        results = []

        for product in PRODUCTS:
            try:
                count = extract_today_purchase(driver, product["url"])
                if count is not None:
                    results.append({
                        "url": product["url"],
                        "today_purchase": count,
                        "record_date": today,
                    })
                    log.info(f"[완료] {product['name']}: {count}명")
                else:
                    log.warning(f"[실패] {product['name']}: 데이터 없음")
                time.sleep(3)
            except Exception as e:
                log.error(f"[오류] {product['name']}: {e}")

        if results:
            send_to_server(results)
        else:
            log.warning("수집된 데이터가 없습니다")

    except Exception as e:
        log.error(f"크롤러 오류: {e}", exc_info=True)
    finally:
        if driver:
            driver.quit()
        log.info(f"수집 종료: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        log.info("=" * 50)


if __name__ == "__main__":
    main()
