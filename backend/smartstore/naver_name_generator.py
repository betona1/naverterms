"""네이버 전용 상품명 생성기 — Ollama 직접 호출 + 후처리.

명세서: docs/naver_product_name_seo.md
구현 책임:
  - LLM 프롬프트로 자연스러운 네이버 상품명 1차 생성
  - 후처리로 SEO 룰 강제(특수문자/금지어/중복/길이)
  - DB 저장 (naver_my_product.naver_product_name + synced_at)

Phase 4-A: 단건 동기 호출. Phase 4-B 에서 큐/워커 듀얼 모드.
"""
from __future__ import annotations

import os
import re
import time
import logging

import requests
from django.db import connections

from . import naver_vision_analyzer

logger = logging.getLogger(__name__)

# ── Ollama 설정 ──────────────────────────────────────────
# env OLLAMA_URL_OVERRIDE (워커용) 또는 NAVER_OLLAMA_URL > localhost 11438.
DEFAULT_OLLAMA_URL = (
    os.environ.get('OLLAMA_URL_OVERRIDE')
    or os.environ.get('NAVER_OLLAMA_URL')
    or 'http://localhost:11438'
)
DEFAULT_MODELS = ['exaone3.5:7.8b', 'qwen2.5:7b']
HTTP_TIMEOUT = float(os.environ.get('NAVER_OLLAMA_TIMEOUT', '60'))

# ── 네이버 상품명 한도 ───────────────────────────────────
NAVER_MAX_CHARS = 50    # 권장값 (네이버 권고)
NAVER_MAX_BYTES = 100   # 한글 2바이트 환산
NAVER_MIN_CHARS = 4

# ── 허용 특수문자 (네이버 공식) ──────────────────────────
ALLOWED_SYMBOLS = set('()-·[]/&+,~.')

# ── 절대 금지 substring (수식어/홍보/과장/혜택/배송) ─────
BANNED_SUBSTRINGS = [
    # 수식어
    '최고급', '프리미엄급', '명품급', '프리미엄',
    # 과장/홍보
    '최저가', '최고가', '최고', '최상', '최강',
    '1위', '1등', 'BEST', 'best', '베스트셀러', '베스트', '인기',
    '정품', '공식', '100%',
    '기적의', '신비한', '마법의', '확실한 효과',
    # 신상/리뉴얼
    '신상품', '신상', '리뉴얼', '업그레이드',
    # 혜택/할인
    '할인', '쿠폰', '이벤트', '사은품',
    # 배송 조건
    '무료배송', '당일발송', '당일출고',
]

# ── 회사형태 접두 (예: (주)나인조이, 주식회사 ...) ───────
_COMPANY_PREFIX_RE = re.compile(
    r'(?:\(\s*[주유재사]\s*\)|'
    r'(?:주식회사|유한회사|유한책임회사|합자회사|합명회사|협동조합|사단법인|재단법인))\s*'
)


def calc_byte_length(text: str) -> int:
    """한글 2바이트, 그 외 1바이트."""
    if not text:
        return 0
    return sum(2 if '가' <= ch <= '힣' else 1 for ch in text)


def _is_allowed_char(ch: str) -> bool:
    """네이버 허용 문자: 한글/영문/숫자/공백/허용특수문자."""
    if ch.isspace():
        return True
    if ch.isascii() and ch.isalnum():
        return True
    # 한글 음절
    if '가' <= ch <= '힣':
        return True
    # 한글 자모(분리된)도 허용 — 다만 ㅋㅎㅠㅜ는 BANNED 에서 별도 제거
    if 'ㄱ' <= ch <= 'ㅣ':
        return True
    if ch in ALLOWED_SYMBOLS:
        return True
    return False


def _strip_disallowed_chars(text: str) -> str:
    """허용 집합 외 모든 문자 제거 (한자/일본어/이모지/금지특수문자 등)."""
    return ''.join(c for c in text if _is_allowed_char(c))


def _strip_meaningless_jamo(text: str) -> str:
    """ㅋ ㅎ ㅠ ㅜ 같은 의미 없는 자모 제거."""
    return re.sub(r'[ㄱ-ㅎㅏ-ㅣ]+', '', text)


