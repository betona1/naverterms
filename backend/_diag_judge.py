import os, sys, time
from pyvirtualdisplay import Display
_d=Display(visible=0,size=(1920,1080)); _d.start()
import django; sys.path.insert(0,'.'); os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings'); django.setup()
from django.db import connections
from smartstore import store_collector as sc, diagnosis_service as ds
LOG=open('/tmp/diag_judge.log','w',buffering=1)
def log(m): LOG.write('%s %s\n'%(time.strftime('%H:%M:%S'),str(m)[:600])); LOG.flush()
# 워커 다 끝날 때까지 대기
import subprocess
while True:
    n=subprocess.run(['pgrep','-fc','diagnosis_worker.py'],capture_output=True,text=True).stdout.strip()
    if n in ('0',''): break
    log('워커 %s개 남음 — 대기'%n); time.sleep(15)
log('워커 종료 — 판별 시작')
targets=[('joacham@nate.com','조아컴퓨존'),('bitic05@nate.com','비트윙')]
mc=connections['myproduct'].cursor()
for lid,sname in targets:
    mc.execute("SELECT store_pw FROM smartstoreIdList WHERE store_id=%s LIMIT 1",[lid]); pw=mc.fetchone()[0]
    sc._ensure_display(); disp=sc._get_display_env()
    drv=sc._create_driver('/tmp/judge_dl'); drv.implicitly_wait(3)
    try:
        sc._login(drv,lid,pw,disp); time.sleep(4)
        try: sc._close_popups(drv)
        except Exception: pass
        # 멀티스토어면 전환
        try:
            stores=sc._get_store_list(drv)
            if sname in stores and len(stores)>1: sc._switch_store(drv,sname); time.sleep(3)
        except Exception as e: log('store목록/전환 err %s'%str(e)[:60])
        drv.get(ds.DIAG_URL); time.sleep(8)
        ok_if=ds._enter_iframe_wait(drv,40)
        log('[%s/%s] iframe진입=%s'%(lid,sname,ok_if))
        if ok_if:
            n=ds._wait_rows(drv,25)
            try: body=drv.find_element('tag name','body').text
            except Exception: body=''
            log('  tbody tr=%d'%n)
            log('  BODY: '+body[:400].replace('\n',' | '))
    except Exception as e:
        import traceback; log('EXC %s'%traceback.format_exc()[:300])
    finally:
        sc._safe_quit_driver(drv)
try: _d.stop()
except Exception: pass
log('=== DONE ===')
