"""네이버상품 중복 검사 — 11st dup_diagnosis_service 의 SELF 모드 패턴 이식.

3 가지 기준:
  1. by-name   : 폴더(스토어) 내부 상품명 정규화 strict + 토큰 Jaccard
  2. by-image  : image_large URL 동일 그룹
  3. by-detail : detail_html MD5 동일 그룹

캐시 키: (mode, folder_id) — 10분 TTL.
"""
from __future__ import annotations

import hashlib
import re
import time

from django.db import connections

DB = 'naverdb'

_CACHE: dict = {}
_CACHE_TTL = 600

NAME_NORM_RE = re.compile(r'[^a-zA-Z0-9가-힣]+')

NOISE_TOKENS = frozenset({
    '정품', '신상', '신상품', '특가', '할인', '세일', '무료배송', '당일발송',
    '사은품', '증정', '선물', '본사정품', '본사', '빠른배송',
    'new', '베스트', 'best', '인기', '추천', '핫딜', '한정',
    '가격인하', '재고확보', '이벤트', '쿠폰', '특별판매', '리퍼',
    '국산', '한국산', '국내', '제조', 'kc인증', '인증',
    '대박', '강추', '득템', '실속', '꿀템',
    '+', '_', '-', '/', '&',
})

JACCARD_TH = 0.85

# ── 옵션 시그니처 ──
# 같은 시리즈의 다른 SKU(사이즈/수량/색상)를 분리하기 위함.
_OPT_DIM = re.compile(r'\d+(?:\.\d+)?\s*[x*×]\s*\d+(?:\.\d+)?(?:\s*[x*×]\s*\d+(?:\.\d+)?)?(?:\s*(?:cm|mm|m))?', re.I)
_OPT_UNIT = re.compile(r'\d+(?:\.\d+)?\s*(?:T|mm|cm|kg|g|ml|l|oz|w|inch|in)\b', re.I)
_OPT_COUNT = re.compile(r'\d+\s*(?:장|개|입|매|팩|박스|봉|세트|셋|포|쌍|벌|켤레|p|pcs|ea)\b', re.I)
# 한글 사이즈 — 한글/영문 글자에 인접하지 않은 경우만 매칭 (괄호/하이픈/공백/숫자 인접 OK)
# "거품기 특대" "고무장갑-중" "(대)" → 매칭 / "대신" "대량" "광대" "여대생" → 무시
_OPT_SIZE_KOR_BARE = re.compile(r'(?<![가-힣a-zA-Z])(?:왕특대|특대|특소|대형|중형|소형|대|중|소)(?![가-힣a-zA-Z])')
_OPT_SIZE_ALPHA = re.compile(r'(?<![a-z])(?:XXS|XS|XL|XXL|2XL|3XL|4XL|5XL)(?![a-z])', re.I)
_OPT_SIZE_LABEL = re.compile(r'사이즈\s*[a-z0-9]+|[a-z0-9]+\s*사이즈', re.I)
# 모델/품번 코드 — H7, V2, LED5, AB12, 3H 등 영문·숫자 혼합
_OPT_MODEL_ALNUM = re.compile(r'(?<![가-힣a-z0-9.])(?:[a-z]+\d+[a-z]*|\d+[a-z]+)(?![가-힣a-z0-9.])', re.I)
# 순수 숫자 모델코드 — 881, 9006 등 3자리 이상 (한글 단위·차원 부착 제외)
_OPT_MODEL_NUM = re.compile(
    r'(?<![가-힣a-z\d.])\d{3,}'
    r'(?![가-힣a-z]|\s*(?:장|개|입|매|팩|박스|봉|세트|셋|포|쌍|벌|켤레|cm|mm|kg|g|ml|l|t|w|inch))'
    r'(?![\d.])',
    re.I,
)

_COLORS = frozenset({
    '블랙', '화이트', '네이비', '베이지', '그레이', '회색', '검정', '검은색', '흰색',
    '핑크', '빨강', '레드', '파랑', '블루', '노랑', '옐로우', '옐로', '초록', '그린',
    '주황', '오렌지', '보라', '퍼플', '갈색', '브라운', '카키', '와인', '민트', '라벤더',
    '카멜', '골드', '실버', '아이보리', '연두', '하늘', '코랄', '머스타드', '버건디',
    '연핑크', '진핑크', '연그레이', '진그레이', '연블루', '진블루', '딥블루', '연베이지',
})


