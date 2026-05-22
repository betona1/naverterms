"""네이버 나의상품 — 11번가 my_product를 가져와 naverdb에 미러링하고
   네이버 ID(스토어) 단위 폴더로 관리. GPU 워커가 네이버 전용 상품명을 생성.

흐름:
  1. ensure_folders_from_stores() — myproduct.smartstoreIdList → naver_my_product_folder UPSERT
  2. import_from_11st() — ads.my_product (11번가 워킹카피) → naverdb.naver_my_product UPSERT
     - 진행상황은 _IMPORT_STATE 에 기록, GET /import-status/ 로 폴링
"""
from __future__ import annotations

import threading
import time
import traceback
from datetime import datetime
from typing import Iterable

from django.db import connections

NAVERDB = 'naverdb'
ADSDB = 'ads'
MYPRODUCT_DB = 'myproduct'

UNCLASSIFIED_FOLDER_ID = 1
QUEUE_PLATFORM = 'naver'  # ads.ai_keyword_task.platform 값

# ads.my_product 에서 가져올 컬럼 → naver_my_product 컬럼
MIRROR_COLUMNS = [
    'product_code', 'product_name', 'market_product_name',
    'ai_product_name', 'ai_recommended_name', 'edited_product_name',
    'category_code', 'category_name', 'manufacturer', 'brand',
    'model_name', 'origin', 'keywords',
    'ownerclan_price', 'consumer_price', 'market_price',
    'shipping_fee', 'return_fee',
    'image_large', 'image_medium', 'image_small',
    'option1_name', 'option1_values', 'option2_name', 'option2_values',
    'combined_option', 'product_attribute',
    'detail_html',
]


