"""
워커 대시보드 — SSH 로 11 워커 + 100/88 의 상태 수집.
- 응답 캐싱 (10초 TTL) 으로 SSH 폭주 방지
- 병렬 SSH (ThreadPoolExecutor)
"""
import subprocess
import time
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed


WORKERS = [
    {'host': 'ws220', 'ip': '192.168.219.220', 'group': 'cluster'},
    {'host': 'ws227', 'ip': '192.168.219.227', 'group': 'cluster'},
    {'host': 'ws228', 'ip': '192.168.219.228', 'group': 'cluster'},
    {'host': 'ws229', 'ip': '192.168.219.229', 'group': 'cluster'},
    {'host': 'ws230', 'ip': '192.168.219.230', 'group': 'cluster'},
    {'host': 'ws231', 'ip': '192.168.219.231', 'group': 'cluster'},
    {'host': 'vm11', 'ip': '192.168.219.11', 'group': 'vm'},
    {'host': 'vm12', 'ip': '192.168.219.12', 'group': 'vm'},
    {'host': 'vm13', 'ip': '192.168.219.13', 'group': 'vm'},
    {'host': 'vm14', 'ip': '192.168.219.14', 'group': 'vm'},
    {'host': 'ws15', 'ip': '192.168.219.15', 'group': 'cluster'},
    # 추가 (분배 제외 대상이지만 가시성)
    {'host': '100',  'ip': '192.168.219.100', 'group': 'main'},
    {'host': '88',   'ip': '192.168.219.88',  'group': 'main'},
    {'host': '80',   'ip': '192.168.219.80',  'group': 'main'},
]

TASK_PATTERNS = [
    ('api_attr_crawl', 'API 크롤'),
    ('attr_label_crawl', '라벨 크롤'),
    ('register_auto_candidates', '자동등록'),
    ('search_quality_crawl', '검색품질'),
    ('category_schema_crawl', '카테고리 스키마'),
]


_cache = {'data': None, 'ts': 0.0}
_CACHE_TTL = 8


def _probe(worker):
    """단일 워커 점검."""
    h = worker['host']
    ip = worker['ip']
    out = {
        'host': h, 'ip': ip, 'group': worker['group'],
        'reachable': False, 'load': None, 'uptime': None,
        'tasks': {}, 'last_log': '', 'log_age_s': None,
        'error': None,
    }
    if h == '100':  # 로컬
        return _probe_local(out)

    target = f'joacham@{ip}'
    remote_cmd = (
        'uptime 2>/dev/null || true; '
        'for n in api_attr_crawl attr_label_crawl register_auto_candidates search_quality_crawl category_schema_crawl; do '
        '  echo "TASK:$n:$(ps aux|grep -v grep|grep -c $n 2>/dev/null || echo 0)"; '
        'done; '
        'for f in ~/naverterms-worker/run.log ~/naverterms-worker/label.log ~/naverterms-worker/register.log ~/naverterms-worker/label_extra.log; do '
        '  [ -f "$f" ] && echo "LOG:$f:$(stat -c %Y "$f" 2>/dev/null || echo 0):$(tail -1 "$f" 2>/dev/null | tail -c 200)"; '
        'done; '
        'echo "OK_END"'
    )
    cmd = [
        'ssh',
        '-o', 'ConnectTimeout=4',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/home/joacham/.ssh/known_hosts',
        '-o', 'LogLevel=ERROR',
        '-i', '/home/joacham/.ssh/id_ed25519',
        target, remote_cmd,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=8, text=True)
    except Exception as e:
        out['error'] = f'ssh exc: {e}'
        return out
    # SSH 가 stdout 에 응답을 줬으면 reachable. rc 가 0 아니어도 OK_END 마커 있으면 성공
    if 'OK_END' in r.stdout or 'load average' in r.stdout:
        out['reachable'] = True
        return _parse_probe_output(out, r.stdout)
    out['error'] = f'ssh rc={r.returncode}: {(r.stderr or r.stdout)[:120]}'
    return out


