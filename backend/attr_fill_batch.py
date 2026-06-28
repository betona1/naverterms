"""속성 정밀 등록 배치 — exact 매칭(상품명/상세 명시값만) → 커머스 API 등록. 스토어별 병렬."""
import os, sys, time, threading
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import attr_fill_service as af
from smartstore.worker_log_handler import WorkerLog

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 500
CONC = 5
wl = WorkerLog('attr_fill_exact', name='속성 정밀등록', worker_type='attr')
wl.start(meta={'limit': LIMIT, 'mode': 'exact'})

# 대상: pending 다중후보 SKU (상품정보 보유) — 스토어별
m = connections['myproduct'].cursor()
m.execute("SELECT DISTINCT seller_management_code, store_id FROM smartstore_product_missing_attrs "
          "WHERE status='pending' AND candidate_count>=2 LIMIT %s", [LIMIT * 3])
cand = m.fetchall()
by_store = {}
for code, sid in cand:
    by_store.setdefault(sid, []).append(code)
wl.heartbeat(f'후보 SKU {len(cand)} / {len(by_store)}스토어 (목표 {LIMIT})')

done = {'sku': 0, 'attrs': 0, 'fail': 0}
lock = threading.Lock()
stop = {'hit': False}

def work_store(sid, codes):
    for code in codes:
        with lock:
            if done['sku'] >= LIMIT: stop['hit'] = True; return
        info = af._product_info(code, sid)
        if not info: continue
        try:
            r = af.process_sku(code, sid, mode='exact', dry_run=False)
            if r.get('picked'):
                with lock:
                    done['sku'] += 1; done['attrs'] += r.get('attrs_set', r.get('picked', 0))
                    if done['sku'] % 25 == 0:
                        wl.heartbeat(f"등록 {done['sku']} SKU / 속성 {done['attrs']}")
                time.sleep(0.5)
        except Exception:
            with lock: done['fail'] += 1

sem = threading.Semaphore(CONC); threads = []
def runner(sid, codes):
    with sem: work_store(sid, codes)
for sid, codes in by_store.items():
    t = threading.Thread(target=runner, args=(sid, codes)); t.start(); threads.append(t)
for t in threads: t.join()
wl.done(f"완료 — SKU {done['sku']} / 속성 {done['attrs']} / 실패 {done['fail']}", meta=done)
print('DONE', done)
