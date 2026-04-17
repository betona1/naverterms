import os
import re
import time
import hmac
import hashlib
import base64
import logging
import urllib.parse
from collections import Counter
from datetime import timedelta
import requests as http_requests
from django.utils import timezone
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
    NaverRankTarget, NaverRankHistory,
)

logger = logging.getLogger(__name__)


def calculate_order_weight(products, term1, term2, top_n=10):
    """순서고정가중치: 상위 N개 상품에서 term1+term2가 붙어있는 비율"""
    count = 0
    order_weight = 0
    joined_term = term1 + term2

    for item in products:
        product_name = item.get('productName', '')
        if term1 in product_name and term2 in product_name:
            count += 1
            product_no_space = product_name.replace(' ', '')
            if joined_term in product_no_space:
                order_weight += 1
            if count >= top_n:
                break

    return {'count': count, 'order_weight': order_weight, 'label': f'{term1}{term2}({order_weight}/{count})'}


def calculate_position_weight(products, term1, term2, top_n=10):
    """위치가중치: 1=정순(term1→term2), 2=역순(term2→term1)"""
    count = 0
    position_weight = 0

    for item in products:
        product_name = item.get('productName', '')
        if term1 in product_name and term2 in product_name:
            count += 1

            if term1 + term2 in product_name:
                position_weight = 1
                break
            if term2 + term1 in product_name:
                position_weight = 2
                break

            words = product_name.replace('  ', ' ').strip().split()
            for i in range(len(words) - 1):
                if words[i] == term1 and words[i + 1] == term2:
                    position_weight = 1
                    break
                if words[i] == term2 and words[i + 1] == term1:
                    position_weight = 2
                    break
            if position_weight:
                break

            if count >= top_n:
                break

    return {'count': count, 'position_weight': position_weight, 'label': f'{term1}{term2}({position_weight}/{count})'}


def calculate_name_weight(products, term1, term2, top_n=40):
    """상품명가중치: 상위 N개 중 term쌍을 모두 포함하는 상품 수"""
    count = 0
    for item in products[:top_n]:
        product_name = item.get('productName', '')
        if term1 in product_name and term2 in product_name:
            count += 1
    return {'count': count, 'total': min(len(products), top_n), 'label': f'{term1}{term2}({count}/{min(len(products), top_n)})'}


def calculate_part_weight(products, terms, top_n=40):
    """파트가중치: term이 상품명의 앞(1/3)/중간(1/3)/뒤(1/3)에 위치하는 비율"""
    result = {}
    for term in terms:
        if not term:
            continue
        front = mid = back = 0
        checked = 0
        for item in products[:top_n]:
            name = item.get('productName', '').replace(' ', '')
            if term not in name:
                continue
            checked += 1
            pos = name.index(term)
            total_len = len(name)
            if total_len == 0:
                continue
            ratio = pos / total_len
            if ratio < 0.33:
                front += 1
            elif ratio < 0.66:
                mid += 1
            else:
                back += 1
        result[term] = {'front': front, 'mid': mid, 'back': back, 'total': checked}
    return result


def calculate_category_priority(products, top_n=40):
    """카테고리우선여부: 1위 상품과 동일 카테고리 비율"""
    items = products[:top_n]
    if not items:
        return {'category': '', 'count': 0, 'total': 0}

    def get_category(item):
        return ' > '.join(filter(None, [
            item.get('category1Name', ''),
            item.get('category2Name', ''),
            item.get('category3Name', ''),
            item.get('category4Name', ''),
        ]))

    first_category = get_category(items[0])
    count = sum(1 for item in items if get_category(item) == first_category)
    return {'category': first_category, 'count': count, 'total': len(items)}


def _get_term_pairs(terms):
    """인접 term 쌍 생성"""
    pairs = []
    for i in range(len(terms) - 1):
        if terms[i] and terms[i + 1]:
            pairs.append((terms[i], terms[i + 1]))
    return pairs


