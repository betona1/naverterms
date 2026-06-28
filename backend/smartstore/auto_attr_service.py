"""속성 AI 자동체크 — 미리보기(dry-run)/실행(백그라운드 배치)/상태 조회.

정밀 파이프라인(attr_fill_service.process_sku mode='auto'):
  1) 상품명·상세 명시값(exact)  2) 도메인 매핑사전 텍스트매칭  3) 비전(썸네일)분석 사전매핑
모두 '유일매칭'만 채택 → 추측 0, 정확한 것만 등록.
"""
from __future__ import annotations

import os
import subprocess
from django.db import connections

from . import attr_fill_service as af

NAVERDB = 'naverdb'
MYPRODUCT_DB = 'myproduct'
WORKER_KEY = 'auto_attr_check'
_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _pending_skus(store_id=None, limit=60, codes=None):
    """미리보기 대상 SKU(상품정보 보유, pending 다중후보)."""
    with connections[MYPRODUCT_DB].cursor() as cur:
        if codes:
            ph = ','.join(['%s'] * len(codes))
            cur.execute(
                f"SELECT DISTINCT seller_management_code, store_id FROM smartstore_product_missing_attrs "
                f"WHERE status='pending' AND candidate_count>=2 AND seller_management_code IN ({ph})", codes)
        else:
            q = ("SELECT DISTINCT seller_management_code, store_id FROM smartstore_product_missing_attrs "
                 "WHERE status='pending' AND candidate_count>=2 AND seller_management_code<>'' ")
            params = []
            if store_id:
                q += "AND store_id=%s "; params.append(int(store_id))
            q += "LIMIT %s"; params.append(int(limit) * 4)
            cur.execute(q, params)
        return cur.fetchall()


def preview(store_id=None, limit=60, codes=None, mode='auto') -> dict:
    """동기 dry-run: 자동체크 결과를 등록 없이 반환 (UI 검토용)."""
    rows = _pending_skus(store_id=store_id, limit=limit, codes=codes)
    results = []
    attr_total = 0
    scanned = 0
    src_count = {'명시': 0, '사전': 0, '비전': 0}
    for code, sid in rows:
        if len(results) >= int(limit):
            break
        scanned += 1
        r = af.process_sku(code, sid, mode=mode, dry_run=True)
        sels = r.get('selections') or []
        if not sels:
            continue
        for s in sels:
            if s.get('source') in src_count:
                src_count[s['source']] += 1
        attr_total += len(sels)
        results.append({
            'seller_code': code, 'store_id': sid,
            'name': r.get('name', ''), 'selections': sels,
        })
    return {
        'ok': True, 'scanned': scanned, 'matched_skus': len(results),
        'attr_total': attr_total, 'sources': src_count, 'mode': mode,
        'results': results,
    }


def start(store_id=None, limit=500, mode='auto') -> dict:
    """백그라운드 배치 실행 (auto_attr_batch.py)."""
    # 중복 실행 방지
    st = status()
    if st.get('running'):
        return {'ok': False, 'error': '이미 실행 중', 'worker': st.get('worker')}
    args = ['python3', '-u', 'auto_attr_batch.py', str(int(limit)),
            str(int(store_id)) if store_id else 'all', mode]
    log_path = os.path.join(_BASE, 'exports', 'auto_attr_check.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logf = open(log_path, 'a')
    subprocess.Popen(args, cwd=_BASE,
                     env={**os.environ, 'DJANGO_SETTINGS_MODULE': 'config.settings'},
                     stdout=logf, stderr=logf)
    return {'ok': True, 'started': True, 'limit': limit, 'store_id': store_id, 'mode': mode}


def start_vision(store_id=None, limit=500) -> dict:
    """썸네일 라이브 비전 배치(GPU 분산) 실행."""
    st = vision_status()
    if st.get('running'):
        return {'ok': False, 'error': '비전 배치 이미 실행 중', 'worker': st.get('worker')}
    args = ['python3', '-u', 'thumbnail_vision_batch.py', str(int(limit)),
            str(int(store_id)) if store_id else 'all']
    log_path = os.path.join(_BASE, 'exports', 'thumbnail_vision.log')
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    logf = open(log_path, 'a')
    subprocess.Popen(args, cwd=_BASE,
                     env={**os.environ, 'DJANGO_SETTINGS_MODULE': 'config.settings'},
                     stdout=logf, stderr=logf)
    return {'ok': True, 'started': True, 'limit': limit, 'store_id': store_id}


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


def vision_status() -> dict:
    """썸네일 비전 배치 상태 + 비전캐시 진척."""
    worker, running = _worker_row('thumbnail_vision')
    pending_targets = 0
    try:
        with connections[MYPRODUCT_DB].cursor() as cur:
            cur.execute(
                "SELECT COUNT(DISTINCT m.seller_management_code) FROM smartstore_product_missing_attrs m "
                "JOIN smartstore_product p ON p.seller_management_code="
                "  m.seller_management_code COLLATE utf8mb4_unicode_ci AND p.store_id=m.store_id "
                "WHERE m.status='pending' AND m.candidate_count>=2 AND m.seller_management_code LIKE 'W%%' "
                "AND (m.attribute_name LIKE '%%색상%%' OR m.attribute_name LIKE '%%재질%%' "
                "     OR m.attribute_name LIKE '%%소재%%' OR m.attribute_name LIKE '%%형태%%')")
            pending_targets = cur.fetchone()[0] or 0
    except Exception:
        pass
    return {'running': running, 'worker': worker, 'pending_targets': pending_targets,
            'gpus': __import__('smartstore.thumbnail_vision_service', fromlist=['GPU_HOSTS']).GPU_HOSTS}


def status() -> dict:
    """워커 상태 + pending/registered 카운트."""
    worker, running = _worker_row(WORKER_KEY)
    counts = {}
    try:
        with connections[MYPRODUCT_DB].cursor() as cur:
            cur.execute("SELECT status, COUNT(*) FROM smartstore_product_missing_attrs GROUP BY status")
            counts = {k: v for k, v in cur.fetchall()}
    except Exception:
        pass
    return {'running': running, 'worker': worker, 'counts': counts}
