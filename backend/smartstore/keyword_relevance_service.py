"""GPU 키워드 적합도 검증 — LLM 으로 상품과 어울리는 키워드만 골라내기.

흐름:
  1) 상품 정보 (원본명, 카테고리, 비전 분석) + 키워드 후보 list
  2) Ollama (exaone3.5) 에 "이 상품에 어울리는 키워드만 JSON 배열로" 요청
  3) 결과 → DB 캐싱 (keyword_relevance_cache, product_id + keywords hash)
  4) 다음 호출 시 캐시 hit
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta

import requests
from django.db import connections

logger = logging.getLogger(__name__)

DB = 'naverdb'
DEFAULT_OLLAMA_URL = (
    os.environ.get('OLLAMA_URL_OVERRIDE')
    or os.environ.get('NAVER_OLLAMA_URL')
    or 'http://localhost:11438'
)
DEFAULT_MODELS = ['exaone3.5:7.8b', 'qwen2.5:7b']
HTTP_TIMEOUT = float(os.environ.get('NAVER_OLLAMA_TIMEOUT', '60'))


def _hash_keywords(keywords: list[str]) -> str:
    """키워드 셋의 안정 해시 (순서 무관)."""
    norm = sorted(set(k.strip().lower() for k in keywords if k and k.strip()))
    return hashlib.md5('\n'.join(norm).encode('utf-8')).hexdigest()[:16]


def _ensure_cache_table():
    """첫 호출에만 — IF NOT EXISTS."""
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS keyword_relevance_cache (
              product_id INT NOT NULL,
              keywords_hash VARCHAR(32) NOT NULL,
              relevant_keywords JSON NOT NULL,
              irrelevant_keywords JSON NULL,
              model VARCHAR(40) NULL,
              elapsed_ms INT NULL,
              fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (product_id, keywords_hash),
              KEY ix_fetched (fetched_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )


_TABLE_READY = False


def get_relevance(product_id: int, keywords: list[str],
                  force: bool = False) -> dict:
    """캐시 hit 우선. miss/force 면 LLM 호출.
    반환: {ok, relevant: [...], irrelevant: [...], cached: bool, model, elapsed_ms}
    """
    global _TABLE_READY
    if not _TABLE_READY:
        try:
            _ensure_cache_table()
            _TABLE_READY = True
        except Exception as e:
            logger.warning('keyword_relevance_cache 생성 실패: %s', e)

    kws = [k.strip() for k in (keywords or []) if k and k.strip()]
    if not kws:
        return {'ok': True, 'relevant': [], 'irrelevant': [], 'cached': False}

    khash = _hash_keywords(kws)

    if not force:
        try:
            with connections[DB].cursor() as cur:
                cur.execute(
                    "SELECT relevant_keywords, irrelevant_keywords, model, elapsed_ms, fetched_at "
                    "FROM keyword_relevance_cache WHERE product_id=%s AND keywords_hash=%s",
                    [product_id, khash],
                )
                row = cur.fetchone()
                if row:
                    rel = row[0] if isinstance(row[0], list) else json.loads(row[0])
                    irrel = row[1] if isinstance(row[1], list) else (json.loads(row[1]) if row[1] else [])
                    return {
                        'ok': True, 'relevant': rel, 'irrelevant': irrel,
                        'cached': True, 'model': row[2], 'elapsed_ms': row[3],
                        'fetched_at': row[4].isoformat() if row[4] else None,
                    }
        except Exception as e:
            logger.warning('cache lookup 실패: %s', e)

    # LLM 호출
    product = _fetch_product_context(product_id)
    if not product:
        return {'ok': False, 'error': 'product not found'}

    system, user = _build_prompt(product, kws)
    t0 = time.time()
    last_err = None
    for model in DEFAULT_MODELS:
        try:
            raw = _call_ollama(system, user, model, DEFAULT_OLLAMA_URL)
        except Exception as e:
            last_err = str(e)[:200]
            continue

        parsed = _parse_relevance(raw, kws)
        if not parsed:
            last_err = f'parse fail: {raw[:200]!r}'
            continue

        rel, irrel = parsed
        elapsed_ms = int((time.time() - t0) * 1000)

        # 캐시 저장
        try:
            with connections[DB].cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO keyword_relevance_cache
                      (product_id, keywords_hash, relevant_keywords, irrelevant_keywords, model, elapsed_ms)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      relevant_keywords=VALUES(relevant_keywords),
                      irrelevant_keywords=VALUES(irrelevant_keywords),
                      model=VALUES(model),
                      elapsed_ms=VALUES(elapsed_ms),
                      fetched_at=NOW()
                    """,
                    [product_id, khash,
                     json.dumps(rel, ensure_ascii=False),
                     json.dumps(irrel, ensure_ascii=False),
                     model, elapsed_ms],
                )
        except Exception as e:
            logger.warning('cache save 실패: %s', e)

        return {
            'ok': True, 'relevant': rel, 'irrelevant': irrel,
            'cached': False, 'model': model, 'elapsed_ms': elapsed_ms,
        }

    return {'ok': False, 'error': last_err or 'all_models_failed'}


