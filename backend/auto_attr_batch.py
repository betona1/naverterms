"""속성 AI 자동체크 배치 — 상품명/상세 명시값 + 확장 매핑사전 + 비전분석을 통합해
'정확하게 판별되는 속성만' 커머스 API 자동등록. 스토어별 병렬.

usage: python3 auto_attr_batch.py <limit> [store_id] [mode]
  mode: auto(기본, 명시+사전+비전캐시) | vision(비전캐시 우선)
"""
import os, sys, time, threading
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import attr_fill_service as af
from smartstore.worker_log_handler import WorkerLog

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 500
STORE = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] not in ('-', 'all') else None
MODE = sys.argv[3] if len(sys.argv) > 3 else 'auto'
CONC = 5

wl = WorkerLog('auto_attr_check', name='속성 AI 자동체크', worker_type='attr')
wl.start(meta={'limit': LIMIT, 'store_id': STORE, 'mode': MODE})

m = connections['myproduct'].cursor()
q = ("SELECT DISTINCT seller_management_code, store_id FROM smartstore_product_missing_attrs "
     "WHERE status='pending' AND candidate_count>=2 AND seller_management_code<>'' ")
params = []
if STORE:
    q += "AND store_id=%s "; params.append(STORE)
q += "LIMIT %s"; params.append(LIMIT * 4)
m.execute(q, params)
cand = m.fetchall()
by_store = {}
for code, sid in cand:
    by_store.setdefault(sid, []).append(code)
wl.heartbeat(f'후보 SKU {len(cand)} / {len(by_store)}스토어 (목표 {LIMIT}, mode={MODE})')

done = {'sku': 0, 'attrs': 0, 'fail': 0, 'scan': 0}
lock = threading.Lock()
stop = {'hit': False}


def work_store(sid, codes):
    for code in codes:
        with lock:
            if done['sku'] >= LIMIT:
                stop['hit'] = True; return
            done['scan'] += 1
        try:
            r = af.process_sku(code, sid, mode=MODE, dry_run=False)
            if r.get('picked'):
                with lock:
                    done['sku'] += 1
                    done['attrs'] += r.get('attrs_set', r.get('picked', 0))
                    if done['sku'] % 20 == 0:
                        wl.heartbeat(f"등록 {done['sku']}SKU / 속성 {done['attrs']} (스캔 {done['scan']})")
                time.sleep(0.4)
        except Exception:
            with lock:
                done['fail'] += 1


sem = threading.Semaphore(CONC); threads = []


def runner(sid, codes):
    with sem:
        work_store(sid, codes)


for sid, codes in by_store.items():
    t = threading.Thread(target=runner, args=(sid, codes)); t.start(); threads.append(t)
for t in threads:
    t.join()

wl.done(f"완료 — 등록 {done['sku']}SKU / 속성 {done['attrs']} / 스캔 {done['scan']} / 실패 {done['fail']}", meta=done)
print('DONE', done)