def run_full_analysis(keyword_id):
    """전체 가중치 분석 실행 → NaverTermAnalysis 저장"""
    kw = NaverKeyword.objects.get(id=keyword_id)
    terms = kw.terms or []

    snapshot = NaverSearchSnapshot.objects.filter(
        keyword=kw, tab_type='total'
    ).order_by('-collected_at').first()

    if not snapshot or not snapshot.products:
        return None

    items = snapshot.products
    pairs = _get_term_pairs(terms)

    # 순서고정가중치
    order_results = {}
    for t1, t2 in pairs:
        order_results[f'{t1}{t2}'] = calculate_order_weight(items, t1, t2)

    # 위치가중치
    position_results = {}
    for t1, t2 in pairs:
        position_results[f'{t1}{t2}'] = calculate_position_weight(items, t1, t2)

    # 상품명가중치
    name_results = {}
    for t1, t2 in pairs:
        name_results[f'{t1}{t2}'] = calculate_name_weight(items, t1, t2)

    # 파트가중치
    part_results = calculate_part_weight(items, terms)

    # 카테고리우선여부
    cat_results = calculate_category_priority(items)

    analysis = NaverTermAnalysis.objects.create(
        keyword=kw,
        term1=terms[0] if len(terms) > 0 else '',
        term2=terms[1] if len(terms) > 1 else '',
        term3=terms[2] if len(terms) > 2 else '',
        term4=terms[3] if len(terms) > 3 else '',
        order_weight=order_results,
        position_weight=position_results,
        name_weight=name_results,
        part_weight=part_results,
        category_priority=cat_results,
    )
    return analysis


def get_tag_statistics(keyword_id):
    """태그 통계 (모든 탭의 태그를 합산, 중복 수 내림차순)"""
    snapshots = NaverSearchSnapshot.objects.filter(keyword_id=keyword_id)
    all_tags = []
    for snap in snapshots:
        for item in (snap.products or []):
            tags = item.get('manuTag', '')
            if isinstance(tags, str) and tags:
                all_tags.extend(t.strip() for t in tags.split(',') if t.strip())
            elif isinstance(tags, list):
                all_tags.extend(t.strip() for t in tags if t.strip())

    counter = Counter(all_tags)
    special_prefixes = ['오늘출발', '오늘발송', '빠른배송', '새벽배송', '무료배송',
                        '무료반품', '무료교환', '정기구독', '정기배송', '정기배달']
    normal = []
    special = []
    for tag, cnt in counter.items():
        entry = {'tag': tag, 'count': cnt}
        if any(tag.startswith(s) for s in special_prefixes):
            special.append(entry)
        else:
            normal.append(entry)

    normal.sort(key=lambda x: x['count'], reverse=True)
    special.sort(key=lambda x: x['count'], reverse=True)
    return normal + special


# ══════════════════════════════════════════
# 연관키워드 — 네이버 검색광고 API
# ══════════════════════════════════════════

_NAVER_AD_BASE = 'https://api.naver.com'
_NAVER_AD_URI = '/keywordstool'


def _naver_ad_signature(timestamp, method, uri):
    secret = os.getenv('NAVER_AD_SECRET_KEY', '')
    message = f'{timestamp}.{method}.{uri}'
    sig = hmac.new(secret.encode(), message.encode(), hashlib.sha256)
    return base64.b64encode(sig.digest()).decode()


def search_related_keywords(hint_keyword):
    """네이버 검색광고 API — 연관키워드 조회"""
    customer_id = os.getenv('NAVER_AD_CUSTOMER_ID', '')
    access_key = os.getenv('NAVER_AD_ACCESS_KEY', '')
    if not customer_id or not access_key:
        raise ValueError('NAVER_AD_CUSTOMER_ID / ACCESS_KEY / SECRET_KEY 미설정')

    timestamp = str(int(time.time() * 1000))
    signature = _naver_ad_signature(timestamp, 'GET', _NAVER_AD_URI)

    headers = {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp': timestamp,
        'X-API-KEY': access_key,
        'X-Customer': customer_id,
        'X-Signature': signature,
    }
    params = {'hintKeywords': hint_keyword, 'showDetail': 1}

    resp = http_requests.get(
        _NAVER_AD_BASE + _NAVER_AD_URI,
        headers=headers, params=params, timeout=10,
    )
    if resp.status_code == 200:
        return resp.json().get('keywordList', [])
    raise Exception(f'Naver Ad API error: {resp.status_code} {resp.text}')


