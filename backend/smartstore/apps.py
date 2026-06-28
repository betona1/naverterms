import sys
import threading
import time

from django.apps import AppConfig


class SmartstoreConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'smartstore'

    def ready(self):
        # runserver 단일 프로세스(--noreload)일 때만 — migrate/shell 등에서는 스킵.
        if 'runserver' not in sys.argv:
            return
        threading.Thread(target=self._revive_upscale_dispatcher,
                         daemon=True, name='upscale-revive').start()

    @staticmethod
    def _revive_upscale_dispatcher():
        """백엔드 재시작 시 status='running' 인 업스케일 job 이 있으면
        고아 'running' row 복구 + 디스패처 루프 재기동. (프론트 폴링 의존 제거)"""
        time.sleep(5)  # DB 커넥션/앱 로딩 안정화 대기
        try:
            from django.db import connections
            from . import naver_upscale_dispatcher as _d
            with connections[_d.NAVERDB].cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM naver_upscale_batch_job WHERE status='running'")
                running_jobs = cur.fetchone()[0]
            if running_jobs:
                _d._recover_stuck_rows()
                _d._ensure_dispatcher_running()
                print(f'[upscale-revive] running job {running_jobs}개 감지 → 디스패처 재기동', flush=True)
        except Exception as e:
            print(f'[upscale-revive] 실패: {e}', flush=True)