def _extract_option_signature(name: str) -> frozenset:
    """상품명에서 옵션 시그니처(사이즈/수량/색상) 토큰 셋 추출.
    시그니처가 다른 두 상품은 같은 시리즈여도 중복으로 묶지 않는다.
    """
    if not name:
        return frozenset()
    s = name.lower()
    sig: set = set()
    for pat in (_OPT_DIM, _OPT_UNIT, _OPT_COUNT, _OPT_SIZE_KOR_BARE, _OPT_SIZE_ALPHA, _OPT_SIZE_LABEL,
                _OPT_MODEL_ALNUM, _OPT_MODEL_NUM):
        for m in pat.findall(s):
            t = re.sub(r'\s+', '', m if isinstance(m, str) else m[0])
            if t:
                sig.add(t)
    for t in NAME_NORM_RE.sub(' ', name).split():
        if t in _COLORS:
            sig.add(f'c:{t}')
    return frozenset(sig)


def _split_by_option_sig(group: list[dict]) -> list[list[dict]]:
    """그룹을 옵션 시그니처별로 분리 — 같은 시그니처끼리만 묶음."""
    buckets: dict = {}
    for r in group:
        sig = _extract_option_signature(r.get('product_name') or '')
        buckets.setdefault(sig, []).append(r)
    return [g for g in buckets.values() if len(g) >= 2]


def _now():
    return time.time()


def _normalize_strict(name: str) -> str:
    if not name:
        return ''
    return NAME_NORM_RE.sub('', name).lower()


def _tokenize(name: str) -> frozenset:
    if not name:
        return frozenset()
    s = NAME_NORM_RE.sub(' ', name.lower())
    return frozenset(t for t in s.split() if len(t) >= 2 and t not in NOISE_TOKENS)


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter < 2:
        return 0.0
    union = len(a) + len(b) - inter
    return inter / union if union else 0.0


def _fetch_rows(folder_id: int | None = None, exclude_folder_id: int | None = None,
                dismiss_mode: str | None = None) -> list[dict]:
    where_parts: list = []
    params: list = []
    if folder_id is not None:
        where_parts.append('p.folder_id=%s')
        params.append(int(folder_id))
    elif exclude_folder_id is not None:
        where_parts.append('(p.folder_id IS NULL OR p.folder_id<>%s)')
        params.append(int(exclude_folder_id))
    # 사용자가 "중복 아님" 해제한 상품은 해당 모드에서 제외
    if dismiss_mode:
        where_parts.append(
            "(p.dup_dismissed_modes IS NULL "
            "OR (NOT FIND_IN_SET(%s, p.dup_dismissed_modes) "
            "AND NOT FIND_IN_SET('all', p.dup_dismissed_modes)))"
        )
        params.append(dismiss_mode)
    where = ('WHERE ' + ' AND '.join(where_parts)) if where_parts else ''
    sql = (
        "SELECT p.id, p.folder_id, p.product_code, p.product_name, "
        "p.naver_product_name, p.image_large, p.detail_html, "
        "p.market_price, p.sale_status, "
        "f.name AS folder_name "
        f"FROM naver_my_product p "
        f"LEFT JOIN naver_my_product_folder f ON f.id=p.folder_id "
        f"{where}"
    )
    with connections[DB].cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _pack(r: dict, group: list[dict], strength: str, score: float, key: str) -> dict:
    twins = sorted({g['product_code'] for g in group
                    if g['product_code'] and g['id'] != r['id']})
    return {
        'id': r['id'],
        'folder_id': r['folder_id'],
        'folder_name': r['folder_name'] or '',
        'product_code': r['product_code'],
        'product_name': r['product_name'],
        'naver_product_name': r.get('naver_product_name'),
        'image_large': r['image_large'],
        'market_price': r.get('market_price', 0),
        'sale_status': r.get('sale_status'),
        'match_count': len(group),
        'twin_codes': twins,
        'strength': strength,
        'score': round(score, 3),
        'group_key': key,
    }


