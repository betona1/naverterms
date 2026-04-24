# http_crawler.py — 경량 HTTP 크롤러 (requests 기반)
# JavaScript 렌더링 불필요: __NEXT_DATA__는 SSR이므로 HTML에 내장됨

import os
import time
import random
import logging
import urllib.parse
import requests as http_requests
from . import crawl_utils

logger = logging.getLogger(__name__)

MOBILE_UAS = [
    'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
]

TAB_ORDER = ['total', 'model', 'checkout']
TAB_NAME = {'total': '전체', 'model': '가격비교', 'checkout': '네이버페이'}


def _get_proxy():
    """환경변수에서 프록시 설정 로드
    NAVER_CRAWL_PROXY=socks5://host:port 또는 http://host:port
    """
    proxy = os.getenv('NAVER_CRAWL_PROXY', '').strip()
    if proxy:
        return {'http': proxy, 'https': proxy}
    return None


def _get_session():
    """쿠키 유지 세션 생성 (모바일 UA 랜덤 + 프록시)"""
    s = http_requests.Session()
    s.headers.update({
        'User-Agent': random.choice(MOBILE_UAS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://search.shopping.naver.com/',
        'Cache-Control': 'no-cache',
    })
    proxies = _get_proxy()
    if proxies:
        s.proxies.update(proxies)
        logger.info(f'[HTTP] 프록시 사용: {proxies["https"][:30]}...')
    return s


def _is_blocked(resp):
    """IP 차단 여부 판단"""
    if resp.status_code in (403, 418):
        return True
    text = resp.text[:5000]
    if 'content_error' in text:
        return True
    if '접속이 일시적으로 제한' in text:
        return True
    if '비정상적인 접근' in text:
        return True
    return False


def fetch_keyword(session, keyword, tab='total'):
    """단일 키워드+탭 HTTP 수집

    반환: shoppingResult dict | {'blocked': True} | None
    """
    url = (
        f'https://search.shopping.naver.com/search/all?'
        f'query={urllib.parse.quote(keyword)}&sort=rel&productSet={tab}'
    )
    try:
        resp = session.get(url, timeout=15, allow_redirects=True)

        if _is_blocked(resp):
            logger.warning(f'[HTTP] IP 차단 감지: "{keyword}" [{tab}]')
            return {'blocked': True}

        if resp.status_code != 200:
            logger.warning(f'[HTTP] 상태코드 {resp.status_code}: "{keyword}" [{tab}]')
            return None

        sr = crawl_utils.parse_next_data(resp.text)
        if sr and sr.get('products'):
            return sr

        logger.info(f'[HTTP] __NEXT_DATA__ 파싱 실패: "{keyword}" [{tab}]')
        return None

    except http_requests.exceptions.Timeout:
        logger.warning(f'[HTTP] 타임아웃: "{keyword}" [{tab}]')
        return None
    except Exception as e:
        logger.error(f'[HTTP] 요청 오류: "{keyword}" [{tab}] — {e}')
        return None


def crawl_keywords(keywords, tabs=None, on_progress=None):
    """다중 키워드 순차 수집

    on_progress(event_type, data): 콜백
      event_type: 'start', 'saved', 'empty', 'blocked', 'done'

    반환: {
        'results': [{'keyword', 'tab', 'count', 'terms'}],
        'blocked': bool,
        'method': 'http',
    }
    """
    if tabs is None:
        tabs = TAB_ORDER
    session = _get_session()
    results = []
    blocked = False

    if on_progress:
        on_progress('start', {'total_keywords': len(keywords), 'total_tabs': len(keywords) * len(tabs)})

    for ki, keyword in enumerate(keywords):
        keyword_blocked = False

        for ti, tab in enumerate(tabs):
            sr = fetch_keyword(session, keyword, tab)

            if sr and sr.get('blocked'):
                blocked = True
                keyword_blocked = True
                if on_progress:
                    on_progress('blocked', {'keyword': keyword, 'tab': tab, 'ki': ki})
                break

            if sr and sr.get('products'):
                kw = crawl_utils.save_search_result(keyword, tab, sr, source='http')
                entry = {
                    'keyword': keyword,
                    'tab': tab,
                    'count': len(sr.get('products', [])),
                    'terms': sr.get('terms', []),
                    'total': sr.get('total', 0),
                    'keyword_id': kw.id,
                }
                results.append(entry)
                if on_progress:
                    on_progress('saved', entry)
            else:
                if on_progress:
                    on_progress('empty', {'keyword': keyword, 'tab': tab})

            # 탭 간 딜레이 (2~4초 — 느리게)
            if ti < len(tabs) - 1:
                time.sleep(2 + random.random() * 2)

        if blocked:
            break

        # 키워드 간 딜레이 (5~10초 — 느리게)
        if ki < len(keywords) - 1 and not keyword_blocked:
            time.sleep(5 + random.random() * 5)

    if on_progress:
        on_progress('done', {'results': len(results), 'blocked': blocked})

    return {'results': results, 'blocked': blocked, 'method': 'http'}
