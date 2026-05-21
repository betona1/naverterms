import os
import re
import json
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
# 공식 API 상품 → 크롤링 형식 변환
# ══════════════════════════════════════════

def _map_api_to_crawl_format(item):
    """공식 API items[] → 크롤링 products[] 형식 변환"""
    title = re.sub(r'<[^>]+>', '', item.get('title', ''))
    return {
        'productName': title,
        'lowPrice': item.get('lprice', ''),
        'mallName': item.get('mallName', ''),
        'imageUrl': item.get('image', ''),
        'productUrl': item.get('link', ''),
        'category1Name': item.get('category1', ''),
        'category2Name': item.get('category2', ''),
        'category3Name': item.get('category3', ''),
        'category4Name': item.get('category4', ''),
        'maker': item.get('maker', ''),
        'brand': item.get('brand', ''),
        'productId': item.get('productId', ''),
        'productType': item.get('productType', ''),
        'manuTag': '',
        'attributeValue': '',
        'characterValue': '',
        'reviewCount': 0,
        'openDate': '',
        'scoreInfo': '',
        '_source': 'api',
    }


def fetch_products_via_api(keyword, max_items=40):
    """공식 네이버 쇼핑 API로 상품 수집 (차단 위험 없음)"""
    data = _naver_search(keyword, display=min(max_items, 100), start=1)
    items = data.get('items', [])
    total = data.get('total', 0)
    products = [_map_api_to_crawl_format(item) for item in items[:max_items]]
    return {'products': products, 'total': total}


def run_smart_analysis(keyword_id, method='auto'):
    """스마트 분석: 자동 fallback 지원

    method:
      'auto' — HTTP 크롤링 시도 → 차단 시 API fallback
      'api'  — 공식 API + 캐시된 terms
      'http' — HTTP 크롤링만

    반환: {'analysis': NaverTermAnalysis, 'method_used': str, 'terms_source': str, 'products_source': str}
    """
    from . import http_crawler

    kw = NaverKeyword.objects.get(id=keyword_id)
    terms = kw.terms or []
    result_info = {'method_used': method, 'terms_source': None, 'products_source': None}

    if method in ('auto', 'http'):
        # HTTP 크롤링 시도
        session = http_crawler._get_session()
        sr = http_crawler.fetch_keyword(session, kw.keyword, 'total')

        if sr and not sr.get('blocked') and sr.get('products'):
            # HTTP 성공 → 저장 + 분석
            from . import crawl_utils
            crawl_utils.save_search_result(kw.keyword, 'total', sr, source='http')
            kw.refresh_from_db()
            result_info['terms_source'] = 'http'
            result_info['products_source'] = 'http'
            result_info['method_used'] = 'http'
            analysis = run_full_analysis(keyword_id)
            return {**result_info, 'analysis': analysis}

        if sr and sr.get('blocked') and method == 'http':
            # HTTP만 요청했는데 차단 → 실패
            return {**result_info, 'analysis': None, 'blocked': True}

        # auto이고 차단/실패 → API fallback
        if method == 'auto':
            logger.info(f'[Smart] HTTP 실패/차단 → API fallback: "{kw.keyword}"')

    # API 모드 (method='api' 또는 auto의 fallback)
    result_info['method_used'] = 'api'

    # terms 캐시 확인
    if not terms:
        result_info['terms_source'] = 'missing'
    else:
        result_info['terms_source'] = 'cache'

    # products는 공식 API로 수집
    try:
        api_data = fetch_products_via_api(kw.keyword, max_items=40)
        products = api_data['products']
        total = api_data['total']
        result_info['products_source'] = 'api'
    except Exception as e:
        logger.error(f'[Smart] API 실패: "{kw.keyword}" — {e}')
        return {**result_info, 'analysis': None, 'error': str(e)}

    if not products:
        return {**result_info, 'analysis': None}

    # 스냅샷 저장
    NaverSearchSnapshot.objects.create(
        keyword=kw, tab_type='total',
        products=products, total=total,
    )
    kw.total_count = total
    kw.last_searched_at = timezone.now()
    kw.save(update_fields=['total_count', 'last_searched_at'])

    if not terms:
        # terms 없으면 가중치 분석 불가 — products만 저장됨
        return {**result_info, 'analysis': None, 'need_terms': True}

    # 가중치 분석 실행
    analysis = run_full_analysis(keyword_id)
    return {**result_info, 'analysis': analysis}


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
                        tv = str(target.target_value).strip()
                        # productId 매칭
                        if str(item.get('productId', '')) == tv:
                            match = True
                        # link URL에 상품번호 포함 매칭
                        elif tv in item.get('link', ''):
                            match = True

                    if match:
                        rank = idx + 1
                        found = item
                        break

                # HTML 태그 제거
                product_name = ''
                if found:
                    product_name = re.sub(r'<[^>]+>', '', found.get('title', ''))

                # 매칭된 상품 정보를 타겟에 저장 (상품별 그룹핑용)
                if found:
                    pid = str(found.get('productId', ''))
                    update_fields = []
                    if pid and target.matched_product_id != pid:
                        target.matched_product_id = pid
                        update_fields.append('matched_product_id')
                    if product_name and target.matched_product_name != product_name:
                        target.matched_product_name = product_name
                        update_fields.append('matched_product_name')
                    if update_fields:
                        target.save(update_fields=update_fields)

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
        resp = None
        for attempt in range(5):
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
                time.sleep(2 * (attempt + 1))
                continue
            break
        if resp is None or resp.status_code == 429:
            # 429 지속 → 여기까지 수집한 데이터라도 반환
            break
        if resp.status_code != 200:
            raise Exception(f'DataLab keyword rank API error: {resp.status_code}')

        data = resp.json()
        ranks = data.get('ranks', [])
        all_ranks.extend(ranks)

        if len(ranks) < 20:
            break
        page_num += 1
        time.sleep(0.5)

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


