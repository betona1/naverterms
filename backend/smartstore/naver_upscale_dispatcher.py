"""이미지 일괄 업스케일 디스패처 — 작업큐 + N 워커 분산.

흐름:
  1. start_job(folder_id, scale=1.5) — 폴더 상품 모두 naver_upscale_queue 에 INSERT
  2. background thread tick():
     - 각 가용 워커마다 pending 1건씩 할당 (state='running')
     - 워커가 처리 (image-ai service /api/v1/flux-upscale → ComfyUI)
     - 결과를 218 서버 ~/upscaled_thumbs/{code}_1.jpg 로 scp + DB 업데이트
  3. pause/resume/cancel API
  4. 진행률은 job summary 조회로

구조:
  - job (전체 작업 단위)
  - queue (상품별 row, state=pending/running/done/error/skip)
  - worker_log (워커별 처리 로그 — 모니터링용)
"""
from __future__ import annotations

import base64
import io
import json
import os
import threading
import time
import urllib.request
from typing import Optional

from django.db import connections

NAVERDB = 'naverdb'

# 워커 endpoint 목록 — 추후 동적으로. 처음엔 88 만, SSH 활성화되면 추가.
DEFAULT_WORKERS: list[dict] = [
    {'endpoint': 'http://192.168.219.100:8188', 'name': '100', 'gpu_free_mb': 8600},
    {'endpoint': 'http://192.168.219.88:8188',  'name': '88',  'gpu_free_mb': 9300},
    {'endpoint': 'http://192.168.219.219:8188', 'name': '219', 'gpu_free_mb': 9800},
    {'endpoint': 'http://192.168.219.80:8188',  'name': '80',  'gpu_free_mb': 7500},
    # Windows 워커 — alive 체크로 자동 합류/제외
    {'endpoint': 'http://192.168.219.92:8188',  'name': '92-win',  'gpu_free_mb': 8000},
    {'endpoint': 'http://192.168.219.111:8188', 'name': '111-win', 'gpu_free_mb': 8000},
    {'endpoint': 'http://192.168.219.130:8188', 'name': '130-win', 'gpu_free_mb': 8000},
    {'endpoint': 'http://192.168.219.140:8188', 'name': '140-win', 'gpu_free_mb': 8000},
    {'endpoint': 'http://192.168.219.108:8188', 'name': '108-win', 'gpu_free_mb': 8000},
    {'endpoint': 'http://192.168.219.136:8188', 'name': '136-win', 'gpu_free_mb': 8000},
    # CPU 워커 — Real-ESRGAN x2 CPU 추론 (~15~60s/이미지). GPU 워커 대비 5~20배 느림.
    {'endpoint': 'http://192.168.219.15:8188',  'name': '15-cpu',  'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.220:8188', 'name': '220-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.228:8188', 'name': '228-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.229:8188', 'name': '229-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.230:8188', 'name': '230-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.231:8188', 'name': '231-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.226:8188', 'name': '226-cpu', 'gpu_free_mb': 0},
    {'endpoint': 'http://192.168.219.227:8188', 'name': '227-cpu', 'gpu_free_mb': 0},
    # M1 Mac Mini (203, 개발기) — CPU 워커 티어로 등록. ComfyUI :8188 기동 시 alive-체크로 자동 합류.
    {'endpoint': 'http://192.168.219.203:8188', 'name': '203-mac', 'gpu_free_mb': 0},
]

# 저장: STORAGE_LOCAL_DIR 은 218 의 ~/upscaled_thumbs 가 sshfs 로 마운트된 경로.
# write 가 곧 218 에 직접 기록되고, Django MEDIA 가 동일 경로에서 서빙. (2026-05-27)
STORAGE_LOCAL_DIR = '/home/joacham/projects/naverterms/backend/media/upscaled_thumbs'
STORAGE_URL_PREFIX = '/media/upscaled_thumbs/'
# scp 백업은 더이상 불필요 (mount 가 곧 218 이므로 자기복제). 비상시만 True 로.
BACKUP_HOST = '192.168.219.218'
BACKUP_USER = 'joacham'
BACKUP_DIR = '/home/joacham/upscaled_thumbs'
BACKUP_ENABLED = False  # mount 로 이미 218 에 저장됨. 중복 scp 차단.

