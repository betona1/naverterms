"""상품 이미지 → 시각 속성 JSON 추출기 (Ollama gemma3:12b 멀티모달).

상품명 생성 정확도 향상을 위해 이미지에서 추출:
  - color (주요 색상 1~3개)
  - material (소재/재질)
  - form (상품 형태/유형)
  - package_qty (패키지 수량/구성 정보)
  - key_features (눈에 띄는 특징 키워드 배열)
  - readable_text (이미지 안에 보이는 글자 — 모델명, 용량 등)

결과를 naver_my_product.image_analysis (JSON) 에 캐싱. 한 상품당 1회만 호출.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from datetime import datetime

import requests
from django.db import connections

logger = logging.getLogger(__name__)

DEFAULT_OLLAMA_URL = (
    os.environ.get('OLLAMA_VISION_URL_OVERRIDE')
    or os.environ.get('OLLAMA_URL_OVERRIDE')
    or os.environ.get('NAVER_OLLAMA_URL')
    or 'http://localhost:11438'
)
DEFAULT_MODELS = ['qwen2.5vl:7b', 'gemma3:12b']  # qwen2.5vl 우선(한국어/e-commerce), gemma3 fallback
HTTP_TIMEOUT = float(os.environ.get('NAVER_VISION_TIMEOUT', '90'))
IMAGE_DL_TIMEOUT = float(os.environ.get('NAVER_IMAGE_DL_TIMEOUT', '10'))
IMAGE_MAX_BYTES = 5 * 1024 * 1024  # 5MB 안전 한도


_VISION_PROMPT = """당신은 한국 이커머스 상품 이미지 분석 전문가입니다.
주어진 상품 사진을 보고 네이버 쇼핑 상품명 작성에 도움될 시각적 속성을 JSON으로만 출력하세요.

[추출 항목]
- color: 주요 색상 1~3개 — **반드시 한국어 단어만** (예: ["블랙", "화이트", "네이비"])
- material: 소재/재질 1개 — **다음 중에서 가장 정확한 것 하나만 선택, 없으면 null**:
  * 의류: 면 / 린넨 / 폴리에스터 / 나일론 / 울 / 데님 / 가죽 / 합성가죽 / 스판덱스 / 니트 / 혼방
  * 식기/주방: 스테인리스 / 알루미늄 / 유리 / 도자기 / 실리콘 / 트라이탄
  * 일반: 플라스틱 / 종이 / 페이퍼 / 목재 / 금속 / 카펫 / 메쉬
  * 추측 금지 — 명확히 안 보이면 null
- form: 상품 형태/유형 1개 — **한국어 단어만** (예: "자켓", "텀블러", "후크", "캐리어", "신발")
- package_qty: 패키지 구성 정보 — 한국어 (예: "1세트", "10개입", "2팩", null)
- key_features: 눈에 띄는 특징 3~6개 — **반드시 한국어 단어/짧은 합성어만**
  * 좋은 예: ["접이식", "휴대용", "이중구조", "방수", "보온"]
  * 절대 금지: 영어 단어("hooded", "lightweight"), 한자, 키릴문자(рукав, дом), 일본어, 구문(여러 단어 공백)
  * 영어로 떠올랐다면 한국어로 번역: hooded→후드, lightweight→경량, loose fit→루즈핏
- readable_text: 이미지 안에서 보이는 **모든** 글자를 줄바꿈/공백 그대로 추출.
  * 상세 페이지 사진은 광고 문구, 카피, 소재 설명, 사이즈, 모델컷 글씨가 풍부 — 다 뽑아라
  * 큰 카피 ("부드러운 면 혼방 자켓") + 작은 디테일 ("색상: 핑크, 사이즈: M") 모두 포함
  * 광고 문구도 OK (홍보문구 reject 는 후처리에서)
  * 외국어/숫자도 그대로
  * 없으면 null. 짧게 1단어만 보이면 그것만이라도 적어라.

[절대 규칙]
1. **모든 텍스트 필드는 한국어만**. 영어/한자/일본어/키릴 단어는 출력 금지.
   (단 readable_text 와 브랜드 로고 영문은 예외 — 그대로)
2. 추측하지 말 것 — 명확히 안 보이면 null 또는 빈 배열
3. 광고 문구/홍보 어휘는 무시
4. 출력은 JSON 한 객체만. ```json``` fence 금지. 설명 문장 금지.

