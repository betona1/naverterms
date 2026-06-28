"""속성 동기화(적용) 서비스 — 스테이징(status='classified')된 추론값을 네이버에 PUT.

3단계 파이프라인:
  1) 수집(크롤)  →  pending
  2) 추론(GPU stage_sku)  →  classified  (네이버 PUT 없음)
  3) 동기화(apply_staged)  →  registered  (네이버 PUT, 이 단계만 등록)

apply_staged 는 classified 행을 SKU 별로 묶어 register_for_sku(dry_run=False) 호출 →
성공시 register_for_sku 가 해당 행을 status='registered' 로 마킹한다.
"""
from __future__ import annotations

import os
import subprocess
from django.db import connections

from . import missing_attrs_service

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'
WORKER_KEY = 'attr_sync'
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def apply_staged(store_id=None, limit=5000) -> dict:
    """classified 추론값을 SKU 단위로 네이버에 적용(PUT)."""
    where = ["m.status='classified'"]
    params = []
    if store_id:
        where.append('p.store_id=%s')
        params.append(int(store_id))
    where_sql = ' AND '.join(where)

    # 등록가능(smartstore_product 실존, origin_product_no 보유) SKU 의 classified 행
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute(f"""
            SELECT m.seller_management_code, p.store_id,
                   m.attribute_seq, m.recommended_value_seq, m.recommended_value_text
            FROM smartstore_product_missing_attrs m
            JOIN smartstore_product p
              ON p.seller_management_code=m.seller_management_code COLLATE utf8mb4_unicode_ci
                 AND p.store_id=m.store_id
            WHERE {where_sql} AND p.origin_product_no IS NOT NULL
              AND p.status_type='SALE'
            ORDER BY p.store_id, m.seller_management_code
            LIMIT %s
        """, params + [int(limit)])
        rows = c.fetchall()

    # SKU 별 selections 그룹핑
    skus: dict = {}
    for seller, sid, aseq, vseq, vtext in rows:
        skus.setdefault((seller, sid), []).append({
            'attribute_seq': aseq,
            'value_seq': vseq or 0,
            'value_text': (vtext or '').split(',')[0].strip() if vtext else '',
        })

    res = {'skus': len(skus), 'attr_rows': len(rows), 'ok': 0, 'fail': 0, 'attrs_set': 0, 'errors': []}
    for (seller, sid), sels in skus.items():
        try:
            r = missing_attrs_service.register_for_sku(seller, sid, sels, dry_run=False)
        except Exception as e:
            r = {'ok': False, 'error': f'exc: {e}'}
        if r.get('ok'):
            res['ok'] += 1
            res['attrs_set'] += r.get('attrs_set', 0)
        else:
            res['fail'] += 1
            if len(res['errors']) < 50:
                res['errors'].append(f'{seller}: {r.get("error","?")[:150]}')
    return res


