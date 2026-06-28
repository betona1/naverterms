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

# ── 상품명수정 네이버 — 패치 버전 ────────────────────────
# 변경 시 docs/PATCH_NOTES_naver_name.md 에 항목 추가 필수.
# 모달 헤더 표시 / 롤백 스냅샷 태깅에 사용.
NAVER_NAME_VERSION = 'v1.02'

# 모달 [📋 상품명AI패치 사항 안내] 섹션에 노출되는 구조화 패치 노트.
# 최신 버전을 리스트 [0] 에 두고, 한 줄 summary 가 접힘 상태에 표시된다.
# 변경 시 docs/PATCH_NOTES_naver_name.md 와 1:1 동기화.
NAVER_NAME_PATCH_NOTES: list[dict] = [
    {
        'version': 'v1.02',
        'date': '2026-05-26',
        'summary': '정규식 경계 + evidence 엄격화 (괄호/하이픈/N세트 패턴 보완)',
        'issues': [
            'v1.01 단어경계 `(^|\\s)X(?=\\s|$)` 가 괄호/슬래시/하이픈 인식 못함 → (소꿉놀이 세트), (1세트) 등 잔존 4,468건',
            'combined_option 의 "1개" 단순 단위가 set evidence 로 오인되어 안전망 미작동',
            '`1세트`, `2세트` 같은 숫자+세트 노이즈 패턴 누락',
        ],
        'fixes': [
            'boundary 를 `(?<![가-힣a-zA-Z0-9])X(?![가-힣a-zA-Z0-9])` 로 교체 — 한글/영숫자 인접만 합성어 보호, 그 외는 모두 경계',
            'evidence 엄격화 — 단순 `1개` 미인정, `[2-9]\\d*개\\s*(세트|묶음|입|팩|박스|세|개입)` 또는 `\\d+(팩|박스)` 동반 시만',
            '`\\d+세트` 노이즈 패턴 추가 (1세트, 10세트 등)',
        ],
    },
    {
        'version': 'v1.01',
        'date': '2026-05-26',
        'summary': '세트/색상 할루시네이션 안전망 + 롤백 인프라 도입',
        'issues': [
            '세트 할루시네이션 — 단일 상품인데 LLM 이 "세트/묶음/패키지/N개입" 자의적 박음 (64,077건)',
            '색상 할루시네이션 — 옵션/원본 어디에도 없는 색상이 비전 추측 단독으로 박힘 (15,724건)',
        ],
        'fixes': [
            'postprocess() 에 SET-안전망 추가 — 단서 없으면 세트류 자동 제거',
            'postprocess() 에 COLOR-안전망 추가 — 36개 색상 단어, 단서 없으면 자동 제거',
            '시스템 프롬프트 [절대 금지] 에 세트/색상 할루시네이션 명시',
            '버전 스냅샷(naver_name_version_snapshot) + 롤백 API 도입',
        ],
    },
]

# ── 네이버 상품명 한도 ───────────────────────────────────
NAVER_MAX_CHARS = 50    # 권장값 (네이버 권고)
NAVER_MAX_BYTES = 100   # 한글 2바이트 환산
NAVER_MIN_CHARS = 4

