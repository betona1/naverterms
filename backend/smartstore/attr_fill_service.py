"""속성 자동 채움 — 다중후보 속성을 상품명/이미지/상세 기반 LLM으로 "정확한 것만" 선택.

원칙: 상품 정보로 확실히 판단되는 속성만 등록. 측정범위(길이/수량/무게/속도 등)는
정보에 명시 안 되면 null(스킵). 오등록 방지 > 커버리지.
GPU: localhost:11438 (11 GPU 분산 프록시)에 동시 요청.
"""
from __future__ import annotations

import json
import re
from django.db import connections

from . import naver_name_generator as g
from . import missing_attrs_service

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'

# 측정/범위형 속성 키워드 — 정보에 수치 명시 없으면 스킵 (LLM 추측 금지)
_RANGE_HINT = re.compile(r'(길이|수량|무게|중량|용량|속도|크기|사이즈|개수|두께|폭|높이|지름|cm|mm|kg|개$)')

SYS = (
    "너는 네이버 쇼핑 상품속성 분류기다. 상품 정보로 각 속성의 정답 후보를 1개 고른다.\n"
    "규칙:\n"
    "1) 상품 정보로 '확실히' 판단되는 것만 고른다. 애매하면 반드시 null.\n"
    "2) 길이/수량/무게/용량/속도/크기 등 '수치 범위'는 정보에 수치가 명시된 경우만, 아니면 null.\n"
    "3) 상품과 무관한(카테고리 안 맞는) 속성은 전부 null.\n"
    "4) 후보 목록에 있는 seq 숫자만 쓴다. 후보당 1개만(배열 금지).\n"
    "출력은 평면 JSON 1개. 키=속성의 seq숫자(문자열), 값=고른 후보 seq숫자 또는 null.\n"
    "예시) 속성 사용대상(seq=10005212): 10029065=남성용, 10030583=남녀공용 이고 남성용이 맞으면\n"
    "  → {\"10005212\": 10029065}\n"
    "설명/코드블록 없이 JSON만 출력."
)


def _product_info(seller_code: str, store_id: int = None) -> dict | None:
    """상품 정보 — smartstore_product(라이브, missing_attrs와 동일 키) 우선,
    네이버 비전캐시(naver_my_product)는 W코드일 때 보조."""
    with connections[MYPRODUCT_DB].cursor() as cur:
        if store_id:
            cur.execute(
                "SELECT name, whole_category_name, LEFT(detail_content,400) "
                "FROM smartstore_product WHERE seller_management_code=%s AND store_id=%s LIMIT 1",
                [seller_code, store_id])
        else:
            cur.execute(
                "SELECT name, whole_category_name, LEFT(detail_content,400) "
                "FROM smartstore_product WHERE seller_management_code=%s LIMIT 1", [seller_code])
        r = cur.fetchone()
    if not r:
        return None
    vision = ''
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT image_analysis FROM naver_my_product WHERE product_code=%s", [seller_code])
        vr = cur.fetchone()
    if vr and vr[0]:
        try:
            v = json.loads(vr[0])
            vision = ', '.join(f'{k}:{x}' for k, x in v.items() if x)[:300]
        except Exception:
            vision = str(vr[0])[:300]
    return {'name': r[0] or '', 'category': r[1] or '', 'vision': vision,
            'detail': re.sub(r'<[^>]+>', ' ', r[2] or '')[:200]}


def _get_pending_attrs(seller_code: str, store_id: int) -> list[dict]:
    with connections[MYPRODUCT_DB].cursor() as cur:
        cur.execute(
            "SELECT attribute_seq, attribute_name, candidate_values_json, classification_type "
            "FROM smartstore_product_missing_attrs "
            "WHERE seller_management_code=%s AND store_id=%s AND status='pending' AND candidate_count>=2",
            [seller_code, store_id])
        out = []
        for aseq, aname, cj, cls in cur.fetchall():
            try:
                cands = json.loads(cj)
            except Exception:
                continue
            out.append({'seq': aseq, 'name': aname, 'candidates': cands, 'cls': cls})
        return out


