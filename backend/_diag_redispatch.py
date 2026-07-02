import os, django, sys, time, subprocess
sys.path.insert(0,'.'); os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); django.setup()
from django.db import connections
LOG=open('/tmp/diag_dispatch.log','w',buffering=1)
def log(m): LOG.write('%s %s\n'%(time.strftime('%H:%M:%S'),m)); LOG.flush()
mc=connections['myproduct'].cursor(); nc=connections['naverdb'].cursor()
# 로그인별 스토어 pk
mc.execute("SELECT store_id, id FROM smartstoreIdList WHERE store_pw<>'' AND store_id IS NOT NULL")
login_stores={}
for lid,pk in mc.fetchall(): login_stores.setdefault(lid,[]).append(pk)
# 이미 수집된 store_id
nc.execute("SELECT DISTINCT store_id FROM naver_product_diagnosis"); have=set(r[0] for r in nc.fetchall())
# 한 스토어라도 미수집인 로그인 = 재수집 대상 (단, betona1/betona8 성공분 제외 위해 '모든 스토어 수집됨'이면 skip)
todo=[lid for lid,pks in login_stores.items() if any(pk not in have for pk in pks)]
log('재수집 대상 로그인 %d개: %s'%(len(todo),todo))
CONC=int(os.environ.get('DIAG_CONC','2')); here=os.path.dirname(os.path.abspath(__file__)); worker=os.path.join(here,'diagnosis_worker.py')
log('동시 워커 CONC=%d (워커당 python+Chrome ~4GB, DIAG_CONC 로 조절, 순차=1)'%CONC)
running=[]; queue=list(todo); started=0
while queue or running:
    running=[(l,p) for l,p in running if p.poll() is None]
    while queue and len(running)<CONC:
        lid=queue.pop(0)
        p=subprocess.Popen(['python3',worker,lid],cwd=here,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        running.append((lid,p)); started+=1; log('시작 %s (동시%d, %d/%d)'%(lid,len(running),started,len(todo))); time.sleep(4)
    time.sleep(8)
log('=== 재디스패치 완료 (%d) ==='%started)
