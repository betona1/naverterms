"""썸네일 변형 풀 — 제품당 최대 20개 변형 저장.

각 변형 = MEDIA 파일 1개 + naver_thumbnail_variant 행 1개.
활성 변형의 image_url 이 naver_my_product.edited_image_url 에 미러링됨.

원본(image_large)은 절대 건드리지 않음 (CLAUDE.md 규칙).
"""
import base64
import json
import os
import re
import secrets
import time
from typing import Optional

from django.conf import settings
from django.db import connections

NAVERDB = 'naverdb'
SUBDIR = 'edited_thumbs'
MAX_VARIANTS = 20
ALLOWED_SOURCE_TYPES = {
    'ai_edit', 'gemini', 'flux', 'detail_capture',
    'flip_h', 'flip_v', 'manual', 'bg_remove', 'text_remove',
    'upscale', 'rotate',
}


def _media_dir() -> str:
    d = os.path.join(settings.MEDIA_ROOT, SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _decode_b64(image_b64: str) -> tuple[bytes, str]:
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


def _image_size(data: bytes) -> tuple[Optional[int], Optional[int]]:
    """PIL 없이 size 가져오기는 어려우니 PIL 사용."""
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        return img.size
    except Exception:
        return None, None


def _row_to_dict(row, cols) -> dict:
    d = dict(zip(cols, row))
    if d.get('created_at'):
        d['created_at'] = d['created_at'].isoformat()
    if isinstance(d.get('source_meta'), str) and d['source_meta']:
        try:
            d['source_meta'] = json.loads(d['source_meta'])
        except json.JSONDecodeError:
            pass
    d['is_active'] = bool(d.get('is_active'))
    return d


def list_variants(product_id: int) -> dict:
    """제품 변형 풀 전체 + 카운트."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """SELECT id, product_id, image_url, source_type, source_meta,
                      width, height, bytes, is_active, label, created_at
                 FROM naver_thumbnail_variant
                WHERE product_id=%s
                ORDER BY is_active DESC, created_at DESC""",
            [product_id],
        )
        cols = [c[0] for c in cur.description]
        items = [_row_to_dict(r, cols) for r in cur.fetchall()]
    return {
        'ok': True,
        'items': items,
        'count': len(items),
        'max': MAX_VARIANTS,
        'remaining': max(0, MAX_VARIANTS - len(items)),
    }


def add_variant(
    product_id: int, image_b64: str,
    source_type: str, source_meta: Optional[dict] = None,
    label: Optional[str] = None, activate: bool = True,
) -> dict:
    """풀에 추가. 20개 초과 시 error. activate=True 면 즉시 활성화."""
    if source_type not in ALLOWED_SOURCE_TYPES:
        return {'ok': False, 'error': f'invalid source_type: {source_type}'}

    code = _product_code(product_id)
    if not code:
        return {'ok': False, 'error': 'not_found'}

    # 카운트 체크
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM naver_thumbnail_variant WHERE product_id=%s",
            [product_id],
        )
        current = cur.fetchone()[0]
    if current >= MAX_VARIANTS:
        return {
            'ok': False,
            'error': f'풀 가득참 ({current}/{MAX_VARIANTS}). 변형 1개 이상 삭제 후 재시도.',
            'count': current, 'max': MAX_VARIANTS,
        }

    # 파일 저장
    try:
        data, ext = _decode_b64(image_b64)
    except Exception as e:
        return {'ok': False, 'error': f'decode_failed: {e}'}
    if not data:
        return {'ok': False, 'error': 'empty_image'}
    if len(data) > 15 * 1024 * 1024:
        return {'ok': False, 'error': 'too_large (>15MB)'}

    w, h = _image_size(data)
    d = _media_dir()
    fname = f'{code}_{int(time.time() * 1000)}_{secrets.token_hex(3)}.{ext}'
    fpath = os.path.join(d, fname)
    with open(fpath, 'wb') as fh:
        fh.write(data)
    url = f'{settings.MEDIA_URL}{SUBDIR}/{fname}'

    # DB INSERT
    meta_json = json.dumps(source_meta or {}, ensure_ascii=False)
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """INSERT INTO naver_thumbnail_variant
                 (product_id, image_url, source_type, source_meta,
                  width, height, bytes, label, is_active)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0)""",
            [product_id, url, source_type, meta_json, w, h, len(data), label],
        )
        vid = cur.lastrowid

    if activate:
        activate_variant(product_id, vid)

    return {
        'ok': True,
        'variant_id': vid,
        'image_url': url,
        'bytes': len(data),
        'width': w, 'height': h,
        'count': current + 1,
        'max': MAX_VARIANTS,
        'activated': activate,
    }


def _push_to_218_storage(variant_file_url: str, product_code: str) -> Optional[tuple[str, int]]:
    """variant 파일을 218 sshfs mount 의 {code}_1.jpg 로 JPG 변환 저장.
    Returns (new_url, bytes) or None if 실패. 실패해도 fatal X (activate 는 계속).
    """
    try:
        from .naver_upscale_dispatcher import STORAGE_LOCAL_DIR, STORAGE_URL_PREFIX
        from PIL import Image
        # variant url → 로컬 파일 경로 (e.g. /media/edited_thumbs/X.png)
        media_url = settings.MEDIA_URL
        if not variant_file_url.startswith(media_url):
            return None
        rel = variant_file_url[len(media_url):]
        src = os.path.join(settings.MEDIA_ROOT, rel)
        if not os.path.exists(src):
            return None
        os.makedirs(STORAGE_LOCAL_DIR, exist_ok=True)
        fname = f'{product_code}_1.jpg'
        dst = os.path.join(STORAGE_LOCAL_DIR, fname)
        Image.open(src).convert('RGB').save(dst, 'JPEG', quality=92)
        new_url = f'{STORAGE_URL_PREFIX}{fname}'
        return new_url, os.path.getsize(dst)
    except Exception:
        return None


def activate_variant(product_id: int, variant_id: int) -> dict:
    """이 변형을 활성화:
       1) 변형 파일을 218 의 {code}_1.jpg 로 JPG 변환 저장 (sshfs mount).
       2) upscaled_image_url 에 218 URL 덮어쓰기 (NaverMyProductsPage 의 fallback chain 우선순위).
       3) edited_image_url 에도 동일 URL (호환성, 모든 source_type 대응).
       원본(image_large)은 절대 건드리지 않음.
    """
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT image_url, source_type, bytes FROM naver_thumbnail_variant WHERE id=%s AND product_id=%s",
            [variant_id, product_id],
        )
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'variant_not_found'}
        variant_url, source_type, vbytes = row[0], row[1], row[2] or 0
        # 모든 변형 비활성화 → 이거 활성화
        cur.execute(
            "UPDATE naver_thumbnail_variant SET is_active=0 WHERE product_id=%s",
            [product_id],
        )
        cur.execute(
            "UPDATE naver_thumbnail_variant SET is_active=1 WHERE id=%s",
            [variant_id],
        )
        # product_code 얻고 218 저장 시도
        code = _product_code(product_id)
        pushed = _push_to_218_storage(variant_url, code) if code else None
        if pushed:
            final_url, final_bytes = pushed
        else:
            final_url, final_bytes = variant_url, vbytes
        # upscaled_image_url (NaverMyProductsPage 우선 표시) + edited_image_url 둘 다 set
        if source_type == 'upscale' or pushed:
            cur.execute(
                """UPDATE naver_my_product
                      SET upscaled_image_url=%s, upscaled_at=NOW(), upscaled_bytes=%s,
                          edited_image_url=%s,
                          is_modified=1, updated_at=NOW()
                    WHERE id=%s""",
                [final_url, final_bytes, final_url, product_id],
            )
        else:
            # 218 푸시 실패 + upscale 아님 → 기존 edited_image_url 만 (옛 동작)
            cur.execute(
                """UPDATE naver_my_product
                      SET edited_image_url=%s, is_modified=1, updated_at=NOW()
                    WHERE id=%s""",
                [final_url, product_id],
            )
    return {
        'ok': True, 'variant_id': variant_id, 'image_url': final_url,
        'pushed_to_218': bool(pushed),
        'column': 'upscaled_image_url' if (source_type == 'upscale' or pushed) else 'edited_image_url',
    }


def deactivate_all(product_id: int) -> dict:
    """모든 변형 비활성화 + edited_image_url=NULL (원본 image_large 복귀)."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_thumbnail_variant SET is_active=0 WHERE product_id=%s",
            [product_id],
        )
        cur.execute(
            "UPDATE naver_my_product SET edited_image_url=NULL, updated_at=NOW() WHERE id=%s",
            [product_id],
        )
    return {'ok': True}