def pick_for_sku(info: dict, attrs: list[dict], url: str = None, model: str = None) -> dict:
    """LLM으로 속성별 정답 후보 seq 선택. {attr_seq: value_seq} (확신한 것만)."""
    url = url or g.DEFAULT_OLLAMA_URL
    model = model or g.DEFAULT_MODELS[0]
    lines = [f"상품명: {info['name']}", f"카테고리: {info['category']}"]
    if info.get('vision'):
        lines.append(f"이미지분석: {info['vision']}")
    if info.get('detail'):
        lines.append(f"상세: {info['detail']}")
    lines.append("\n[속성 후보]")
    valid = {}
    for a in attrs:
        opts = ', '.join(f"{c['seq']}={c['text'].strip()}" for c in a['candidates'])
        lines.append(f"- {a['name']} (seq={a['seq']}): {opts}")
        valid[str(a['seq'])] = {str(c['seq']): c['text'].strip() for c in a['candidates']}
    user = '\n'.join(lines) + '\n\nJSON:'
    try:
        raw = g._call_ollama(SYS, user, model, url)
    except Exception:
        return {}
    m = re.search(r'\{.*\}', raw, re.S)
    if not m:
        return {}
    try:
        picked = json.loads(m.group(0))
    except Exception:
        return {}
    result = {}
    for aseq, vseq in picked.items():
        if vseq is None:
            continue
        if str(aseq) in valid and str(vseq) in valid[str(aseq)]:
            result[int(aseq)] = (int(vseq), valid[str(aseq)][str(vseq)])
    return result


# 비전 어휘 → 네이버 후보 어휘 동의어 (색상 위주)
SYNONYMS = {
    '빨강': '레드', '빨간색': '레드', '적색': '레드', '레드': '레드',
    '파랑': '블루', '파란색': '블루', '청색': '블루', '하늘색': '스카이블루',
    '노랑': '옐로우', '노란색': '옐로우', '초록': '그린', '녹색': '그린',
    '보라': '퍼플', '보라색': '퍼플', '자주색': '버건디',
    '검정': '블랙', '검은색': '블랙', '흑색': '블랙',
    '하양': '화이트', '하얀색': '화이트', '흰색': '화이트', '백색': '화이트',
    '회색': '그레이', '주황': '오렌지', '주황색': '오렌지', '분홍': '핑크', '분홍색': '핑크',
    '갈색': '브라운', '금색': '골드', '황금색': '골드', '황금': '골드',
    '은색': '실버', '남색': '네이비', '베이지색': '베이지',
}


def _expand_synonyms(text: str) -> str:
    """비전 어휘를 네이버 후보 어휘로 확장 (haystack 보강)."""
    extra = [v for k, v in SYNONYMS.items() if k in text]
    return text + ''.join(extra)


_STRIP_SUFFIX = re.compile(r'(용|형|색|성)$')
_SKIP_VAL = {'기타', '해당없음', '없음', '-', '기타(직접입력)', '직접입력'}


def pick_exact(info: dict, attrs: list[dict]) -> dict:
    """정밀 규칙: 후보 값이 상품명/상세/비전에 '명시'되고 그 속성에서 유일하게 매칭될 때만 선택.
    추측 0. 수치범위 속성은 스킵."""
    hay = re.sub(r'\s+', '', f"{info['name']} {info.get('detail','')} {info.get('vision','')}")
    hay = _expand_synonyms(hay)
    result = {}
    for a in attrs:
        if _RANGE_HINT.search(a['name']):
            continue                      # 길이/수량/무게 등 수치범위 — 명시매칭 위험, 스킵
        matched = []
        for c in a['candidates']:
            t = c['text'].strip()
            if t in _SKIP_VAL or len(t) < 2:
                continue
            core = re.sub(r'\s+', '', t)
            hit = core in hay
            if not hit:
                base = _STRIP_SUFFIX.sub('', core)
                if len(base) >= 2 and base in hay:
                    hit = True
            if hit:
                matched.append((c['seq'], t))
        if len(matched) == 1:             # 유일 매칭만 (모호하면 스킵)
            result[a['seq']] = matched[0]
    return result


