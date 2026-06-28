"""썸네일 라이브 비전 배치 — GPU(108/111/136) 분산.
pending 색상/재질/형태 W코드 썸네일 → qwen2.5vl 분석 → image_analysis 캐시 → 자동 속성등록.

usage: python3 thumbnail_vision_batch.py <limit> [store_id]
"""
import os, sys, threading, time
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import thumbnail_vision_service as tv
from smartstore import attr_fill_service as af
from smartstore.worker_log_handler import WorkerLog

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 500
STORE = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] not in ('-', 'all') else None
CONC_PER_GPU = 2

wl = WorkerLog('thumbnail_vision', name='썸네일 라이브 비전', worker_type='attr')
wl.start(meta={'limit': LIMIT, 'store_id': STORE, 'gpus': tv.GPU_HOSTS})

targets = tv.target_codes(store_id=STORE, limit=LIMIT)
if not targets:
    wl.done('대상 없음 (비전 미수행 색/재질/형태 pending W코드 없음)', meta={})
    print('DONE no-targets'); sys.exit(0)

# code → store_ids (pending) 매핑
codes = [t['code'] for t in targets]
code_stores = {}
with connections['myproduct'].cursor() as cur:
    for i in range(0, len(codes), 500):
        ch = codes[i:i + 500]; ph = ','.join(['%s'] * len(ch))
        q = ("SELECT seller_management_code, store_id FROM smartstore_product_missing_attrs "
             f"WHERE status='pending' AND seller_management_code IN ({ph}) ")
        params = list(ch)
        if STORE:
            q += "AND store_id=%s"; params.append(STORE)
        cur.execute(q, params)
        for code, sid in cur.fetchall():
            code_stores.setdefault(code, set()).add(sid)

wl.heartbeat(f'대상 {len(targets)} W코드 / GPU {len(tv.GPU_HOSTS)}대 분산 시작')

stat = {'vision': 0, 'sku': 0, 'attrs': 0, 'vfail': 0, 'done': 0}
lock = threading.Lock()


def work(item, host):
    code = item['code']
    norm = tv.analyze_code(code, item['up'], item['lg'], item['md'], item['sm'], host)
    with lock:
        stat['done'] += 1
        if not norm:
            stat['vfail'] += 1
        else:
            stat['vision'] += 1
    if not norm:
        return
    for sid in code_stores.get(code, []):
        try:
            r = af.process_sku(code, sid, mode='auto', dry_run=False)
            if r.get('picked'):
                with lock:
                    stat['sku'] += 1
                    stat['attrs'] += r.get('attrs_set', r.get('picked', 0))
        except Exception:
            pass
    with lock:
        if stat['done'] % 10 == 0:
            wl.heartbeat(f"분석 {stat['done']}/{len(targets)} · 비전성공 {stat['vision']} · "
                         f"등록 {stat['sku']}SKU/{stat['attrs']}속성 · 실패 {stat['vfail']}")


# GPU별 큐 — 라운드로빈 분배
queues = {h: [] for h in tv.GPU_HOSTS}
for i, t in enumerate(targets):
    queues[tv.GPU_HOSTS[i % len(tv.GPU_HOSTS)]].append(t)


def gpu_runner(host, items):
    sem = threading.Semaphore(CONC_PER_GPU)
    threads = []

    def one(it):
        with sem:
            work(it, host)
    for it in items:
        th = threading.Thread(target=one, args=(it,)); th.start(); threads.append(th)
        time.sleep(0.05)
    for th in threads:
        th.join()


runners = []
for host, items in queues.items():
    r = threading.Thread(target=gpu_runner, args=(host, items)); r.start(); runners.append(r)
for r in runners:
    r.join()

wl.done(f"완료 — 비전 {stat['vision']}건 · 등록 {stat['sku']}SKU/{stat['attrs']}속성 · "
        f"비전실패 {stat['vfail']} (대상 {len(targets)})", meta=stat)
print('DONE', stat)
