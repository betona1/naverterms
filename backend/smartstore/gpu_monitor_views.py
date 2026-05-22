"""GPU 모니터링 API — ads.gpu_worker_status / gpu_worker_log 조회.
11번가의 gpu_monitor_daemon 이 30초마다 SSH 로 수집해 채우는 테이블을 그대로 조회.
heartbeat/bulk-progress 는 11번가 전용이라 우리는 status/logs 만.
"""
import json
from datetime import datetime
from rest_framework.views import APIView
from rest_framework.response import Response
from django.db import connections


def _list_status() -> list:
    with connections['ads'].cursor() as cur:
        cur.execute(
            """
            SELECT s.endpoint, s.worker_name, s.host_name, s.status,
                   s.available_models, s.gpu_name, s.gpu_mem_used_mb, s.gpu_mem_total_mb,
                   s.gpu_util_pct, s.consecutive_failures, s.last_check_at, s.last_error,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS completions_5min,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)) AS completions_10min,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)) AS completions_30min,
                   (SELECT COUNT(*) FROM gpu_worker_log l
                     WHERE l.endpoint=s.endpoint AND l.event_type='complete'
                       AND l.created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS completions_1h,
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

    for r in rows:
        am = r.get('available_models')
        if isinstance(am, str) and am:
            try:
                r['available_models'] = json.loads(am)
            except Exception:
                r['available_models'] = []
        # stale: dispatch 가 5초마다 갱신 → 60초 넘으면 의심
        if r.get('last_check_at'):
            age = (datetime.now() - r['last_check_at']).total_seconds()
            r['last_check_age_sec'] = int(age)
            r['stale'] = age > 60 and r.get('status') != 'dead'
            r['last_check_at'] = r['last_check_at'].isoformat()
        else:
            r['last_check_age_sec'] = None
            r['stale'] = True
        if r.get('avg_ms_1h'):
            r['avg_ms_1h'] = int(r['avg_ms_1h'])
    return rows


def _list_logs(endpoint=None, limit=50, event_types=None):
    where = []
    params: list = []
    if endpoint:
        where.append('l.endpoint=%s')
        params.append(endpoint)
    if event_types:
        ph = ','.join(['%s'] * len(event_types))
        where.append(f'l.event_type IN ({ph})')
        params.extend(event_types)
    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''
    params.append(int(limit))
    # my_product/folder join 은 11st 전용 — 우리는 endpoint/event/product_id 만
    with connections['ads'].cursor() as cur:
        cur.execute(
            f"""
            SELECT l.id, l.endpoint, l.event_type, l.product_id, l.model_used,
                   l.elapsed_ms, l.error_msg, l.created_at
              FROM gpu_worker_log l
              {where_sql}
             ORDER BY l.id DESC
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
            d['folder_id'] = None
            d['folder_name'] = None
            rows.append(d)
        return rows


class GpuStatusView(APIView):
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        rows = _list_status()
        dead = [r for r in rows if r.get('status') == 'dead' or r.get('stale')]
        return Response({'ok': True, 'workers': rows, 'dead_count': len(dead)})


class GpuLogsView(APIView):
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        endpoint = request.query_params.get('endpoint')
        limit = int(request.query_params.get('limit', 50))
        event_types = request.query_params.get('event_types')
        types = event_types.split(',') if event_types else None
        return Response({'ok': True, 'logs': _list_logs(endpoint, limit, types)})


class GpuBulkProgressStubView(APIView):
    """11번가 전용 bulk_progress 는 우리한테 부적합 — 빈 응답으로 stub.
    모달이 호출하더라도 안 깨지게.
    """
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        return Response({
            'ok': True, 'folders': [], 'main_queue': [],
            'total': 0, 'done': 0, 'remaining': 0, 'pct': 0,
            'rate_1h': 0, 'rate_10min': 0, 'stalled': False, 'avg_ms': 0,
            'eta_hours': None,
        })
