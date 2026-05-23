"""네이버 키워드 조회수 캐싱 서비스.

흐름:
  1) get_volumes(keywords)
  2) DB cache hit + 만료 안 된 거만 즉시 반환
  3) miss + 만료된 keyword 들 background fetch (네이버 검색광고 API + 쇼핑 API)
  4) 결과 UPSERT
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta
from typing import Iterable

from django.db import connections

logger = logging.getLogger(__name__)

DB = 'naverdb'
CACHE_TTL_DAYS = 30
FETCH_BATCH_SIZE = 5  # 검색광고 API 5개 동시 추천
MAX_KEYWORDS_PER_CALL = 100  # 보호 한도

_FETCH_LOCK = threading.Lock()
_PENDING_FETCH: set[str] = set()


def get_volumes(keywords: Iterable[str]) -> dict[str, dict]:
    """DB cache hit 결과 반환 + miss 는 백그라운드 fetch.
    반환: {keyword: {pc, mobile, total, comp, product_count, category}}
    """
    kws = [k.strip() for k in (keywords or []) if k and k.strip()]
    if not kws:
        return {}
    # dedupe + cap
    seen = set()
    uniq: list[str] = []
    for k in kws:
        if k.lower() in seen:
            continue
        seen.add(k.lower())
        uniq.append(k)
        if len(uniq) >= MAX_KEYWORDS_PER_CALL:
            break

    ph = ','.join(['%s'] * len(uniq))
    with connections[DB].cursor() as cur:
        cur.execute(
            f"""
            SELECT keyword, pc_count, mobile_count, total_count, comp_idx,
                   product_count, category_path, fetched_at, expires_at
              FROM naver_keyword_volume
             WHERE keyword IN ({ph})
            """,
            uniq,
        )
        rows = cur.fetchall()

    now = datetime.now()
    cached: dict[str, dict] = {}
    expired: list[str] = []
    for k, pc, mb, total, comp, pcount, cat, fetched, expires in rows:
        if expires and expires < now:
            expired.append(k)
        cached[k] = {
            'pc': pc, 'mobile': mb, 'total': total,
            'comp': comp, 'product_count': pcount, 'category': cat,
            'fetched_at': fetched.isoformat() if fetched else None,
            'fresh': (not expires) or expires >= now,
        }

    missing = [k for k in uniq if k not in cached] + expired
    if missing:
        _trigger_background_fetch(missing)

    return cached


def _trigger_background_fetch(keywords: list[str]):
    """이미 fetching 중인 키워드는 skip — race 방지."""
    with _FETCH_LOCK:
        new_kws = [k for k in keywords if k not in _PENDING_FETCH]
        if not new_kws:
            return
        for k in new_kws:
            _PENDING_FETCH.add(k)

    def _worker(target: list[str]):
        try:
            _fetch_and_save(target)
        except Exception as e:
            logger.warning('keyword_volume fetch 실패: %s', e)
        finally:
            with _FETCH_LOCK:
                for k in target:
                    _PENDING_FETCH.discard(k)

    threading.Thread(target=_worker, args=(new_kws,), daemon=True).start()


def _fetch_and_save(keywords: list[str]):
    """네이버 검색광고 API 호출 → DB UPSERT.
    naver.services._enrich_keywords_live 재사용 (이미 구현됨).
    """
    from naver import services as naver_svc

    try:
        result = naver_svc._enrich_keywords_live(keywords)
    except Exception as e:
        logger.warning('enrich_keywords_live 실패: %s', e)
        return

    if not result:
        return

    now = datetime.now()
    expires = now + timedelta(days=CACHE_TTL_DAYS)
    rows: list[tuple] = []
    for kw, data in result.items():
        pc = int(data.get('monthlyPcQcCnt') or 0)
        mb = int(data.get('monthlyMobileQcCnt') or 0)
        total = pc + mb
        comp = (data.get('compIdx') or '')[:20]
        pcount = data.get('productCount')
        cat = (data.get('category') or '')[:255]
        rows.append((kw, pc, mb, total, comp, pcount, cat, now, expires))

    if not rows:
        return

    with connections[DB].cursor() as cur:
        cur.executemany(
            """
            INSERT INTO naver_keyword_volume
              (keyword, pc_count, mobile_count, total_count, comp_idx,
               product_count, category_path, fetched_at, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              pc_count=VALUES(pc_count),
              mobile_count=VALUES(mobile_count),
              total_count=VALUES(total_count),
              comp_idx=VALUES(comp_idx),
              product_count=VALUES(product_count),
              category_path=VALUES(category_path),
              fetched_at=VALUES(fetched_at),
              expires_at=VALUES(expires_at)
            """,
            rows,
        )


def get_related_keywords(seed: str, limit: int = 30) -> list[dict]:
    """seed 키워드의 연관키워드 — 검색광고 API.
    반환: [{keyword, total, comp, pc, mobile}] desc.
    """
    from naver import services as naver_svc
    try:
        items = naver_svc.search_related_keywords(seed)
    except Exception as e:
        logger.warning('search_related_keywords 실패: %s', e)
        return []
    out: list[dict] = []
    for it in items[:limit]:
        kw = it.get('relKeyword', '')
        if not kw:
            continue
        pc = int(it.get('monthlyPcQcCnt') or 0)
        mb = int(it.get('monthlyMobileQcCnt') or 0)
        out.append({
            'keyword': kw,
            'pc': pc,
            'mobile': mb,
            'total': pc + mb,
            'comp': it.get('compIdx', ''),
        })
    out.sort(key=lambda x: x['total'], reverse=True)
    return out


def get_related_keywords_multi(seeds: list[str], limit: int = 1500,
                                save_to_cache: bool = True) -> list[dict]:
    """multi-seed 연관키워드 대량 수집.
    네이버 검색광고 `hintKeywords` 는 쉼표 구분 최대 5개 동시 가능,
    각 seed 마다 1000개 까지 반환. dedupe 후 조회수 desc.
    save_to_cache=True 면 naver_keyword_volume 에 UPSERT.
    """
    from naver import services as naver_svc
    if not seeds:
        return []
    # seed 정제: 2자 이상 한글, dedupe (대소문자 무시), 최대 5개
    clean: list[str] = []
    seen = set()
    for s in seeds:
        s = (s or '').strip()
        if len(s) < 2:
            continue
        # 한글 + 숫자만 (영어 단독은 skip)
        if not any(c >= '가' and c <= '힣' for c in s):
            continue
        if s.lower() in seen:
            continue
        seen.add(s.lower())
        clean.append(s)
        if len(clean) >= 5:
            break
    if not clean:
        return []

    # 검색광고 API — hintKeywords 콤마 묶어서 한 호출
    hint = ','.join(clean)
    try:
        items = naver_svc.search_related_keywords(hint)
    except Exception as e:
        logger.warning('multi search_related_keywords 실패: %s', e)
        return []

    def _safe_int(v) -> int:
        # 네이버 API 가 검색량 10 미만일 때 '< 10' 같은 문자열 반환
        try:
            return int(v)
        except (TypeError, ValueError):
            if isinstance(v, str) and '<' in v:
                return 5  # 10 미만 → 평균 5
            return 0

    out: list[dict] = []
    rows_for_cache: list[tuple] = []
    now = datetime.now()
    expires = now + timedelta(days=CACHE_TTL_DAYS)
    for it in items:
        kw = (it.get('relKeyword') or '').strip()
        if not kw:
            continue
        pc = _safe_int(it.get('monthlyPcQcCnt'))
        mb = _safe_int(it.get('monthlyMobileQcCnt'))
        total = pc + mb
        comp = (it.get('compIdx') or '')[:20]
        out.append({
            'keyword': kw, 'pc': pc, 'mobile': mb, 'total': total, 'comp': comp,
        })
        if save_to_cache:
            rows_for_cache.append((kw, pc, mb, total, comp, None, None, now, expires))
    out.sort(key=lambda x: x['total'], reverse=True)
    out = out[:limit]

    # 캐시 저장 (백그라운드)
    if rows_for_cache and save_to_cache:
        def _save():
            try:
                with connections[DB].cursor() as cur:
                    cur.executemany(
                        """
                        INSERT INTO naver_keyword_volume
                          (keyword, pc_count, mobile_count, total_count, comp_idx,
                           product_count, category_path, fetched_at, expires_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                          pc_count=VALUES(pc_count),
                          mobile_count=VALUES(mobile_count),
                          total_count=VALUES(total_count),
                          comp_idx=VALUES(comp_idx),
                          fetched_at=VALUES(fetched_at),
                          expires_at=VALUES(expires_at)
                        """,
                        rows_for_cache,
                    )
            except Exception as e:
                logger.warning('cache save 실패: %s', e)
        threading.Thread(target=_save, daemon=True).start()

    return out


def get_category_hot_keywords(category_path: str, limit: int = 20) -> list[dict]:
    """카테고리별 핫 키워드 캐시 조회. 캐시 없으면 빈 배열."""
    if not category_path:
        return []
    with connections[DB].cursor() as cur:
        cur.execute(
            """
            SELECT keyword, total_count, comp_idx
              FROM naver_category_hot_keywords
             WHERE category_path=%s
             ORDER BY rank_position
             LIMIT %s
            """,
            [category_path, limit],
        )
        return [{'keyword': k, 'total': t, 'comp': c}
                for k, t, c in cur.fetchall()]
