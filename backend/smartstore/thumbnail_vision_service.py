"""썸네일 라이브 비전 — pending 색상/재질/형태 속성 W코드 상품의 썸네일을
GPU(qwen2.5vl) 실시간 분석 → image_analysis 캐시 채움 → 자동 속성 등록.

이미지 소스: joacham 업스케일(HTTP, SSL 안전) 우선 → image_large/medium/small.
legacy HTTPS(DH_KEY_TOO_SMALL) 대비 SSL 완화 어댑터.
"""
from __future__ import annotations

import base64
import json
import os
import ssl

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context
from urllib3.exceptions import InsecureRequestWarning
from django.db import connections

from . import naver_vision_analyzer as nva

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'
PUBLIC_MEDIA = os.environ.get('PUBLIC_MEDIA_BASE_URL', 'http://www.joacham.com/imghost').rstrip('/')
GPU_HOSTS = [h.strip() for h in os.environ.get(
    'VISION_GPU_HOSTS', '192.168.219.108,192.168.219.111,192.168.219.136,192.168.219.219').split(',') if h.strip()]


class _LegacyAdapter(HTTPAdapter):
    """레거시 서버(DH_KEY_TOO_SMALL) 다운로드용 SSL 완화 어댑터."""
    def init_poolmanager(self, *a, **k):
        ctx = create_urllib3_context()
        try:
            ctx.set_ciphers('DEFAULT@SECLEVEL=1')
        except Exception:
            pass
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        k['ssl_context'] = ctx
        return super().init_poolmanager(*a, **k)


_sess = requests.Session()
_sess.mount('https://', _LegacyAdapter())


def gpu_url(host: str) -> str:
    return f'http://{host}:11434'


def _best_url(code, up, lg, md, sm) -> str | None:
    if up:
        return f'{PUBLIC_MEDIA}/{code}_1.jpg'
    return lg or md or sm


def _dl_b64(url: str) -> str | None:
    try:
        r = _sess.get(url, timeout=nva.IMAGE_DL_TIMEOUT, stream=True, verify=False)
        r.raise_for_status()
        data = r.raw.read(nva.IMAGE_MAX_BYTES + 1, decode_content=True)
        if not data or len(data) > nva.IMAGE_MAX_BYTES:
            return None
        return base64.b64encode(data).decode('ascii')
    except Exception:
        return None


def _save(code: str, analysis: dict):
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product SET image_analysis=%s, image_analyzed_at=NOW() WHERE product_code=%s",
            [json.dumps(analysis, ensure_ascii=False), code])


def analyze_code(code, up, lg, md, sm, host) -> dict | None:
    """단일 W코드 썸네일 → 비전분석 → 캐시저장. 성공 시 정규화 dict."""
    url = _best_url(code, up, lg, md, sm)
    if not url:
        return None
    b64 = _dl_b64(url)
    if not b64:
        return None
    gurl = gpu_url(host)
    for model in nva.DEFAULT_MODELS:
        try:
            raw = nva._call_ollama_vision(b64, model, gurl)
        except Exception:
            continue
        data = nva._parse_json(raw)
        if data:
            norm = nva._normalize(data)
            _save(code, norm)
            return norm
    return None


def target_codes(store_id=None, limit=500) -> list[dict]:
    """비전 미수행 + 색상/재질/형태 pending인 W코드 + 이미지 정보."""
    with connections[MYPRODUCT_DB].cursor() as cur:
        # smartstore_product 실존(등록가능) + 색/재질/형태 pending W코드만 (orphan 제외)
        q = ("SELECT DISTINCT m.seller_management_code FROM smartstore_product_missing_attrs m "
             "JOIN smartstore_product p ON p.seller_management_code="
             "  m.seller_management_code COLLATE utf8mb4_unicode_ci AND p.store_id=m.store_id "
             "WHERE m.status='pending' AND m.candidate_count>=2 AND m.seller_management_code LIKE 'W%%' "
             "AND (m.attribute_name LIKE '%%색상%%' OR m.attribute_name LIKE '%%재질%%' "
             "     OR m.attribute_name LIKE '%%소재%%' OR m.attribute_name LIKE '%%형태%%') ")
        params = []
        if store_id:
            q += "AND m.store_id=%s "
            params.append(int(store_id))
        # 캐시필터는 naverdb에서 별도로 하므로 후보를 넉넉히 확보(최대 8000)
        q += "LIMIT %s"
        params.append(min(int(limit) * 20, 8000))
        cur.execute(q, params)
        codes = [r[0] for r in cur.fetchall()]
    if not codes:
        return []
    out = []
    with connections[NAVERDB].cursor() as cur:
        for i in range(0, len(codes), 500):
            ch = codes[i:i + 500]
            ph = ','.join(['%s'] * len(ch))
            cur.execute(
                f"SELECT product_code, upscaled_image_url, image_large, image_medium, image_small "
                f"FROM naver_my_product WHERE product_code IN ({ph}) "
                f"AND (image_analysis IS NULL OR image_analysis='') "
                f"AND (upscaled_image_url IS NOT NULL OR image_large IS NOT NULL)", ch)
            for code, up, lg, md, sm in cur.fetchall():
                out.append({'code': code, 'up': up, 'lg': lg, 'md': md, 'sm': sm})
    return out[:int(limit)]