# ══════════════════════════════════════════
# 동의어 — 네이버 사전 후보 + 쇼핑 검증
# ══════════════════════════════════════════

_DICT_BASE_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
)
_HANGUL_RE = re.compile(r'^[가-힣A-Za-z0-9 ·\-]{2,20}$')


def _walk_collect_synonym_strings(obj, found):
    """JSON 트리를 재귀로 돌며 유의어 후보 문자열 수집.
    네이버 한국어사전(api3) 응답: similarWordList[].similarWordName, expSynonym('단어^URL') 등."""
    LIST_KEYS = {'synonym', 'synonyms', 'syn', 'synWords', 'synonymList', 'similarWordList', 'similarWord'}
    NAME_KEYS = {'similarWordName', 'name', 'word', 'entryName', 'text', 'mean'}
    STR_KEYS = {'expSynonym', 'synonym', 'syn'}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in STR_KEYS and isinstance(v, str) and v:
                # "백견^https://..." 형태에서 ^ 앞부분만 먼저 잘라낸 뒤 콤마로 다중분리
                head = v.split('^', 1)[0]
                for chunk in re.split(r'[,;·、|]+', head):
                    name = chunk.strip()
                    if name:
                        found.add(name)
            elif k in LIST_KEYS:
                if isinstance(v, list):
                    for it in v:
                        if isinstance(it, str):
                            name = it.split('^', 1)[0].strip()
                            if name:
                                found.add(name)
                        elif isinstance(it, dict):
                            for nk in NAME_KEYS:
                                if nk in it and isinstance(it[nk], str):
                                    name = it[nk].split('^', 1)[0].strip()
                                    if name:
                                        found.add(name)
                            # similarWordList 등 객체 내부에 URL 필드가 있어 재귀하지 않음
                elif isinstance(v, str):
                    name = v.split('^', 1)[0].strip()
                    if name:
                        found.add(name)
            elif isinstance(v, (dict, list)):
                _walk_collect_synonym_strings(v, found)
    elif isinstance(obj, list):
        for it in obj:
            _walk_collect_synonym_strings(it, found)


def fetch_naver_dict_synonyms(word):
    """네이버 한국어사전에서 유의어 후보 추출 (best-effort).
    여러 엔드포인트를 시도해 결과를 합치고, 한글/영문 단어로 필터링."""
    word = (word or '').strip()
    if not word:
        return []

    headers = {
        'User-Agent': _DICT_BASE_UA,
        'Referer': 'https://ko.dict.naver.com/',
        'Accept': 'application/json, text/plain, */*',
    }
    found = set()

    endpoints = [
        ('https://ko.dict.naver.com/api3/koko/search', {
            'query': word, 'range': 'word', 'shouldSearchOpdic': 'true',
            'articleSearchType': 'WORD', 'part': 'word',
        }),
        ('https://ko.dict.naver.com/api3/koko/search', {
            'query': word, 'articleSearchType': 'THESAURUS', 'range': 'word',
        }),
    ]
    for url, params in endpoints:
        try:
            r = http_requests.get(url, params=params, headers=headers, timeout=6)
            if r.status_code != 200:
                continue
            data = r.json()
            _walk_collect_synonym_strings(data, found)
        except Exception as e:
            logger.debug(f'[Synonym] dict fetch failed {url}: {e}')

    cleaned = []
    seen = set()
    for w in found:
        w = re.sub(r'\s+', ' ', w).strip()
        if not w or w == word or w in seen:
            continue
        if not _HANGUL_RE.match(w):
            continue
        seen.add(w)
        cleaned.append(w)
    cleaned.sort()
    return cleaned[:30]