def by_name(folder_id: int | None = None, page: int = 1, per_page: int = 50,
            refresh: bool = False, strength_filter: str | None = None,
            exclude_folder_id: int | None = None) -> dict:
    """폴더 내 상품명 정규화 strict + 토큰 Jaccard ≥0.85."""
    cache_key = ('name', folder_id, exclude_folder_id)
    cached = _CACHE.get(cache_key)
    if not refresh and cached and (_now() - cached['ts'] < _CACHE_TTL):
        return _paginate(cached, page, per_page, strength_filter)

    rows = _fetch_rows(folder_id, exclude_folder_id, dismiss_mode='name')
    by_folder: dict = {}
    for r in rows:
        fid = r['folder_id']
        if fid is None:
            continue
        by_folder.setdefault(fid, []).append(r)

    matches: list = []
    seen_ids: set = set()

    for fid, frows in by_folder.items():
        # 옵션 시그니처 사전계산
        sig_per: dict = {r['id']: _extract_option_signature(r['product_name'] or '') for r in frows}

        # 1) strict 정규화 + 옵션 시그니처 동시 일치만 그룹
        norm_groups: dict = {}
        tokens_per: dict = {}
        for r in frows:
            n = _normalize_strict(r['product_name'] or '')
            if n:
                sig_key = '|'.join(sorted(sig_per[r['id']]))
                norm_groups.setdefault((n, sig_key), []).append(r)
            tokens_per[r['id']] = _tokenize(r['product_name'] or '')

        for (nkey, _sk), grp in norm_groups.items():
            if len(grp) < 2:
                continue
            for r in grp:
                if r['id'] in seen_ids:
                    continue
                seen_ids.add(r['id'])
                matches.append(_pack(r, grp, 'exact', 1.0, nkey))

        # 2) Jaccard 토큰 매칭 (strict 미적출분)
        token_to_idx: dict = {}
        for r in frows:
            if r['id'] in seen_ids:
                continue
            for t in tokens_per[r['id']]:
                token_to_idx.setdefault(t, set()).add(r['id'])

        common_th = max(50, int(len(frows) * 0.05))
        common = {t for t, ids in token_to_idx.items() if len(ids) > common_th}

        by_id = {r['id']: r for r in frows}
        already: set = set()
        for r in frows:
            if r['id'] in seen_ids or r['id'] in already:
                continue
            tk_r = tokens_per[r['id']]
            if len(tk_r) < 2:
                continue
            cand: dict = {}
            for t in tk_r:
                if t in common:
                    continue
                for oid in token_to_idx.get(t, ()):
                    if oid == r['id']:
                        continue
                    cand[oid] = cand.get(oid, 0) + 1
            if not cand:
                continue
            group = [r]
            sig_r = sig_per[r['id']]
            for oid, shared in cand.items():
                if oid in seen_ids or oid in already:
                    continue
                tk_o = tokens_per[oid]
                if len(tk_o) < 2:
                    continue
                if shared < max(2, int(0.5 * len(tk_r))):
                    continue
                # 옵션 시그니처가 다르면 같은 시리즈 다른 SKU — 묶지 않음
                if sig_per[oid] != sig_r:
                    continue
                if _jaccard(tk_r, tk_o) >= JACCARD_TH:
                    group.append(by_id[oid])
            if len(group) < 2:
                continue
            for m in group:
                already.add(m['id'])
                seen_ids.add(m['id'])
                matches.append(_pack(m, group, 'token', 0.85, f'tk:{r["id"]}'))

    matches.sort(key=lambda m: (m['folder_id'], -m['match_count'], m['group_key'], m['product_code']))
    ids = [m['id'] for m in matches]
    meta = {m['id']: m for m in matches}
    cached = {'ids': ids, 'meta': meta, 'ts': _now()}
    _CACHE[cache_key] = cached
    return _paginate(cached, page, per_page, strength_filter)


