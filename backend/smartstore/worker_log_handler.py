"""모든 크롤링 워커가 import 해서 사용하는 표준 logger.

사용 예:
    from smartstore.worker_log_handler import WorkerLog

    wl = WorkerLog('register_auto_candidates', name='상품 자동등록')
    wl.start(meta={'mode': 'dry-run'})
    wl.heartbeat('현재 W500 처리 중')   # 한 줄 요약 갱신 + log INSERT
    wl.info('처리 결과: 성공 480 / 실패 20')
    wl.error('네이버 API 인증 실패', meta={'reason': 'invalid_token'})
    wl.done()

DB:
  - crawl_worker_status: worker_key UPSERT
  - crawl_worker_log: append-only INSERT
"""
from __future__ import annotations

import json
import logging
import os
import socket
from datetime import datetime
from typing import Any

from django.db import connections

logger = logging.getLogger(__name__)

DB = 'naverdb'


def _json_or_none(v) -> str | None:
    if v is None:
        return None
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None


def _safe_exec(fn):
    """DB 호출 실패가 본 작업 망치면 안 됨 — 로깅 실패는 silent."""
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        logger.warning('worker_log DB 실패: %s', e)


class WorkerLog:
    def __init__(self, worker_key: str, name: str | None = None,
                 worker_type: str = 'crawl'):
        self.worker_key = worker_key
        self.worker_name = name or worker_key
        self.worker_type = worker_type
        self.host = socket.gethostname()
        self.pid = os.getpid()

    # ── 상태 upsert ──
    def _upsert_status(self, status: str, last_line: str | None = None,
                       meta: dict | None = None,
                       reset_started: bool = False,
                       inc_failures: bool = False) -> None:
        # ON DUPLICATE KEY UPDATE 절에서 % 들어간 함수 사용은 ORM cursor 가
        # paramstyle 충돌 인식해 'not all arguments converted' 발생.
        # → INSERT IGNORE 후 별도 UPDATE 로 분리.
        def _do():
            with connections[DB].cursor() as cur:
                # 1) 행 없으면 삽입
                cur.execute(
                    """
                    INSERT IGNORE INTO crawl_worker_status
                      (worker_key, worker_name, worker_type, host_name, pid,
                       status, last_log_line, started_at, last_heartbeat_at, meta)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW(), %s)
                    """,
                    [self.worker_key, self.worker_name, self.worker_type,
                     self.host, self.pid, status, last_line,
                     _json_or_none(meta)],
                )
                # 2) UPDATE
                sets = [
                    "worker_name=%s", "worker_type=%s", "host_name=%s", "pid=%s",
                    "status=%s", "last_heartbeat_at=NOW()",
                ]
                params: list = [self.worker_name, self.worker_type, self.host,
                                self.pid, status]
                if last_line is not None:
                    sets.append("last_log_line=%s")
                    params.append(last_line)
                if reset_started:
                    sets.append("started_at=NOW()")
                    sets.append("consecutive_failures=0")
                if inc_failures:
                    sets.append("consecutive_failures=consecutive_failures+1")
                if meta is not None:
                    sets.append("meta=%s")
                    params.append(_json_or_none(meta))
                params.append(self.worker_key)
                cur.execute(
                    f"UPDATE crawl_worker_status SET {', '.join(sets)} WHERE worker_key=%s",
                    params,
                )
        _safe_exec(_do)

    # ── log append ──
    def _append_log(self, level: str, message: str, meta: dict | None = None) -> None:
        message = (message or '')[:1000]
        def _do():
            with connections[DB].cursor() as cur:
                cur.execute(
                    "INSERT INTO crawl_worker_log (worker_key, level, message, meta) "
                    "VALUES (%s, %s, %s, %s)",
                    [self.worker_key, level, message, _json_or_none(meta)],
                )
        _safe_exec(_do)

    # ── public API ──
    def start(self, message: str = '워커 시작', meta: dict | None = None) -> None:
        self._upsert_status('ok', last_line=message, meta=meta, reset_started=True)
        self._append_log('INFO', message, meta)

    def heartbeat(self, last_line: str | None = None,
                  meta: dict | None = None) -> None:
        """한줄 요약 갱신 + log 추가 (last_line 있을 때만 log INSERT)."""
        self._upsert_status('ok', last_line=last_line, meta=meta)
        if last_line:
            self._append_log('INFO', last_line, meta)

    def info(self, message: str, meta: dict | None = None) -> None:
        self._upsert_status('ok', last_line=message, meta=meta)
        self._append_log('INFO', message, meta)

    def warn(self, message: str, meta: dict | None = None) -> None:
        self._upsert_status('degraded', last_line=message, meta=meta)
        self._append_log('WARN', message, meta)

    def error(self, message: str, meta: dict | None = None) -> None:
        self._upsert_status('degraded', last_line=message, meta=meta,
                            inc_failures=True)
        self._append_log('ERROR', message, meta)

    def done(self, message: str = '완료', meta: dict | None = None) -> None:
        self._upsert_status('ok', last_line=message, meta=meta)
        self._append_log('INFO', message, meta)

    def dead(self, message: str = '비정상 종료', meta: dict | None = None) -> None:
        self._upsert_status('dead', last_line=message, meta=meta)
        self._append_log('ERROR', message, meta)