def delete_variant(product_id: int, variant_id: int) -> dict:
    """변형 삭제 + 파일 제거. 활성 변형이면 edited_image_url 도 비움."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT image_url, is_active FROM naver_thumbnail_variant WHERE id=%s AND product_id=%s",
            [variant_id, product_id],
        )
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'variant_not_found'}
        url, was_active = row[0], bool(row[1])
        cur.execute(
            "DELETE FROM naver_thumbnail_variant WHERE id=%s",
            [variant_id],
        )
        if was_active:
            cur.execute(
                "UPDATE naver_my_product SET edited_image_url=NULL, updated_at=NOW() WHERE id=%s",
                [product_id],
            )

    # 파일 삭제
    if url.startswith(settings.MEDIA_URL):
        rel = url[len(settings.MEDIA_URL):]
        fpath = os.path.join(settings.MEDIA_ROOT, rel)
        try:
            os.remove(fpath)
        except OSError:
            pass
    return {'ok': True, 'was_active': was_active}


def delete_all(product_id: int) -> dict:
    """변형 풀 전체 삭제 (개별 파일 + DB)."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT image_url FROM naver_thumbnail_variant WHERE product_id=%s",
            [product_id],
        )
        urls = [r[0] for r in cur.fetchall()]
        cur.execute(
            "DELETE FROM naver_thumbnail_variant WHERE product_id=%s",
            [product_id],
        )
        cur.execute(
            "UPDATE naver_my_product SET edited_image_url=NULL, updated_at=NOW() WHERE id=%s",
            [product_id],
        )
    for url in urls:
        if url.startswith(settings.MEDIA_URL):
            rel = url[len(settings.MEDIA_URL):]
            fpath = os.path.join(settings.MEDIA_ROOT, rel)
            try:
                os.remove(fpath)
            except OSError:
                pass
    return {'ok': True, 'deleted': len(urls)}


def update_label(product_id: int, variant_id: int, label: str) -> dict:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_thumbnail_variant SET label=%s WHERE id=%s AND product_id=%s",
            [label[:100] if label else None, variant_id, product_id],
        )
        if cur.rowcount == 0:
            return {'ok': False, 'error': 'variant_not_found'}
    return {'ok': True, 'label': label}