def _strip_banned_substrings(text: str) -> str:
    """금지 substring 제거 (대소문자 무시)."""
    out = text
    for bad in BANNED_SUBSTRINGS:
        out = re.sub(re.escape(bad), '', out, flags=re.IGNORECASE)
    return out


def _strip_company_prefix(text: str) -> str:
    """(주)/주식회사 등 회사형태 접두 제거."""
    return _COMPANY_PREFIX_RE.sub('', text)


def _dedupe_tokens(text: str) -> str:
    """공백 기준 토큰화 → 동일 토큰 중복 제거(앞에 나온 것 유지).
    브랜드명 1회만 표기 + 키워드 반복 금지 룰.
    """
    seen = set()
    out = []
    for tok in text.split():
        key = tok.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tok)
    return ' '.join(out)


def _normalize_whitespace(text: str) -> str:
    out = re.sub(r'\s+', ' ', text).strip()
    out = out.strip('"\'`「」『』')
    # 허용 특수문자 양옆의 공백 정리는 안 함 (자연스러움 유지)
    return out


def _truncate_to_naver_limit(text: str) -> str:
    """50자 / 100바이트 둘 다 만족. 단어 경계 우선."""
    if len(text) <= NAVER_MAX_CHARS and calc_byte_length(text) <= NAVER_MAX_BYTES:
        return text
    out = ''
    for p in text.split(' '):
        cand = (out + ' ' + p).strip()
        if len(cand) > NAVER_MAX_CHARS or calc_byte_length(cand) > NAVER_MAX_BYTES:
            break
        out = cand
    if out:
        return out
    # 단어 1개도 한도 초과 → 강제 자르기
    for i in range(len(text), 0, -1):
        s = text[:i]
        if len(s) <= NAVER_MAX_CHARS and calc_byte_length(s) <= NAVER_MAX_BYTES:
            return s.strip()
    return ''


def postprocess(text: str) -> str:
    """LLM 응답 1차 라인 → 모든 SEO 후처리 적용."""
    out = _strip_company_prefix(text)
    out = _strip_disallowed_chars(out)
    out = _strip_meaningless_jamo(out)
    out = _strip_banned_substrings(out)
    out = _normalize_whitespace(out)
    out = _dedupe_tokens(out)
    out = _truncate_to_naver_limit(out)
    return out


# ── LLM 프롬프트 ─────────────────────────────────────────

_SYSTEM_PROMPT = f"""당신은 네이버 쇼핑 상품명 SEO 전문가입니다.
오너클랜 위탁판매 상품 정보를 보고 네이버 검색 노출에 최적화된 상품명을 만드세요.

[글자 수]
- 권장 50자 이내 / 최대 {NAVER_MAX_CHARS}자, {NAVER_MAX_BYTES}바이트 (한글 2바이트)
- 50자 이상은 네이버가 "남용"으로 판단해 노출 패널티

[필드 순서]
1. 브랜드/제조사 (1회만)
2. 시리즈 / 모델명
3. 상품 유형
4. 색상 / 소재
5. 패키지 수량 / 사이즈
6. 성별·나이 / 속성(용량·무게·연식·호수)
7. 용도/시즌 키워드 (롱테일)

[전략]
- 자연스러운 문장 구조 (단순 키워드 나열 금지)
- 롱테일 키워드 조합 우선 (메인키워드 단독보다 세부키워드 조합이 노출 유리)
- 핵심 정보는 앞쪽 25자 안에 배치

[색상 규칙 — 매우 중요]
- 입력에 "⭐ 상품 옵션1번 색상(필수반영): X" 가 있으면 **반드시 X** 를 색상으로 사용
- 그게 없고 비전이 추측한 색상만 있을 때:
  * 원본 상품명/카테고리/키워드에 다른 색상 단어가 없으면 **색상 단어를 상품명에 넣지 마**
  * 비전 추측만으로 색상 박는 건 금지 (오류 위험)
- 비전 색상과 옵션 색상이 다르면 옵션 색상이 정답

[절대 금지]
- 수식어: "고급", "프리미엄", "최고급", "명품급"
- 홍보문구: "인기", "베스트", "베스트셀러", "1위", "BEST", "신상", "신상품"
- 과장: "최저가", "최고", "정품", "공식", "100%", "기적의"
- 혜택/배송: "할인", "쿠폰", "무료배송", "당일발송", "이벤트"
- 브랜드명 중복 (반드시 1회만)
- 같은 단어 반복 (네이버는 키워드 반복을 스팸으로 간주)
- 카테고리명 그대로 사용 (카테고리는 별도 필드)
- 셀러/쇼핑몰명 삽입
- 특수문자: ! ? @ # $ * ★ ☆ ※ ▶ ◆ → 등 (허용: ( ) - · [ ] / & + , ~ .)
- 한자, 일본어, 이모지
- 가격/할인 정보

[좋은 예]
- "유니클로 남성 여름 린넨 반팔 셔츠 네이비 L"
- "락앤락 스테인리스 텀블러 500ml 2개입 직장인 보온"
- "정관장 홍삼정 6년근 100g 선물세트"
- "차량용 대용량 디퓨저 500ml 차박 캠핑 선물용"

[나쁜 예]
- "★최저가★ 베스트셀러 1위! 프리미엄 텀블러!!!"  (특수문자 + 홍보 + 과장)
- "텀블러 텀블러 보온 텀블러 500ml"  (반복)
- "(주)락앤락 카테고리:생활용품 텀블러 가격:9900원"  (회사형태 + 카테고리 + 가격)

[출력 형식]
상품명 한 줄만 출력. 설명/따옴표/번호/이모지/markdown 절대 금지.
"""


