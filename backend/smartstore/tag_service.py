"""상품 태그 생성 — 오너클랜 상품대장 주키워드 기반.

규칙(사용자 지정):
  · 오너클랜 ownerclan_product.keywords(주키워드) 중에서
  · 상품명(naver_product_name)에 이미 없는 키워드만
  · 상품에 맞는 조합형(복합명사) 우선
  · 최대 10개 (과다 금지)
"""
from __future__ import annotations

import re
from django.db import connections

NAVERDB = 'naverdb'
ADS_DB = 'ads'
MAX_TAGS = 10

_split = re.compile(r'[\s,/]+')


def _name_tokens(name: str) -> set:
    """상품명을 토큰화 (공백/기호 분리 + 전체 문자열)."""
    name = name or ''
    toks = set(t for t in _split.split(name) if t)
    toks.add(name.replace(' ', ''))
    return toks


def _in_name(kw: str, name: str, name_nospace: str) -> bool:
    """키워드가 상품명에 이미 포함되는지 (부분일치 포함)."""
    k = kw.replace(' ', '')
    return bool(k) and (k in name_nospace)


def build_tags(name: str, keywords_csv: str, max_tags: int = MAX_TAGS) -> list[str]:
    """주키워드 → 상품명에 없는 조합형 태그 최대 N개."""
    name = name or ''
    name_nospace = name.replace(' ', '')
    raw = [k.strip() for k in (keywords_csv or '').split(',') if k.strip()]
    seen = set()
    cand = []
    for k in raw:
        kk = k.strip()
        if len(kk) < 2:
            continue                      # 1글자 제외
        if kk in seen:
            continue
        if _in_name(kk, name, name_nospace):
            continue                      # 상품명에 이미 있는 건 제외
        seen.add(kk)
        cand.append(kk)
    # 조합형(2글자 이상 복합명사) 우선 — 길이 긴 것 우선, 과다 방지 N개
    cand.sort(key=lambda x: (-len(x),))
    return cand[:max_tags]


def _ensure_table():
    with connections[NAVERDB].cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS naver_product_tags (
              product_code VARCHAR(40) NOT NULL PRIMARY KEY,
              tags_json JSON NULL,
              tag_count INT NOT NULL DEFAULT 0,
              source VARCHAR(20) NOT NULL DEFAULT 'ownerclan',
              registered TINYINT(1) NOT NULL DEFAULT 0,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)


def register_tags_to_naver(store_id: int, origin_product_no: int, tags: list[str], token: str = None) -> dict:
    """상품의 seoInfo.sellerTags 를 태그로 설정 (GET→수정→PUT). 최대 10개."""
    import requests
    from . import smartstore_product_service as sps
    if token is None:
        api, sec, _ = sps._get_store_credentials(store_id)
        token = sps._get_access_token(api, sec)
    url = sps.NAVER_PRODUCT_DETAIL_URL.format(origin_product_no)
    h = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    prod = requests.get(url, headers=h, timeout=30).json()['originProduct']
    detail = prod.setdefault('detailAttribute', {})
    seo = detail.setdefault('seoInfo', {})
    seo['sellerTags'] = [{'text': t} for t in tags[:MAX_TAGS]]
    put = requests.put(url, json={'originProduct': prod}, headers=h, timeout=30)
    if put.status_code == 400:
        inv = put.json().get('invalidInputs', [])
        # 거부된 태그 제거 후 재시도
        bad = set()
        for it in inv:
            msg = it.get('message', '')
            for t in tags:
                if t in msg:
                    bad.add(t)
        if bad:
            seo['sellerTags'] = [{'text': t} for t in tags if t not in bad][:MAX_TAGS]
            put = requests.put(url, json={'originProduct': prod}, headers=h, timeout=30)
    put.raise_for_status()
    return {'ok': True, 'tags': [t['text'] for t in seo['sellerTags']]}


def generate_for_codes(wcodes: list[str]) -> dict:
    """W코드 목록 → 오너클랜 키워드+네이버명으로 태그 생성 → naver_product_tags 저장."""
    import json
    if not wcodes:
        return {'ok': True, 'generated': 0}
    _ensure_table()
    # 네이버 상품명
    names = {}
    with connections[NAVERDB].cursor() as cur:
        for i in range(0, len(wcodes), 500):
            ch = wcodes[i:i + 500]; ph = ','.join(['%s'] * len(ch))
            cur.execute(f"SELECT product_code, naver_product_name FROM naver_my_product WHERE product_code IN ({ph})", ch)
            for code, nm in cur.fetchall():
                names[code] = nm or ''
    # 오너클랜 주키워드
    kws = {}
    with connections[ADS_DB].cursor() as cur:
        for i in range(0, len(wcodes), 500):
            ch = wcodes[i:i + 500]; ph = ','.join(['%s'] * len(ch))
            cur.execute(f"SELECT product_code, keywords FROM ownerclan_product WHERE product_code IN ({ph})", ch)
            for code, kw in cur.fetchall():
                kws[code] = kw or ''
    n = 0
    with connections[NAVERDB].cursor() as cur:
        for code in wcodes:
            tags = build_tags(names.get(code, ''), kws.get(code, ''))
            if not tags:
                continue
            cur.execute(
                "INSERT INTO naver_product_tags (product_code, tags_json, tag_count) "
                "VALUES (%s,%s,%s) ON DUPLICATE KEY UPDATE tags_json=VALUES(tags_json), "
                "tag_count=VALUES(tag_count), registered=0, updated_at=NOW()",
                [code, json.dumps(tags, ensure_ascii=False), len(tags)])
            n += 1
    return {'ok': True, 'generated': n, 'requested': len(wcodes)}