# ══════════════════════════════════════════
# 순위추적 — 네이버 쇼핑 검색 API
# ══════════════════════════════════════════

NAVER_SHOP_API = 'https://openapi.naver.com/v1/search/shop.json'


def _naver_search(keyword, display=100, start=1):
    """네이버 쇼핑 검색 API 호출"""
    client_id = os.getenv('NAVER_SEARCH_CLIENT_ID', '')
    client_secret = os.getenv('NAVER_SEARCH_CLIENT_SECRET', '')
    if not client_id or not client_secret:
        raise ValueError('NAVER_SEARCH_CLIENT_ID / SECRET 미설정')

    resp = http_requests.get(NAVER_SHOP_API, params={
        'query': keyword,
        'display': display,
        'start': start,
        'sort': 'sim',
    }, headers={
        'X-Naver-Client-Id': client_id,
        'X-Naver-Client-Secret': client_secret,
    }, timeout=10)
    resp.raise_for_status()
    return resp.json()


def run_rank_tracking(target_ids=None):
    """활성 순위추적 대상을 네이버 API로 조회하고 결과 저장.
    target_ids: 특정 타겟만 추적 (None이면 전체 활성 타겟)
    """
    if target_ids:
        targets = NaverRankTarget.objects.filter(id__in=target_ids, is_active=True)
    else:
        targets = NaverRankTarget.objects.filter(is_active=True)
    targets = targets.select_related('keyword')

    if not targets.exists():
        return {'tracked': 0, 'results': []}

    # 키워드별 그룹핑
    kw_map = {}
    for t in targets:
        kw_map.setdefault(t.keyword.keyword, []).append(t)

    results = []
    for keyword, kw_targets in kw_map.items():
        try:
            # 100개씩 최대 200위까지 검색
            all_items = []
            for start in [1, 101]:
                data = _naver_search(keyword, display=100, start=start)
                items = data.get('items', [])
                total = data.get('total', 0)
                all_items.extend(items)
                if len(items) < 100:
                    break
                time.sleep(0.15)  # rate limit 배려

            logger.info(f'[순위추적] "{keyword}" {len(all_items)}개 상품 조회 (total={total})')

            for target in kw_targets:
                rank = None
                found = None

                for idx, item in enumerate(all_items):
                    match = False
                    if target.target_type == 'store':
                        match = (item.get('mallName', '').strip() == target.target_value.strip())
                    elif target.target_type == 'product_id':
                        match = (str(item.get('productId', '')) == str(target.target_value))

                    if match:
                        rank = idx + 1
                        found = item
                        break

                # HTML 태그 제거
                product_name = ''
                if found:
                    product_name = re.sub(r'<[^>]+>', '', found.get('title', ''))

                history = NaverRankHistory.objects.create(
                    target=target,
                    rank_position=rank,
                    tab_type='total',
                    total_results=total,
                    found_product_name=product_name,
                    found_product_price=int(found['lprice']) if found and found.get('lprice') else None,
                    found_review_count=None,
                    found_product_id=found.get('productId', '') if found else '',
                    found_product_url=found.get('link', '') if found else '',
                    found_product_image=found.get('image', '') if found else '',
                )
                results.append({
                    'target_id': target.id,
                    'keyword': keyword,
                    'target_value': target.target_value,
                    'rank': rank,
                    'product_name': product_name,
                    'product_url': found.get('link', '') if found else '',
                    'product_image': found.get('image', '') if found else '',
                    'product_id': found.get('productId', '') if found else '',
                })
                logger.info(f'  [{target.target_value}] {rank or "미발견"}위')

        except Exception as e:
            logger.error(f'[순위추적] "{keyword}" 실패: {e}')
            for target in kw_targets:
                results.append({
                    'target_id': target.id,
                    'keyword': keyword,
                    'target_value': target.target_value,
                    'rank': None,
                    'error': str(e),
                })

        time.sleep(0.3)  # 키워드 간 간격

    return {'tracked': len(results), 'results': results}