def _fetch_product_context(product_id: int) -> dict | None:
    with connections[DB].cursor() as cur:
        cur.execute(
            "SELECT product_name, ai_product_name, ai_recommended_name, category_name, "
            "brand, manufacturer, image_analysis "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if not row:
            return None
    pn, ai_p, ai_r, cat, brand, mfr, vis_raw = row
    vis = None
    if vis_raw:
        try:
            vis = json.loads(vis_raw) if isinstance(vis_raw, str) else vis_raw
        except (ValueError, TypeError):
            vis = None
    return {
        'product_name': pn, 'ai_product_name': ai_p, 'ai_recommended_name': ai_r,
        'category_name': cat, 'brand': brand, 'manufacturer': mfr,
        'vision': vis,
    }


def _build_prompt(p: dict, keywords: list[str]) -> tuple[str, str]:
    system = (
        "당신은 네이버 쇼핑 상품명 SEO 전문가입니다.\n"
        "후보 키워드 중 이 상품에 정확히 어울리는 것만 골라주세요.\n"
        "\n"
        "[적합 기준]\n"
        "- 상품의 카테고리/유형/색상/소재/용도와 직접 관련 있음\n"
        "- 상품 사진(비전 분석)으로 확인되는 시각 속성과 일치\n"
        "- 검색 쿼리로 적절한 명사/형용사 (조사·동사·접속사 제외)\n"
        "\n"
        "[부적합 기준]\n"
        "- 상품과 무관한 일반어 (예: '드시면', '있는', '같은')\n"
        "- 운영 boilerplate (예: '배송기간', '판매자', '교환반품')\n"
        "- 다른 상품 카테고리 단어 (예: 의류 상품에 '가전')\n"
        "- 반대 성별 (예: 여성복인데 '남성')\n"
        "- 명백한 어뷰징 (예: '최저가', '베스트1위')\n"
        "\n"
        "[출력 형식]\n"
        "JSON 객체 한 개만 출력. ```json``` fence 금지.\n"
        '{"relevant": ["키워드1", "키워드2", ...], "irrelevant": ["키워드3", ...]}\n'
        "모든 입력 키워드를 둘 중 하나에 분류해야 합니다."
    )
    parts = []
    parts.append(f'원본 상품명: {p.get("product_name") or ""}')
    if p.get('ai_recommended_name') or p.get('ai_product_name'):
        parts.append(f'AI 상품명: {p.get("ai_recommended_name") or p.get("ai_product_name")}')
    if p.get('category_name'):
        parts.append(f'카테고리: {p["category_name"]}')
    if p.get('brand'):
        parts.append(f'브랜드: {p["brand"]}')
    vis = p.get('vision') or {}
    v_parts = []
    if vis.get('form'): v_parts.append(f'형태={vis["form"]}')
    if vis.get('color'): v_parts.append(f'색상={vis["color"]}')
    if vis.get('material'): v_parts.append(f'소재={vis["material"]}')
    if v_parts:
        parts.append(f'비전 분석: {", ".join(v_parts)}')

    parts.append('')
    parts.append('후보 키워드:')
    parts.append(json.dumps(keywords, ensure_ascii=False))

    return system, '\n'.join(parts)


def _call_ollama(system: str, user: str, model: str, url: str) -> str:
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'stream': False,
        'options': {'temperature': 0.2, 'num_predict': 1200},
    }
    r = requests.post(f'{url}/api/chat', json=payload, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    return (data.get('message') or {}).get('content', '') or ''


_JSON_RE = re.compile(r'\{[\s\S]*\}')


def _parse_relevance(text: str, original_keywords: list[str]) -> tuple[list, list] | None:
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```\s*$', '', text)
    m = _JSON_RE.search(text)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        s = m.group(0)
        s = re.sub(r',\s*}', '}', s)
        s = re.sub(r',\s*]', ']', s)
        try:
            data = json.loads(s)
        except json.JSONDecodeError:
            return None

    rel = data.get('relevant') or []
    irrel = data.get('irrelevant') or []
    if not isinstance(rel, list):
        rel = []
    if not isinstance(irrel, list):
        irrel = []
    # 원본 키워드 set 으로 sanitize — 환각 단어 제거
    orig_set = {k.lower(): k for k in original_keywords}
    rel_out = []
    for k in rel:
        if not isinstance(k, str):
            continue
        canonical = orig_set.get(k.lower())
        if canonical:
            rel_out.append(canonical)
    irrel_out = []
    for k in irrel:
        if not isinstance(k, str):
            continue
        canonical = orig_set.get(k.lower())
        if canonical:
            irrel_out.append(canonical)

    # 둘 다 비어있으면 fail
    if not rel_out and not irrel_out:
        return None
    return rel_out, irrel_out