# ── 카테고리 타입 추론 + 카테고리별 룰 ───────────────────────

def _infer_category_type(category_name: str | None) -> str:
    """category_name 의 1~2 depth 보고 카테고리 타입 추론.
    반환: 'apparel' / 'food' / 'kitchen' / 'living' / 'beauty' / 'electronics' / 'baby' / 'pet' / 'sports' / 'office' / 'general'
    """
    if not category_name:
        return 'general'
    s = category_name.lower()
    # 의류 / 패션
    if any(k in category_name for k in ('패션의류', '의류>', '아우터', '상의', '하의', '원피스', '점퍼', '자켓', '코트', '니트', '셔츠', '티셔츠', '드레스', '바지')):
        return 'apparel'
    if any(k in category_name for k in ('가방', '잡화', '신발', '시계', '주얼리', '액세서리')):
        return 'fashion_acc'
    # 식품
    if any(k in category_name for k in ('식품', '음료', '건강식품', '간식', '농수산')):
        return 'food'
    # 주방
    if any(k in category_name for k in ('주방용품', '주방>', '식기', '조리도구', '냄비', '프라이팬')):
        return 'kitchen'
    # 화장품/뷰티
    if any(k in category_name for k in ('화장품', '뷰티', '미용', '스킨케어', '메이크업')):
        return 'beauty'
    # 가전
    if any(k in category_name for k in ('가전', 'TV>', '냉장고', '세탁기', '컴퓨터', '노트북', '스마트폰', '디지털')):
        return 'electronics'
    # 출산/유아
    if any(k in category_name for k in ('출산', '유아', '아기', '아동', '베이비')):
        return 'baby'
    # 반려동물
    if any(k in category_name for k in ('반려', '강아지', '고양이', '펫', '애견')):
        return 'pet'
    # 스포츠
    if any(k in category_name for k in ('스포츠', '레저', '운동', '캠핑', '낚시', '자전거', '골프')):
        return 'sports'
    # 사무용품
    if any(k in category_name for k in ('사무용품', '문구', '도서')):
        return 'office'
    # 생활용품
    if any(k in category_name for k in ('생활/건강', '생활용품', '욕실', '세제', '정리')):
        return 'living'
    return 'general'


