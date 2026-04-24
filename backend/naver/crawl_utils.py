# crawl_utils.py — 크롤링 공통 유틸리티
# uc_crawler, http_crawler 공용 함수

import re
import json
import logging
from django.utils import timezone

logger = logging.getLogger(__name__)


def find_shopping_result(data, depth=0):
    """JSON에서 shoppingResult 재귀 탐색 (깊이 12까지)"""
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
            r = find_shopping_result(v, depth + 1)
            if r:
                return r
    return None


def parse_next_data(html):
    """HTML에서 __NEXT_DATA__ JSON 추출 → shoppingResult 반환"""
    match = re.search(r'<script\s+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except (json.JSONDecodeError, ValueError):
        return None

    pp = data.get('props', {}).get('pageProps')
    if not pp:
        return None

    for target in [pp.get('initialState'), pp.get('dehydratedState'),
                   pp.get('compositeList'), pp]:
        if not target:
            continue
        sr = find_shopping_result(target)
        if sr:
            return sr
        if isinstance(target, dict) and 'queries' in target:
            for q in target.get('queries', []):
                sr2 = find_shopping_result((q.get('state') or {}).get('data'))
                if sr2:
                    return sr2
    return None


def save_search_result(keyword_text, tab_type, sr, source='unknown'):
    """검색 결과 DB 저장 (공통)

    source: 'chrome', 'uc', 'http', 'api'
    """
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

    logger.info(f'[{source}] [{tab_type}] "{keyword_text}" 저장 — {len(products)}개 total={total}')
    return kw
