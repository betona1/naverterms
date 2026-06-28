"""썸네일 AI 편집 결과 저장/복구 — naver_my_product.edited_image_url.

원본(image_large)은 절대 건드리지 않는다. 편집본만 backend/media/edited_thumbs/ 에 저장.
파일 URL 은 Django MEDIA_URL 로 서빙 (DEBUG 시 dev 서버, 운영 시 nginx 별도 설정).
"""
import base64
import os
import re
import time
from typing import Optional

from django.conf import settings
from django.db import connections

NAVERDB = 'naverdb'
SUBDIR = 'edited_thumbs'


def _media_dir() -> str:
    d = os.path.join(settings.MEDIA_ROOT, SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _decode_b64(image_b64: str) -> tuple[bytes, str]:
    """data URL 또는 순수 base64 → (bytes, 확장자)"""
    ext = 'webp'
    m = re.match(r'^data:image/(\w+);base64,(.+)$', image_b64, re.DOTALL)
    if m:
        ext = m.group(1).lower()
        if ext == 'jpeg':
            ext = 'jpg'
        data = base64.b64decode(m.group(2))
    else:
        data = base64.b64decode(image_b64)
    if ext not in ('webp', 'jpg', 'png'):
        ext = 'webp'
    return data, ext


def _product_code(product_id: int) -> Optional[str]:
    with connections[NAVERDB].cursor() as cur:
        cur.execute("SELECT product_code FROM naver_my_product WHERE id=%s", [product_id])
        row = cur.fetchone()
    return row[0] if row else None


def save_edited_thumbnail(product_id: int, image_b64: str) -> dict:
    """편집본 저장 → DB UPDATE → URL 반환.
    이전 편집본 파일은 지운다(같은 product_id 의 다른 timestamp 파일).
    """
    code = _product_code(product_id)
    if not code:
        return {'ok': False, 'error': 'not_found'}

    try:
        data, ext = _decode_b64(image_b64)
    except Exception as e:
        return {'ok': False, 'error': f'decode_failed: {e}'}
    if not data:
        return {'ok': False, 'error': 'empty_image'}
    if len(data) > 10 * 1024 * 1024:
        return {'ok': False, 'error': 'too_large (>10MB)'}

    d = _media_dir()
    # 이전 편집본 정리 (같은 product_code prefix)
    prefix = f'{code}_'
    for f in os.listdir(d):
        if f.startswith(prefix):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass

    ts = int(time.time())
    fname = f'{code}_{ts}.{ext}'
    fpath = os.path.join(d, fname)
    with open(fpath, 'wb') as fh:
        fh.write(data)

    url = f'{settings.MEDIA_URL}{SUBDIR}/{fname}'
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product SET edited_image_url=%s, is_modified=1, updated_at=NOW() WHERE id=%s",
            [url, product_id],
        )
    return {'ok': True, 'edited_image_url': url, 'bytes': len(data)}


def reset_edited_thumbnail(product_id: int) -> dict:
    """편집본 제거 → 원본만 사용. 파일도 함께 삭제."""
    code = _product_code(product_id)
    if not code:
        return {'ok': False, 'error': 'not_found'}
    d = _media_dir()
    prefix = f'{code}_'
    deleted = 0
    for f in os.listdir(d):
        if f.startswith(prefix):
            try:
                os.remove(os.path.join(d, f))
                deleted += 1
            except OSError:
                pass
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product SET edited_image_url=NULL, updated_at=NOW() WHERE id=%s",
            [product_id],
        )
    return {'ok': True, 'deleted_files': deleted}
