"""GPU 멀티모달 속성 추론(스테이징) 배치 — GPU(108/111/136) 분산.
등록가능(smartstore_product 실존) 상품의 빈 속성을 상품명+대표이미지+상세로 GPU 분류 →
네이버 PUT 없이 missing_attrs 에 status='classified' 로 기록만 한다 (동기화는 별도 단계).

usage: python3 gpu_attr_stage_batch.py <limit> [store_id]
"""
import os, sys, threading, time
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import gpu_attr_classifier as gc
from smartstore import thumbnail_vision_service as tv
from smartstore.worker_log_handler import WorkerLog

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 500
STORE = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] not in ('-', 'all') else None
CONC_PER_GPU = 2

wl = WorkerLog('gpu_attr_stage', name='GPU 속성 추론(스테이징)', worker_type='attr')
wl.start(meta={'limit': LIMIT, 'store_id': STORE, 'gpus': tv.GPU_HOSTS})

# 대상: 등록가능(smartstore_product 실존) + 빈속성 pending SKU
with connections['myproduct'].cursor() as c:
    q = ("SELECT DISTINCT p.seller_management_code, p.store_id "
         "FROM smartstore_product p "
         "JOIN smartstore_product_missing_attrs m "
         "  ON m.seller_management_code=p.seller_management_code COLLATE utf8mb4_unicode_ci "
         "  AND m.store_id=p.store_id "
         "WHERE m.status='pending' AND m.candidate_count BETWEEN 2 AND 20 ")
    params = []
    if STORE:
        q += "AND p.store_id=%s "
        params.append(STORE)
    q += "LIMIT %s"
    params.append(LIMIT)
    c.execute(q, params)
    targets = c.fetchall()

if not targets:
    wl.done('대상 없음', meta={}); print('DONE no-targets'); sys.exit(0)

wl.heartbeat(f'대상 {len(targets)} SKU / GPU {len(tv.GPU_HOSTS)}대 분산')

# 스토어별 토큰 캐시 (TTL 30분 — 장기 실행 토큰 만료 방지)
tokens = {}          # sid → (token, fetched_at)
tlock = threading.Lock()
TOKEN_TTL = 1800


def get_token(sid):
    now = time.time()
    with tlock:
        cached = tokens.get(sid)
        if cached and (now - cached[1]) < TOKEN_TTL and cached[0]:
            return cached[0]
        try:
            tok = gc._token(sid)
        except Exception:
            tok = None
        tokens[sid] = (tok, now)
        return tok


stat = {'sku': 0, 'attrs': 0, 'none': 0, 'fail': 0, 'done': 0}
lock = threading.Lock()


def work(seller, sid, host):
    tok = get_token(sid)
    try:
        r = gc.stage_sku(seller, sid, host=host, token=tok)
        with lock:
            stat['done'] += 1
            if r.get('staged'):
                stat['sku'] += 1; stat['attrs'] += r['staged']
            elif r.get('staged', 0) == 0:
                stat['none'] += 1
            if not r.get('ok'):
                stat['fail'] += 1
    except Exception:
        with lock:
            stat['done'] += 1; stat['fail'] += 1
    with lock:
        if stat['done'] % 10 == 0:
            wl.heartbeat(f"처리 {stat['done']}/{len(targets)} · 추론 {stat['sku']}SKU/{stat['attrs']}속성 "
                         f"· 추론없음 {stat['none']} · 실패 {stat['fail']}")


# GPU 라운드로빈
queues = {h: [] for h in tv.GPU_HOSTS}
for i, (s, sid) in enumerate(targets):
    queues[tv.GPU_HOSTS[i % len(tv.GPU_HOSTS)]].append((s, sid))


def gpu_runner(host, items):
    sem = threading.Semaphore(CONC_PER_GPU)
    ths = []

    def one(s, sid):
        with sem:
            work(s, sid, host)
    for s, sid in items:
        t = threading.Thread(target=one, args=(s, sid)); t.start(); ths.append(t)
        time.sleep(0.05)
    for t in ths:
        t.join()


runners = []
for host, items in queues.items():
    r = threading.Thread(target=gpu_runner, args=(host, items)); r.start(); runners.append(r)
for r in runners:
    r.join()

wl.done(f"완료 — 추론 {stat['sku']}SKU / {stat['attrs']}속성 · 추론없음 {stat['none']} · 실패 {stat['fail']} (대상 {len(targets)})", meta=stat)
print('DONE', stat)