_CATEGORY_PROMPTS: dict[str, str] = {
    'apparel': """
[패션의류 전용 룰 — 매우 중요]
- 필드 순서: [브랜드] [성별] [시즌(선택)] [소재(선택)] [상품유형] [색상] [사이즈(선택)] [핏/디테일(선택)]
- 좋은 예: "유니클로 남성 여름 린넨 반팔 셔츠 네이비 L 루즈핏"
- 좋은 예: "여성 가을 면 혼방 후드 자켓 블랙 오버핏"
- 성별: 원본/카테고리에서 명확하면 반드시 명시. 불명확하면 생략 (혼성 표기 금지)
- 시즌: 1개만 — '봄가을' 같은 합성은 OK. "봄,가을,겨울" 동시 나열 금지
- 사이즈: 원본/옵션에 명시되어 있으면 끝쪽에 추가, 추측 금지
- 핏: 원본/비전에 있을 때만 ("루즈핏/오버핏/슬림핏/레귤러핏") — 추측 금지
- 소매 길이(반팔/긴팔/민소매): 원본에 명시되어 있을 때만 (사진은 신뢰도 낮음)
""",
    'fashion_acc': """
[패션잡화 전용 룰]
- 필드 순서: [브랜드] [성별/연령] [재질] [상품유형] [색상] [사이즈/용량]
- 예: "닥스 남성 가죽 장지갑 블랙"
- 예: "여성 캔버스 토트백 베이지 대용량"
""",
    'food': """
[식품 전용 룰]
- 필드 순서: [브랜드/생산자] [상품명] [원재료/원산지] [중량] [패키지 수량] [용도]
- 예: "정관장 홍삼정 6년근 100g 선물세트"
- 예: "지리산 9회 용융죽염 300g 고체 미네랄"
- "국산/국내산" 명시되어 있으면 반드시 포함
- 신선식품: 원산지/등급 우선
""",
    'kitchen': """
[주방용품 전용 룰]
- 필드 순서: [브랜드] [재질] [상품유형] [용량/사이즈] [패키지 수량] [색상] [용도]
- 예: "락앤락 스테인리스 텀블러 500ml 2개입 보온"
- 예: "테팔 인덕션 프라이팬 28cm 논스틱"
- 재질이 중요 — 명시되어 있으면 반드시 포함 (스테인리스/유리/실리콘/도자기)
""",
    'living': """
[생활용품 전용 룰]
- 필드 순서: [브랜드] [재질] [상품명] [용량/사이즈] [패키지 수량] [용도/장소]
- 예: "옥시 표백제 1.5L 4개입 흰빨래용"
- 예: "디플로 욕실 미끄럼방지 매트 그레이 60x40"
""",
    'beauty': """
[뷰티/화장품 전용 룰]
- 필드 순서: [브랜드] [라인/시리즈] [상품유형] [용량] [효능/기능]
- 예: "이니스프리 그린티 세럼 80ml 수분"
- 효능 어뷰징 금지 ("주름개선/미백" 류는 식약처 인증 표기 있는 경우만)
""",
    'electronics': """
[가전/디지털 전용 룰]
- 필드 순서: [브랜드] [모델명/코드] [상품유형] [핵심 스펙] [색상]
- 예: "삼성 BESPOKE 비스포크 냉장고 4도어 875L 화이트"
- 예: "LG 그램 17 노트북 i7 16GB 512GB 실버"
- 모델명 정확 표기 (예: BR-300 같은 코드)
""",
    'baby': """
[출산/유아 전용 룰]
- 필드 순서: [브랜드] [개월수/연령] [상품유형] [재질] [색상] [사이즈]
- 예: "맘앤리틀 0-12개월 신생아 모자 면 베이지"
- 안전/친환경 단어 OK ("유기농/오가닉/안전인증")
""",
    'pet': """
[반려동물 전용 룰]
- 필드 순서: [브랜드] [대상(강아지/고양이)] [상품유형] [재질/맛] [중량/사이즈]
- 예: "로얄캐닌 강아지 사료 어덜트 7kg"
- 대상 종 명확 표기
""",
    'sports': """
[스포츠/레저 전용 룰]
- 필드 순서: [브랜드] [성별(선택)] [종목/용도] [상품유형] [재질/사이즈] [색상]
- 예: "콜핑 남성 등산화 방수 280mm 블랙"
- 예: "캠핑 4인용 텐트 방수 차박 텐트 그레이"
""",
    'office': """
[사무용품/문구 전용 룰]
- 필드 순서: [브랜드] [상품유형] [규격/사이즈] [수량] [색상] [용도]
- 예: "모나미 153 볼펜 검정 0.7mm 12자루"
- 예: "옥스포드 A4 노트 80매 라인 5권"
""",
}


