import os, django, sys, time, subprocess
sys.path.insert(0,'.'); os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); django.setup()
from django.db import connections
LOG=open('/tmp/diag_dispatch.log','w',buffering=1)
def log(m): LOG.write('%s %s\n'%(time.strftime('%H:%M:%S'),m)); LOG.flush()
with connections['myproduct'].cursor() as c:
    c.execute("SELECT DISTINCT store_id FROM smartstoreIdList WHERE store_pw<>'' AND store_id IS NOT NULL")
    logins=[r[0] for r in c.fetchall()]
log('대상 로그인 %d개: %s'%(len(logins),logins))
CONC=5; here=os.path.dirname(os.path.abspath(__file__)); worker=os.path.join(here,'diagnosis_worker.py')
running=[]; queue=list(logins); started=0
while queue or running:
    running=[(l,p) for l,p in running if p.poll() is None]
    while queue and len(running)<CONC:
        lid=queue.pop(0)
        p=subprocess.Popen(['python3',worker,lid],cwd=here,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        running.append((lid,p)); started+=1
        log('시작 %s (동시%d, 시작누적%d/%d)'%(lid,len(running),started,len(logins)))
        time.sleep(3)
    time.sleep(6)
log('=== 전체 디스패치 완료 (%d 워커) ==='%started)
