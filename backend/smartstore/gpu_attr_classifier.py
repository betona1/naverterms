"""GPU 멀티모달 속성 분류기 — 상품명 + 대표이미지(썸네일) + 상세 → 속성값 분류.

원칙: 확실한 것만(확신 없으면 null). 네이버 커머스 API로 실제 대표이미지/상세 취득 →
qwen2.5vl(GPU) 멀티모달 분류 → register_for_sku 로 실등록.
"""
from __future__ import annotations

import json
import re
import requests
from django.db import connections

from . import thumbnail_vision_service as tv
from . import smartstore_product_service as sps
from . import missing_attrs_service

MYPRODUCT_DB = 'myproduct'
HTTP_TIMEOUT = 120

_SYS = (
    "너는 네이버 쇼핑 상품속성 분류기다. 상품명·상세설명·상품이미지를 보고 각 속성의 정답 후보 1개를 고른다.\n"
    "규칙: 1) 상품 정보로 '확실히' 판단되는 것만. 애매하면 반드시 null. 추측 금지.\n"
    "2) 후보 목록의 seq 숫자만 사용. 속성당 1개.\n"
    "3) 수치범위(길이/수량/무게 등)는 정보에 명시된 경우만.\n"
    "출력은 평면 JSON 하나 — 키=속성seq(숫자), 값=고른 후보seq(숫자) 또는 null. 설명/코드펜스 금지."
)

_RANGE_HINT = re.compile(r'(길이|수량|무게|중량|용량|크기|사이즈|개수|두께|폭|높이|지름|용량|cm|mm|kg)')
# 등록 금지 값 (의미없음/추측)
_SKIP_VAL = {'해당없음', '없음', '기타', '-', '직접입력', '기타(직접입력)', '상관없음', '없슴'}
# 범위형 후보값 패턴 (예: "11cm ~ 15cm", "~ 50매", "11g 이상") — 추측 위험, 등록 금지
_RANGE_VAL = re.compile(r'~|이상|이하|미만|초과|\d+\s*(cm|mm|kg|g|ml|l|m)\b', re.I)


def _token(store_id: int) -> str:
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute("SELECT commerce_api_key, commerce_secret_key FROM smartstoreIdList WHERE id=%s", [store_id])
        ak, sk = c.fetchone()
    return sps._get_access_token(ak, sk)


def _product_payload(seller_code: str, store_id: int, token: str) -> dict | None:
    """커머스 API GET → 상품명/대표이미지/상세/현재속성seq + opno."""
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute("SELECT origin_product_no, name FROM smartstore_product WHERE seller_management_code=%s AND store_id=%s LIMIT 1",
                  [seller_code, store_id])
        r = c.fetchone()
    if not r or not r[0]:
        return None
    opno, name = r
    try:
        det = requests.get(sps.NAVER_PRODUCT_DETAIL_URL.format(opno),
                           headers={'Authorization': f'Bearer {token}'}, timeout=20).json()
    except Exception:
        return None
    op = det.get('originProduct', {}) or {}
    imgs = op.get('images', {}) or {}
    rep = (imgs.get('representativeImage') or {}).get('url')
    detail = re.sub(r'<[^>]+>', ' ', op.get('detailContent') or '')[:500]
    cur = {a.get('attributeSeq') for a in (op.get('detailAttribute', {}) or {}).get('productAttributes', []) or []}
    return {'opno': opno, 'name': op.get('name') or name, 'image': rep, 'detail': detail, 'current': cur}