def by_image(folder_id: int | None = None, page: int = 1, per_page: int = 50,
             refresh: bool = False, exclude_folder_id: int | None = None) -> dict:
    """image_large URL 완전 일치 — 같은 사진 등록한 케이스."""
    cache_key = ('image', folder_id, exclude_folder_id)
    cached = _CACHE.get(cache_key)
    if not refresh and cached and (_now() - cached['ts'] < _CACHE_TTL):
        return _paginate(cached, page, per_page, None)

    rows = _fetch_rows(folder_id, exclude_folder_id, dismiss_mode='image')
    by_folder: dict = {}
    for r in rows:
        if not r['image_large'] or r['folder_id'] is None:
            continue
        by_folder.setdefault(r['folder_id'], []).append(r)

    matches: list = []
    for fid, frows in by_folder.items():
        groups: dict = {}
        for r in frows:
            groups.setdefault(r['image_large'], []).append(r)
        for url, grp in groups.items():
            if len(grp) < 2:
                continue
            url_key = hashlib.md5(url.encode()).hexdigest()[:12]
            # 같은 이미지여도 옵션 시그니처가 다르면 다른 SKU
            for sub in _split_by_option_sig(grp):
                for r in sub:
                    matches.append(_pack(r, sub, 'exact', 1.0, url_key))

    matches.sort(key=lambda m: (m['folder_id'], -m['match_count'], m['group_key'], m['product_code']))
    ids = [m['id'] for m in matches]
    meta = {m['id']: m for m in matches}
    cached = {'ids': ids, 'meta': meta, 'ts': _now()}
    _CACHE[cache_key] = cached
    return _paginate(cached, page, per_page, None)


def by_detail(folder_id: int | None = None, page: int = 1, per_page: int = 50,
              refresh: bool = False, exclude_folder_id: int | None = None) -> dict:
    """detail_html MD5 동일 — 같은 상세 페이지 재사용."""
    cache_key = ('detail', folder_id, exclude_folder_id)
    cached = _CACHE.get(cache_key)
    if not refresh and cached and (_now() - cached['ts'] < _CACHE_TTL):
        return _paginate(cached, page, per_page, None)

    rows = _fetch_rows(folder_id, exclude_folder_id, dismiss_mode='detail')
    by_folder: dict = {}
    for r in rows:
        h = r.get('detail_html') or ''
        if not h or r['folder_id'] is None:
            continue
        # 너무 짧은 detail (빈 div 등) 은 skip — 의미 없음
        if len(h) < 200:
            continue
        r['_detail_md5'] = hashlib.md5(h.encode('utf-8', 'ignore')).hexdigest()
        by_folder.setdefault(r['folder_id'], []).append(r)

    matches: list = []
    for fid, frows in by_folder.items():
        groups: dict = {}
        for r in frows:
            groups.setdefault(r['_detail_md5'], []).append(r)
        for md5, grp in groups.items():
            if len(grp) < 2:
                continue
            # 같은 detail_html 공유는 대량등록에서 흔함 → 옵션 시그니처 필수 체크
            for sub in _split_by_option_sig(grp):
                for r in sub:
                    matches.append(_pack(r, sub, 'exact', 1.0, md5[:12]))

    matches.sort(key=lambda m: (m['folder_id'], -m['match_count'], m['group_key'], m['product_code']))
    ids = [m['id'] for m in matches]
    meta = {m['id']: m for m in matches}
    cached = {'ids': ids, 'meta': meta, 'ts': _now()}
    _CACHE[cache_key] = cached
    return _paginate(cached, page, per_page, None)


def _paginate(cached: dict, page: int, per_page: int,
              strength_filter: str | None) -> dict:
    ids = cached['ids']
    meta = cached['meta']
    if strength_filter:
        ids = [i for i in ids if meta[i]['strength'] == strength_filter]
    total = len(ids)
    page = max(1, int(page))
    per_page = max(1, min(int(per_page), 200))
    s = (page - 1) * per_page
    items = [meta[i] for i in ids[s:s + per_page]]
    return {
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page if total else 0,
    }


# ── 일괄 마킹/삭제 ──