def start_sync(store_id=None, limit=5000) -> dict:
    """백그라운드 동기화 배치(attr_sync_batch.py) 실행."""
    st = sync_status()
    if st.get('running'):
        return {'ok': False, 'error': '이미 실행 중', 'worker': st.get('worker')}
    args = ['python3', '-u', 'attr_sync_batch.py', str(int(limit)),
            str(int(store_id)) if store_id else 'all']
    log_path = os.path.join(_BASE, 'exports', 'attr_sync.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logf = open(log_path, 'a')
    subprocess.Popen(args, cwd=_BASE,
                     env={**os.environ, 'DJANGO_SETTINGS_MODULE': 'config.settings'},
                     stdout=logf, stderr=logf)
    return {'ok': True, 'started': True, 'limit': limit, 'store_id': store_id}


def _launch(args: list, log_name: str) -> None:
    log_path = os.path.join(_BASE, 'exports', log_name)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logf = open(log_path, 'a')
    subprocess.Popen(args, cwd=_BASE,
                     env={**os.environ, 'DJANGO_SETTINGS_MODULE': 'config.settings'},
                     stdout=logf, stderr=logf)


def start_crawl(store_id=None) -> dict:
    """① 수집(크롤)+탐지 — 커머스 API로 현재속성 수집 후 빈속성 탐지."""
    _, running = _worker_row('api_attr_crawl')
    if running:
        return {'ok': False, 'error': '수집 이미 실행 중'}
    sid = str(int(store_id)) if store_id else None
    # 크롤 → 탐지 체인 (sh -c)
    crawl = f"python3 -u api_attr_crawl.py --skip-done" + (f" --store-id {sid}" if sid else "")
    detect = f"python3 -u detect_missing_attrs.py" + (f" --store {sid}" if sid else "")
    _launch(['sh', '-c', f"{crawl} && {detect}"], 'pipeline_crawl.log')
    return {'ok': True, 'started': True, 'store_id': store_id}


def start_stage(store_id=None, limit=5000) -> dict:
    """② 추론(GPU stage) — 빈속성을 상품명+이미지+상세로 GPU 분류해 스테이징(PUT 없음)."""
    _, running = _worker_row('gpu_attr_stage')
    if running:
        return {'ok': False, 'error': '추론 이미 실행 중'}
    args = ['python3', '-u', 'gpu_attr_stage_batch.py', str(int(limit)),
            str(int(store_id)) if store_id else 'all']
    _launch(args, 'pipeline_stage.log')
    return {'ok': True, 'started': True, 'store_id': store_id, 'limit': limit}


def workers() -> dict:
    """3단계 워커 진행상태 (수집/추론/동기화)."""
    out = {}
    for key, stage in [('api_attr_crawl', 'crawl'), ('gpu_attr_stage', 'stage'), (WORKER_KEY, 'sync')]:
        w, running = _worker_row(key)
        out[stage] = {'running': running, 'log': (w or {}).get('log'), 'name': (w or {}).get('name')}
    return out


def _is_running(status, idle_sec, log) -> bool:
    """WorkerLog는 항상 'ok'라 idle + 완료메시지로 진행중 판정."""
    if status in ('dead', 'degraded'):
        return False
    if idle_sec is None or idle_sec >= 300:
        return False
    lg = log or ''
    if lg.startswith('완료') or lg.startswith('대상 없음'):
        return False
    return True


def _worker_row(key):
    try:
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                "SELECT worker_key, worker_name, status, last_log_line, last_heartbeat_at, "
                "TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) "
                "FROM crawl_worker_status WHERE worker_key=%s", [key])
            r = cur.fetchone()
        if r:
            worker = {'key': r[0], 'name': r[1], 'status': r[2], 'log': r[3],
                      'heartbeat_at': r[4], 'idle_sec': r[5]}
            running = _is_running(r[2], r[5], r[3])
            return worker, running
    except Exception:
        pass
    return None, False


def sync_status() -> dict:
    """동기화 워커 상태 + classified/registered 남은 카운트."""
    worker, running = _worker_row(WORKER_KEY)
    counts = {}
    try:
        with connections[MYPRODUCT_DB].cursor() as cur:
            cur.execute("SELECT status, COUNT(*) FROM smartstore_product_missing_attrs "
                        "WHERE status IN ('classified','registered') GROUP BY status")
            counts = {k: v for k, v in cur.fetchall()}
    except Exception:
        pass
    return {'running': running, 'worker': worker, 'counts': counts}


