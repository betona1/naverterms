"""태그 일괄 등록 — naver_product_tags → 네이버 sellerTags. 스토어별 병렬(쓰레드)."""
import os, sys, time, json, threading
import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()
from django.db import connections
from smartstore import tag_service as ts, smartstore_product_service as sps
from smartstore.worker_log_handler import WorkerLog

CONC = 5
wl = WorkerLog('tag_register_all', name='태그 일괄등록', worker_type='tag')
wl.start()

# 대상: 태그 있고 미등록 + SALE opno 보유
nc = connections['naverdb'].cursor()
nc.execute("SELECT product_code, tags_json FROM naver_product_tags WHERE registered=0 AND tag_count>0")
tagmap = {code: json.loads(tj) for code, tj in nc.fetchall()}
codes = list(tagmap.keys())
mc = connections['myproduct'].cursor()
prod = {}  # code -> (store_id, opno)
for i in range(0, len(codes), 500):
    ch = codes[i:i+500]; ph = ','.join(['%s']*len(ch))
    mc.execute(f"SELECT seller_management_code, store_id, origin_product_no FROM smartstore_product WHERE status_type='SALE' AND seller_management_code IN ({ph})", ch)
    for code, sid, opno in mc.fetchall():
        prod.setdefault(code, (sid, opno))   # 첫 SALE 매칭
by_store = {}
for code, (sid, opno) in prod.items():
    by_store.setdefault(sid, []).append((code, opno))
wl.heartbeat(f'대상 {len(prod)}건 / {len(by_store)}스토어')

done = {'ok': 0, 'fail': 0}
lock = threading.Lock()

def work_store(sid, items):
    try:
        api, sec, _ = sps._get_store_credentials(sid)
        token = sps._get_access_token(api, sec)
    except Exception as e:
        return
    for code, opno in items:
        try:
            ts.register_tags_to_naver(sid, opno, tagmap[code], token=token)
            with connections['naverdb'].cursor() as c2:
                c2.execute("UPDATE naver_product_tags SET registered=1 WHERE product_code=%s", [code])
            with lock: done['ok'] += 1
        except Exception:
            with lock: done['fail'] += 1
        if (done['ok'] + done['fail']) % 50 == 0:
            wl.heartbeat(f"진행 {done['ok']} 성공 / {done['fail']} 실패")
        time.sleep(0.6)

sem = threading.Semaphore(CONC)
threads = []
def runner(sid, items):
    with sem:
        work_store(sid, items)
for sid, items in by_store.items():
    t = threading.Thread(target=runner, args=(sid, items)); t.start(); threads.append(t)
for t in threads: t.join()
wl.done(f"완료 — 성공 {done['ok']} / 실패 {done['fail']}", meta=done)
print('DONE', done)
