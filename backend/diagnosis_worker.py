"""상품등록정보검토 수집 워커 (1 로그인 = 1 프로세스 = 1 독립 Xvfb).

병렬 실행을 위해 각 프로세스가 자기 디스플레이를 띄운다 (xdotool 타이핑 충돌 방지).
사용: python3 diagnosis_worker.py <login_id>
"""
import os, sys, time

# 1) 이 프로세스 전용 Xvfb 먼저 띄워 DISPLAY 격리
from pyvirtualdisplay import Display
_disp = Display(visible=0, size=(1920, 1080))
_disp.start()

import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections
from smartstore import store_collector as sc
from smartstore import diagnosis_service as ds
from smartstore.worker_log_handler import WorkerLog


def main():
    login_id = sys.argv[1]
    wl = WorkerLog(f'diagnosis_{login_id}', name=f'진단수집 {login_id}', worker_type='diagnosis')
    wl.start(meta={'login_id': login_id, 'display': os.environ.get('DISPLAY')})

    with connections['myproduct'].cursor() as cur:
        cur.execute("SELECT id, store_pw, store_name FROM smartstoreIdList WHERE store_id=%s AND store_pw<>''", [login_id])
        rows = cur.fetchall()
    if not rows:
        wl.dead('스토어 없음'); return
    pw = rows[0][1]
    stores = [(pk, nm) for pk, _pw, nm in rows if nm]
    pkmap = {nm: pk for pk, nm in stores}
    store_names = [nm for _, nm in stores]
    wl.heartbeat(f'스토어 {len(store_names)}개: {store_names}')

    sc._ensure_display()
    disp = sc._get_display_env()
    drv = sc._create_driver(f'/tmp/diag_{os.getpid()}')
    drv.implicitly_wait(4)
    total = 0
    try:
        if not sc._login(drv, login_id, pw, disp):
            wl.dead('로그인 실패'); return
        time.sleep(4)
        try: sc._close_popups(drv)
        except Exception: pass
        for sname in store_names:
            try:
                if len(store_names) > 1:
                    sc._switch_store(drv, sname); time.sleep(3)
                rows = ds._collect_diagnosis(drv)
                sid = pkmap.get(sname)
                if sid and rows:
                    ds._match_wcodes(sid, rows)
                    saved = ds._save(sid, login_id, sname, rows)
                    total += saved
                    wl.heartbeat(f'{sname}: {saved}건 저장', meta={'store': sname, 'count': saved})
            except Exception as e:
                wl.error(f'{sname} 실패: {str(e)[:150]}')
        wl.done(f'완료 — {len(store_names)}스토어 / {total}건', meta={'total': total})
    except Exception as e:
        import traceback
        wl.dead(f'예외: {traceback.format_exc()[:300]}')
    finally:
        sc._safe_quit_driver(drv)
        try: _disp.stop()
        except Exception: pass


if __name__ == '__main__':
    main()