def pipeline_status(store_id=None) -> dict:
    """스토어별 파이프라인 카운트(등록가능 SKU 의 속성행) + 수집 커버리지.
      pending/classified/registered : missing_attrs 행 수 (smartstore_product JOIN)
      sale_skus      : 해당 스토어 SALE 상품 수
      crawled_skus   : 그 중 attr_crawl_log status='ok' 보유 SKU 수
    """
    where = ['1=1']
    params = []
    if store_id:
        where.append('p.store_id=%s')
        params.append(int(store_id))
    where_sql = ' AND '.join(where)

    out: dict = {}
    with connections[MYPRODUCT_DB].cursor() as c:
        # 속성 단계별 카운트
        c.execute(f"""
            SELECT p.store_id,
                   SUM(CASE WHEN m.status='pending'    THEN 1 ELSE 0 END) AS pending,
                   SUM(CASE WHEN m.status='classified' THEN 1 ELSE 0 END) AS classified,
                   SUM(CASE WHEN m.status='registered' THEN 1 ELSE 0 END) AS registered
            FROM smartstore_product_missing_attrs m
            JOIN smartstore_product p
              ON p.seller_management_code=m.seller_management_code COLLATE utf8mb4_unicode_ci
                 AND p.store_id=m.store_id
            WHERE {where_sql}
            GROUP BY p.store_id
        """, params)
        for sid, pend, cls, reg in c.fetchall():
            out[sid] = {'store_id': sid, 'pending': int(pend or 0),
                        'classified': int(cls or 0), 'registered': int(reg or 0),
                        'sale_skus': 0, 'crawled_skus': 0}

        # 수집 커버리지 — SALE 상품 수 / crawl_log ok 보유 수
        cov_where = ["p.status_type='SALE'"]
        cov_params = []
        if store_id:
            cov_where.append('p.store_id=%s')
            cov_params.append(int(store_id))
        cov_sql = ' AND '.join(cov_where)
        c.execute(f"""
            SELECT p.store_id,
                   COUNT(*) AS sale_skus,
                   SUM(CASE WHEN l.seller_management_code IS NOT NULL THEN 1 ELSE 0 END) AS crawled
            FROM smartstore_product p
            LEFT JOIN (
                SELECT DISTINCT seller_management_code, store_id
                FROM smartstore_attr_crawl_log WHERE status='ok'
            ) l ON l.seller_management_code=p.seller_management_code COLLATE utf8mb4_unicode_ci
                   AND l.store_id=p.store_id
            WHERE {cov_sql}
            GROUP BY p.store_id
        """, cov_params)
        for sid, sale, crawled in c.fetchall():
            row = out.setdefault(sid, {'store_id': sid, 'pending': 0, 'classified': 0,
                                       'registered': 0, 'sale_skus': 0, 'crawled_skus': 0})
            row['sale_skus'] = int(sale or 0)
            row['crawled_skus'] = int(crawled or 0)

        # 스토어명
        c.execute("SELECT id, store_name FROM smartstoreIdList")
        names = {r[0]: r[1] for r in c.fetchall()}

    items = []
    for sid in sorted(out.keys()):
        row = out[sid]
        row['store_name'] = names.get(sid, f'store_{sid}')
        items.append(row)

    totals = {
        'pending': sum(r['pending'] for r in items),
        'classified': sum(r['classified'] for r in items),
        'registered': sum(r['registered'] for r in items),
        'sale_skus': sum(r['sale_skus'] for r in items),
        'crawled_skus': sum(r['crawled_skus'] for r in items),
    }
    return {'ok': True, 'stores': items, 'totals': totals}


def product_attrs(seller_code, store_id=None) -> dict:
    """단일 상품의 속성 추론/등록 현황 (개별 표시용).
    store_id 미지정 시 해당 W코드를 보유한 임의 스토어로 자동 해석(My상품용)."""
    import json
    with connections[MYPRODUCT_DB].cursor() as c:
        if not store_id:
            c.execute("SELECT store_id FROM smartstore_product_missing_attrs "
                      "WHERE seller_management_code=%s ORDER BY store_id LIMIT 1", [seller_code])
            r = c.fetchone()
            store_id = r[0] if r else 0
        c.execute("""
            SELECT attribute_name, classification_type, status,
                   candidate_values_json, recommended_value_text, registered_value_text
            FROM smartstore_product_missing_attrs
            WHERE seller_management_code=%s AND store_id=%s
            ORDER BY status, attribute_name
        """, [seller_code, int(store_id)])
        cols = [d[0] for d in c.description]
        rows = [dict(zip(cols, r)) for r in c.fetchall()]
    items = []
    for r in rows:
        try:
            cands = json.loads(r.pop('candidate_values_json') or '[]')
        except Exception:
            cands = []
        items.append({
            'attribute_name': r['attribute_name'],
            'classification_type': r['classification_type'],
            'status': r['status'],
            'candidate_values': [{'seq': c2.get('seq'), 'text': c2.get('text')} for c2 in cands],
            'recommended_value_text': r['recommended_value_text'],
            'registered_value_text': r['registered_value_text'],
        })
    return {'ok': True, 'seller_code': seller_code, 'store_id': int(store_id), 'attributes': items}