# 워커당 동시 작업 1개 (lowvram → 1 batch). 추후 GPU 메모리에 따라 조정.
WORKER_CONCURRENCY = 1

# 디스패처 전역 상태
_DISPATCH_LOCK = threading.Lock()
_DISPATCH_THREAD: Optional[threading.Thread] = None
_DISPATCH_RUNNING = False
_WORKER_BUSY: dict[str, int] = {}  # endpoint → 진행중 count


# ─────────────────────── Job CRUD ───────────────────────

def list_jobs(limit: int = 20) -> dict:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """SELECT id, folder_id, scale, model_family, status,
                      total_targets, done_count, error_count, bytes_total,
                      started_at, finished_at, last_error, created_at,
                      storage_host, filename_format
                 FROM naver_upscale_batch_job
                ORDER BY id DESC LIMIT %s""",
            [limit],
        )
        cols = [c[0] for c in cur.description]
        items = [dict(zip(cols, r)) for r in cur.fetchall()]
    for it in items:
        for k in ('started_at', 'finished_at', 'created_at'):
            if it.get(k):
                it[k] = it[k].isoformat()
    return {'ok': True, 'items': items}


def get_job(job_id: int) -> Optional[dict]:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """SELECT id, folder_id, scale, model_family, status,
                      total_targets, done_count, error_count, bytes_total,
                      started_at, finished_at, last_error, created_at,
                      workers, storage_host, storage_path, filename_format
                 FROM naver_upscale_batch_job WHERE id=%s""",
            [job_id],
        )
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        d = dict(zip(cols, row))
    for k in ('started_at', 'finished_at', 'created_at'):
        if d.get(k):
            d[k] = d[k].isoformat()
    if isinstance(d.get('workers'), str) and d['workers']:
        try: d['workers'] = json.loads(d['workers'])
        except: pass
    return d


def get_job_progress(job_id: int) -> dict:
    """진행률 + 워커별 처리량 + ETA. dispatcher 자동 깨어남."""
    # process restart 후 첫 호출 시 dispatcher 자동 시작 + stuck row 복구
    _ensure_dispatcher_running()
    _recover_stuck_rows()
    with connections[NAVERDB].cursor() as cur:
        cur.execute("""SELECT total_targets, done_count, error_count, bytes_total,
                              status, started_at FROM naver_upscale_batch_job WHERE id=%s""", [job_id])
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'job_not_found'}
        total, done, err, bytes_total, status, started_at = row

        cur.execute("""SELECT state, COUNT(*) FROM naver_upscale_queue WHERE job_id=%s GROUP BY state""",
                    [job_id])
        by_state = dict(cur.fetchall())

        cur.execute("""SELECT worker_endpoint,
                              SUM(CASE WHEN event='complete' THEN 1 ELSE 0 END) AS done,
                              SUM(CASE WHEN event='error' THEN 1 ELSE 0 END) AS errors,
                              AVG(CASE WHEN event='complete' THEN elapsed_ms END) AS avg_ms,
                              SUM(CASE WHEN event='complete' THEN bytes ELSE 0 END) AS bytes
                         FROM naver_upscale_worker_log
                        WHERE job_id=%s AND worker_endpoint IS NOT NULL
                        GROUP BY worker_endpoint""", [job_id])
        workers = []
        for ep, w_done, w_err, avg, b in cur.fetchall():
            workers.append({
                'endpoint': ep, 'done': int(w_done or 0), 'errors': int(w_err or 0),
                'avg_ms': int(avg) if avg else None, 'bytes': int(b or 0),
                'busy': _WORKER_BUSY.get(ep, 0) > 0,
            })

        # 최근 1분 처리량
        cur.execute("""SELECT COUNT(*) FROM naver_upscale_worker_log
                        WHERE job_id=%s AND event='complete'
                          AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)""", [job_id])
        rate_per_min = cur.fetchone()[0]

    pct = round(done * 100 / total, 1) if total else 0
    remaining = max(0, total - done - err)
    eta_min = round(remaining / rate_per_min, 1) if rate_per_min > 0 else None
    return {
        'ok': True, 'job_id': job_id, 'status': status,
        'total': total, 'done': done, 'error': err,
        'pct': pct, 'remaining': remaining,
        'bytes_total': bytes_total, 'bytes_mb': round((bytes_total or 0) / (1024*1024), 1),
        'by_state': by_state, 'workers': workers,
        'rate_per_min': rate_per_min,
        'eta_min': eta_min,
        'started_at': started_at.isoformat() if started_at else None,
    }