def _missing(seller_code: str, store_id: int, current: set) -> list[dict]:
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute("""SELECT attribute_seq, attribute_name, classification_type, candidate_values_json
            FROM smartstore_product_missing_attrs
            WHERE seller_management_code=%s AND store_id=%s AND status='pending'
              AND candidate_count BETWEEN 2 AND 20""", [seller_code, store_id])
        out = []
        for aseq, aname, cls, cj in c.fetchall():
            if aseq in current:
                continue
            if _RANGE_HINT.search(aname):
                continue                      # 수치범위 속성(무게/길이/사이즈 등) — GPU 추측 금지
            try:
                cands = json.loads(cj)
            except Exception:
                continue
            # 의미없음/범위형 후보 제거
            cands = [c for c in cands
                     if c.get('text', '').strip() not in _SKIP_VAL
                     and not _RANGE_VAL.search(c.get('text', ''))]
            if len(cands) < 2:
                continue
            out.append({'seq': aseq, 'name': aname, 'cls': cls, 'cands': cands})
        return out


def _gpu_classify(info: dict, attrs: list[dict], host: str) -> dict:
    """GPU 멀티모달 분류 → {attr_seq: (value_seq, value_text)}."""
    b64 = tv._dl_b64(info['image']) if info.get('image') else None
    lines = [f"상품명: {info['name']}", f"상세설명: {info['detail']}", "", "[속성]"]
    for a in attrs:
        opts = ', '.join(f"{c['seq']}={c['text']}" for c in a['cands'])
        lines.append(f"- {a['name']} (seq={a['seq']}): {opts}")
    ex = attrs[0]
    lines.append(f'\n예: {{"{ex["seq"]}": {ex["cands"][0]["seq"]}}}')
    payload = {'model': 'qwen2.5vl:7b',
               'messages': [{'role': 'user', 'content': _SYS + '\n\n' + '\n'.join(lines),
                             'images': [b64] if b64 else []}],
               'stream': False, 'options': {'temperature': 0.1, 'num_predict': 500}}
    try:
        r = requests.post(f'http://{host}:11434/api/chat', json=payload, timeout=HTTP_TIMEOUT)
        out = (r.json().get('message') or {}).get('content', '') or ''
    except Exception:
        return {}
    m = re.search(r'\{.*\}', out, re.S)
    if not m:
        return {}
    try:
        picked = json.loads(m.group(0))
    except Exception:
        return {}
    valid = {str(a['seq']): {str(c['seq']): c['text'].strip() for c in a['cands']} for a in attrs}
    result = {}
    for aseq, vseq in picked.items():
        if vseq is None or str(aseq) not in valid:
            continue
        if str(vseq) in valid[str(aseq)]:
            vtext = valid[str(aseq)][str(vseq)]
            if vtext in _SKIP_VAL or _RANGE_VAL.search(vtext):
                continue                      # 의미없음/범위형 — 등록 제외
            result[int(aseq)] = (int(vseq), vtext)
    return result


# 재질 약어 → 표준 재질어 (상품명 명시 매칭용)
_MAT_ABBR = {'스텐': '스테인리스', '스뎅': '스테인리스', 'pp': '폴리프로필렌', 'pe': '폴리에틸렌',
             'abs': 'ABS', 'pc': '폴리카보네이트', '스댕': '스테인리스'}


def _name_material_picks(name: str, attrs: list[dict]) -> dict:
    """상품명에 재질이 '명시'된 경우 그 값을 우선(이미지 판단 오버라이드).
    재질/소재 속성에 한해, 후보값(또는 vocab 동의어/약어)이 상품명에 등장하고
    그 매칭이 '유일'할 때만 채택. {attr_seq: (value_seq, value_text)}."""
    from . import attr_fill_service as af
    name_ns = re.sub(r'\s+', '', name or '').lower()
    out = {}
    for a in attrs:
        if '재질' not in a['name'] and '소재' not in a['name']:
            continue
        matched, groups = [], set()
        for c in a['cands']:
            t = c['text'].strip()
            if t in _SKIP_VAL or len(t) < 2:
                continue
            core = re.sub(r'\s+', '', t).lower()
            hit = core in name_ns
            if not hit:                       # vocab 동의어 그룹
                gi = af._VOCAB_LOOKUP.get(t)
                if gi is not None and any(len(s) >= 2 and s.lower() in name_ns for s in af._VOCAB_GROUPS[gi]):
                    hit = True
            if not hit:                       # 약어(스텐→스테인리스 등)
                for ab, full in _MAT_ABBR.items():
                    if ab in name_ns and (full.lower() in core or core in full.lower()):
                        hit = True
                        break
            if hit:
                key = af._VOCAB_LOOKUP.get(t, t)
                if key not in groups:
                    matched.append((c['seq'], t))
                    groups.add(key)
        if len(matched) == 1:                 # 명시 재질이 유일할 때만
            out[a['seq']] = matched[0]
    return out


