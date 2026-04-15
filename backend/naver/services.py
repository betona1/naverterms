import re
from collections import Counter
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
)


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