# ══════════════════════════════════════════
# 카테고리키워드 — 네이버 데이터랩 API
# ══════════════════════════════════════════

_DATALAB_CATEGORY_URL = 'https://datalab.naver.com/shoppingInsight/getCategory.naver'
_DATALAB_KEYWORD_RANK_URL = 'https://datalab.naver.com/shoppingInsight/getCategoryKeywordRank.naver'
_DATALAB_HEADERS = {
    'Referer': 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}


def get_datalab_categories(parent_cid='0'):
    """네이버 데이터랩 카테고리 목록 조회 → [{cid, pid, name}, ...]"""
    resp = http_requests.get(
        _DATALAB_CATEGORY_URL,
        params={'cid': parent_cid},
        headers=_DATALAB_HEADERS,
        timeout=10,
    )
    if resp.status_code == 200:
        data = resp.json()
        children = data.get('childList', [])
        return [{'cid': str(c['cid']), 'pid': str(c['pid']), 'name': c['name']} for c in children]
    raise Exception(f'DataLab category API error: {resp.status_code}')


def _fetch_category_keyword_rank_live(cid, start_date, end_date, age='', gender='', device='', max_count=500):
    """DataLab API 라이브 호출 (캐시 없이)"""
    all_ranks = []
    page_num = 1
    max_pages = (max_count + 19) // 20

    post_headers = {
        **_DATALAB_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
    }

    while page_num <= max_pages:
        for attempt in range(3):
            resp = http_requests.post(
                _DATALAB_KEYWORD_RANK_URL,
                headers=post_headers,
                data={
                    'cid': cid, 'timeUnit': 'date',
                    'startDate': start_date, 'endDate': end_date,
                    'age': age, 'gender': gender, 'device': device,
                    'page': page_num, 'count': 20,
                },
                timeout=15,
            )
            if resp.status_code == 429:
                time.sleep(1 * (attempt + 1))
                continue
            break
        if resp.status_code != 200:
            raise Exception(f'DataLab keyword rank API error: {resp.status_code}')

        data = resp.json()
        ranks = data.get('ranks', [])
        all_ranks.extend(ranks)

        if len(ranks) < 20:
            break
        page_num += 1
        time.sleep(0.2)

    return all_ranks[:max_count]


def get_category_keyword_rank(cid, start_date, end_date, age='', gender='', device='', max_count=500):
    """캐시 우선 조회 → 없으면 라이브 → 캐시 저장"""
    from .models import CategoryKeywordCache
    filter_key = f'{age}_{gender}_{device}'
    cache_hours = 24

    try:
        cached = CategoryKeywordCache.objects.get(cid=cid, filter_key=filter_key)
        age_hours = (timezone.now() - cached.cached_at).total_seconds() / 3600
        if age_hours < cache_hours:
            return {'ranks': cached.ranks_json, 'cached': True, 'cached_at': cached.cached_at.isoformat()}
    except CategoryKeywordCache.DoesNotExist:
        pass

    ranks = _fetch_category_keyword_rank_live(cid, start_date, end_date, age, gender, device, max_count)

    CategoryKeywordCache.objects.update_or_create(
        cid=cid, filter_key=filter_key,
        defaults={'ranks_json': ranks},
    )

    return {'ranks': ranks}


def _safe_int(v):
    """검색광고 API 값 안전 변환 (예: '< 10' → 0)"""
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        v = v.strip().replace(',', '')
        if v.startswith('<') or v == '':
            return 0
        try:
            return int(float(v))
        except Exception:
            return 0
    return 0


