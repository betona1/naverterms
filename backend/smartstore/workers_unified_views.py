"""통합 워커 모니터링 API — GPU 워커 + 일반 크롤링 워커.

GPU 워커:
  - ads.gpu_worker_status (11번가 gpu_monitor_daemon 이 30초마다 채움)
  - ads.gpu_worker_log 의 platform meta 추출 → 11번가/네이버 처리량 분리

크롤 워커:
  - naverdb.crawl_worker_status (각 워커가 WorkerLog 로 heartbeat upsert)
  - naverdb.crawl_worker_log
"""
import json
from datetime import datetime, timedelta

from django.db import connections
from rest_framework.views import APIView
from rest_framework.response import Response


# ── GPU 워커 (네이버 / 11번가 분리 카운트 포함) ─────────

def _list_gpu_workers() -> list:
    """기존 GPU status + 최근 1h platform 별 처리량 분리."""
    with connections['ads'].cursor() as cur:
        cur.execute(
            """
            SELECT s.endpoint, s.worker_name, s.host_name, s.status,
                   s.available_models, s.gpu_name,
                   s.gpu_mem_used_mb, s.gpu_mem_total_mb, s.gpu_util_pct,
                   s.consecutive_failures, s.last_check_at, s.last_error,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS total_1h,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='error'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS errors_1h,
                   (SELECT AVG(l.elapsed_ms) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS avg_ms_1h
              FROM gpu_worker_status s
             ORDER BY CASE WHEN s.endpoint LIKE '192.168.%%' OR s.endpoint LIKE 'localhost%%' THEN 0 ELSE 1 END,
                      CASE WHEN s.gpu_mem_total_mb >= 10000 THEN 0 ELSE 1 END,
                      s.endpoint
            """
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    # 1시간 내 platform 별 처리량 — meta JSON 안의 platform 값 추출
    with connections['ads'].cursor() as cur:
        cur.execute(
            """
            SELECT endpoint,
                   JSON_UNQUOTE(JSON_EXTRACT(meta, '$.platform')) AS platform,
                   COUNT(*) AS cnt
              FROM gpu_worker_log
             WHERE event_type='complete'
               AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
             GROUP BY endpoint, platform
            """
        )
        plat_map: dict = {}
        for ep, plat, cnt in cur.fetchall():
            d = plat_map.setdefault(ep, {'naver': 0, '11st': 0})
            key = 'naver' if plat == 'naver' else '11st'
            d[key] += int(cnt)

    for r in rows:
        am = r.get('available_models')
        if isinstance(am, str) and am:
            try:
                r['available_models'] = json.loads(am)
            except (ValueError, TypeError):
                r['available_models'] = []
        if r.get('last_check_at'):
            age = (datetime.now() - r['last_check_at']).total_seconds()
            r['last_check_age_sec'] = int(age)
            r['stale'] = age > 60 and r.get('status') != 'dead'
            r['last_check_at'] = r['last_check_at'].isoformat()
        else:
            r['last_check_age_sec'] = None
            r['stale'] = True
        avg = r.get('avg_ms_1h')
        r['avg_ms_1h'] = int(avg) if avg else None
        # platform 분리 카운트
        m = plat_map.get(r['endpoint']) or {'naver': 0, '11st': 0}
        r['naver_1h'] = m['naver']
        r['eleven_1h'] = m['11st']
    return rows


# ── 일반 크롤링 워커 ─────────────────────────────────

def _list_crawl_workers() -> list:
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            """
            SELECT s.worker_key, s.worker_name, s.worker_type, s.host_name, s.pid,
                   s.status, s.last_log_line, s.started_at, s.last_heartbeat_at,
                   s.consecutive_failures, s.meta,
                   (SELECT COUNT(*) FROM crawl_worker_log l
                     WHERE l.worker_key=s.worker_key
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS logs_1h,
                   (SELECT COUNT(*) FROM crawl_worker_log l
                     WHERE l.worker_key=s.worker_key AND l.level='ERROR'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS errors_1h
              FROM crawl_worker_status s
             ORDER BY s.last_heartbeat_at DESC, s.worker_key
            """
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    now = datetime.now()
    for r in rows:
        for k in ('started_at', 'last_heartbeat_at'):
            v = r.get(k)
            if isinstance(v, datetime):
                r[k] = v.isoformat()
        # stale 판정 — heartbeat 끊긴 시간
        hb = r.get('last_heartbeat_at')
        age_sec = None
        if hb:
            try:
                hb_dt = datetime.fromisoformat(hb)
                age_sec = int((now - hb_dt).total_seconds())
            except (TypeError, ValueError):
                pass
        r['hb_age_sec'] = age_sec
        # heartbeat 5분 끊기면 stale, 30분 끊기면 dead 로 자동 표시 (DB 갱신 없이 view 차원)
        if r.get('status') != 'dead':
            if age_sec is not None and age_sec > 1800:
                r['effective_status'] = 'dead'
            elif age_sec is not None and age_sec > 300:
                r['effective_status'] = 'degraded'
            else:
                r['effective_status'] = r.get('status') or 'unknown'
        else:
            r['effective_status'] = 'dead'

        meta = r.get('meta')
        if isinstance(meta, str) and meta:
            try:
                r['meta'] = json.loads(meta)
            except (ValueError, TypeError):
                r['meta'] = None
    return rows


def _list_crawl_logs(worker_key: str, limit: int = 50,
                     levels: list[str] | None = None) -> list:
    where = ['worker_key=%s']
    params: list = [worker_key]
    if levels:
        ph = ','.join(['%s'] * len(levels))
        where.append(f'level IN ({ph})')
        params.extend(levels)
    where_sql = ' AND '.join(where)
    params.append(int(limit))
    with connections['naverdb'].cursor() as cur:
        cur.execute(
            f"""
            SELECT id, worker_key, level, message, meta, created_at
              FROM crawl_worker_log
             WHERE {where_sql}
             ORDER BY id DESC
             LIMIT %s
            """,
            params,
        )
        cols = [d[0] for d in cur.description]
        rows = []
        for r in cur.fetchall():
            d = dict(zip(cols, r))
            if d.get('created_at'):
                d['created_at'] = d['created_at'].isoformat()
            if isinstance(d.get('meta'), str) and d['meta']:
                try:
                    d['meta'] = json.loads(d['meta'])
                except (ValueError, TypeError):
                    d['meta'] = None
            rows.append(d)
        return rows


# ── Views ─────────────────────────────────────────────

class WorkersGpuView(APIView):
    """GET /api/workers/gpu/ — GPU 워커 11개 (네이버/11번가 분리 카운트 포함)."""
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        rows = _list_gpu_workers()
        return Response({'ok': True, 'workers': rows,
                         'dead_count': sum(1 for r in rows if r.get('status') == 'dead' or r.get('stale'))})


class WorkersCrawlView(APIView):
    """GET /api/workers/crawl/ — 일반 크롤링 워커 status 카드."""
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        return Response({'ok': True, 'workers': _list_crawl_workers()})


class WorkersCrawlLogsView(APIView):
    """GET /api/workers/crawl/<key>/logs/?limit=50&levels=INFO,WARN,ERROR"""
    authentication_classes = []
    permission_classes = []

    def get(self, request, key):
        limit = int(request.query_params.get('limit', 50))
        levels_q = request.query_params.get('levels')
        levels = levels_q.split(',') if levels_q else None
        return Response({'ok': True, 'logs': _list_crawl_logs(key, limit, levels)})


class WorkersCrawlHeartbeatView(APIView):
    """POST /api/workers/crawl/heartbeat/ — 외부 워커가 HTTP 로 heartbeat (선택)."""
    authentication_classes = []
    permission_classes = []

    def post(self, request):
        d = request.data or {}
        key = d.get('worker_key')
        if not key:
            return Response({'ok': False, 'error': 'worker_key required'}, status=400)
        from .worker_log_handler import WorkerLog
        wl = WorkerLog(key, name=d.get('worker_name') or key,
                       worker_type=d.get('worker_type') or 'crawl')
        last_line = d.get('last_line') or d.get('message')
        meta = d.get('meta')
        level = (d.get('level') or 'INFO').upper()
        if level == 'ERROR':
            wl.error(last_line or 'error', meta=meta)
        elif level == 'WARN':
            wl.warn(last_line or 'warn', meta=meta)
        else:
            wl.heartbeat(last_line, meta=meta)
        return Response({'ok': True})