# 멀티셀렉트(특징/부가기능 등) 값 동의어 — 상품명 표기 변형 흡수 (정확한 것만)
_MULTI_SYN = {
    '미끄럼방지': ['논슬립', '미끄럼방지', '미끄럼 방지'],
    '방수': ['방수', '워터프루프', '워터푸르프'],
    '생활방수': ['생활방수'],
    '접이식': ['접이식', '폴딩', '접이', '폴더블'],
    '블루투스': ['블루투스', '블루투수', '무선블루투스'],
    '무드등': ['무드등', '무드 등', '무드램프'],
    '저소음': ['저소음', '무소음'],
    '높이조절': ['높이조절', '높이 조절'],
    '밝기조절': ['밝기조절', '밝기 조절', '디밍'],
    '리모컨': ['리모컨', '리모콘'],
    '식기세척기사용': ['식기세척기', '식세기'],
    '전자레인지사용': ['전자레인지', '전자렌지'],
    '오븐사용가능': ['오븐사용', '오븐가능'],
    '친환경': ['친환경'],
    '이동바퀴': ['이동바퀴', '바퀴', '캐스터'],
}


_ASCII_RE = re.compile(r'[A-Za-z0-9]')


def _multi_hit(t: str, hay_ns: str, hay_sp: str) -> bool:
    """멀티셀렉트 값 매칭 — 한글은 무공백 부분일치, 영숫자 포함값은 단어경계 매칭(모델코드 오탐 방지)."""
    core = re.sub(r'\s+', '', t)
    if _ASCII_RE.search(core):
        # 영숫자 포함(4H, RCA, HDMI 등) → 띄어쓰기 유지 원문에서 단어경계 매칭(134HB의 4H 차단, 공백구분 2B는 허용)
        pat = re.compile(r'(?<![A-Za-z0-9])' + re.escape(t) + r'(?![A-Za-z0-9])', re.I)
        return bool(pat.search(hay_sp))
    return core in hay_ns


def pick_multi(info: dict, attrs: list[dict]) -> list[tuple]:
    """MULTI_SELECT 속성 — 상품명/상세에 '그대로 등장'하는 모든 후보값 등록(추측0).
    반환: [(attr_seq, value_seq, value_text), ...] (속성당 다중값 가능)."""
    hay_sp = f"{info.get('name','')} {info.get('detail','')}"
    hay_ns = re.sub(r'\s+', '', hay_sp)
    out = []
    for a in attrs:
        if a.get('cls') != 'MULTI_SELECT':
            continue
        if _RANGE_HINT.search(a['name']):
            continue
        for c in a['candidates']:
            t = c['text'].strip()
            if t in _SKIP_VAL or len(t) < 2:
                continue
            hit = _multi_hit(t, hay_ns, hay_sp)
            if not hit:
                for syn in _MULTI_SYN.get(t, []):
                    if _multi_hit(syn, hay_ns, hay_sp):
                        hit = True
                        break
            if hit:
                out.append((a['seq'], c['seq'], t))
    return out


import hashlib

_VISION_ATTR = {  # 비전 필드 → 매핑 대상 속성명 키워드
    'color': ['색상', '색'],
    'material': ['재질', '소재', '주요소재'],
    'form': ['형태', '종류', '타입'],
}
_MAP_SYS = (
    "너는 어휘 매핑기다. '비전값'이 네이버 후보 중 '같은 의미'의 것이 있으면 그 seq숫자만 출력, "
    "없으면 null. 비슷하지만 다른 건 null. 오직 숫자 또는 null 만 출력."
)