def enrich_keywords(keywords):
    """캐시 우선 → 미캐시 키워드만 API 호출 → 캐시 저장"""
    from .models import KeywordEnrichCache
    result = {}
    cache_hours = 24
    cutoff = timezone.now() - timedelta(hours=cache_hours)

    # ── 캐시에서 조회 ──
    cached_qs = KeywordEnrichCache.objects.filter(keyword__in=keywords, cached_at__gte=cutoff)
    for c in cached_qs:
        result[c.keyword] = {
            'monthlyPcQcCnt': c.monthly_pc_qc,
            'monthlyMobileQcCnt': c.monthly_mobile_qc,
            'compIdx': c.comp_idx,
            'productCount': c.product_count,
            'category': c.category_name,
        }

    uncached = [kw for kw in keywords if kw not in result]
    if not uncached:
        return result

    # ── 미캐시 키워드: 라이브 API 호출 ──
    live = _enrich_keywords_live(uncached)
    result.update(live)

    # ── 결과 캐시 저장 ──
    for kw, data in live.items():
        KeywordEnrichCache.objects.update_or_create(
            keyword=kw,
            defaults={
                'monthly_pc_qc': data.get('monthlyPcQcCnt', 0),
                'monthly_mobile_qc': data.get('monthlyMobileQcCnt', 0),
                'comp_idx': data.get('compIdx', ''),
                'product_count': data.get('productCount', 0),
                'category_name': data.get('category', ''),
            },
        )

    return result


def _enrich_keywords_live(keywords):
    """검색광고 API + 쇼핑 API 라이브 호출 (캐시 없이)"""
    result = {}
    kw_set = set(keywords)

    # ── 1) 검색광고 API — 5개씩 배치 ──
    customer_id = os.getenv('NAVER_AD_CUSTOMER_ID', '')
    access_key = os.getenv('NAVER_AD_ACCESS_KEY', '')
    if customer_id and access_key:
        for i in range(0, len(keywords), 5):
            batch = keywords[i:i + 5]
            try:
                kw_list = search_related_keywords(','.join(batch))
                for item in kw_list:
                    kw = item.get('relKeyword', '')
                    if kw in kw_set and kw not in result:
                        result[kw] = {
                            'monthlyPcQcCnt': _safe_int(item.get('monthlyPcQcCnt', 0)),
                            'monthlyMobileQcCnt': _safe_int(item.get('monthlyMobileQcCnt', 0)),
                            'compIdx': item.get('compIdx', ''),
                        }
            except Exception:
                pass
            time.sleep(0.1)

    # ── 2) 쇼핑 API — 상품수 + 카테고리 ──
    client_id = os.getenv('NAVER_SEARCH_CLIENT_ID', '')
    client_secret = os.getenv('NAVER_SEARCH_CLIENT_SECRET', '')
    if client_id and client_secret:
        for kw in keywords:
            if kw not in result:
                result[kw] = {}
            try:
                data = _naver_search(kw, display=1, start=1)
                result[kw]['productCount'] = data.get('total', 0)
                items = data.get('items', [])
                if items:
                    cats = [items[0].get(f'category{i}', '') for i in range(1, 5)]
                    result[kw]['category'] = ' > '.join(c for c in cats if c)
                else:
                    result[kw]['category'] = ''
            except Exception:
                result[kw].setdefault('productCount', 0)
                result[kw].setdefault('category', '')
            time.sleep(0.1)

    return result


def match_keywords_for_product(product_name, keywords):
    """상품명 기반 키워드 연관도 매칭 — score > 0 키워드 반환"""
    # 상품명 정규화: 괄호/특수문자 제거, 소문자
    clean = re.sub(r'[(\[{<][^)}\]>]*[)\]}>]', ' ', product_name)
    clean = re.sub(r'[^가-힣a-zA-Z0-9\s]', ' ', clean)
    name_lower = clean.lower().strip()
    name_no_space = re.sub(r'\s+', '', name_lower)

    # 토큰 추출 (2글자 이상)
    tokens = [t for t in name_lower.split() if len(t) >= 2]

    scored = []
    for kw in keywords:
        kw_lower = kw.lower()
        kw_no_space = re.sub(r'\s+', '', kw_lower)
        score = 0

        # 키워드가 상품명에 substring으로 존재
        if kw_no_space in name_no_space:
            score += 3

        # 상품명 토큰이 키워드에 포함
        for token in tokens:
            if token in kw_lower:
                score += 1

        if score > 0:
            scored.append((kw, score))

    scored.sort(key=lambda x: -x[1])
    return [kw for kw, _ in scored]