# ── v1.02 안전망: 세트/패키지/수량 표현 (LLM 할루시네이션 방지) ─
# 한글/영숫자 인접이면 합성어로 보고 보호. 그 외(공백/괄호/슬래시/하이픈 등)는 모두 경계로 처리.
SET_NOISE_TOKENS = (
    '세트', '묶음', '패키지', '구성품',
)
SET_NOISE_PATTERNS = (
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*세트(?![가-힣a-zA-Z0-9])'),     # 1세트, 2세트
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*개\s*세트(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*개\s*입(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*개\s*묶음(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*입(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*개세트(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*피스(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<![가-힣a-zA-Z0-9])\d+\s*팩(?![가-힣a-zA-Z0-9])'),
    re.compile(r'(?<!\d)1\+1(?!\d)'),
    re.compile(r'(?<!\d)2\+1(?!\d)'),
    re.compile(r'(?<!\d)3\+1(?!\d)'),
)
# evidence — '1개' 단순 단위는 제외, 명확한 set 신호만 인정
SET_EVIDENCE_TOKENS = (
    '세트', '묶음', '패키지', '구성품', '구성',
    '개입', '개 입', '개세트', '개 세트',
    '개묶음', '개 묶음', '피스',
    '+1', '+ 1',
)
# evidence 보강 — N>=2 인 'N개' 또는 'N개 + (세트|묶음|입|팩|박스|세)' 동반
SET_EVIDENCE_PATTERNS = (
    re.compile(r'[2-9]\d*\s*개\s*(?:세트|묶음|입|팩|박스|세|개입)'),
    re.compile(r'\d+\s*(?:팩|박스)(?![가-힣])'),
    re.compile(r'[2-9]\d*\s*개입'),
)

# ── v1.01 안전망: 36개 색상 단어 (옵션/원본 단서 없으면 제거) ───
COLOR_TOKENS = (
    '블랙', '화이트', '네이비', '그레이', '베이지', '카키', '브라운',
    '핑크', '옐로우', '그린', '블루', '레드', '와인', '머스타드', '라벤더',
    '퍼플', '오렌지', '민트', '아이보리', '차콜', '실버', '골드', '코랄',
    '카멜', '모카',
    '검정', '검은', '흰색', '하얀', '빨강', '노랑', '파랑', '초록', '보라',
    '분홍', '회색', '갈색',
)

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
    """공백 기준 토큰화 → 동일 토큰 **최대 2회**까지 허용 (네이버 SEO).
    3회 이상은 패널티 — 자동 제거 (앞 2개만 유지).
    """
    counts: dict[str, int] = {}
    out = []
    for tok in text.split():
        key = tok.lower()
        counts[key] = counts.get(key, 0) + 1
        if counts[key] <= 2:
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


def _build_evidence_blob(product: dict | None) -> str:
    """원본 product_name + 옵션 + 키워드 + 속성을 한 덩어리 lower 문자열로.
    안전망에서 단서 검색용."""
    if not product:
        return ''
    parts = [
        product.get('product_name') or '',
        product.get('option1_name') or '',
        product.get('option1_values') or '',
        product.get('option2_name') or '',
        product.get('option2_values') or '',
        product.get('combined_option') or '',
        product.get('keywords') or '',
        product.get('product_attribute') or '',
        product.get('model_name') or '',
    ]
    return (' '.join(parts)).lower()


def _strip_set_hallucination(text: str, evidence: str) -> str:
    """v1.02 — 원본/옵션/키워드 어디에도 세트/패키지/수량 단서가 없으면
    LLM 출력의 해당 표현을 자동 제거.

    개선:
      - 한글/영숫자 외 모든 경계 인식 (괄호/슬래시/하이픈)
      - '1개' 단순 단위는 evidence 미포함 (오인 방지)
      - 'N세트' 숫자 prefix 패턴 추가
    """
    if not text:
        return text
    has_evidence = any(e in evidence for e in SET_EVIDENCE_TOKENS) \
        or any(p.search(evidence) for p in SET_EVIDENCE_PATTERNS)
    if has_evidence:
        return text
    out = text
    # 1) 숫자+단어 결합 패턴 (1세트, 2개입, 1+1 등)
    for pat in SET_NOISE_PATTERNS:
        out = pat.sub(' ', out)
    # 2) 단독 토큰 (세트/묶음/패키지/구성품) — 한글/영숫자 아닌 모든 경계 허용
    for tok in SET_NOISE_TOKENS:
        out = re.sub(
            rf'(?<![가-힣a-zA-Z0-9]){re.escape(tok)}(?![가-힣a-zA-Z0-9])',
            ' ', out,
        )
    return out


def _strip_color_hallucination(text: str, evidence: str) -> str:
    """v1.02 — 옵션/원본/키워드에 단서 없는 색상은 자동 제거.
    경계: 한글/영숫자 외 모두 (괄호/슬래시/하이픈/쉼표 포함).
    """
    if not text:
        return text
    out = text
    for col in COLOR_TOKENS:
        if col.lower() in evidence:
            continue  # 단서 있음 → 유지
        out = re.sub(
            rf'(?<![가-힣a-zA-Z0-9]){re.escape(col)}(?![가-힣a-zA-Z0-9])',
            ' ', out,
        )
    return out


def postprocess(text: str, product: dict | None = None) -> str:
    """LLM 응답 1차 라인 → 모든 SEO 후처리 적용.

    product 가 주어지면 v1.01 안전망(SET/COLOR 할루시네이션 제거) 도 적용.
    """
    out = _strip_company_prefix(text)
    out = _strip_disallowed_chars(out)
    out = _strip_meaningless_jamo(out)
    out = _strip_banned_substrings(out)
    if product is not None:
        evidence = _build_evidence_blob(product)
        out = _strip_set_hallucination(out, evidence)
        out = _strip_color_hallucination(out, evidence)
    out = _normalize_whitespace(out)
    out = _dedupe_tokens(out)
    out = _truncate_to_naver_limit(out)
    return out


def _enrich_short_name(name: str, product_id: int) -> str:
    """결과가 너무 짧으면 keyword_volume 캐시의 고조회수 + GPU 적합 키워드를 자동 보강.
    한도 50자/100바이트 안에서. 중복 토큰은 _dedupe_tokens 가 막아줌.
    """
    if not name:
        return name
    if len(name) >= 30 and calc_byte_length(name) >= 60:
        return name  # 충분히 김

    try:
        from . import naver_my_product_service as _s
        # 적합 키워드 (LLM 검증) — 있으면 strict, 없으면 lenient
        relev = _fetch_relevance_cache(int(product_id))
        rel_kws = (relev[0] if relev else []) or []
        irrelev_kws = (relev[1] if relev else []) or []
        strict_mode = bool(rel_kws or irrelev_kws)  # 캐시 있으면 strict
        rel_set = {k.lower() for k in rel_kws}
        irrelev_lower = {k.lower() for k in irrelev_kws}

        # 키워드 풀 lookup
        pool = _s.get_keyword_pool(int(product_id))
        if not pool.get('ok'):
            return name

        volumes = pool.get('keyword_volumes') or {}
        banned = set(map(str.lower,
                         (pool.get('banned_keywords') or [])
                         + (pool.get('season_banned_keywords') or [])))
        seen_lower = {t.lower() for t in name.split()}

        # 후보 수집 (소스별 우선순위, 중복 제거)
        candidates: list[tuple[str, int]] = []
        cand_set: set = set()

        def _add(lst: list[str]):
            for k in lst or []:
                if not k or len(k) < 2:
                    continue
                lc = k.lower()
                if lc in seen_lower or lc in cand_set:
                    continue
                if lc in banned or lc in irrelev_lower:
                    continue
                # strict: GPU 적합 캐시 있을 때 적합 set 에 없으면 reject
                if strict_mode and lc not in rel_set:
                    continue
                vol = (volumes.get(k) or {}).get('total', 0)
                candidates.append((k, vol))
                cand_set.add(lc)

        # 1순위: GPU 적합 키워드 (strict mode 의 메인)
        _add(rel_kws)
        # 2순위: preset (원본 검색태그) — strict 면 GPU 적합인것만, lenient 면 모두
        _add(pool.get('preset_keywords') or [])
        # 3순위: detail (이미지 OCR + HTML)
        _add(pool.get('detail_keywords') or [])

        # 조회수 desc
        candidates.sort(key=lambda x: x[1], reverse=True)

        out = name
        for kw, _vol in candidates:
            lc = kw.lower()
            # substring (예: '여름바람막이' 안에 '여름' 이미 있음)
            if lc in out.lower():
                continue
            cand = out + ' ' + kw
            if len(cand) > NAVER_MAX_CHARS or calc_byte_length(cand) > NAVER_MAX_BYTES:
                break
            out = cand
            if len(out) >= 35 and calc_byte_length(out) >= 60:
                break
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning('enrich 실패: %s', e)
        return name


# ── LLM 프롬프트 ─────────────────────────────────────────

_SYSTEM_PROMPT = f"""당신은 네이버 쇼핑 상품명 SEO 전문가입니다.
오너클랜 위탁판매 상품 정보를 보고 네이버 검색 노출에 최적화된 상품명을 만드세요.

[글자 수 — 매우 중요]
- **목표 35~50자 풍부하게 채우기**. 너무 짧으면 검색 노출 안 됨.
- 최대 {NAVER_MAX_CHARS}자 / {NAVER_MAX_BYTES}바이트 (한글 2바이트)
- 원본 상품명의 핵심 명사 키워드는 **최대한 보존** — 동의어 변환 OK, 단어 삭제는 신중히
- 원본에 "낚시/등산/방수/캠핑" 같은 용도 키워드가 있으면 검색 다양화 위해 가능한 많이 포함
- 단순화 ≠ 좋음. 검색 키워드 많을수록 노출 다양해짐.

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
- **원본보다 짧아지지 않도록 주의**. 원본에 있던 용도/소재/시즌 키워드는 정리 후 살려라.
  예: 원본 "골프 우의 세트 상하의 레인슈트 골프 낚시 등산 생활방수 셋업 상하의세트"
      → 골프(중복제거) + 우의/레인슈트/낚시/등산/방수 등 검색 키워드 모두 살려
      "베르 남성 방수 우의 레인슈트 상하의 세트 골프 낚시 등산용 셋업"

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
- **세트/패키지/수량 할루시네이션 금지(v1.01)**: 원본 상품명/옵션/키워드 어디에도 "세트, 묶음, 패키지, N개입, N개세트, 1+1, 2+1" 단서가 없으면 절대 박지 마라. 검색 다양화 명목으로 자의적으로 "세트" 추가 금지.
- **색상 할루시네이션 금지(v1.01)**: 옵션/원본/키워드에 명시되지 않은 색상은 비전 추측만으로 박지 마라. 단서 없는 색상은 후처리에서 자동 제거된다.

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
[패션의류 전용 룰]
- 필드 순서: [브랜드] [성별] [시즌(선택)] [소재(선택)] [상품유형] [색상] [사이즈(선택)] [핏/디테일(선택)] [용도]
- **원본의 용도 키워드는 살려라**: 골프, 낚시, 등산, 캠핑, 출근, 데일리, 작업복, 운동, 비즈니스 등
- 좋은 예: "유니클로 남성 여름 린넨 반팔 셔츠 네이비 L 루즈핏 출근용"
- 좋은 예: "베르 남성 방수 우의 레인슈트 상하의 세트 골프 낚시 등산 블루"
- 성별: 원본/카테고리 명확할 때만. 불명확하면 생략 (혼성 표기 금지)
- 시즌: 1개만 — '봄가을' 합성 OK. "봄,가을,겨울" 동시 나열 금지
- 사이즈: 원본/옵션 명시되어 있을 때만
- 핏/소매길이: 원본에 명시 있을 때만 (비전 추측 금지)
- 목표 길이: 35~50자 (정보 풍부)
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

    # ── AI 컨펌 학습 컨텍스트 ──────────────────────────────────────
    # 1) 같은 W코드 직전 컨펌이 있으면 → 사용자가 검증한 after_name 이 최우선 골든 샘플
    # 2) 같은 카테고리 누적 정책 top-N (white = 살려라, black = 절대 쓰지마)
    try:
        from . import naver_name_confirmation_service as _ncs
        last_conf = _ncs.get_last_confirmation_for_product(p.get('product_code'))
        if last_conf and last_conf.get('after_name'):
            parts.append(
                '⭐ 직전 사용자 컨펌 상품명(이 흐름을 그대로 유지하면서 개선): '
                + last_conf['after_name']
            )
            if last_conf.get('ai_comment'):
                parts.append(
                    f'⭐ 사용자 지시({last_conf.get("comment_type") or "overall"}): '
                    + last_conf['ai_comment']
                )
        cat_policy = _ncs.get_policy_for_generator(cat_type)
        cat_white = cat_policy.get('white') or []
        cat_black = cat_policy.get('black') or []
        if cat_white:
            parts.append(
                f'⭐ 카테고리({cat_type}) 사용자 학습 화이트 키워드(가능하면 포함): '
                + ', '.join(cat_white)
            )
        if cat_black:
            parts.append(
                f'🚫 카테고리({cat_type}) 사용자 학습 블랙 키워드(절대 사용 금지): '
                + ', '.join(cat_black)
            )
    except Exception as _e:  # noqa: BLE001
        logger.warning('confirmation 컨텍스트 주입 실패: %s', _e)

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
    # 브랜드/제조사 — naver_brand_policy DB 우선, 미등록은 휴리스틱
    try:
        from . import brand_policy_service as _bp

        def _safe_brand(s):
            if not s or not s.strip():
                return None
            return s.strip() if _bp.is_allowed(s) else None
    except Exception:
        def _safe_brand(s):
            return s.strip() if s and s.strip() else None

    sb = _safe_brand(p.get('brand'))
    sm = _safe_brand(p.get('manufacturer'))
    if sb:
        parts.append(f'브랜드: {sb}')
    if sm and sm != sb:
        parts.append(f'제조사: {sm}')
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
        'option1_name, option1_values, option2_name, option2_values, '
        'combined_option, product_attribute'
    )
    with connections['naverdb'].cursor() as cur:
        cur.execute(f"SELECT {fields} FROM naver_my_product WHERE id=%s", [product_id])
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        return dict(zip(cols, row))


def _save_naver_name(product_id: int, name: str):
    """새 AI 상품명 저장 — 직전 값을 naver_product_name_before 에 백업 + 버전 스냅샷 기록.
    스냅샷 source='auto' note='regenerate' 로 자동 누적 → 롤백 가능.
    """
    with connections['naverdb'].cursor() as cur:
        # 직전 상태 스냅샷 (이미 이름이 있을 때만)
        cur.execute(
            "SELECT product_code, naver_product_name, name_version "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if row and row[1]:
            prev_code, prev_name, prev_ver = row[0], row[1], row[2]
            cur.execute(
                """INSERT INTO naver_name_version_snapshot
                     (product_id, product_code, version_tag, naver_product_name, source, note)
                   VALUES (%s, %s, %s, %s, 'auto', 'before regenerate')""",
                [product_id, prev_code, prev_ver or 'unknown', prev_name],
            )
        cur.execute(
            """UPDATE naver_my_product
                  SET naver_product_name_before = naver_product_name,
                      naver_product_name = %s,
                      name_version = %s,
                      synced_at = NOW()
                WHERE id=%s""",
            [name, NAVER_NAME_VERSION, product_id],
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
        result = postprocess(first, product=p)
        if not result or len(result) < NAVER_MIN_CHARS:
            continue

        # 길이 부족 시 keyword pool 자동 보강 (조회수/적합도 기반)
        result = _enrich_short_name(result, product_id)
        result = _dedupe_tokens(result)
        result = _truncate_to_naver_limit(result)

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