# ── 수작업 큐레이션 매핑사전: 도메인별 동의어 그룹 (비전어휘 + 네이버후보어휘 한 묶음) ──
# 비전 term/상품명 텍스트 와 후보가 같은 그룹이면 동의어. 후보 중 그룹 매칭이 '유일'할 때만 채택.
# 도메인으로 묶어 속성명에 맞는 어휘만 비교(교차 도메인 오매칭 차단).
_VOCAB_BY_DOMAIN = {
    'color': [
        {'레드', '빨강', '빨간색', '적색', '다홍'}, {'블루', '파랑', '파란색', '청색'},
        {'스카이블루', '하늘색', '하늘'}, {'네이비', '남색', '곤색'},
        {'옐로우', '노랑', '노란색'}, {'그린', '초록', '녹색', '연두'},
        {'카키', '카키색'}, {'민트', '민트색'}, {'라벤더', '라벤더색'}, {'코랄', '코랄색', '산호색'},
        {'퍼플', '보라', '보라색', '자주', '자주색'}, {'바이올렛', '바이올렛색'},
        {'블랙', '검정', '검은색', '흑색'}, {'화이트', '하양', '하얀색', '흰색', '백색'},
        {'그레이', '회색', '그레이색', '쥐색'}, {'차콜', '차콜색', '챠콜'},
        {'오렌지', '주황', '주황색'}, {'핑크', '분홍', '분홍색'}, {'핫핑크'},
        {'브라운', '갈색', '밤색'}, {'베이지', '베이지색', '아이보리'},
        {'골드', '금색', '황금색', '황금'}, {'실버', '은색', '은빛'},
        {'카멜', '카멜색'}, {'버건디', '와인색', '와인'}, {'투명', '클리어'},
        {'멀티', '혼합색상', '여러가지색상', '멀티컬러'},
    ],
    'material': [
        {'금속', '메탈', '철제', '스틸', '스테인리스', '스테인레스', '합금', '주철', '메탈소재'},
        {'스테인리스스틸', '스테인레스스틸'}, {'알루미늄', '알루미늄합금', '알류미늄'},
        {'목재', '원목', '우드', '나무', '천연목', '집성목', '고무나무', '소나무', '자작나무'},
        {'합성목재', 'MDF', 'PB', '파티클보드'}, {'라탄', '등나무', '라탄소재'}, {'한지'},
        {'대나무', '죽재', '뱀부'}, {'코르크'},
        {'가죽', '천연가죽', '소가죽', '천연소가죽'}, {'인조가죽', '레쟈', 'PU가죽', '합성가죽', '레자'},
        {'스웨이드'}, {'캔버스', '캔버스천'}, {'펠트', '펠트지'},
        {'플라스틱', 'ABS', 'PP', 'PVC', '합성수지', '아크릴'},
        {'유리', '강화유리', '글라스'}, {'내열유리', '보로실리케이트'},
        {'세라믹', '도자기', '자기', '도기', '본차이나'},
        {'법랑', '에나멜', '법랑코팅'}, {'대리석', '마블'},
        {'실리콘'}, {'고무', '러버', 'TPR'}, {'네오프렌'},
        {'면', '순면', '코튼'}, {'폴리', '폴리에스터', '폴리에스테르'}, {'나일론'},
        {'스판덱스', '스판'}, {'데님'}, {'벨벳', '벨벳지', '우단'}, {'린넨', '리넨', '삼베'},
        {'양모', '캐시미어', '메리노'}, {'티타늄', '티탄'}, {'텅스텐'}, {'백금', '플래티넘'},
        {'종이', '페이퍼', '하드보드'}, {'패브릭', '직물', '원단'},
        {'니켈'}, {'황동', '놋쇠', '브라스', '유기'}, {'구리', '동판'},
        {'카펫', '카페트'}, {'메쉬', '메시', '망사'}, {'트라이탄'}, {'라텍스'},
    ],
    'gender': [
        {'남성용', '남성', '남자', '맨즈'}, {'여성용', '여성', '여자', '우먼', '레이디'},
        {'남녀공용', '공용', '남녀', '유니섹스', '남여공용'},
        {'성인용', '성인', '어른'}, {'아동용', '아동', '어린이', '키즈'},
        {'유아용', '유아', '영아', '베이비'}, {'주니어용', '주니어', '청소년'},
    ],
    'season': [
        {'여름', '여름용', '하절기'}, {'겨울', '겨울용', '동절기', '한파', '방한'},
        {'봄', '봄용'}, {'가을', '가을용'}, {'사계절', '사계절용', '올시즌', '사철'},
        {'환절기', '간절기'},
    ],
    'pattern': [
        {'무지', '민무늬', '솔리드', '무패턴'}, {'플라워', '꽃무늬', '플로럴'},
        {'도트', '땡땡이', '물방울', '폴카도트'}, {'체크', '체크무늬', '격자', '타탄'},
        {'스트라이프', '줄무늬', '스트라입'}, {'레오파드', '호피', '표범무늬'},
        {'지브라', '얼룩말'}, {'카모플라쥬', '카모', '밀리터리', '위장무늬'},
        {'캐릭터'}, {'로고'}, {'레터링'}, {'기하학', '지오메트릭'},
        {'페이즐리'}, {'헤링본'}, {'하트', '하트무늬'}, {'그라데이션'}, {'타이다이'},
    ],
}
# 속성명 키워드 → 도메인 (텍스트 매칭 시 비교할 어휘 한정)
_ATTR_DOMAIN = [
    (('색상', '색'), 'color'),
    (('재질', '소재'), 'material'),
    (('사용대상', '성별', '대상'), 'gender'),
    (('계절', '시즌'), 'season'),
    (('패턴', '무늬'), 'pattern'),
]

