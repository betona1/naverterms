"""네이버 상품명 AI 컨펌 학습.

사용자가 모달에서 AI 생성 상품명을 컨펌(저장)하면:
  - before_name / after_name diff 로 자동 black/white 키워드 추출
  - W코드 단위 raw 이벤트 누적 (naver_name_confirmation)
  - 카테고리별 누적 정책 upsert (naver_name_keyword_policy)
  - generator 에서 향후 같은 카테고리/같은 W코드 생성 시 컨텍스트로 활용
"""
from __future__ import annotations

import json
import logging
import re

from django.db import connections

from . import naver_name_generator as _gen

logger = logging.getLogger(__name__)

DB = 'naverdb'

_TOKEN_SPLIT_RE = re.compile(r'[\s/,()\[\]\-_+]+')


def _tokenize(name: str | None) -> list[str]:
    if not name:
        return []
    return [t.strip() for t in _TOKEN_SPLIT_RE.split(name) if len(t.strip()) >= 1]


def _diff_keywords(before: str | None, after: str | None) -> tuple[list[str], list[str]]:
    """before→after diff.
    - bad  : before 에만 있는 토큰 (삭제됨)
    - white: before·after 모두에 있는 토큰 + after 에 새로 추가된 토큰
    case-insensitive 비교, 표기는 첫 등장 형태 유지.
    """
    before_tokens = _tokenize(before)
    after_tokens = _tokenize(after)
    before_lc = {t.lower(): t for t in before_tokens}
    after_lc = {t.lower(): t for t in after_tokens}
    bad = [before_lc[k] for k in before_lc if k not in after_lc]
    white = [after_lc[k] for k in after_lc]  # 결과적으로 살아있는 토큰 전부
    # 토큰 너무 짧은 단편(1글자) 은 학습에 의미 없음
    bad = [t for t in bad if len(t) >= 2]
    white = [t for t in white if len(t) >= 2]
    return bad, white