def _fetch_relevance_cache(product_id: int) -> tuple[list, list] | None:
    """GPU 검증 캐시 가장 최근 1건 — 이 상품의 가장 큰 키워드 셋 우선.
    반환: (relevant, irrelevant) 또는 None.
    """
    try:
        from django.db import connections as _conns
        import json as _json
        with _conns['naverdb'].cursor() as cur:
            cur.execute(
                "SELECT relevant_keywords, irrelevant_keywords FROM keyword_relevance_cache "
                "WHERE product_id=%s ORDER BY fetched_at DESC LIMIT 1",
                [product_id],
            )
            row = cur.fetchone()
            if not row:
                return None
            rel = row[0] if isinstance(row[0], list) else (_json.loads(row[0]) if row[0] else [])
            irrel = row[1] if isinstance(row[1], list) else (_json.loads(row[1]) if row[1] else [])
            return rel or [], irrel or []
    except Exception:
        return None


def _build_user(p: dict, vision: dict | None = None) -> str:
    parts = [f'원본 상품명: {p.get("product_name") or ""}']
    if p.get('ai_product_name'):
        parts.append(f'11번가 AI상품명(참고만): {p["ai_product_name"]}')

    # 카테고리 별 룰 — system 보다 우선되는 카테고리 특화 가이드
    cat_type = _infer_category_type(p.get('category_name'))
    cat_rule = _CATEGORY_PROMPTS.get(cat_type)
    if cat_rule:
        parts.append(cat_rule.strip())

    if p.get('category_name'):
        parts.append(f'카테고리: {p["category_name"]}')

    # GPU 적합도 캐시 — 이전 검증에서 사용자가 인증한 키워드 우선 활용 + 부적합 회피
    pid = p.get('id')
    if pid:
        cached = _fetch_relevance_cache(int(pid))
        if cached:
            rel, irrel = cached
            if rel:
                parts.append(f'⭐ GPU 검증 적합 키워드(이 단어 우선 활용): {", ".join(rel[:20])}')
            if irrel:
                parts.append(f'🚫 GPU 검증 부적합 키워드(절대 사용 금지): {", ".join(irrel[:20])}')
    if p.get('brand'):
        parts.append(f'브랜드: {p["brand"]}')
    if p.get('manufacturer'):
        parts.append(f'제조사: {p["manufacturer"]}')
    if p.get('model_name'):
        parts.append(f'모델명: {p["model_name"]}')
    if p.get('keywords'):
        parts.append(f'키워드: {p["keywords"]}')

    # 옵션1번 색상 — 공급사 등록 정보로 신뢰도 높음. 비전 색상보다 우선.
    try:
        from . import naver_my_product_service as _s
        opt_color = _s._first_option_color(p.get('option1_name'), p.get('option1_values'))
        if opt_color:
            parts.append(f'⭐ 상품 옵션1번 색상(필수반영): {opt_color}')
    except Exception:
        opt_color = None

    # 상세 페이지 추출 키워드 (있을 때만, 상위 12개) — 사진에 안 보이는 정보 (소재/스펙) 보강
    detail_html = p.get('detail_html')
    if detail_html:
        try:
            from . import naver_my_product_service as _s
            dks = _s._extract_html_keywords(detail_html, max_words=12)
            if dks:
                parts.append(f'상세페이지 키워드: {", ".join(dks)}')
        except Exception:
            pass

    # 이미지 분석 결과(있을 때만) — 비전 모델이 본 시각 속성
    if vision:
        v_lines = ['', '── 이미지 분석 결과(비전 모델) — 참고용 ──']
        if vision.get('color'):
            colors_str = ", ".join(vision["color"]) if isinstance(vision["color"], list) else vision["color"]
            # 옵션 색상과 비전 색상 불일치 시 옵션 우선 명시
            if opt_color and colors_str and opt_color not in colors_str:
                v_lines.append(f'색상(비전 추측 — 옵션과 불일치, 옵션 우선): {colors_str}')
            else:
                v_lines.append(f'색상: {colors_str}')
        if vision.get('material'):
            v_lines.append(f'소재: {vision["material"]}')
        if vision.get('form'):
            v_lines.append(f'형태/유형: {vision["form"]}')
        if vision.get('package_qty'):
            v_lines.append(f'패키지: {vision["package_qty"]}')
        if vision.get('key_features'):
            feats = vision['key_features']
            v_lines.append(f'특징 키워드: {", ".join(feats) if isinstance(feats, list) else feats}')
        if vision.get('readable_text'):
            v_lines.append(f'이미지 내 글자: {vision["readable_text"]}')
        if len(v_lines) > 2:
            parts.extend(v_lines)

    return '\n'.join(parts) + '\n\n네이버 최적화 상품명:'