def product_context(seller_code, store_id=None) -> dict:
    """단일 상품의 실물 컨텍스트(상품명/카테고리/대표이미지/상세이미지/상세텍스트).
    커머스 API GET 1회 — 모달 오픈/SKU 선택 시에만 호출(리스트 호출 금지).
    store_id 미지정 시 W코드 보유 스토어로 자동 해석(product_attrs 와 동일)."""
    import re
    from . import gpu_attr_classifier as gac
    from . import smartstore_product_service as sps
    import requests

    with connections[MYPRODUCT_DB].cursor() as c:
        if not store_id:
            c.execute("SELECT store_id FROM smartstore_product WHERE seller_management_code=%s "
                      "AND origin_product_no IS NOT NULL ORDER BY store_id LIMIT 1", [seller_code])
            r = c.fetchone()
            if not r:
                c.execute("SELECT store_id FROM smartstore_product_missing_attrs "
                          "WHERE seller_management_code=%s ORDER BY store_id LIMIT 1", [seller_code])
                r = c.fetchone()
            store_id = r[0] if r else 0
        if not store_id:
            return {'ok': False, 'error': 'store_id 해석 실패'}
        c.execute("SELECT origin_product_no, name, whole_category_name FROM smartstore_product "
                  "WHERE seller_management_code=%s AND store_id=%s LIMIT 1",
                  [seller_code, int(store_id)])
        pr = c.fetchone()
    if not pr or not pr[0]:
        return {'ok': False, 'error': '상품 없음', 'seller_code': seller_code, 'store_id': int(store_id)}
    opno, db_name, db_cat = pr

    try:
        token = gac._token(int(store_id))
    except Exception as e:
        return {'ok': False, 'error': f'토큰 실패: {str(e)[:120]}',
                'seller_code': seller_code, 'store_id': int(store_id), 'name': db_name}

    try:
        det = requests.get(sps.NAVER_PRODUCT_DETAIL_URL.format(opno),
                           headers={'Authorization': f'Bearer {token}'}, timeout=20).json()
    except Exception as e:
        return {'ok': False, 'error': f'API 실패: {str(e)[:120]}',
                'seller_code': seller_code, 'store_id': int(store_id), 'name': db_name}

    op = det.get('originProduct', {}) or {}
    imgs = op.get('images', {}) or {}
    rep = (imgs.get('representativeImage') or {}).get('url')
    option_images = [(o or {}).get('url') for o in (imgs.get('optionalImages') or []) if (o or {}).get('url')]

    detail_html = op.get('detailContent') or ''
    # 상세 HTML 에서 <img src> 추출 (최대 12, dedupe, data: URI 제외)
    detail_images, seen = [], set()
    for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', detail_html, re.I):
        u = m.group(1).strip()
        if not u or u.lower().startswith('data:') or u in seen:
            continue
        if u.startswith('//'):
            u = 'https:' + u
        seen.add(u)
        detail_images.append(u)
        if len(detail_images) >= 12:
            break
    detail_text = re.sub(r'<[^>]+>', ' ', detail_html)
    detail_text = re.sub(r'\s+', ' ', detail_text).strip()[:1500]

    # 카테고리명: 상세 GET 응답엔 사람이 읽는 카테고리명이 없어 DB(whole_category_name) 우선.
    category_name = (db_cat or '') or op.get('wholeCategoryName') or ''

    return {
        'ok': True,
        'seller_code': seller_code,
        'store_id': int(store_id),
        'name': op.get('name') or db_name,
        'category_name': category_name,
        'representative_image': rep,
        'option_images': option_images,
        'detail_images': detail_images,
        'detail_text': detail_text,
    }