JSON:"""


_HANGUL_RE = re.compile(r'[가-힣]')


def _is_korean_token(s: str) -> bool:
    """한국어 단어 검증 — 한글 1자 이상 + 영어 단어 4자 이상은 reject.
    합성어/짧은 영문 약어(B, S, L, 3D, 4K) 는 허용.
    """
    if not s or not isinstance(s, str):
        return False
    s = s.strip()
    if not s:
        return False
    # 공백 포함 = 구문 → reject
    if ' ' in s:
        return False
    has_hangul = bool(_HANGUL_RE.search(s))
    # 영어 4자 이상 단독은 reject
    if not has_hangul:
        # 짧은 ascii (1~3자, 사이즈/모델 코드용) 만 허용
        if all(c.isascii() and (c.isalnum() or c in '-_') for c in s) and len(s) <= 3:
            return True
        return False
    # 한자/일본어/키릴 문자 reject
    for c in s:
        cp = ord(c)
        if 0x4E00 <= cp <= 0x9FFF:  # 한자
            return False
        if 0x3040 <= cp <= 0x30FF:  # 가나
            return False
        if 0x0400 <= cp <= 0x04FF:  # 키릴
            return False
    return True


def _download_image_b64(url: str) -> str | None:
    """이미지 URL → base64. 실패 시 None."""
    try:
        r = requests.get(url, timeout=IMAGE_DL_TIMEOUT, stream=True)
        r.raise_for_status()
        data = r.raw.read(IMAGE_MAX_BYTES + 1, decode_content=True)
        if len(data) > IMAGE_MAX_BYTES:
            logger.warning('이미지 너무 큼 (%dB): %s', len(data), url[:80])
            return None
        return base64.b64encode(data).decode('ascii')
    except Exception as e:
        logger.warning('이미지 다운로드 실패: %s — %s', url[:80], e)
        return None


def _call_ollama_vision(b64: str, model: str, url: str) -> str:
    payload = {
        'model': model,
        'messages': [
            {
                'role': 'user',
                'content': _VISION_PROMPT,
                'images': [b64],
            },
        ],
        'stream': False,
        'options': {'temperature': 0.2, 'num_predict': 600},
    }
    r = requests.post(f'{url}/api/chat', json=payload, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    return (data.get('message') or {}).get('content', '') or ''


_JSON_RE = re.compile(r'\{[\s\S]*\}')


def _parse_json(text: str) -> dict | None:
    text = text.strip()
    # ```json ... ``` fence 제거
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```\s*$', '', text)
    # 첫 { ... } 만 추출
    m = _JSON_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        # 누락 콤마 등 미세 보정 시도
        s = m.group(0)
        s = re.sub(r',\s*}', '}', s)
        s = re.sub(r',\s*]', ']', s)
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return None


def _normalize(data: dict) -> dict:
    """필드 정규화 + 한국어 필터링."""
    out = {
        'color': data.get('color'),
        'material': data.get('material'),
        'form': data.get('form'),
        'package_qty': data.get('package_qty'),
        'key_features': data.get('key_features') or [],
        'readable_text': data.get('readable_text'),
    }
    # color/key_features 가 문자열이면 리스트로
    if isinstance(out['color'], str):
        out['color'] = [c.strip() for c in re.split(r'[,/]', out['color']) if c.strip()]
    if isinstance(out['key_features'], str):
        out['key_features'] = [c.strip() for c in re.split(r'[,/]', out['key_features']) if c.strip()]
    # 빈 문자열 → None
    for k in ('material', 'form', 'package_qty'):
        if out[k] in ('', '없음', 'null', 'None', None):
            out[k] = None
    # color / key_features — 한국어 필터링
    if isinstance(out['color'], list):
        out['color'] = [c for c in out['color'] if _is_korean_token(c)]
    if isinstance(out['key_features'], list):
        out['key_features'] = [k for k in out['key_features'] if _is_korean_token(k)]
        # 비전 신뢰도 낮은 항목 reject — 의류 소매길이는 사진으로 자주 오판 (반팔/긴팔 혼동)
        # 원본 상품명에 명시 안 됐으면 이런 추측은 위험
        UNRELIABLE_FEATURES = {
            '반팔', '긴팔', '민소매', '7부', '9부',  # 소매 — 사진 각도 의존
        }
        out['key_features'] = [k for k in out['key_features'] if k not in UNRELIABLE_FEATURES]
    # material / form 도 한국어만
    for k in ('material', 'form'):
        v = out[k]
        if v and not _is_korean_token(v):
            out[k] = None
    return out


# ── DB ─────────────────────────────────────────────

def _fetch_product_image(product_id: int) -> dict | None:
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            "SELECT id, image_large, image_medium, image_small, image_analysis, detail_html "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if not row:
            return None
        return {
            'id': row[0],
            'image_large': row[1],
            'image_medium': row[2],
            'image_small': row[3],
            'image_analysis': row[4],
            'detail_html': row[5],
        }


def _save_analysis(product_id: int, analysis: dict):
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product "
            "SET image_analysis=%s, image_analyzed_at=NOW() "
            "WHERE id=%s",
            [json.dumps(analysis, ensure_ascii=False), product_id],
        )


def get_cached_analysis(product_id: int) -> dict | None:
    """DB에 캐싱된 분석 결과 가져오기 (없으면 None)."""
    p = _fetch_product_image(product_id)
    if not p:
        return None
    raw = p.get('image_analysis')
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


# ── Public ─────────────────────────────────────────

def _extract_detail_image_urls(html: str | None, max_urls: int = 3) -> list[str]:
    """detail_html 안의 <img src="..."> 추출 (광고/배너 우선, 최대 N개)."""
    if not html:
        return []
    urls = re.findall(r'<img[^>]*\s(?:data-original|data-src|src)="([^"]+)"', html)
    out: list[str] = []
    seen: set = set()
    for u in urls:
        if not u or u.startswith('data:'):
            continue
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= max_urls:
            break
    return out


def analyze_product_image(product_id: int,
                          force: bool = False,
                          url: str | None = None,
                          models: list[str] | None = None) -> dict:
    """상품 이미지 분석 (캐시 우선).
    image_large 1차 분석 + detail_html 안의 추가 이미지 OCR (readable_text 만 흡수).

    Args:
        product_id: naver_my_product.id
        force: True 면 캐시 무시하고 재분석
        url, models: 디버그/오버라이드
    """
    p = _fetch_product_image(product_id)
    if not p:
        return {'ok': False, 'error': 'not_found'}

    # 캐시 hit
    cached = None if force else (p.get('image_analysis') and get_cached_analysis(product_id))
    if cached:
        return {'ok': True, 'analysis': cached, 'cached': True, 'elapsed_ms': 0}

    # 이미지 URL 결정 (large > medium > small)
    img_url = p['image_large'] or p['image_medium'] or p['image_small']
    if not img_url:
        return {'ok': False, 'error': 'no_image_url'}

    t0 = time.time()
    b64 = _download_image_b64(img_url)
    if not b64:
        return {'ok': False, 'error': 'image_download_failed', 'image_url': img_url}

    use_url = url or DEFAULT_OLLAMA_URL
    use_models = models or DEFAULT_MODELS

    last_err = None
    for model in use_models:
        try:
            raw = _call_ollama_vision(b64, model, use_url)
        except Exception as e:
            last_err = str(e)[:200]
            logger.warning('vision %s 실패: %s', model, e)
            continue

        data = _parse_json(raw)
        if not data:
            last_err = f'JSON 파싱 실패: {raw[:120]!r}'
            continue

        analysis = _normalize(data)

        # detail_html 안의 추가 이미지들도 OCR — readable_text 만 흡수
        # (form/color/material 등은 사진마다 달라질 수 있어 건드리지 않음)
        detail_urls = _extract_detail_image_urls(p.get('detail_html'), max_urls=3)
        # 메인 image_large 와 동일한 URL 제외
        detail_urls = [u for u in detail_urls if u != img_url]
        extra_texts: list[str] = []
        if analysis.get('readable_text'):
            extra_texts.append(analysis['readable_text'])
        for du in detail_urls:
            db64 = _download_image_b64(du)
            if not db64:
                continue
            try:
                draw = _call_ollama_vision(db64, model, use_url)
            except Exception:
                continue
            ddata = _parse_json(draw)
            if not ddata:
                continue
            rt = ddata.get('readable_text')
            if rt and isinstance(rt, str) and rt.strip() and rt.strip().lower() not in ('null', 'none'):
                extra_texts.append(rt.strip())

        if extra_texts:
            # 합쳐서 저장 — 모달의 detail_keywords 처럼 토큰 풀에 활용 가능
            analysis['readable_text'] = ' '.join(extra_texts)[:2000]

        _save_analysis(product_id, analysis)
        elapsed_ms = int((time.time() - t0) * 1000)
        return {
            'ok': True,
            'analysis': analysis,
            'cached': False,
            'model': model,
            'elapsed_ms': elapsed_ms,
            'image_url': img_url,
            'detail_image_count': len(detail_urls),
        }

    return {'ok': False, 'error': last_err or 'all_models_failed', 'image_url': img_url}