def mark_for_deletion(ids: list[int], note: str = 'dup') -> dict:
    """sale_status='DUP' 같은 식으로 마킹 (실제 DELETE는 안전상 별도).
    여기선 단순히 sync_status 컬럼에 'dup_marked' 저장.
    """
    if not ids:
        return {'ok': False, 'error': 'ids required'}
    ids = [int(x) for x in ids]
    ph = ','.join(['%s'] * len(ids))
    with connections[DB].cursor() as cur:
        cur.execute(
            f"UPDATE naver_my_product SET sync_status='dup_marked' WHERE id IN ({ph})",
            ids,
        )
        return {'ok': True, 'marked': cur.rowcount}


def dismiss_as_not_dup(ids: list[int], mode: str = 'all') -> dict:
    """선택한 상품을 '중복 아님' 으로 마킹.
    mode='all' 이면 모든 검사에서 제외. 'name'/'image'/'detail' 은 해당 모드에서만 제외.
    누적 가능 — FIND_IN_SET 기반.
    """
    if not ids:
        return {'ok': False, 'error': 'ids required'}
    if mode not in ('name', 'image', 'detail', 'all'):
        return {'ok': False, 'error': 'invalid mode'}
    ids = [int(x) for x in ids]
    ph = ','.join(['%s'] * len(ids))
    with connections[DB].cursor() as cur:
        cur.execute(
            f"UPDATE naver_my_product "
            f"SET dup_dismissed_modes = "
            f"  CASE "
            f"    WHEN dup_dismissed_modes IS NULL OR dup_dismissed_modes='' THEN %s "
            f"    WHEN FIND_IN_SET(%s, dup_dismissed_modes) THEN dup_dismissed_modes "
            f"    ELSE CONCAT(dup_dismissed_modes, ',', %s) "
            f"  END "
            f"WHERE id IN ({ph})",
            [mode, mode, mode, *ids],
        )
        # 캐시 무효화
        _CACHE.clear()
        return {'ok': True, 'dismissed': cur.rowcount, 'mode': mode}


def undismiss(ids: list[int]) -> dict:
    """해제 — dup_dismissed_modes 비우기."""
    if not ids:
        return {'ok': False, 'error': 'ids required'}
    ids = [int(x) for x in ids]
    ph = ','.join(['%s'] * len(ids))
    with connections[DB].cursor() as cur:
        cur.execute(
            f"UPDATE naver_my_product SET dup_dismissed_modes=NULL WHERE id IN ({ph})",
            ids,
        )
        _CACHE.clear()
        return {'ok': True, 'cleared': cur.rowcount}


def group_members(group_key: str, mode: str, folder_id: int | None = None) -> dict:
    """특정 group_key 그룹의 모든 멤버 fetch.
    재계산 없이 캐시된 결과에서 동일 group_key 인 것들 반환.
    """
    cache_key = (mode, folder_id, None)
    cached = _CACHE.get(cache_key)
    # 캐시 miss 시 한 번 계산
    if not cached:
        if mode == 'name':
            by_name(folder_id=folder_id, refresh=True)
        elif mode == 'image':
            by_image(folder_id=folder_id, refresh=True)
        elif mode == 'detail':
            by_detail(folder_id=folder_id, refresh=True)
        cached = _CACHE.get(cache_key)
        if not cached:
            return {'items': []}
    meta = cached['meta']
    members = [m for m in meta.values() if m.get('group_key') == group_key]
    members.sort(key=lambda m: (m.get('market_price') or 0, m['id']))
    return {'items': members}


def delete_products(ids: list[int]) -> dict:
    """⚠ 실제 삭제 (DB row 제거). 신중히.
    CLAUDE.md 원칙: 원본 상품 DELETE 금지 — 우리는 naver_my_product 미러일 뿐 11st 원본 아니므로 안전.
    """
    if not ids:
        return {'ok': False, 'error': 'ids required'}
    ids = [int(x) for x in ids]
    ph = ','.join(['%s'] * len(ids))
    with connections[DB].cursor() as cur:
        cur.execute(f"DELETE FROM naver_my_product WHERE id IN ({ph})", ids)
        _CACHE.clear()
        return {'ok': True, 'deleted': cur.rowcount}