def _dictfetchall(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _serialize_row(row: dict) -> dict:
    for key in ('copied_at', 'synced_at', 'created_at', 'updated_at'):
        v = row.get(key)
        if isinstance(v, datetime):
            row[key] = v.isoformat()
    return row


# ── 폴더 ──────────────────────────────────────────────────────────

def list_folders() -> list[dict]:
    """폴더 목록 + 각 폴더 상품수."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """
            SELECT f.id, f.store_id, f.name, f.color, f.sort_order,
                   f.is_system, f.queue_position, f.description,
                   COALESCE(c.cnt, 0) AS product_count
              FROM naver_my_product_folder f
              LEFT JOIN (
                SELECT folder_id, COUNT(*) AS cnt
                  FROM naver_my_product GROUP BY folder_id
              ) c ON c.folder_id = f.id
             ORDER BY f.is_system DESC, f.sort_order, f.id
            """
        )
        return _dictfetchall(cur)


def ensure_folders_from_stores() -> dict:
    """myproduct.smartstoreIdList 의 활성 스토어마다 폴더 자동 생성.
    store_id(myproduct PK)를 폴더의 store_id 컬럼에 저장 → UNIQUE.
    """
    # 1) 활성 스토어 목록
    with connections[MYPRODUCT_DB].cursor() as cur:
        cur.execute(
            "SELECT id, store_name FROM smartstoreIdList "
            "WHERE is_active=1 ORDER BY id"
        )
        stores = cur.fetchall()

    created = 0
    updated = 0
    with connections[NAVERDB].cursor() as cur:
        for idx, (sid, sname) in enumerate(stores, start=1):
            cur.execute(
                """
                INSERT INTO naver_my_product_folder
                  (store_id, name, sort_order, is_system)
                VALUES (%s, %s, %s, 0)
                ON DUPLICATE KEY UPDATE
                  name=VALUES(name),
                  sort_order=VALUES(sort_order),
                  updated_at=CURRENT_TIMESTAMP
                """,
                [sid, sname, idx],
            )
            # rowcount: 1=insert, 2=update (mysql)
            if cur.rowcount == 1:
                created += 1
            elif cur.rowcount == 2:
                updated += 1

    return {'ok': True, 'stores_total': len(stores),
            'folders_created': created, 'folders_updated': updated}


# ── Import from 11st ────────────────────────────────────────────

_IMPORT_LOCK = threading.Lock()
_IMPORT_STATE: dict = {
    'running': False,
    'started_at': None,
    'finished_at': None,
    'total': 0,
    'processed': 0,
    'inserted': 0,
    'updated': 0,
    'error': None,
    'message': '',
}


def get_import_status() -> dict:
    with _IMPORT_LOCK:
        return dict(_IMPORT_STATE)


def _set_state(**kwargs):
    with _IMPORT_LOCK:
        _IMPORT_STATE.update(kwargs)


def _iter_11st_products(batch_size: int = 1000) -> Iterable[list[dict]]:
    """ads.my_product 를 청크 단위로 SELECT."""
    cols_sql = ', '.join(['id'] + MIRROR_COLUMNS)
    offset = 0
    while True:
        with connections[ADSDB].cursor() as cur:
            cur.execute(
                f"SELECT {cols_sql} FROM my_product "
                f"ORDER BY id LIMIT %s OFFSET %s",
                [batch_size, offset],
            )
            rows = _dictfetchall(cur)
        if not rows:
            return
        yield rows
        if len(rows) < batch_size:
            return
        offset += batch_size


def _upsert_naverdb(rows: list[dict], folder_id: int) -> tuple[int, int]:
    """naver_my_product 에 UPSERT. (inserted, updated) 반환."""
    if not rows:
        return 0, 0

    # MIRROR_COLUMNS 의 첫 컬럼이 product_code(UNIQUE). 추가 컬럼은 source_id/folder_id/copied_at.
    insert_cols = MIRROR_COLUMNS + ['source_id', 'folder_id', 'copied_at']
    placeholders = ', '.join(['%s'] * len(insert_cols))
    # product_code 는 UNIQUE 이므로 UPDATE 절에서는 제외.
    update_cols = [c for c in MIRROR_COLUMNS if c != 'product_code'] + ['source_id', 'folder_id', 'copied_at']
    update_clause = ', '.join([f"{c}=VALUES({c})" for c in update_cols])
    sql = (
        f"INSERT INTO naver_my_product ({', '.join(insert_cols)}) "
        f"VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )
    now = datetime.now()
    inserted = updated = 0
    with connections[NAVERDB].cursor() as cur:
        for r in rows:
            params = [r.get(c) for c in MIRROR_COLUMNS]
            params += [r['id'], folder_id, now]
            cur.execute(sql, params)
            # rowcount: 1=insert, 2=update
            if cur.rowcount == 1:
                inserted += 1
            elif cur.rowcount == 2:
                updated += 1
            else:
                # 0=값 동일(no-op)
                pass
    return inserted, updated


def _import_worker(batch_size: int):
    try:
        # 폴더 자동 생성 (스토어별)
        ensure_folders_from_stores()

        with connections[ADSDB].cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM my_product")
            total = cur.fetchone()[0]
        _set_state(total=total, message=f'{total:,}건 import 시작')

        ins_total = upd_total = proc = 0
        for batch in _iter_11st_products(batch_size=batch_size):
            ins, upd = _upsert_naverdb(batch, folder_id=UNCLASSIFIED_FOLDER_ID)
            ins_total += ins
            upd_total += upd
            proc += len(batch)
            _set_state(
                processed=proc, inserted=ins_total, updated=upd_total,
                message=f'{proc:,}/{total:,} 처리 ({ins_total:,} 신규 / {upd_total:,} 갱신)'
            )

        _set_state(
            running=False, finished_at=datetime.now().isoformat(),
            message=f'완료 — {ins_total:,} 신규 / {upd_total:,} 갱신 / 총 {proc:,}건'
        )
    except Exception as e:
        _set_state(
            running=False, finished_at=datetime.now().isoformat(),
            error=str(e), message=f'에러: {e}'
        )
        traceback.print_exc()


def start_import_from_11st(batch_size: int = 1000) -> dict:
    """11st my_product → naverdb naver_my_product 백그라운드 import 시작."""
    with _IMPORT_LOCK:
        if _IMPORT_STATE['running']:
            return {'ok': False, 'error': 'already_running',
                    'state': dict(_IMPORT_STATE)}
        _IMPORT_STATE.update({
            'running': True,
            'started_at': datetime.now().isoformat(),
            'finished_at': None,
            'total': 0, 'processed': 0,
            'inserted': 0, 'updated': 0,
            'error': None, 'message': '준비 중...',
        })

    t = threading.Thread(target=_import_worker, args=(batch_size,), daemon=True)
    t.start()
    return {'ok': True, 'state': get_import_status()}


# ── 상품 조회 ────────────────────────────────────────────────────

DETAIL_FIELDS = (
    'id, product_code, source_id, folder_id, '
    'product_name, market_product_name, '
    'ai_product_name, ai_recommended_name, edited_product_name, naver_product_name, '
    'naver_keywords, keywords, '
    'category_code, category_name, manufacturer, brand, model_name, origin, '
    'ownerclan_price, consumer_price, market_price, shipping_fee, return_fee, '
    'image_large, image_medium, image_small, '
    'option1_name, option1_values, option2_name, option2_values, combined_option, product_attribute, '
    'detail_html, '
    'sale_status, sync_status, is_modified, '
    'image_analysis, image_analyzed_at, '
    'copied_at, synced_at, created_at, updated_at'
)

# 편집 허용 필드 (UI 폼에서 보낼 수 있는 것만 화이트리스트)
PATCHABLE_FIELDS = {
    'product_name', 'naver_product_name', 'edited_product_name',
    'naver_keywords', 'keywords',
    'category_name', 'brand', 'manufacturer', 'origin', 'model_name',
    'folder_id',
}


def get_product_detail(product_id: int) -> dict | None:
    import json
    from datetime import datetime as _dt
    with connections[NAVERDB].cursor() as cur:
        cur.execute(f"SELECT {DETAIL_FIELDS} FROM naver_my_product WHERE id=%s", [product_id])
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        d = dict(zip(cols, row))
    # 직렬화
    for k, v in list(d.items()):
        if isinstance(v, _dt):
            d[k] = v.isoformat()
    # image_analysis JSON → dict
    ia = d.get('image_analysis')
    if isinstance(ia, str) and ia:
        try:
            d['image_analysis'] = json.loads(ia)
        except json.JSONDecodeError:
            pass
    return d


def patch_product(product_id: int, payload: dict) -> dict:
    """편집 허용 필드만 UPDATE. 빈 문자열은 NULL 로 변환 (CHAR 컬럼 NULL 허용)."""
    sets: list[str] = []
    params: list = []
    for k, v in (payload or {}).items():
        if k not in PATCHABLE_FIELDS:
            continue
        # folder_id 는 INT
        if k == 'folder_id':
            try:
                params.append(int(v))
            except (ValueError, TypeError):
                return {'ok': False, 'error': f'invalid folder_id: {v!r}'}
        else:
            params.append(v if v not in ('', None) else None)
        sets.append(f"{k}=%s")
    if not sets:
        return {'ok': False, 'error': '편집 가능한 필드가 없음'}
    sets.append('is_modified=1')
    sets.append('updated_at=NOW()')
    params.append(int(product_id))
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"UPDATE naver_my_product SET {', '.join(sets)} WHERE id=%s",
            params,
        )
        affected = cur.rowcount
    if affected == 0:
        return {'ok': False, 'error': 'not_found'}
    return {'ok': True, 'updated': True, 'detail': get_product_detail(product_id)}


def _split_kws(text) -> list[str]:
    if not text:
        return []
    if isinstance(text, list):
        return [str(k).strip() for k in text if str(k).strip()]
    return [k.strip() for k in str(text).replace('\n', ',').replace('/', ',').split(',') if k.strip()]


def get_keyword_pool(product_id: int) -> dict:
    """편집 모달의 키워드 풀.
    - vision_features: image_analysis.key_features (qwen2.5vl 시각 키워드)
    - vision_meta: color/material/form/package_qty/readable_text (참고 정보)
    - 11번가 my_product_ad_keyword: best/good/ad/functional (source_id 로 cross-DB)
    - preset_keywords: naver_my_product.keywords / naver_keywords (원본 + 사용자 편집)
    """
    import json as _json
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT source_id, image_analysis, keywords, naver_keywords, "
            "product_name, naver_product_name "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'not_found'}
        source_id, vision_raw, kw, naver_kw, product_name, naver_name = row

    # vision
    vision_features: list = []
    vision_meta: dict = {}
    if vision_raw:
        try:
            v = _json.loads(vision_raw) if isinstance(vision_raw, str) else vision_raw
            kf = v.get('key_features') or []
            if isinstance(kf, list):
                vision_features = [str(k) for k in kf if k]
            for k in ('color', 'material', 'form', 'package_qty', 'readable_text'):
                vision_meta[k] = v.get(k)
            # color 가 list 면 평탄화 → 칩 후보
            if isinstance(vision_meta.get('color'), list):
                vision_features = vision_features + [c for c in vision_meta['color'] if c]
        except (ValueError, TypeError):
            pass

    # 11번가 키워드 풀 (source_id 가 11st my_product.id 와 매핑)
    pool_11st = {
        'best_picks': [], 'good_picks': [], 'ad_keywords': [], 'functional_keywords': [],
    }
    if source_id:
        try:
            with connections[ADSDB].cursor() as cur:
                cur.execute(
                    "SELECT best_picks, good_picks, ad_keywords, functional_keywords "
                    "FROM my_product_ad_keyword WHERE my_product_id=%s",
                    [int(source_id)],
                )
                row2 = cur.fetchone()
                if row2:
                    pool_11st['best_picks'] = _split_kws(row2[0])
                    pool_11st['good_picks'] = _split_kws(row2[1])
                    pool_11st['ad_keywords'] = _split_kws(row2[2])
                    pool_11st['functional_keywords'] = _split_kws(row2[3])
        except Exception:
            pass

    return {
        'ok': True,
        'product_name': product_name,
        'naver_product_name': naver_name,
        'vision_features': vision_features,
        'vision_meta': vision_meta,
        'best_picks': pool_11st['best_picks'],
        'good_picks': pool_11st['good_picks'],
        'ad_keywords': pool_11st['ad_keywords'],
        'functional_keywords': pool_11st['functional_keywords'],
        'preset_keywords': _split_kws(kw),
        'naver_keywords': _split_kws(naver_kw),
    }


def clear_image_analysis(product_id: int) -> dict:
    """비전 분석 캐시 삭제 — 다음 generate 시 재분석."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product "
            "SET image_analysis=NULL, image_analyzed_at=NULL "
            "WHERE id=%s",
            [int(product_id)],
        )
        affected = cur.rowcount
    if affected == 0:
        return {'ok': False, 'error': 'not_found'}
    return {'ok': True}