def verify_synonym_in_shopping(keyword, candidate, top_n=20):
    """네이버쇼핑 검색 API로 두 키워드의 결과를 비교해 동의어 여부 검증.
    카테고리 분포 + 최상위 카테고리 일치 + 상품 ID 중복도 가중합."""
    keyword = (keyword or '').strip()
    candidate = (candidate or '').strip()
    if not keyword or not candidate:
        return {'error': '키워드/후보 누락'}
    if keyword == candidate:
        return {'verdict': 'same_word', 'score': 1.0, 'details': '동일 단어'}

    try:
        d1 = _naver_search(keyword, display=top_n, start=1)
        d2 = _naver_search(candidate, display=top_n, start=1)
    except Exception as e:
        return {'error': str(e)}

    items1 = d1.get('items', [])[:top_n]
    items2 = d2.get('items', [])[:top_n]
    if not items1 or not items2:
        return {
            'verdict': 'no_data',
            'score': 0.0,
            'total1': d1.get('total', 0),
            'total2': d2.get('total', 0),
            'details': '검색 결과 부족',
        }

    def cat_path(it, depth=3):
        return ' > '.join([str(it.get(f'category{i}', '') or '') for i in range(1, depth + 1) if it.get(f'category{i}')])

    cats1 = Counter(cat_path(it) for it in items1 if cat_path(it))
    cats2 = Counter(cat_path(it) for it in items2 if cat_path(it))

    # 카테고리 자카드 (multiset min/max)
    common_keys = set(cats1) & set(cats2)
    inter = sum(min(cats1[k], cats2[k]) for k in common_keys)
    union = sum((cats1 | cats2).values()) or 1
    cat_score = inter / union

    top_cat1 = cats1.most_common(1)[0][0] if cats1 else ''
    top_cat2 = cats2.most_common(1)[0][0] if cats2 else ''
    top_cat_match = bool(top_cat1) and (top_cat1 == top_cat2)

    # category1 (대분류) 일치
    big1 = Counter(it.get('category1', '') for it in items1 if it.get('category1'))
    big2 = Counter(it.get('category1', '') for it in items2 if it.get('category1'))
    big_top1 = big1.most_common(1)[0][0] if big1 else ''
    big_top2 = big2.most_common(1)[0][0] if big2 else ''
    big_match = bool(big_top1) and (big_top1 == big_top2)

    # 상품 ID 중복
    ids1 = {str(it.get('productId') or '') for it in items1 if it.get('productId')}
    ids2 = {str(it.get('productId') or '') for it in items2 if it.get('productId')}
    overlap = len(ids1 & ids2) / max(len(ids1 | ids2), 1) if (ids1 or ids2) else 0.0

    score = cat_score * 0.45 + (1.0 if top_cat_match else 0.0) * 0.30 + \
            (1.0 if big_match else 0.0) * 0.10 + overlap * 0.15

    if score >= 0.6:
        verdict = 'likely_synonym'   # 동의어 가능성 높음
    elif score >= 0.35:
        verdict = 'maybe_synonym'    # 보류
    else:
        verdict = 'unlikely_synonym' # 동의어 아님

    return {
        'verdict': verdict,
        'score': round(score, 3),
        'cat_score': round(cat_score, 3),
        'product_overlap': round(overlap, 3),
        'top_cat_match': top_cat_match,
        'big_cat_match': big_match,
        'top_cat_keyword': top_cat1,
        'top_cat_candidate': top_cat2,
        'top_categories_keyword': cats1.most_common(3),
        'top_categories_candidate': cats2.most_common(3),
        'total1': d1.get('total', 0),
        'total2': d2.get('total', 0),
        'sample_count': min(len(items1), len(items2)),
    }


# ══════════════════════════════════════════
# 자동완성 — 마켓별 (1단계: 네이버, 쿠팡)
# ══════════════════════════════════════════

def _autocomplete_headers():
    return {
        'User-Agent': _DICT_BASE_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    }


