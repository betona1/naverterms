"""브랜드/제조사 화이트·블랙리스트 정책.

LLM prompt 에 brand/manufacturer 전달 전 check:
  - 블랙: 무조건 제거
  - 화이트: 무조건 전달
  - 미등록: 휴리스틱 (공급사 패턴 매치 시 제거)
"""
from __future__ import annotations

import re
from datetime import datetime

from django.db import connections

DB = 'naverdb'

# 휴리스틱 — DB 미등록 시 fallback (협력사/파트너/도매 등)
_SUPPLIER_NOISE_RE = re.compile(
    r'(파트너|partner|협력사|공급사|벤더|vendor|에이전트|agent|'
    r'대표|판매자|판매처|취급점|총판|유통|distribution|distributor|'
    r'도매|상사|상회|무역|trade|trading|글로벌|global|코리아\s*$)',
    re.IGNORECASE,
)


def _norm(name: str) -> str:
    return (name or '').strip().lower()


def get_policy(name: str) -> dict | None:
    """name 의 화이트/블랙 조회.
    반환: {policy, source, note} 또는 None (미등록)
    """
    if not name or not name.strip():
        return None
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT policy, source, note, hit_count FROM naver_brand_policy "
            "WHERE name_lower=%s",
            [_norm(name)],
        )
        row = cur.fetchone()
        if not row:
            return None
        return {'policy': row[0], 'source': row[1], 'note': row[2], 'hit_count': row[3]}


def is_allowed(name: str) -> bool:
    """LLM prompt 에 노출할 만한 brand/manufacturer 인지.
    - 블랙: False
    - 화이트: True
    - 미등록: 휴리스틱 (공급사 패턴이면 False, 그 외 True)
    """
    if not name:
        return False
    p = get_policy(name)
    if p:
        # hit_count 증가 (silent)
        try:
            with connections[DB].cursor() as cur:
                cur.execute(
                    "UPDATE naver_brand_policy SET hit_count=hit_count+1 WHERE name_lower=%s",
                    [_norm(name)],
                )
        except Exception:
            pass
        return p['policy'] == 'white'
    # 미등록 — 휴리스틱
    if _SUPPLIER_NOISE_RE.search(name):
        return False
    has_hangul = any('가' <= c <= '힣' for c in name)
    # 한글 포함 또는 짧은 코드만 허용 (영문 풀네임 차단)
    return has_hangul or len(name.strip()) <= 3


def upsert(name: str, policy: str, source: str = 'user', note: str | None = None) -> dict:
    name = (name or '').strip()
    if not name:
        return {'ok': False, 'error': 'name required'}
    if policy not in ('white', 'black'):
        return {'ok': False, 'error': 'policy must be white|black'}
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            INSERT INTO naver_brand_policy (name, name_lower, policy, source, note)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              name=VALUES(name),
              policy=VALUES(policy),
              source=VALUES(source),
              note=VALUES(note),
              updated_at=NOW()
            """,
            [name, _norm(name), policy, source, note],
        )
    return {'ok': True, 'name': name, 'policy': policy}


def delete(name: str) -> dict:
    with connections[DB].cursor() as cur:
        cur.execute("DELETE FROM naver_brand_policy WHERE name_lower=%s", [_norm(name)])
        return {'ok': True, 'deleted': cur.rowcount}


def list_all(policy: str | None = None, search: str | None = None,
             limit: int = 200, offset: int = 0) -> dict:
    where = ['1=1']
    params: list = []
    if policy in ('white', 'black'):
        where.append('policy=%s')
        params.append(policy)
    if search:
        where.append('name_lower LIKE %s')
        params.append(f'%{search.lower()}%')
    where_sql = ' AND '.join(where)
    with connections[DB].cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM naver_brand_policy WHERE {where_sql}", params)
        total = cur.fetchone()[0]
        cur.execute(
            f"SELECT name, policy, source, note, hit_count, created_at, updated_at "
            f"FROM naver_brand_policy WHERE {where_sql} "
            f"ORDER BY hit_count DESC, name LIMIT %s OFFSET %s",
            params + [limit, offset],
        )
        rows = []
        for r in cur.fetchall():
            d = {
                'name': r[0], 'policy': r[1], 'source': r[2], 'note': r[3],
                'hit_count': r[4],
                'created_at': r[5].isoformat() if r[5] else None,
                'updated_at': r[6].isoformat() if r[6] else None,
            }
            rows.append(d)
    return {'items': rows, 'total': total}


def auto_discover(limit: int = 50) -> list[dict]:
    """미등록 brand/manufacturer 중 자주 등장하는 것 top N — 사용자가 빠르게 분류하기 위해.
    naver_my_product 의 brand+manufacturer 빈도 + 정책 미등록.
    """
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            SELECT name, SUM(cnt) AS cnt FROM (
              SELECT TRIM(brand) AS name, COUNT(*) AS cnt
                FROM naver_my_product
               WHERE brand IS NOT NULL AND TRIM(brand) <> ''
               GROUP BY TRIM(brand)
              UNION ALL
              SELECT TRIM(manufacturer), COUNT(*)
                FROM naver_my_product
               WHERE manufacturer IS NOT NULL AND TRIM(manufacturer) <> ''
               GROUP BY TRIM(manufacturer)
            ) t
            WHERE name NOT IN (SELECT name FROM naver_brand_policy)
              AND CHAR_LENGTH(name) >= 2
            GROUP BY name
            ORDER BY cnt DESC
            LIMIT %s
            """,
            [limit],
        )
        return [{'name': r[0], 'count': int(r[1])} for r in cur.fetchall()]