def _probe_local(out):
    out['reachable'] = True
    try:
        r = subprocess.run(
            'uptime; for n in api_attr_crawl attr_label_crawl register_auto_candidates search_quality_crawl category_schema_crawl; do '
            'echo "TASK:$n:$(ps aux|grep -v grep|grep -c $n)"; done; '
            'for f in /tmp/register_local.log /tmp/label_local.log /tmp/label_local_chunk4.log; do '
            '[ -f "$f" ] && echo "LOG:$f:$(stat -c %Y "$f"):$(tail -1 "$f" 2>/dev/null | tail -c 200)"; done',
            shell=True, capture_output=True, timeout=4, text=True,
        )
        return _parse_probe_output(out, r.stdout)
    except Exception as e:
        out['error'] = f'local exc: {e}'
        return out


def _parse_probe_output(out, stdout):
    now = time.time()
    last_log_ts = 0
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if 'load average' in line:
            # uptime 형식: " 12:39:44 up 14 days, 21:39,  6 users,  load average: 0.01, 0.03, 0.02"
            try:
                la = line.split('load average:')[1].strip().split(',')[0]
                out['load'] = float(la)
            except Exception:
                pass
            try:
                if 'up ' in line:
                    parts = line.split('up ')[1].split(',')
                    out['uptime'] = parts[0].strip()
            except Exception:
                pass
        elif line.startswith('TASK:'):
            _, name, count = line.split(':', 2)
            try:
                count = int(count)
            except ValueError:
                count = 0
            if count > 0:
                out['tasks'][name] = count
        elif line.startswith('LOG:'):
            try:
                _, fname, mtime, content = line.split(':', 3)
                mtime = int(mtime)
                if mtime > last_log_ts:
                    last_log_ts = mtime
                    out['last_log'] = content.strip()
                    out['log_age_s'] = max(0, int(now - mtime))
            except Exception:
                pass
    return out


def get_workers_status():
    """모든 워커 병렬 점검 (캐시 8s)."""
    now = time.time()
    if _cache['data'] and (now - _cache['ts']) < _CACHE_TTL:
        cached = list(_cache['data'])
        for w in cached:
            w['cached_age_s'] = int(now - _cache['ts'])
        return cached

    results = [None] * len(WORKERS)
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as ex:
        futures = {ex.submit(_probe, w): i for i, w in enumerate(WORKERS)}
        for f in as_completed(futures, timeout=15):
            i = futures[f]
            try:
                results[i] = f.result()
            except Exception as e:
                w = WORKERS[i]
                results[i] = {
                    'host': w['host'], 'ip': w['ip'], 'group': w['group'],
                    'reachable': False, 'error': str(e)[:120],
                    'tasks': {}, 'last_log': '', 'log_age_s': None,
                }

    # 빈 슬롯 채우기
    for i, w in enumerate(WORKERS):
        if results[i] is None:
            results[i] = {'host': w['host'], 'ip': w['ip'], 'group': w['group'],
                          'reachable': False, 'error': 'timeout', 'tasks': {}}

    for r in results:
        r['cached_age_s'] = 0

    _cache['data'] = results
    _cache['ts'] = now
    return results


def get_aggregate_status():
    """대시보드 상단용 집계."""
    workers = get_workers_status()
    online = sum(1 for w in workers if w.get('reachable'))
    offline = len(workers) - online
    busy = sum(1 for w in workers if w.get('reachable') and w.get('tasks'))
    idle = online - busy

    task_totals = {}
    for w in workers:
        for k, v in (w.get('tasks') or {}).items():
            task_totals[k] = task_totals.get(k, 0) + v

    return {
        'total': len(workers),
        'online': online,
        'offline': offline,
        'busy': busy,
        'idle': idle,
        'task_totals': task_totals,
    }