def start_job(folder_id: Optional[int], scale: float = 1.5,
              model_family: str = 'sd15', workers: Optional[list[str]] = None) -> dict:
    """폴더(또는 전체)의 상품을 큐에 INSERT + 디스패처 시작."""
    # 1) 대상 SELECT — 이미 업스케일된 상품(upscaled_image_url)은 제외해 중복 재처리 차단
    if folder_id is not None:
        where = ("WHERE p.folder_id=%s AND f.is_system!=1 AND p.image_large IS NOT NULL "
                 "AND p.image_large<>'' AND p.upscaled_image_url IS NULL")
        params: list = [folder_id]
    else:
        where = ("WHERE f.is_system!=1 AND p.image_large IS NOT NULL "
                 "AND p.image_large<>'' AND p.upscaled_image_url IS NULL")
        params = []
    with connections[NAVERDB].cursor() as cur:
        cur.execute(f"""SELECT p.id, p.product_code, p.image_large
                          FROM naver_my_product p
                          JOIN naver_my_product_folder f ON p.folder_id=f.id
                          {where}""", params)
        targets = cur.fetchall()
    if not targets:
        return {'ok': False, 'error': '대상 상품 없음 (이미지 있는 상품 + 미분류 제외)'}

    used_workers = workers or [w['endpoint'] for w in DEFAULT_WORKERS]

    # 2) job 생성
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """INSERT INTO naver_upscale_batch_job
                 (folder_id, scale, model_family, status, total_targets,
                  workers, storage_host, storage_path, filename_format, started_at)
               VALUES (%s, %s, %s, 'pending', %s, %s, %s, %s, %s, NOW())""",
            [folder_id, scale, model_family, len(targets),
             json.dumps(used_workers), BACKUP_HOST, BACKUP_DIR, '{code}_1.jpg'],
        )
        job_id = cur.lastrowid

    # 3) queue 행 INSERT (BULK)
    with connections[NAVERDB].cursor() as cur:
        # 1000건씩 청크
        for i in range(0, len(targets), 1000):
            chunk = targets[i:i+1000]
            args = []
            for pid, code, url in chunk:
                args.append((job_id, pid, code, url))
            placeholders = ','.join(['(%s,%s,%s,%s)'] * len(chunk))
            flat = [v for tup in args for v in tup]
            cur.execute(
                f"""INSERT IGNORE INTO naver_upscale_queue
                      (job_id, product_id, product_code, image_url)
                    VALUES {placeholders}""",
                flat,
            )

    # 4) status 'running' + dispatcher 시작
    with connections[NAVERDB].cursor() as cur:
        cur.execute("UPDATE naver_upscale_batch_job SET status='running' WHERE id=%s", [job_id])
    _ensure_dispatcher_running()

    return {'ok': True, 'job_id': job_id, 'total_targets': len(targets),
            'workers': used_workers}


def pause_job(job_id: int) -> dict:
    with connections[NAVERDB].cursor() as cur:
        cur.execute("UPDATE naver_upscale_batch_job SET status='paused' WHERE id=%s AND status='running'",
                    [job_id])
    return {'ok': True}


def resume_job(job_id: int) -> dict:
    with connections[NAVERDB].cursor() as cur:
        cur.execute("UPDATE naver_upscale_batch_job SET status='running' WHERE id=%s AND status='paused'",
                    [job_id])
    _ensure_dispatcher_running()
    return {'ok': True}