def _upsert_policy(category_type: str, keyword: str, policy: str,
                   product_code: str | None, source: str = 'user') -> None:
    if not category_type or not keyword or policy not in ('white', 'black'):
        return
    kw = keyword.strip()
    if not kw or len(kw) < 2 or len(kw) > 80:
        return
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            INSERT INTO naver_name_keyword_policy
              (category_type, keyword, policy, hit_count, source, last_product_code)
            VALUES (%s, %s, %s, 1, %s, %s)
            ON DUPLICATE KEY UPDATE
              hit_count = hit_count + 1,
              source = VALUES(source),
              last_product_code = VALUES(last_product_code),
              updated_at = NOW()
            """,
            [category_type, kw, policy, source, product_code],
        )


def save_confirmation(product_id: int,
                      before_name: str | None,
                      after_name: str | None,
                      comment: str | None,
                      comment_type: str = 'overall') -> dict:
    """컨펌 이벤트 저장 + 카테고리 정책 학습.

    comment_type:
      - wrong   : black 만 학습
      - missing : white 만 학습
      - overall : 둘 다 학습
    """
    if comment_type not in ('wrong', 'missing', 'overall'):
        comment_type = 'overall'

    # 상품 정보 조회 (W코드/카테고리)
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT product_code, category_code, category_name "
            "FROM naver_my_product WHERE id=%s",
            [int(product_id)],
        )
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'not_found'}
        product_code, category_code, category_name = row[0], row[1], row[2]

    category_type = _gen._infer_category_type(category_name)
    bad, white = _diff_keywords(before_name, after_name)

    # raw 저장
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            INSERT INTO naver_name_confirmation
              (product_code, product_id, category_code, category_name, category_type,
               before_name, after_name, bad_keywords, white_keywords,
               ai_comment, comment_type)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                product_code, int(product_id),
                category_code, category_name, category_type,
                before_name, after_name,
                json.dumps(bad, ensure_ascii=False),
                json.dumps(white, ensure_ascii=False),
                comment, comment_type,
            ],
        )

    # 카테고리 정책 누적
    learn_black = comment_type in ('wrong', 'overall')
    learn_white = comment_type in ('missing', 'overall')
    if learn_black:
        for kw in bad:
            _upsert_policy(category_type, kw, 'black', product_code, 'user')
    if learn_white:
        # white 는 'must keep' 신호가 너무 많아질 수 있으니, 사용자가 missing/overall 으로
        # 명시한 컨펌에서만 누적. 또한 before 에 없던 ‘추가된’ 토큰을 우선 가중치 적용.
        before_tokens_lc = {t.lower() for t in _tokenize(before_name)}
        for kw in white:
            # before 에 없었는데 after 에 있다 = 사용자가 직접 보강한 키워드 → 학습 가치 큼
            if kw.lower() not in before_tokens_lc:
                _upsert_policy(category_type, kw, 'white', product_code, 'user')

    return {
        'ok': True,
        'product_code': product_code,
        'category_type': category_type,
        'bad_keywords': bad,
        'white_keywords': white,
        'comment_type': comment_type,
    }


def list_confirmations(product_code: str | None = None,
                       limit: int = 50, offset: int = 0) -> dict:
    where = ['1=1']
    params: list = []
    if product_code:
        where.append('product_code=%s')
        params.append(product_code)
    where_sql = ' AND '.join(where)
    with connections[DB].cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM naver_name_confirmation WHERE {where_sql}", params)
        total = cur.fetchone()[0]
        cur.execute(
            f"""SELECT id, product_code, product_id, category_type, category_name,
                       before_name, after_name, bad_keywords, white_keywords,
                       ai_comment, comment_type, created_at
                  FROM naver_name_confirmation WHERE {where_sql}
                 ORDER BY created_at DESC LIMIT %s OFFSET %s""",
            params + [limit, offset],
        )
        items: list[dict] = []
        for r in cur.fetchall():
            items.append({
                'id': r[0],
                'product_code': r[1],
                'product_id': r[2],
                'category_type': r[3],
                'category_name': r[4],
                'before_name': r[5],
                'after_name': r[6],
                'bad_keywords': _json_load(r[7]),
                'white_keywords': _json_load(r[8]),
                'ai_comment': r[9],
                'comment_type': r[10],
                'created_at': r[11].isoformat() if r[11] else None,
            })
    return {'items': items, 'total': total}


def _json_load(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return []


def list_policy(category_type: str | None = None,
                policy: str | None = None,
                limit: int = 200) -> dict:
    where = ['1=1']
    params: list = []
    if category_type:
        where.append('category_type=%s')
        params.append(category_type)
    if policy in ('white', 'black'):
        where.append('policy=%s')
        params.append(policy)
    where_sql = ' AND '.join(where)
    with connections[DB].cursor() as cur:
        cur.execute(
            f"""SELECT category_type, keyword, policy, hit_count, source,
                       last_product_code, updated_at
                  FROM naver_name_keyword_policy WHERE {where_sql}
                 ORDER BY hit_count DESC, updated_at DESC LIMIT %s""",
            params + [limit],
        )
        items = []
        for r in cur.fetchall():
            items.append({
                'category_type': r[0],
                'keyword': r[1],
                'policy': r[2],
                'hit_count': r[3],
                'source': r[4],
                'last_product_code': r[5],
                'updated_at': r[6].isoformat() if r[6] else None,
            })
    return {'items': items, 'total': len(items)}


def get_policy_for_generator(category_type: str,
                             white_limit: int = 12,
                             black_limit: int = 20) -> dict:
    """generator._build_user 에서 호출 — 같은 카테고리 누적 정책 top-N."""
    if not category_type:
        return {'white': [], 'black': []}
    with connections[DB].cursor() as cur:
        cur.execute(
            """SELECT keyword FROM naver_name_keyword_policy
                WHERE category_type=%s AND policy='white'
                ORDER BY hit_count DESC LIMIT %s""",
            [category_type, white_limit],
        )
        white = [r[0] for r in cur.fetchall()]
        cur.execute(
            """SELECT keyword FROM naver_name_keyword_policy
                WHERE category_type=%s AND policy='black'
                ORDER BY hit_count DESC LIMIT %s""",
            [category_type, black_limit],
        )
        black = [r[0] for r in cur.fetchall()]
    return {'white': white, 'black': black}


def get_last_confirmation_for_product(product_code: str) -> dict | None:
    """generator._build_user 에서 호출 — 같은 W코드 직전 컨펌(있으면 그대로 활용)."""
    if not product_code:
        return None
    with connections[DB].cursor() as cur:
        cur.execute(
            """SELECT after_name, ai_comment, comment_type, bad_keywords, white_keywords
                 FROM naver_name_confirmation
                WHERE product_code=%s
                ORDER BY created_at DESC LIMIT 1""",
            [product_code],
        )
        row = cur.fetchone()
        if not row:
            return None
        return {
            'after_name': row[0],
            'ai_comment': row[1],
            'comment_type': row[2],
            'bad_keywords': _json_load(row[3]),
            'white_keywords': _json_load(row[4]),
        }


def list_version_snapshots(product_id: int, limit: int = 20) -> dict:
    """롤백 UI 용 — 해당 상품의 버전 스냅샷 목록 (최근순)."""
    with connections[DB].cursor() as cur:
        cur.execute(
            """SELECT id, version_tag, naver_product_name, source, note, created_at
                 FROM naver_name_version_snapshot
                WHERE product_id=%s
                ORDER BY created_at DESC LIMIT %s""",
            [int(product_id), limit],
        )
        items = []
        for r in cur.fetchall():
            items.append({
                'id': r[0],
                'version_tag': r[1],
                'naver_product_name': r[2],
                'source': r[3],
                'note': r[4],
                'created_at': r[5].isoformat() if r[5] else None,
            })
        # 현재 적용된 버전/이름도 같이
        cur.execute(
            "SELECT name_version, naver_product_name FROM naver_my_product WHERE id=%s",
            [int(product_id)],
        )
        cur_row = cur.fetchone()
    return {
        'items': items,
        'current_version': cur_row[0] if cur_row else None,
        'current_name': cur_row[1] if cur_row else None,
    }


def rollback_to_snapshot(product_id: int, snapshot_id: int) -> dict:
    """스냅샷 id 기준으로 naver_product_name 복원.
    복원 전 현재 상태도 스냅샷(source=manual, note=before rollback)으로 보존.
    """
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT product_code, naver_product_name, name_version FROM naver_my_product WHERE id=%s",
            [int(product_id)],
        )
        prod = cur.fetchone()
        if not prod:
            return {'ok': False, 'error': 'not_found'}
        cur.execute(
            """SELECT version_tag, naver_product_name FROM naver_name_version_snapshot
                WHERE id=%s AND product_id=%s""",
            [int(snapshot_id), int(product_id)],
        )
        snap = cur.fetchone()
        if not snap:
            return {'ok': False, 'error': 'snapshot_not_found'}

        # 현재 상태 보존
        if prod[1]:
            cur.execute(
                """INSERT INTO naver_name_version_snapshot
                     (product_id, product_code, version_tag, naver_product_name, source, note)
                   VALUES (%s, %s, %s, %s, 'manual', %s)""",
                [int(product_id), prod[0], prod[2] or 'unknown', prod[1],
                 f'before rollback to snapshot#{snapshot_id}'],
            )
        # 복원
        cur.execute(
            """UPDATE naver_my_product
                  SET naver_product_name_before = naver_product_name,
                      naver_product_name = %s,
                      name_version = %s,
                      synced_at = NOW()
                WHERE id=%s""",
            [snap[1], snap[0], int(product_id)],
        )
    return {
        'ok': True,
        'restored_name': snap[1],
        'restored_version': snap[0],
        'snapshot_id': int(snapshot_id),
    }


def delete_policy(category_type: str, keyword: str, policy: str) -> dict:
    with connections[DB].cursor() as cur:
        cur.execute(
            "DELETE FROM naver_name_keyword_policy "
            "WHERE category_type=%s AND keyword=%s AND policy=%s",
            [category_type, keyword, policy],
        )
        return {'ok': True, 'deleted': cur.rowcount}