_VOCAB_GROUPS = []
_DOMAIN_GIDS = {}
for _dom, _grps in _VOCAB_BY_DOMAIN.items():
    _ids = set()
    for _g in _grps:
        _VOCAB_GROUPS.append(_g)
        _ids.add(len(_VOCAB_GROUPS) - 1)
    _DOMAIN_GIDS[_dom] = _ids
_VOCAB_LOOKUP = {}
for _gi, _grp in enumerate(_VOCAB_GROUPS):
    for _w in _grp:
        _VOCAB_LOOKUP[_w] = _gi


def _attr_domain(name: str) -> str | None:
    for kws, dom in _ATTR_DOMAIN:
        if any(k in name for k in kws):
            return dom
    return None


def _haystack(info: dict) -> str:
    h = re.sub(r'\s+', '', f"{info.get('name','')} {info.get('detail','')} {info.get('vision','')}")
    return _expand_synonyms(h)


def pick_vocab_text(info: dict, attrs: list[dict]) -> dict:
    """확장 매핑사전(도메인 동의어 그룹)으로 상품명/상세/비전 텍스트에서 후보 매칭.
    속성 도메인에 맞는 어휘만 비교, 그룹 단위 유일매칭만 채택(추측 0)."""
    hay = _haystack(info)
    result = {}
    for a in attrs:
        if _RANGE_HINT.search(a['name']):
            continue
        dom = _attr_domain(a['name'])
        if not dom:
            continue
        gids = _DOMAIN_GIDS.get(dom, set())
        by_group = {}                     # gid → (seq, text, literal?) — 그룹별 최선 후보
        for c in a['candidates']:
            t = c['text'].strip()
            if t in _SKIP_VAL or len(t) < 1:
                continue
            gi = _VOCAB_LOOKUP.get(t)
            if gi is None or gi not in gids:
                continue
            grp = _VOCAB_GROUPS[gi]
            if not any(len(s) >= 2 and s in hay for s in grp):
                continue
            literal = re.sub(r'\s+', '', t) in hay   # 후보 자신이 상품명에 직접 등장?
            cur = by_group.get(gi)
            if cur is None or (literal and not cur[2]):  # 구체 후보(literal) 우선
                by_group[gi] = (c['seq'], t, literal)
        if len(by_group) == 1:            # 도메인 내 유일 그룹 매칭만
            seq, txt, _ = next(iter(by_group.values()))
            result[a['seq']] = (seq, txt)
    return result