def classify_sku(seller_code: str, store_id: int, host: str = None, token: str = None,
                 dry_run: bool = False) -> dict:
    host = host or tv.GPU_HOSTS[0]
    token = token or _token(store_id)
    info = _product_payload(seller_code, store_id, token)
    if not info:
        return {'ok': False, 'reason': 'no_product'}
    attrs = _missing(seller_code, store_id, info['current'])
    if not attrs:
        return {'ok': True, 'picked': 0, 'reason': 'no_missing'}
    picks = _gpu_classify(info, attrs, host)
    picks.update(_name_material_picks(info['name'], attrs))  # 상품명 명시 재질 우선
    if not picks:
        return {'ok': True, 'picked': 0, 'attrs': len(attrs)}
    aname = {a['seq']: a['name'] for a in attrs}
    selections = [{'attribute_seq': k, 'value_seq': v[0], 'value_text': v[1]} for k, v in picks.items()]
    if dry_run:
        return {'ok': True, 'dry_run': True, 'picked': len(selections), 'name': info['name'],
                'selections': [{'attr_name': aname.get(k), 'value': v[1]} for k, v in picks.items()]}
    try:
        r = missing_attrs_service.register_for_sku(seller_code, store_id, selections, dry_run=False)
        return {'ok': r.get('ok', False), 'picked': len(selections), 'attrs_set': r.get('attrs_set', 0),
                'error': r.get('error'),
                'selections': [{'attr_name': aname.get(k), 'value': v[1]} for k, v in picks.items()]}
    except Exception as e:
        return {'ok': False, 'picked': len(selections), 'error': str(e)[:150]}


def stage_sku(seller_code: str, store_id: int, host: str = None, token: str = None) -> dict:
    """스테이징 모드 — classify_sku 와 동일(GET+GPU분류)하지만 네이버 PUT 없이
    smartstore_product_missing_attrs 에 추론값만 기록한다.
      SET recommended_value_seq/text, status='classified', reviewed_at=NOW()
    MULTI_SELECT(같은 attr_seq 다중값)는 value_text 콤마조인 + 첫 seq 저장 (sync 가 재도출).
    """
    host = host or tv.GPU_HOSTS[0]
    token = token or _token(store_id)
    info = _product_payload(seller_code, store_id, token)
    if not info:
        return {'ok': False, 'reason': 'no_product'}
    attrs = _missing(seller_code, store_id, info['current'])
    if not attrs:
        return {'ok': True, 'staged': 0, 'reason': 'no_missing'}
    picks = _gpu_classify(info, attrs, host)
    picks.update(_name_material_picks(info['name'], attrs))  # 상품명 명시 재질 우선
    if not picks:
        return {'ok': True, 'staged': 0, 'attrs': len(attrs)}
    aname = {a['seq']: a['name'] for a in attrs}
    staged = 0
    with connections[MYPRODUCT_DB].cursor() as c:
        for aseq, (vseq, vtext) in picks.items():
            c.execute("""
                UPDATE smartstore_product_missing_attrs
                SET recommended_value_seq=%s, recommended_value_text=%s,
                    status='classified', reviewed_at=NOW()
                WHERE seller_management_code=%s AND store_id=%s AND attribute_seq=%s
            """, [vseq, vtext, seller_code, store_id, aseq])
            if c.rowcount:
                staged += 1
    return {'ok': True, 'staged': staged, 'name': info['name'],
            'selections': [{'attr_name': aname.get(k), 'value': v[1]} for k, v in picks.items()]}
