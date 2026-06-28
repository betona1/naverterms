"""비전 속성 등록 배치 — 수작업 매핑사전(동의어그룹) 기반.
1) 비전캐시 보유분 즉시 매핑·등록  2) 미보유분 GPU 비전분석 후 등록. register_for_sku 라이브."""
import os, sys, time, threading
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings'); django.setup()
from django.db import connections
from smartstore import attr_fill_service as af, naver_vision_analyzer as vis
from smartstore.worker_log_handler import WorkerLog

GPU_N = int(sys.argv[1]) if len(sys.argv) > 1 else 300   # 추가 GPU 분석 상한
VGPUS = ['http://192.168.219.108:11434', 'http://192.168.219.111:11434', 'http://192.168.219.136:11434']
wl = WorkerLog('vision_attr_fill', name='비전 속성등록', worker_type='attr')
wl.start(meta={'gpu_n': GPU_N})

m = connections['myproduct'].cursor(); n = connections['naverdb'].cursor()
# 색상/재질/형태 pending SKU
m.execute("SELECT DISTINCT seller_management_code, store_id FROM smartstore_product_missing_attrs "
          "WHERE status='pending' AND candidate_count>=2 AND attribute_name IN ('색상','재질','형태','소재')")
skus = m.fetchall()
# naver_my_product 보유 + 비전캐시 여부
cached, uncached = [], []
for code, sid in skus:
    n.execute("SELECT image_analysis IS NOT NULL FROM naver_my_product WHERE product_code=%s AND image_large<>''", [code])
    r = n.fetchone()
    if not r: continue
    (cached if r[0] else uncached).append((code, sid))
wl.heartbeat(f'대상 색상/재질/형태 SKU — 캐시보유 {len(cached)} / 미보유 {len(uncached)}')

done = {'sku': 0, 'attrs': 0}; lock = threading.Lock()

def register(code, sid):
    try:
        r = af.process_sku(code, sid, mode='vision', dry_run=False)
        if r.get('picked'):
            with lock:
                done['sku'] += 1; done['attrs'] += r.get('attrs_set', r.get('picked', 0))
                if done['sku'] % 25 == 0: wl.heartbeat(f"등록 {done['sku']} SKU / {done['attrs']} 속성")
            time.sleep(0.4)
    except Exception: pass

# 1) 캐시 보유분 — 병렬 등록 (GPU 불필요)
sem = threading.Semaphore(6); ths = []
def run1(code, sid):
    with sem: register(code, sid)
for code, sid in cached:
    t = threading.Thread(target=run1, args=(code, sid)); t.start(); ths.append(t)
for t in ths: t.join()
wl.heartbeat(f"[1단계 완료] 캐시분 등록 {done['sku']} SKU / {done['attrs']} 속성")

# 2) 미보유분 — GPU 비전분석 후 등록 (상한 GPU_N, 3 GPU 분산)
todo = uncached[:GPU_N]
gsem = threading.Semaphore(3); ths = []
def run2(i, code, sid):
    with gsem:
        n2 = connections['naverdb'].cursor()
        n2.execute("SELECT id FROM naver_my_product WHERE product_code=%s AND image_large<>''", [code])
        r = n2.fetchone()
        if r:
            try: vis.analyze_product_image(r[0], url=VGPUS[i % 3], models=['qwen2.5vl:7b'])
            except Exception: return
            register(code, sid)
for i, (code, sid) in enumerate(todo):
    t = threading.Thread(target=run2, args=(i, code, sid)); t.start(); ths.append(t)
for t in ths: t.join()
wl.done(f"완료 — 총 {done['sku']} SKU / {done['attrs']} 속성", meta=done)
print('DONE', done)