def list_by_status(status, store_id=None, limit=200, search='') -> dict:
    """특정 status(pending/classified/registered/needs_manual/fail)의 SKU 목록.
    distinct SKU(seller_code, store_id) + 상품명 + 해당 status 속성행 수.
    needs_manual 의 경우 SALE 상품 우선 정렬(비SALE은 등록 불가).
    """
    valid = {'pending', 'classified', 'registered', 'needs_manual', 'fail'}
    if status not in valid:
        return {'ok': False, 'error': f'invalid status: {status}', 'items': []}
    where = ['m.status=%s']
    params = [status]
    if store_id:
        where.append('p.store_id=%s')
        params.append(int(store_id))
    if search and search.strip():
        where.append('(m.seller_management_code LIKE %s OR p.name LIKE %s)')
        like = f'%{search.strip()}%'
        params += [like, like]
    where_sql = ' AND '.join(where)
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute(f"""
            SELECT m.seller_management_code, p.store_id, s.store_name, p.name,
                   p.status_type, COUNT(*) AS attr_count
            FROM smartstore_product_missing_attrs m
            JOIN smartstore_product p
              ON p.seller_management_code=m.seller_management_code COLLATE utf8mb4_unicode_ci
                 AND p.store_id=m.store_id
            LEFT JOIN smartstoreIdList s ON s.id=p.store_id
            WHERE {where_sql}
            GROUP BY m.seller_management_code, p.store_id, s.store_name, p.name, p.status_type
            ORDER BY (p.status_type='SALE') DESC, attr_count DESC
            LIMIT %s
        """, params + [int(limit)])
        rows = c.fetchall()
    items = [{
        'seller_code': r[0],
        'store_id': r[1],
        'store_name': r[2] or (f'store_{r[1]}' if r[1] else '-'),
        'name': r[3],
        'status_type': r[4],
        'is_sale': (r[4] == 'SALE'),
        'attr_count': int(r[5] or 0),
    } for r in rows]
    return {'ok': True, 'status': status, 'items': items}


def needs_manual_for_sku(seller_code, store_id) -> dict:
    """단일 SKU 의 needs_manual 속성 + 후보값(파싱). 수동검토 저장용."""
    import json
    where = ["m.status='needs_manual'", 'm.seller_management_code=%s']
    params = [seller_code]
    if store_id:
        where.append('m.store_id=%s')
        params.append(int(store_id))
    where_sql = ' AND '.join(where)
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute(f"""
            SELECT m.attribute_seq, m.attribute_name, m.classification_type,
                   m.candidate_values_json, m.recommended_value_seq,
                   m.recommended_value_text, m.last_error
            FROM smartstore_product_missing_attrs m
            WHERE {where_sql}
            ORDER BY m.attribute_name
        """, params)
        rows = c.fetchall()
    attrs = []
    for aseq, aname, cls, cj, rseq, rtext, err in rows:
        try:
            cands = json.loads(cj or '[]')
        except Exception:
            cands = []
        attrs.append({
            'attribute_seq': aseq,
            'attribute_name': aname,
            'classification_type': cls,
            'candidate_values': [{'seq': cc.get('seq'), 'text': cc.get('text')} for cc in cands],
            'recommended_value_seq': rseq,
            'recommended_value_text': rtext,
            'last_error': err,
        })
    return {'ok': True, 'seller_code': seller_code,
            'store_id': int(store_id) if store_id else 0, 'attributes': attrs}


def recent_changes(store_id=None, limit=100) -> dict:
    """속성 적용(PUT) 변경 이력 — 최근순. smartstore_attr_change_log 기반."""
    where = ['1=1']
    params = []
    if store_id:
        where.append('l.store_id=%s')
        params.append(int(store_id))
    where_sql = ' AND '.join(where)
    with connections[MYPRODUCT_DB].cursor() as c:
        c.execute(f"""
            SELECT l.id, l.seller_management_code, l.store_id, s.store_name,
                   JSON_LENGTH(l.added_attrs_json) AS added_count,
                   l.status, l.changed_at
            FROM smartstore_attr_change_log l
            LEFT JOIN smartstoreIdList s ON s.id=l.store_id
            WHERE {where_sql}
            ORDER BY l.changed_at DESC
            LIMIT %s
        """, params + [int(limit)])
        cols = [d[0] for d in c.description]
        rows = [dict(zip(cols, r)) for r in c.fetchall()]
    items = []
    for r in rows:
        items.append({
            'id': r['id'],
            'seller_code': r['seller_management_code'],
            'store_id': r['store_id'],
            'store_name': r['store_name'] or (f"store_{r['store_id']}" if r['store_id'] else '-'),
            'added_count': int(r['added_count'] or 0),
            'status': r['status'],
            'changed_at': r['changed_at'].isoformat(sep=' ', timespec='seconds') if r['changed_at'] else None,
        })
    return {'ok': True, 'changes': items}
