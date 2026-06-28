"""불량 상품명 탐지 — AI 생성 실패/안내문 누출/형식오류.

예: "네이버 검색 노출에 최적화된 상품명을 다음과 같이 제안드립니다",
    "네이버 쇼핑 상품명 최적화 제안 ...", "... 이하 상세설명 ..." 등.
정상 괄호명 "(브랜드)상품" 은 오탐하지 않도록 정밀 패턴만 사용.
"""
from __future__ import annotations

import re
from django.db import connections

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'

# AI 실패/안내문 누출에 특화된 고정밀 패턴
LEAK_PATTERNS = [
    r'최적화된\s*상품명', r'상품명\s*최적화', r'상품명을\s*(?:다음|아래|제안|추천|작성)',
    r'최적화\s*(?:제안|예시)', r'최적화를?\s*위해', r'제안\s*드림', r'제안\s*드립',
    r'추천\s*드립', r'다음과\s*같(?:이|은)', r'아래와\s*같', r'^\s*다음은', r'다음은\s*.{0,10}상품명',
    r'네이버\s*검색\s*노출', r'네이버\s*쇼핑\s*상품명', r'제공된\s*정보', r'규칙을\s*바탕',
    r'이하\s*상세설명', r'상세설명\s*참조\s*상품명', r'^\s*[#*\-]\s', r'```',
    r'\bhere\s+is\b', r'다음\s*상품명', r'상품명\s*예시', r'전용\s*상품명',
]
LEAK_RE = re.compile('|'.join('(?:%s)' % p for p in LEAK_PATTERNS), re.I)


def classify(name: str | None) -> str | None:
    """불량이면 사유 문자열, 정상이면 None."""
    if not name:
        return 'empty'
    n = name.strip()
    if len(n) < 6:
        return '너무짧음'
    if len(n) > 100:
        return '100자초과'
    if '\n' in n:
        return '줄바꿈포함'
    m = LEAK_RE.search(n)
    if m:
        return 'AI안내문(%s)' % m.group(0).strip()[:18]
    return None


def scan_pool(stages: list[str] | None = ('queue', 'candidate')) -> dict:
    """naver_my_product 상품명 불량 탐지. stages=None 이면 전체."""
    where = "naver_product_name<>''"
    params: list = []
    if stages:
        ph = ','.join(['%s'] * len(stages))
        where += f" AND register_stage IN ({ph})"
        params += list(stages)
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"SELECT id, product_code, folder_id, naver_product_name, register_stage "
            f"FROM naver_my_product WHERE {where}", params)
        rows = cur.fetchall()
    items = []
    for pid, code, fid, name, st in rows:
        r = classify(name)
        if r:
            items.append({'id': pid, 'product_code': code, 'folder_id': fid,
                          'name': name, 'stage': st, 'reason': r})
    return {'total': len(items), 'items': items}


def scan_live(store_id: int | None = None) -> dict:
    """smartstore_product(라이브) 상품명 불량 탐지."""
    where = "name<>''"
    params: list = []
    if store_id:
        where += " AND store_id=%s"
        params.append(int(store_id))
    with connections[MYPRODUCT_DB].cursor() as cur:
        cur.execute(
            f"SELECT s.store_id, i.store_name, s.origin_product_no, s.seller_management_code, s.name "
            f"FROM smartstore_product s LEFT JOIN smartstoreIdList i ON i.id=s.store_id "
            f"WHERE {where}", params)
        rows = cur.fetchall()
    items = []
    for sid, sn, opno, code, name in rows:
        r = classify(name)
        if r:
            items.append({'store_id': sid, 'store_name': sn, 'origin_product_no': opno,
                          'product_code': code, 'name': name, 'reason': r})
    return {'total': len(items), 'items': items}


def purge_from_queue(ids: list[int]) -> dict:
    """불량명 상품을 작업대기/후보에서 제외 (register_stage=NULL) — 등록 방지."""
    if not ids:
        return {'ok': False, 'error': 'ids 없음'}
    with connections[NAVERDB].cursor() as cur:
        ph = ','.join(['%s'] * len(ids))
        cur.execute(
            f"UPDATE naver_my_product SET register_stage=NULL WHERE id IN ({ph})",
            [int(x) for x in ids])
        n = cur.rowcount
    return {'ok': True, 'purged': n}