def fetch_autocomplete_naver(query):
    """네이버 통합검색 자동완성 (ac.search.naver.com/nx/ac).
    응답: {"query":[...], "items":[ [["키워드"], ...] ]}
    """
    query = (query or '').strip()
    if not query:
        return []
    url = 'https://ac.search.naver.com/nx/ac'
    params = {
        'of': 'os1,os2,os3,os4,os5,os6,os7,os8,os9,os10,os11',
        'q': query, 'frm': 'shopping',
        'st': '11111', 'r_format': 'json', 'r_enc': 'UTF-8',
        'r_unicode': '0', 'r_lt': '11111', '_callback': '',
    }
    try:
        r = http_requests.get(url, params=params, headers=_autocomplete_headers(), timeout=5)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        raise RuntimeError(f'네이버 자동완성 실패: {e}')
    items = data.get('items') or []
    out = []
    seen = set()
    # items 자체가 [[ ["kw"], ... ]] 1중 또는 2중 — 모든 list-of-list-of-str 패턴 안전하게 처리
    def collect(node):
        if isinstance(node, str):
            w = node.strip()
            if w and w not in seen:
                seen.add(w)
                out.append(w)
        elif isinstance(node, list):
            for c in node:
                collect(c)
    collect(items)
    # 첫 항목이 query 자체면 제외
    if out and out[0] == query:
        out = out[1:]
    return out


def fetch_autocomplete_coupang(query):
    """쿠팡 자동완성 — Akamai 봇차단으로 단순 GET이 403 됨.
    여러 호스트/UA 조합을 시도하고, 모두 차단되면 명시적 에러 발생.
    (실제 동작 시 Selenium 기반 마켓 자동완성으로 전환 필요)"""
    query = (query or '').strip()
    if not query:
        return []

    candidates = [
        ('https://www.coupang.com/np/search/autoComplete',
         {'keyword': query, '_': int(time.time() * 1000)}),
        ('https://m.coupang.com/np/search/autoComplete.pang',
         {'keyword': query}),
    ]
    last_err = None
    for url, params in candidates:
        try:
            r = http_requests.get(
                url, params=params,
                headers={**_autocomplete_headers(),
                         'Referer': 'https://www.coupang.com/',
                         'X-Requested-With': 'XMLHttpRequest'},
                timeout=5,
            )
            if r.status_code == 403 or '<HTML' in r.text[:100].upper() or 'Access Denied' in r.text:
                last_err = f'HTTP {r.status_code} — Akamai 차단'
                continue
            text = r.text.strip()
            if not text:
                last_err = 'empty response'
                continue
            m = re.match(r'^[a-zA-Z_$][\w$]*\((.*)\)\s*;?\s*$', text, re.S)
            payload = m.group(1) if m else text
            data = json.loads(payload)
        except Exception as e:
            last_err = str(e)
            continue

        out = []
        auto_list = data.get('autoCompleteList') or data.get('list') or []
        for entry in auto_list:
            if isinstance(entry, dict):
                w = entry.get('keyword') or entry.get('text') or entry.get('label')
                if w and isinstance(w, str):
                    out.append(w.strip())
            elif isinstance(entry, str):
                out.append(entry.strip())

        items = data.get('items')
        if not out and isinstance(items, list) and len(items) >= 2 and isinstance(items[1], list):
            for entry in items[1]:
                try:
                    w = entry[0][0]
                    if isinstance(w, str) and w.strip():
                        out.append(w.strip())
                except (IndexError, TypeError):
                    continue

        seen = set()
        dedup = []
        for w in out:
            if w and w not in seen:
                seen.add(w)
                dedup.append(w)
        if dedup:
            return dedup

    raise RuntimeError(f'쿠팡 자동완성 실패 (서버측 직접 호출 차단): {last_err or "no data"}')


MARKET_FETCHERS = {
    'naver': fetch_autocomplete_naver,
    'coupang': fetch_autocomplete_coupang,
}


def fetch_autocomplete_multi(query, markets):
    """여러 마켓 자동완성을 병렬로 조회 → {market: {keywords, error}} 반환"""
    from concurrent.futures import ThreadPoolExecutor

    targets = [m for m in (markets or []) if m in MARKET_FETCHERS]
    if not targets:
        return {}

    def run(m):
        try:
            return m, {'keywords': MARKET_FETCHERS[m](query), 'error': None}
        except Exception as e:
            return m, {'keywords': [], 'error': str(e)}

    out = {}
    with ThreadPoolExecutor(max_workers=len(targets)) as ex:
        for m, res in ex.map(run, targets):
            out[m] = res
    return out
