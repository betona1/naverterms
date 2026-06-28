"""스토어별 순회 GPU 추론 재시도 — 전체-DISTINCT 느린쿼리 회피.
각 스토어는 smartstore_product(작은 집합)에서 시작하는 빠른 JOIN으로 등록가능 pending 선택.
토큰 30분 TTL 갱신, GPU 4대 분산. 이미 classified/registered 는 자연 제외(pending만).
"""
import os, sys, time, threading
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import gpu_attr_classifier as gc
from smartstore import thumbnail_vision_service as tv
from smartstore.worker_log_handler import WorkerLog

CONC_PER_GPU = 2
GPUS = tv.GPU_HOSTS

wl = WorkerLog('gpu_attr_stage', name='GPU 속성 추론(스토어별 재시도)', worker_type='attr')
wl.start(meta={'mode': 'perstore_retry', 'gpus': GPUS})

# pending 보유 스토어
with connections['myproduct'].cursor() as c:
    c.execute("SELECT DISTINCT store_id FROM smartstore_product_missing_attrs "
              "WHERE status='pending' AND candidate_count BETWEEN 2 AND 20")
    store_ids = [r[0] for r in c.fetchall()]

# 토큰 TTL 캐시
tokens = {}
tlock = threading.Lock()


def get_token(sid):
    now = time.time()
    with tlock:
        cur = tokens.get(sid)
        if cur and (now - cur[1]) < 1800 and cur[0]:
            return cur[0]
        try:
            tok = gc._token(sid)
        except Exception:
            tok = None
        tokens[sid] = (tok, now)
        return tok


stat = {'store': 0, 'sku': 0, 'attrs': 0, 'none': 0, 'fail': 0, 'done': 0, 'total': 0}
lock = threading.Lock()


def work(seller, sid, host):
    tok = get_token(sid)
    try:
        r = gc.stage_sku(seller, sid, host=host, token=tok)
        with lock:
            stat['done'] += 1
            if r.get('staged'):
                stat['sku'] += 1; stat['attrs'] += r['staged']
            elif r.get('ok'):
                stat['none'] += 1
            else:
                stat['fail'] += 1
    except Exception:
        with lock:
            stat['done'] += 1; stat['fail'] += 1
    with lock:
        if stat['done'] % 20 == 0:
            wl.heartbeat(f"[{stat['store']}/{len(store_ids)}스토어] 추론 {stat['sku']}SKU/{stat['attrs']}속성 "
                         f"· 분류없음 {stat['none']} · 실패 {stat['fail']} · 처리 {stat['done']}/{stat['total']}")


def run_store(sid):
    # 등록가능 pending SKU (product에서 시작 → 빠름)
    with connections['myproduct'].cursor() as c:
        c.execute("""SELECT DISTINCT p.seller_management_code FROM smartstore_product p
            JOIN smartstore_product_missing_attrs m
              ON m.seller_management_code=p.seller_management_code COLLATE utf8mb4_unicode_ci
                 AND m.store_id=p.store_id
            WHERE p.store_id=%s AND m.status='pending' AND m.candidate_count BETWEEN 2 AND 20""", [sid])
        sellers = [r[0] for r in c.fetchall()]
    if not sellers:
        return
    with lock:
        stat['total'] += len(sellers)
    sem = threading.Semaphore(CONC_PER_GPU * len(GPUS))
    threads = []

    def one(seller, idx):
        with sem:
            work(seller, sid, GPUS[idx % len(GPUS)])
    for i, seller in enumerate(sellers):
        t = threading.Thread(target=one, args=(seller, i)); t.start(); threads.append(t)
        time.sleep(0.04)
    for t in threads:
        t.join()


for sid in store_ids:
    stat['store'] += 1
    wl.heartbeat(f"[{stat['store']}/{len(store_ids)}] store{sid} 시작 · 누적 추론 {stat['sku']}SKU/{stat['attrs']}속성")
    run_store(sid)

wl.done(f"완료(스토어별 재시도) — 추론 {stat['sku']}SKU/{stat['attrs']}속성 · 분류없음 {stat['none']} · 실패 {stat['fail']}", meta=stat)
print('DONE', stat)
