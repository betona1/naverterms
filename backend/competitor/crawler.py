import json
import os
import re
import time
import random
import requests

NAVER_SHOP_API = 'https://openapi.naver.com/v1/search/shop.json'
MOBILE_UA = (
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0.0.0 Mobile Safari/537.36'
)


def parse_product_no_from_url(url: str):
    m = re.search(r'/products/(\d+)', url)
    return m.group(1) if m else ''


def parse_store_alias_from_url(url: str):
    m = re.search(r'smartstore\.naver\.com/([^/?#]+)', url)
    return m.group(1) if m else ''


def _find(obj, key, depth=0):
    """__NEXT_DATA__ 재귀 탐색"""
    if depth > 15 or not obj:
        return None
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = _find(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = _find(item, key, depth + 1)
            if r is not None:
                return r
    return None


def fetch_smartstore_page(url: str):
    """스마트스토어 상품 페이지에서 __NEXT_DATA__ 파싱"""
    headers = {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Referer': 'https://m.naver.com/',
        'Cache-Control': 'max-age=0',
    }
    # URL 정규화 (쿼리스트링 제거)
    url_clean = re.sub(r'\?.*$', '', url.rstrip('/'))

    for attempt in range(3):
        try:
            resp = requests.get(url_clean, headers=headers, timeout=15, allow_redirects=True)
            resp.raise_for_status()
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', resp.text, re.DOTALL)
            if not m:
                return None, '__NEXT_DATA__ 없음'
            data = json.loads(m.group(1))

            product_name = _find(data, 'name')
            if product_name and not isinstance(product_name, str):
                product_name = None

            # 가격
            price = None
            for key in ('salePrice', 'discountedSalePrice', 'price'):
                v = _find(data, key)
                if v and isinstance(v, (int, float)) and v > 0:
                    price = int(v)
                    break

            # purchaseCount (누적), recentPurchaseCount (오늘)
            purchase_count = _find(data, 'purchaseCount')
            recent_purchase_count = _find(data, 'recentPurchaseCount')
            review_count = _find(data, 'reviewCount')

            if purchase_count is not None:
                purchase_count = int(purchase_count)
            if recent_purchase_count is not None:
                recent_purchase_count = int(recent_purchase_count)
            if review_count is not None:
                review_count = int(review_count)

            return {
                'product_name': product_name or '',
                'price': price,
                'purchase_count': purchase_count,
                'recent_purchase_count': recent_purchase_count,
                'review_count': review_count,
            }, None

        except requests.HTTPError as e:
            if e.response.status_code in (403, 429) and attempt < 2:
                time.sleep(2 ** attempt * 2)
                continue
            return None, f'HTTP {e.response.status_code}'
        except Exception as e:
            if attempt < 2:
                time.sleep(1.5)
                continue
            return None, str(e)

    return None, '재시도 초과'


def _get_api_keys():
    client_id = os.getenv('NAVER_SEARCH_CLIENT_ID', '')
    client_secret = os.getenv('NAVER_SEARCH_CLIENT_SECRET', '')
    return client_id, client_secret


def _naver_search(keyword: str, display: int = 100) -> list:
    client_id, client_secret = _get_api_keys()
    if not client_id:
        raise ValueError('NAVER_SEARCH_CLIENT_ID 미설정')
    resp = requests.get(NAVER_SHOP_API, params={
        'query': keyword,
        'display': display,
        'sort': 'sim',
    }, headers={
        'X-Naver-Client-Id': client_id,
        'X-Naver-Client-Secret': client_secret,
    }, timeout=10)
    resp.raise_for_status()
    return resp.json().get('items', [])


def get_rank(keyword: str, naver_product_id: str, store_alias: str) -> int | None:
    if not keyword:
        return None
    try:
        items = _naver_search(keyword, display=100)
        store_lower = store_alias.lower()
        for i, item in enumerate(items, 1):
            pid = item.get('productId', '')
            mall = item.get('mallName', '').lower()
            if naver_product_id and pid == naver_product_id:
                return i
            if store_lower and (store_lower in mall or mall in store_lower):
                return i
        return None
    except Exception:
        return None


def _get_naver_pid(url: str, keyword: str, store_alias: str, product_no: str) -> str:
    """네이버 검색 API로 productId 조회"""
    if not keyword:
        return ''
    try:
        items = _naver_search(keyword, display=100)
        store_lower = store_alias.lower()
        for item in items:
            link = item.get('link', '')
            if product_no and product_no in link:
                return item.get('productId', '')
            mall = item.get('mallName', '').lower()
            if store_lower and (store_lower in mall or mall in store_lower):
                return item.get('productId', '')
    except Exception:
        pass
    return ''


def crawl_and_save(product_id: int):
    from competitor.models import CompetitorProduct, CompetitorSnapshot
    from django.utils import timezone

    try:
        product = CompetitorProduct.objects.get(pk=product_id, is_active=True)
    except CompetitorProduct.DoesNotExist:
        return False, '상품을 찾을 수 없음'

    if not product.track_keyword:
        return False, '순위추적 키워드 미설정'

    time.sleep(random.uniform(0.5, 1.5))

    # 네이버 쇼핑 검색 API로 가격/리뷰/순위 수집
    try:
        items = _naver_search(product.track_keyword, display=100)
    except ValueError as e:
        return False, str(e)
    except Exception as e:
        return False, f'검색 API 오류: {e}'

    # 상품 매칭
    matched = None
    store_lower = product.store_alias.lower()
    for item in items:
        link = item.get('link', '')
        if product.product_no and product.product_no in link:
            matched = item
            break
        mall = item.get('mallName', '').lower()
        if store_lower and (store_lower in mall or mall in store_lower):
            matched = item
            break

    if not matched:
        return False, f'"{product.track_keyword}" 검색 결과에서 상품을 찾지 못했습니다'

    title = re.sub(r'<[^>]+>', '', matched.get('title', ''))
    price = int(matched['lprice']) if matched.get('lprice') else None
    review_count = int(matched.get('reviewCount', 0)) if matched.get('reviewCount') else None
    naver_pid = matched.get('productId', '')

    rank = None
    for i, item in enumerate(items, 1):
        if naver_pid and item.get('productId') == naver_pid:
            rank = i
            break
        mall = item.get('mallName', '').lower()
        if store_lower and (store_lower in mall or mall in store_lower):
            rank = i
            break

    if title and not product.product_name:
        product.product_name = title

    prev = CompetitorSnapshot.objects.filter(product=product).order_by('-crawled_at').first()

    # purchaseCount는 확장프로그램 수집분 유지, 서버는 null
    estimated_sales = 0
    if prev and prev.purchase_count is not None:
        estimated_sales = prev.estimated_sales  # 이전 값 유지

    snapshot = CompetitorSnapshot.objects.create(
        product=product,
        price=price,
        review_count=review_count,
        purchase_count=prev.purchase_count if prev else None,
        recent_purchase_count=prev.recent_purchase_count if prev else None,
        naver_product_id=naver_pid,
        rank_position=rank,
        estimated_sales=estimated_sales,
    )

    product.last_crawled_at = snapshot.crawled_at
    product.save(update_fields=['product_name', 'last_crawled_at'])

    return True, snapshot


def crawl_all():
    from competitor.models import CompetitorProduct
    products = CompetitorProduct.objects.filter(is_active=True)
    results = []
    for p in products:
        ok, result = crawl_and_save(p.pk)
        results.append({'product_id': p.pk, 'url': p.url, 'ok': ok, 'detail': str(result)})
        time.sleep(random.uniform(1.5, 3.0))
    return results