def move_products(ids: list[int], folder_id: int) -> dict:
    """선택된 상품들을 지정 폴더로 이동."""
    if not ids:
        return {'ok': False, 'error': 'ids 비어있음'}
    folder_id = int(folder_id)

    with connections[NAVERDB].cursor() as cur:
        # 폴더 존재 검증
        cur.execute("SELECT id FROM naver_my_product_folder WHERE id=%s", [folder_id])
        if not cur.fetchone():
            return {'ok': False, 'error': f'폴더 {folder_id} 없음'}

        ph = ','.join(['%s'] * len(ids))
        cur.execute(
            f"UPDATE naver_my_product SET folder_id=%s WHERE id IN ({ph})",
            [folder_id] + list(ids),
        )
        moved = cur.rowcount

    return {'ok': True, 'moved': moved, 'folder_id': folder_id}


## ── 듀얼 워커 큐 (ads.ai_keyword_task, platform='naver') ────────────

def enqueue_products(ids: list[int] | None = None,
                     folder_id: int | None = None,
                     only_missing: bool = True,
                     top_sales: int | None = None) -> dict:
    """네이버 상품명 생성 task 를 ads.ai_keyword_task 에 enqueue.

    Args:
        ids: 직접 지정 (priority 1)
        folder_id: 폴더 단위 (priority 2)
        top_sales: 매출 상위 N개 (priority 3) — myproduct.eleven_sales_w_stats 기준
        only_missing: True 면 naver_product_name 이 NULL/'' 인 것만
    """
    target_ids: list[int] = []

    if ids:
        target_ids = [int(x) for x in ids]
    elif top_sales is not None and top_sales > 0:
        # 매출 상위 W코드 → naver_my_product.id 매핑
        # eleven_sales_w_stats 는 myproduct DB, naver_my_product 는 naverdb → 분리 쿼리
        with connections[MYPRODUCT_DB].cursor() as cur:
            cur.execute(
                "SELECT w_code FROM eleven_sales_w_stats "
                "WHERE w_code IS NOT NULL AND w_code <> '' "
                "ORDER BY total_amount DESC LIMIT %s",
                [int(top_sales) * 3],  # only_missing 필터 손실 대비 3배 후보
            )
            top_wcodes = [r[0] for r in cur.fetchall()]
        if not top_wcodes:
            return {'ok': True, 'queued': 0, 'requested': 0}

        with connections[NAVERDB].cursor() as cur:
            ph = ','.join(['%s'] * len(top_wcodes))
            where = [f'product_code IN ({ph})']
            params: list = list(top_wcodes)
            if only_missing:
                where.append("(naver_product_name IS NULL OR naver_product_name='')")
            # 매출 순서 보존: FIELD(product_code, ...) 로 정렬
            order_field = ', '.join(['%s'] * len(top_wcodes))
            cur.execute(
                f"SELECT id FROM naver_my_product WHERE {' AND '.join(where)} "
                f"ORDER BY FIELD(product_code, {order_field}) LIMIT %s",
                params + list(top_wcodes) + [int(top_sales)],
            )
            target_ids = [r[0] for r in cur.fetchall()]
    elif folder_id is not None:
        with connections[NAVERDB].cursor() as cur:
            where = ['folder_id=%s']
            params: list = [int(folder_id)]
            if only_missing:
                where.append("(naver_product_name IS NULL OR naver_product_name='')")
            cur.execute(
                f"SELECT id FROM naver_my_product WHERE {' AND '.join(where)} ORDER BY id",
                params,
            )
            target_ids = [r[0] for r in cur.fetchall()]
    else:
        # all_missing: 모든 미생성
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                "SELECT id FROM naver_my_product "
                "WHERE naver_product_name IS NULL OR naver_product_name=''"
            )
            target_ids = [r[0] for r in cur.fetchall()]

    if not target_ids:
        return {'ok': True, 'queued': 0, 'requested': 0}

    # 이미 큐에 들어가 있는 (pending/running) 것은 중복 INSERT 방지
    with connections[ADSDB].cursor() as cur:
        ph = ','.join(['%s'] * len(target_ids))
        cur.execute(
            f"SELECT product_id FROM ai_keyword_task "
            f"WHERE platform=%s AND product_id IN ({ph}) AND status IN ('pending','running')",
            [QUEUE_PLATFORM] + target_ids,
        )
        existing = {r[0] for r in cur.fetchall()}

    to_insert = [pid for pid in target_ids if pid not in existing]
    if not to_insert:
        return {'ok': True, 'queued': 0, 'requested': len(target_ids), 'already_queued': len(existing)}

    with connections[ADSDB].cursor() as cur:
        # ON DUPLICATE: 이미 done/error 인 task 도 platform='naver' 면 pending 으로 재투입
        # (only_missing=False 일 때 강제 재생성 의도. uniq_product 인덱스 회피)
        cur.executemany(
            "INSERT INTO ai_keyword_task "
            "(product_id, folder_id, folder_queue_position, claimed_by, platform, status) "
            "VALUES (%s, 1, 0, NULL, %s, 'pending') "
            "ON DUPLICATE KEY UPDATE "
            "  platform=VALUES(platform), status='pending', "
            "  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, "
            "  completed_at=NULL, error=NULL, retry_count=0",
            [(pid, QUEUE_PLATFORM) for pid in to_insert],
        )
        inserted = cur.rowcount

    return {
        'ok': True,
        'queued': inserted,
        'requested': len(target_ids),
        'already_queued': len(existing),
    }