def cancel_job(job_id: int) -> dict:
    """모든 pending → skip, running 은 워커가 끝낼 때까지 대기."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute("UPDATE naver_upscale_queue SET state='skip' WHERE job_id=%s AND state='pending'",
                    [job_id])
        cur.execute("UPDATE naver_upscale_batch_job SET status='done', finished_at=NOW() WHERE id=%s",
                    [job_id])
    return {'ok': True}


# ─────────────────────── Dispatcher Worker ───────────────────────

_LAST_STUCK_RECOVERY = 0
_ALIVE_CACHE: tuple[float, list[str]] = (0.0, [])


def _alive_workers_cached() -> list[str]:
    """alive 워커 목록 (10초 캐시). dead 워커 자동 제외."""
    global _ALIVE_CACHE
    if time.time() - _ALIVE_CACHE[0] < 10:
        return _ALIVE_CACHE[1]
    alive = []
    for w in DEFAULT_WORKERS:
        ep = w['endpoint']
        try:
            urllib.request.urlopen(f"{ep}/queue", timeout=2).read()
            alive.append(ep)
        except Exception:
            pass
    _ALIVE_CACHE = (time.time(), alive)
    return alive


def _recover_stuck_rows():
    """5분 이상 'running' 인 row 를 pending 으로 복구 (process restart 시).
    1분에 한 번만 실행."""
    global _LAST_STUCK_RECOVERY
    if time.time() - _LAST_STUCK_RECOVERY < 60:
        return
    _LAST_STUCK_RECOVERY = time.time()
    with connections[NAVERDB].cursor() as cur:
        cur.execute("""UPDATE naver_upscale_queue
                          SET state='pending', worker_endpoint=NULL
                        WHERE state='running'
                          AND started_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)""")


def _ensure_dispatcher_running():
    global _DISPATCH_THREAD, _DISPATCH_RUNNING
    with _DISPATCH_LOCK:
        if _DISPATCH_RUNNING:
            return
        _DISPATCH_RUNNING = True
        _DISPATCH_THREAD = threading.Thread(target=_dispatch_loop, daemon=True, name='upscale-dispatch')
        _DISPATCH_THREAD.start()


def _dispatch_loop():
    """주 디스패치 루프 — pending 작업을 가용 워커에 할당."""
    global _DISPATCH_RUNNING
    print('[upscale-dispatch] 시작', flush=True)
    try:
        while True:
            # 고아 'running' row 자가복구 (워커/프로세스 사망 대비, 60초 쓰로틀)
            _recover_stuck_rows()
            # 활성 job 확인
            with connections[NAVERDB].cursor() as cur:
                cur.execute("""SELECT id, workers FROM naver_upscale_batch_job
                                WHERE status='running' ORDER BY id LIMIT 5""")
                active_jobs = cur.fetchall()
            if not active_jobs:
                time.sleep(3)
                # 5분간 활성 작업 없으면 종료
                continue

            # 가용 워커 풀 — alive 체크 (죽은 워커 임시 제외, 1분 캐시)
            all_workers = _alive_workers_cached()
            free_workers = [w for w in all_workers if _WORKER_BUSY.get(w, 0) < WORKER_CONCURRENCY]
            if not free_workers:
                time.sleep(1.5)
                continue

            # 각 가용 워커마다 pending 1건씩 할당
            dispatched = 0
            for ep in free_workers:
                row = _claim_next_pending(ep, [j[0] for j in active_jobs])
                if not row:
                    continue
                _WORKER_BUSY[ep] = _WORKER_BUSY.get(ep, 0) + 1
                threading.Thread(target=_process_one,
                                 args=(ep, row), daemon=True).start()
                dispatched += 1
            if dispatched == 0:
                time.sleep(2)
    except Exception as e:
        print(f'[upscale-dispatch] 루프 종료: {e}', flush=True)
    finally:
        with _DISPATCH_LOCK:
            _DISPATCH_RUNNING = False


def _claim_next_pending(worker_ep: str, job_ids: list[int]) -> Optional[dict]:
    """pending 작업 1개를 atomic 으로 claim (MariaDB SKIP LOCKED 미지원 호환).
    SELECT → UPDATE WHERE state='pending' AND id=X. UPDATE rowcount=1 이면 성공.
    rowcount=0 면 race (다른 worker 가 가져감) → retry.
    """
    if not job_ids:
        return None
    ph = ','.join(['%s'] * len(job_ids))
    for _ in range(5):  # race retry
        with connections[NAVERDB].cursor() as cur:
            cur.execute(f"""SELECT id, job_id, product_id, product_code, image_url, attempts
                              FROM naver_upscale_queue
                             WHERE job_id IN ({ph}) AND state='pending'
                             ORDER BY id LIMIT 1""", job_ids)
            row = cur.fetchone()
            if not row:
                return None
            qid = row[0]
            cur.execute(
                """UPDATE naver_upscale_queue
                      SET state='running', worker_endpoint=%s, started_at=NOW(),
                          attempts=attempts+1
                    WHERE id=%s AND state='pending'""",
                [worker_ep, qid],
            )
            if cur.rowcount == 1:
                return {'qid': row[0], 'job_id': row[1], 'product_id': row[2],
                        'product_code': row[3], 'image_url': row[4], 'attempts': row[5]}
            # race → 다음 row 시도
    return None


def _process_one(worker_ep: str, q: dict):
    """단일 상품 처리: ComfyUI 호출 → 결과 218 저장 → DB 업데이트."""
    job_id = q['job_id']
    qid = q['qid']
    code = q['product_code']
    t0 = time.time()
    _log_worker(job_id, worker_ep, q['product_id'], 'start', None, None, None)

    try:
        # 1) ComfyUI 호출 — image-ai service 통해 (worker_ep 무관하게 image-ai 가 라우팅)
        # 단순화: image-ai service 의 /api/v1/flux-upscale 사용. 그게 ComfyUI 88로 보냄.
        # 다중 워커 분산은 image-ai service 가 worker_ep 별 ComfyUI 호출하도록 향후 확장.
        # 현재는 worker_ep 직접 ComfyUI 호출.
        b64 = _call_comfyui_upscale(worker_ep, q['image_url'], scale=1.5)

        # 2) JPG 변환 + 218 서버 저장
        from PIL import Image
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        if img.mode in ('RGBA', 'LA'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=90, optimize=True)
        jpg_bytes = buf.getvalue()

        # 3) 218 저장
        fname = f'{code}_1.jpg'
        result_url = _scp_to_storage(jpg_bytes, fname)

        # 4) DB 업데이트
        elapsed = int((time.time() - t0) * 1000)
        with connections[NAVERDB].cursor() as cur:
            cur.execute("""UPDATE naver_upscale_queue
                              SET state='done', result_url=%s, result_bytes=%s,
                                  elapsed_ms=%s, finished_at=NOW()
                            WHERE id=%s""",
                        [result_url, len(jpg_bytes), elapsed, qid])
            cur.execute("""UPDATE naver_my_product
                              SET upscaled_image_url=%s, upscaled_at=NOW(),
                                  upscaled_bytes=%s
                            WHERE id=%s""",
                        [result_url, len(jpg_bytes), q['product_id']])
            cur.execute("""UPDATE naver_upscale_batch_job
                              SET done_count=done_count+1,
                                  bytes_total=bytes_total+%s,
                                  updated_at=NOW()
                            WHERE id=%s""",
                        [len(jpg_bytes), job_id])
        _log_worker(job_id, worker_ep, q['product_id'], 'complete', elapsed, len(jpg_bytes), None)

    except Exception as e:
        err = str(e)[:300]
        elapsed = int((time.time() - t0) * 1000)
        with connections[NAVERDB].cursor() as cur:
            # 3회 실패까지는 pending 으로 (재시도). 그 이상은 error 확정.
            if q['attempts'] < 3:
                cur.execute("""UPDATE naver_upscale_queue
                                  SET state='pending', worker_endpoint=NULL,
                                      error_msg=%s
                                WHERE id=%s""", [err, qid])
            else:
                cur.execute("""UPDATE naver_upscale_queue
                                  SET state='error', error_msg=%s,
                                      elapsed_ms=%s, finished_at=NOW()
                                WHERE id=%s""", [err, elapsed, qid])
                cur.execute("""UPDATE naver_upscale_batch_job
                                  SET error_count=error_count+1, last_error=%s
                                WHERE id=%s""", [err, job_id])
        _log_worker(job_id, worker_ep, q['product_id'], 'error', elapsed, None, err)

    finally:
        _WORKER_BUSY[worker_ep] = max(0, _WORKER_BUSY.get(worker_ep, 1) - 1)
        # job 완료 체크
        _check_job_done(job_id)


def _log_worker(job_id: int, endpoint: str, product_id: Optional[int],
                event: str, elapsed_ms: Optional[int],
                bytes_: Optional[int], msg: Optional[str]):
    try:
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                """INSERT INTO naver_upscale_worker_log
                     (job_id, worker_endpoint, product_id, event, elapsed_ms, bytes, msg)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [job_id, endpoint, product_id, event, elapsed_ms, bytes_, msg],
            )
    except Exception:
        pass