def pick_by_vocab(seller_code, attrs) -> dict:
    """수작업 매핑사전(동의어 그룹)으로 비전값→후보 선택. LLM 없음, 유일매칭만."""
    v = _get_vision_struct(seller_code)
    if not v:
        return {}
    result = {}
    for a in attrs:
        if _RANGE_HINT.search(a['name']):
            continue
        terms = []
        for vfield, kws in _VISION_ATTR.items():
            if any(k in a['name'] for k in kws):
                val = v.get(vfield)
                terms += ([str(x) for x in val if x] if isinstance(val, list) else ([str(val)] if val else []))
        # 비전 term 들의 그룹 집합
        groups = {_VOCAB_LOOKUP[t] for t in terms if t in _VOCAB_LOOKUP}
        if not groups:
            continue
        matched = [c for c in a['candidates']
                   if _VOCAB_LOOKUP.get(c['text'].strip()) in groups]
        if len(matched) == 1:
            result[a['seq']] = (matched[0]['seq'], matched[0]['text'].strip())
    return result


def _ensure_vocab_table():
    with connections[NAVERDB].cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS naver_attr_vocab_map (
              attr_name VARCHAR(60) NOT NULL,
              vision_term VARCHAR(60) NOT NULL,
              cand_hash CHAR(32) NOT NULL,
              value_seq BIGINT NULL, value_text VARCHAR(120) NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (attr_name, vision_term, cand_hash)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)


def _cand_hash(cands):
    return hashlib.md5('|'.join(sorted(c['text'].strip() for c in cands)).encode()).hexdigest()


def map_term(attr_name, term, cands, url=None, model=None):
    """비전 term → 후보 seq 매핑 (LLM, 캐시). (value_seq, value_text) 또는 None."""
    term = (term or '').strip()
    if not term:
        return None
    _ensure_vocab_table()
    ch = _cand_hash(cands)
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT value_seq, value_text FROM naver_attr_vocab_map WHERE attr_name=%s AND vision_term=%s AND cand_hash=%s",
                    [attr_name, term, ch])
        r = cur.fetchone()
    if r is not None:
        return (r[0], r[1]) if r[0] else None
    # LLM 매핑
    opts = ', '.join(f"{c['seq']}={c['text'].strip()}" for c in cands)
    user = f"속성: {attr_name}\n비전값: {term}\n후보: {opts}\n정답 seq(또는 null):"
    val = (None, None)
    llm_ok = False
    try:
        raw = g._call_ollama(_MAP_SYS, user, model or g.DEFAULT_MODELS[0], url or g.DEFAULT_OLLAMA_URL)
        llm_ok = True
        m = re.search(r'\d{6,}', raw)   # 실제 후보 seq는 6자리 이상
        if m:
            vseq = int(m.group(0))
            hit = next((c for c in cands if int(c['seq']) == vseq), None)
            if hit:
                val = (vseq, hit['text'].strip())
    except Exception:
        pass
    if llm_ok:   # 성공(정답/명시null)일 때만 캐시. 타임아웃/예외는 캐시 안 함(재시도)
        with connections[NAVERDB].cursor() as cur:
            cur.execute("INSERT IGNORE INTO naver_attr_vocab_map (attr_name,vision_term,cand_hash,value_seq,value_text) VALUES (%s,%s,%s,%s,%s)",
                        [attr_name, term, ch, val[0], val[1]])
    return val if val[0] else None


def _get_vision_struct(seller_code):
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT image_analysis FROM naver_my_product WHERE product_code=%s", [seller_code])
        r = cur.fetchone()
    if not r or not r[0]:
        return None
    try:
        return json.loads(r[0])
    except Exception:
        return None