def get_queue_status() -> dict:
    """현재 platform='naver' 큐 상태 + 워커별 진행 현황."""
    out = {'pending': 0, 'running': 0, 'done_recent': 0, 'error': 0, 'by_worker': []}
    with connections[ADSDB].cursor() as cur:
        cur.execute(
            "SELECT status, COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s GROUP BY status",
            [QUEUE_PLATFORM],
        )
        for status, n in cur.fetchall():
            if status == 'done':
                # done 은 최근 1시간만 세서 노이즈 줄임
                continue
            out[status] = n
        cur.execute(
            "SELECT COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s AND status='done' AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)",
            [QUEUE_PLATFORM],
        )
        out['done_recent'] = cur.fetchone()[0]
        cur.execute(
            "SELECT claimed_by, status, COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s AND claimed_by IS NOT NULL AND status IN ('running','done') "
            "AND COALESCE(completed_at, claimed_at) >= DATE_SUB(NOW(), INTERVAL 1 HOUR) "
            "GROUP BY claimed_by, status ORDER BY claimed_by",
            [QUEUE_PLATFORM],
        )
        worker_map: dict = {}
        for ep, status, n in cur.fetchall():
            if ep not in worker_map:
                worker_map[ep] = {'endpoint': ep, 'running': 0, 'done': 0}
            worker_map[ep][status] = n
        out['by_worker'] = list(worker_map.values())
    return out