def _call_ollama(system: str, user: str, model: str, url: str) -> str:
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'stream': False,
        'options': {'temperature': 0.3, 'num_predict': 200},
    }
    r = requests.post(f'{url}/api/chat', json=payload, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    return (data.get('message') or {}).get('content', '') or ''


def _extract_first_line(text: str) -> str:
    """LLM 응답에서 첫 비어있지 않은 라인 추출 + 라벨/번호 제거."""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        s = re.sub(r'^[-*0-9]+[\.)]\s*', '', s).strip()
        s = re.sub(r'^(네이버\s*)?(최적화\s*)?상품명\s*[:：]\s*', '', s).strip()
        s = re.sub(r'^["\'`「『]', '', s)
        s = re.sub(r'["\'`」』]$', '', s)
        if s:
            return s
    return ''


# ── DB 접근 ──────────────────────────────────────────────

def _fetch_product(product_id: int) -> dict | None:
    fields = (
        'id, product_code, product_name, ai_product_name, ai_recommended_name, '
        'category_name, brand, manufacturer, model_name, keywords, detail_html, '
        'option1_name, option1_values'
    )
    with connections['naverdb'].cursor() as cur:
        cur.execute(f"SELECT {fields} FROM naver_my_product WHERE id=%s", [product_id])
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        return dict(zip(cols, row))


def _save_naver_name(product_id: int, name: str):
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product SET naver_product_name=%s, synced_at=NOW() WHERE id=%s",
            [name, product_id],
        )


# ── Public API ───────────────────────────────────────────

def generate_naver_name(product_id: int,
                        url: str | None = None,
                        models: list[str] | None = None,
                        use_vision: bool = True) -> dict:
    """단건 네이버 상품명 생성. (옵션) 이미지 분석 캐시 활용 → Ollama → SEO 후처리 → DB 저장.

    use_vision=True 일 때:
      - DB에 image_analysis 캐시가 있으면 그것 사용
      - 없으면 naver_vision_analyzer.analyze_product_image() 호출 후 캐시 생성
      - 이미지 분석 실패해도 텍스트 모델로 계속 진행 (graceful)
    """
    p = _fetch_product(product_id)
    if not p:
        return {'ok': False, 'error': 'not_found'}

    use_url = url or DEFAULT_OLLAMA_URL
    use_models = models or DEFAULT_MODELS

    vision_result: dict | None = None
    vision_meta: dict = {}
    if use_vision:
        cached = naver_vision_analyzer.get_cached_analysis(product_id)
        if cached:
            vision_result = cached
            vision_meta = {'vision_cached': True}
        else:
            # 텍스트 호출과 같은 endpoint 사용 — 11 GPU 분산
            va = naver_vision_analyzer.analyze_product_image(product_id, url=url or use_url)
            if va.get('ok'):
                vision_result = va.get('analysis')
                vision_meta = {
                    'vision_cached': False,
                    'vision_model': va.get('model'),
                    'vision_elapsed_ms': va.get('elapsed_ms'),
                }
            else:
                vision_meta = {'vision_error': va.get('error')}

    user = _build_user(p, vision=vision_result)
    last_err = None
    t0 = time.time()
    for model in use_models:
        try:
            raw = _call_ollama(_SYSTEM_PROMPT, user, model, use_url)
        except Exception as e:
            last_err = str(e)[:200]
            logger.warning('ollama %s 실패: %s', model, e)
            continue

        first = _extract_first_line(raw)
        if not first:
            continue
        result = postprocess(first)
        if not result or len(result) < NAVER_MIN_CHARS:
            continue

        _save_naver_name(product_id, result)
        elapsed_ms = int((time.time() - t0) * 1000)
        return {
            'ok': True,
            'naver_product_name': result,
            'model': model,
            'elapsed_ms': elapsed_ms,
            'char_length': len(result),
            'byte_length': calc_byte_length(result),
            'raw_first_line': first,
            'vision': vision_result,
            **vision_meta,
        }

    return {'ok': False, 'error': last_err or 'all_models_failed'}
