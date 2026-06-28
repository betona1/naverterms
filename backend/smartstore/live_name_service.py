"""라이브 상품명 금지어 일괄점검 + 수정.

네이버에 실제 등록된 상품(smartstore_product.name)에서 브랜드 금지어(naver_brand_policy
policy='black', 예: 크록스)를 찾아 정리명 제안 + 커머스 API 로 상품명 수정.
"""
from __future__ import annotations

import re
import time

from django.db import connections

from . import brand_policy_service as bp
from . import smartstore_product_service as sps

MYPRODUCT_DB = 'myproduct'


def get_banned_words() -> list[str]:
    """브랜드정책 black 중 상품명 금지어(브랜드/상표). 협력사·공급사 라벨은 제외."""
    res = bp.list_all(policy='black', limit=10000)
    items = res.get('items', []) if isinstance(res, dict) else []
    words = []
    for r in items:
        nm = (r.get('name') or '').strip()
        if not nm:
            continue
        if '협력사' in nm or '공급사' in nm or '도매' in nm:
            continue   # 공급사 라벨 — 상품명 금지어 아님
        words.append(nm)
    return words


def clean_name(name: str, words: list[str]) -> str:
    """상품명에서 금지어 제거 + 공백 정리."""
    out = name or ''
    for w in words:
        if not w:
            continue
        out = re.sub(re.escape(w), '', out, flags=re.IGNORECASE)
    return re.sub(r'\s+', ' ', out).strip()


def scan(store_id: int | None = None, words: list[str] | None = None, limit: int = 1000) -> dict:
    """라이브 상품명에 금지어 포함된 것 스캔. {matches:[...], words, total}."""
    words = words or get_banned_words()
    if not words:
        return {'matches': [], 'words': [], 'total': 0}
    where = ['(' + ' OR '.join(['s.name LIKE %s'] * len(words)) + ')']
    params: list = [f'%{w}%' for w in words]
    if store_id:
        where.append('s.store_id=%s'); params.append(int(store_id))
    where_sql = ' AND '.join(where)
    sql = (f"SELECT s.store_id, i.store_name, s.origin_product_no, "
           f"s.seller_management_code, s.name, s.status_type "
           f"FROM smartstore_product s LEFT JOIN smartstoreIdList i ON i.id=s.store_id "
           f"WHERE {where_sql} ORDER BY s.store_id LIMIT %s")
    with connections[MYPRODUCT_DB].cursor() as cur:
        cur.execute(sql, params + [int(limit)])
        rows = cur.fetchall()
    matches = []
    for sid, sname, opno, wcode, name, status in rows:
        hit = [w for w in words if w.lower() in (name or '').lower()]
        matches.append({
            'store_id': sid, 'store_name': sname, 'origin_product_no': opno,
            'product_code': wcode, 'name': name, 'clean_name': clean_name(name, words),
            'status_type': status, 'banned_hit': hit,
        })
    return {'matches': matches, 'words': words, 'total': len(matches)}


def fix_names(items: list[dict]) -> dict:
    """items=[{store_id, origin_product_no, new_name}] → 네이버 API 수정 + DB 반영."""
    ok = fail = 0
    results = []
    for it in items:
        sid = it.get('store_id'); opno = it.get('origin_product_no')
        new_name = (it.get('new_name') or '').strip()
        if not (sid and opno and new_name):
            fail += 1; results.append({'origin_product_no': opno, 'ok': False, 'error': '필수값 누락'})
            continue
        try:
            r = sps.update_product_fields(opno, int(sid), {'name': new_name})
            if isinstance(r, dict) and r.get('error'):
                fail += 1; results.append({'origin_product_no': opno, 'ok': False, 'error': str(r['error'])[:150]})
                continue
            with connections[MYPRODUCT_DB].cursor() as cur:
                cur.execute("UPDATE smartstore_product SET name=%s WHERE store_id=%s AND origin_product_no=%s",
                            [new_name, int(sid), opno])
            ok += 1; results.append({'origin_product_no': opno, 'ok': True, 'new_name': new_name})
        except Exception as e:
            em = str(e)
            if 'statusType' in em or '400' in em:
                em = '판매금지/품절 등 상태제약으로 API 수정 불가 (네이버에서 직접 처리 필요)'
            fail += 1; results.append({'origin_product_no': opno, 'ok': False, 'error': em[:150]})
        time.sleep(1)   # rate limit (GET+PUT)
    return {'ok': True, 'updated': ok, 'failed': fail, 'results': results}