def get_products(page: int = 1, per_page: int = 50,
                 folder_id: int | None = None,
                 search: str | None = None,
                 sort: str = 'id_desc',
                 include_sales: bool = False) -> dict:
    """상품 목록.

    sort:
        'id_desc'   (기본)
        'sales'     매출액 desc (eleven_sales_w_stats.total_amount)
        'updated'   updated_at desc
    include_sales: 응답에 sales (total_amount, total_quantity, order_count) 포함
    """
    page = max(1, int(page))
    per_page = max(1, min(int(per_page), 500))
    offset = (page - 1) * per_page

    where = ['1=1']
    params: list = []
    if folder_id is not None:
        where.append('p.folder_id=%s')
        params.append(int(folder_id))
    if search:
        where.append("(p.product_code LIKE %s OR p.product_name LIKE %s OR p.ai_product_name LIKE %s)")
        like = f'%{search}%'
        params += [like, like, like]
    where_sql = ' AND '.join(where)

    fields = (
        'p.id, p.product_code, p.source_id, p.folder_id, p.product_name, '
        'p.ai_product_name, p.ai_recommended_name, p.edited_product_name, '
        'p.naver_product_name, p.category_name, p.brand, p.manufacturer, p.origin, '
        'p.ownerclan_price, p.market_price, p.shipping_fee, p.return_fee, '
        'p.image_small, p.image_large, p.sale_status, p.sync_status, '
        'p.copied_at, p.synced_at, p.created_at, p.updated_at'
    )

    # 매출 정렬 또는 매출 정보 표시 시 — 매출 W코드를 미리 가져와 IN 절로 좁힘 (cross-DB JOIN 불가)
    sales_map: dict = {}
    if sort == 'sales' or include_sales:
        # 1차: 매출 정렬이면 매출 상위 W코드 추출
        if sort == 'sales':
            with connections[MYPRODUCT_DB].cursor() as cur:
                cur.execute(
                    "SELECT w_code, total_amount, total_quantity, order_count "
                    "FROM eleven_sales_w_stats "
                    "WHERE w_code IS NOT NULL AND total_amount > 0 "
                    "ORDER BY total_amount DESC LIMIT %s",
                    [per_page * page + 1000],  # 충분히 가져와서 페이지네이션 안정화
                )
                for r in cur.fetchall():
                    sales_map[r[0]] = {'total_amount': r[1], 'total_quantity': r[2], 'order_count': r[3]}
            wcodes = list(sales_map.keys())
            if not wcodes:
                return {'items': [], 'total': 0, 'page': page, 'per_page': per_page, 'total_pages': 0}
            ph = ','.join(['%s'] * len(wcodes))
            where.append(f'p.product_code IN ({ph})')
            params.extend(wcodes)
            where_sql = ' AND '.join(where)
            # 매출액 순서 보존
            order_clause = f"FIELD(p.product_code, {','.join(['%s'] * len(wcodes))})"
            order_params = list(wcodes)
        else:
            order_clause = 'p.id DESC'
            order_params = []
    else:
        order_clause = {
            'id_desc': 'p.id DESC',
            'updated': 'p.updated_at DESC, p.id DESC',
        }.get(sort, 'p.id DESC')
        order_params = []

    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"SELECT COUNT(*) FROM naver_my_product p WHERE {where_sql}", params)
        total = cur.fetchone()[0]
        cur.execute(
            f"SELECT {fields} FROM naver_my_product p "
            f"WHERE {where_sql} ORDER BY {order_clause} LIMIT %s OFFSET %s",
            params + order_params + [per_page, offset],
        )
        items = [_serialize_row(r) for r in _dictfetchall(cur)]

    # 페이지 항목에만 매출 정보 lookup (include_sales=True 일 때 sales_map 비어있으면 채움)
    if include_sales:
        if not sales_map:
            wcodes_page = [it['product_code'] for it in items if it.get('product_code')]
            if wcodes_page:
                with connections[MYPRODUCT_DB].cursor() as cur:
                    ph = ','.join(['%s'] * len(wcodes_page))
                    cur.execute(
                        f"SELECT w_code, total_amount, total_quantity, order_count "
                        f"FROM eleven_sales_w_stats WHERE w_code IN ({ph})",
                        wcodes_page,
                    )
                    for r in cur.fetchall():
                        sales_map[r[0]] = {'total_amount': r[1], 'total_quantity': r[2], 'order_count': r[3]}
        for it in items:
            s = sales_map.get(it.get('product_code'))
            if s:
                it['sales'] = s

    return {
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page if total else 0,
    }