def _check_job_done(job_id: int):
    """모든 큐 완료 시 job status='done'."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute("""SELECT COUNT(*) FROM naver_upscale_queue
                        WHERE job_id=%s AND state IN ('pending','running')""", [job_id])
        remaining = cur.fetchone()[0]
        if remaining == 0:
            cur.execute("""UPDATE naver_upscale_batch_job
                              SET status='done', finished_at=NOW()
                            WHERE id=%s AND status='running'""", [job_id])


def _call_comfyui_upscale(worker_endpoint: str, image_url: str, scale: float) -> str:
    """워커의 ComfyUI 에 직접 SD 1.5 latent upscale 워크플로우 제출.
    실제로는 image-ai service (8902) 의 /api/v1/flux-upscale 로 라우팅하는 게 더 단순.
    여기서는 직접 호출 (분산을 위해)."""
    import sys
    sys.path.insert(0, '/home/joacham/projects/naverterms/backend/image_ai_service')
    import flux_client
    import sd15_workflows as sw

    # 워커별 base URL — thread-local (race-safe). 글로벌 swap 금지.
    flux_client.set_base(worker_endpoint)
    try:
        from PIL import Image as PILImage
        # 이미지 다운로드
        req = urllib.request.Request(image_url, headers={
            'User-Agent': 'Mozilla/5.0', 'Referer': 'https://shopping.naver.com/',
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            img_bytes = r.read()
        img = PILImage.open(io.BytesIO(img_bytes)).convert('RGBA')
        # 업로드
        name = flux_client.upload_image(img)
        # 워크플로우 + 제출 — Real-ESRGAN (SD 1.5 inference 대비 약 10배 빠름, 2~3s/이미지)
        wf = sw.realesrgan_workflow(name, scale=scale)
        pid = flux_client.queue_prompt(wf)
        # GPU 는 2~3s 면 끝, CPU 워커는 cold 59s + warm 20~30s 정도. 180s 면 둘 다 안전.
        results = flux_client.wait_for_result(pid, timeout=180)
        if not results:
            raise RuntimeError('빈 결과')
        # 첫 결과 → WEBP base64 (그대로 반환, 호출자가 JPG 변환)
        buf = io.BytesIO()
        results[0].convert('RGB').save(buf, format='WEBP', quality=92)
        return base64.b64encode(buf.getvalue()).decode()
    finally:
        flux_client.set_base('')  # 스레드 local 해제 (선택적, 스레드 곧 종료)


def _scp_to_storage(jpg_bytes: bytes, fname: str) -> str:
    """STORAGE_LOCAL_DIR(=218 sshfs mount) 에 직접 저장. 즉시 서빙 가능한 URL 반환."""
    os.makedirs(STORAGE_LOCAL_DIR, exist_ok=True)
    fpath = os.path.join(STORAGE_LOCAL_DIR, fname)
    with open(fpath, 'wb') as f:
        f.write(jpg_bytes)
    # 218 백업 — 별도 thread 로 비동기 (실패해도 무시)
    if BACKUP_ENABLED:
        threading.Thread(target=_backup_to_218, args=(fpath, fname), daemon=True).start()
    return f'{STORAGE_URL_PREFIX}{fname}'


def _backup_to_218(fpath: str, fname: str):
    """218 백업 — 실패해도 무시."""
    import subprocess
    try:
        subprocess.run(
            ['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', fpath,
             f'{BACKUP_USER}@{BACKUP_HOST}:{BACKUP_DIR}/{fname}'],
            check=True, capture_output=True, timeout=20,
        )
    except Exception:
        pass


# ─────────────────────── 워커 관리 ───────────────────────

def list_workers() -> dict:
    """가용 워커 + 상태."""
    out = []
    for w in DEFAULT_WORKERS:
        ep = w['endpoint']
        try:
            urllib.request.urlopen(f"{ep}/queue", timeout=2).read()
            alive = True
        except Exception:
            alive = False
        out.append({
            **w, 'alive': alive,
            'busy_count': _WORKER_BUSY.get(ep, 0),
            'concurrency': WORKER_CONCURRENCY,
        })
    return {'ok': True, 'workers': out, 'storage': {
        'host': '218서버 (sshfs mount)', 'path': STORAGE_LOCAL_DIR, 'url_prefix': STORAGE_URL_PREFIX,
        'backup_host': BACKUP_HOST, 'backup_path': BACKUP_DIR,
    }}