def pick_by_vision(seller_code, store_id, attrs, url=None, model=None):
    """비전 추출값을 후보 어휘로 매핑(LLM)해서 속성 선택. {attr_seq:(vseq,vtext)}."""
    v = _get_vision_struct(seller_code)
    if not v:
        return {}
    result = {}
    for a in attrs:
        if _RANGE_HINT.search(a['name']):
            continue
        # 이 속성에 해당하는 비전 필드 찾기
        terms = []
        for vfield, kws in _VISION_ATTR.items():
            if any(k in a['name'] for k in kws):
                val = v.get(vfield)
                if isinstance(val, list):
                    terms += [str(x) for x in val if x]
                elif val:
                    terms.append(str(val))
        for term in terms:
            mp = map_term(a['name'], term, a['candidates'], url=url, model=model)
            if mp:
                result[a['seq']] = mp
                break
    return result


def process_sku(seller_code: str, store_id: int, url: str = None, model: str = None,
                dry_run: bool = False, mode: str = 'llm') -> dict:
    info = _product_info(seller_code, store_id)
    if not info:
        return {'ok': False, 'reason': 'no_product_info', 'picked': 0}
    attrs = _get_pending_attrs(seller_code, store_id)
    if not attrs:
        return {'ok': True, 'picked': 0, 'reason': 'no_pending'}
    source = {}
    if mode == 'exact':
        picks = pick_exact(info, attrs)
    elif mode == 'vision':
        picks = pick_exact(info, attrs)                       # 명시값 우선
        for aseq, mp in pick_by_vocab(seller_code, attrs).items():
            picks.setdefault(aseq, mp)                        # 수작업 매핑사전 보강 (LLM 없음)
    elif mode == 'auto':
        # AI 자동체크: 상품명/상세 명시값(exact) → 확장 매핑사전 텍스트매칭 → 비전 매핑사전, 모두 유일매칭만
        picks = {}
        for aseq, mp in pick_exact(info, attrs).items():
            picks[aseq] = mp; source[aseq] = '명시'          # 1) 상품명·상세 명시값(단일)
        for aseq, mp in pick_vocab_text(info, attrs).items():
            if aseq not in picks:
                picks[aseq] = mp; source[aseq] = '사전'      # 2) 도메인 사전 텍스트매칭
        for aseq, mp in pick_by_vocab(seller_code, attrs).items():
            if aseq not in picks:
                picks[aseq] = mp; source[aseq] = '비전'      # 3) 비전 분석값 사전매핑
    else:
        picks = pick_for_sku(info, attrs, url=url, model=model)
    # 4) MULTI_SELECT — 상품명에 등장하는 모든 후보값 (auto 모드만)
    multi = pick_multi(info, attrs) if mode == 'auto' else []
    # picks 에서 다룬(단일) 속성과 겹치면 멀티가 우선 (여러 값 등록)
    multi_aseqs = {m[0] for m in multi}
    picks = {a: v for a, v in picks.items() if a not in multi_aseqs}
    if not picks and not multi:
        return {'ok': True, 'picked': 0, 'attrs': len(attrs)}
    aname = {a['seq']: a['name'] for a in attrs}
    selections = [{'attribute_seq': aseq, 'value_seq': vseq, 'value_text': vtext}
                  for aseq, (vseq, vtext) in picks.items()]
    selections += [{'attribute_seq': aseq, 'value_seq': vseq, 'value_text': vtext}
                   for aseq, vseq, vtext in multi]
    for aseq in multi_aseqs:
        source.setdefault(aseq, '명시(다중)')
    if dry_run:
        disp = [{'attr_seq': s['attribute_seq'], 'attr_name': aname.get(s['attribute_seq'], ''),
                 'value': s['value_text'], 'source': source.get(s['attribute_seq'], mode)}
                for s in selections]
        return {'ok': True, 'dry_run': True, 'picked': len(selections),
                'name': info.get('name', ''), 'selections': disp}
    try:
        r = missing_attrs_service.register_for_sku(
            seller_management_code=seller_code, store_id=store_id, selections=selections, dry_run=False)
        return {'ok': r.get('ok', False), 'picked': len(selections), 'attrs_set': r.get('attrs_set', 0),
                'error': r.get('error')}
    except Exception as e:
        return {'ok': False, 'picked': len(selections), 'error': str(e)[:150]}
