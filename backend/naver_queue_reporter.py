#!/usr/bin/env python3
"""네이버 작업큐 진척 텔레그램 보고 — PM2 cron_restart 로 1시간마다 1회 실행 후 종료."""
import os
import sys
import json
import time
import urllib.request

import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.conf import settings  # noqa: E402
from django.db import connections  # noqa: E402

TG_TOKEN = getattr(settings, 'TELEGRAM_BOT_TOKEN', None)
TG_CHAT = getattr(settings, 'TELEGRAM_CHAT_ID', None)

ENABLED_FLAG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.tg_reporter_enabled')


def is_enabled() -> bool:
    return os.path.exists(ENABLED_FLAG)


def tg(msg: str) -> None:
    if not TG_TOKEN or not TG_CHAT:
        print('TG 미설정', file=sys.stderr)
        return
    try:
        req = urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'HTML'}).encode(),
            headers={'Content-Type': 'application/json'},
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f'TG 실패: {e}', file=sys.stderr)


def fetch_state() -> dict:
    # 폴더 큐
    with connections['naverdb'].cursor() as cur:
        cur.execute("""
            SELECT f.id, f.name, f.queue_position,
                   COUNT(p.id) AS total,
                   SUM(p.naver_product_name IS NOT NULL AND p.naver_product_name<>'') AS done
              FROM naver_my_product_folder f
              LEFT JOIN naver_my_product p ON p.folder_id=f.id
             WHERE f.queue_position IS NOT NULL
             GROUP BY f.id, f.name, f.queue_position
             ORDER BY f.queue_position
        """)
        queue = [{'fid': r[0], 'name': r[1], 'pos': r[2], 'total': int(r[3] or 0), 'done': int(r[4] or 0)}
                 for r in cur.fetchall()]

    # 워커 task
    with connections['ads'].cursor() as cur:
        cur.execute("SELECT status, COUNT(*) FROM ai_keyword_task WHERE platform='naver' GROUP BY status")
        tasks = {r[0]: int(r[1]) for r in cur.fetchall()}

        # 최근 1시간 처리량
        cur.execute("""
            SELECT COUNT(*) FROM ai_keyword_task
             WHERE platform='naver' AND status='done'
               AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        """)
        last_hour_done = int(cur.fetchone()[0])

        # 워커별 처리량 (지난 1시간)
        cur.execute("""
            SELECT claimed_by, COUNT(*) FROM ai_keyword_task
             WHERE platform='naver' AND status='done'
               AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
             GROUP BY claimed_by
             ORDER BY 2 DESC
        """)
        worker_stats = cur.fetchall()

    return {
        'queue': queue,
        'tasks': tasks,
        'last_hour_done': last_hour_done,
        'workers': worker_stats,
    }


def fmt_report(s: dict) -> str:
    q = s['queue']
    t = s['tasks']
    lines = [f'🌙 <b>네이버 큐 진척 보고</b> ({time.strftime("%H:%M")})']

    # 큐 요약
    total_total = sum(it['total'] for it in q)
    total_done = sum(it['done'] for it in q)
    total_rem = total_total - total_done
    pct = (total_done * 100 / total_total) if total_total else 0
    lines.append(f'\n📦 큐 <b>{len(q)}개 폴더</b> · 전체 {total_done:,}/{total_total:,} ({pct:.1f}%) · 남은 <b>{total_rem:,}</b>건')

    # 큐 상세 (상위 10)
    for it in q[:10]:
        rem = it['total'] - it['done']
        p = (it['done'] * 100 / it['total']) if it['total'] else 0
        bar = '█' * int(p / 10) + '░' * (10 - int(p / 10))
        lines.append(f'  #{it["pos"]} {it["name"][:10]:<10} {bar} {p:5.1f}% ({rem:,})')
    if len(q) > 10:
        lines.append(f'  … +{len(q)-10}개 폴더')

    # 워커 상태
    lines.append('\n⚙️ <b>워커</b>')
    lines.append(f'  pending {t.get("pending",0):,} · running {t.get("running",0)} · done {t.get("done",0):,} · error {t.get("error",0)}')
    lines.append(f'  ⏱ 최근 1시간 처리: <b>{s["last_hour_done"]:,}</b>건')

    # 워커별 (상위 5)
    if s['workers']:
        lines.append('\n🏎 워커별 1h 처리량')
        for w, n in s['workers'][:5]:
            lines.append(f'  {(w or "?")[:25]:<25} {n:>4}건')

    # ETA
    if s['last_hour_done'] > 0 and total_rem > 0:
        hours = total_rem / s['last_hour_done']
        lines.append(f'\n⏳ ETA: ~<b>{hours:.1f}시간</b> (현재 속도 기준)')

    return '\n'.join(lines)


if __name__ == '__main__':
    if not is_enabled():
        print(f'⏸  플래그 OFF — 스킵 ({ENABLED_FLAG})')
        sys.exit(0)
    try:
        state = fetch_state()
        # 완료 감지 — 큐 모두 100% 도달
        q = state['queue']
        total_rem = sum(it['total'] - it['done'] for it in q)
        if not q or total_rem == 0:
            tg(f'🎉 <b>큐 전체 완료!</b>\n\n폴더 0개 남음 — 누적 done {state["tasks"].get("done",0):,}건\n매시간 보고 자동 OFF.')
            # 플래그 OFF (스팸 방지)
            try:
                os.remove(ENABLED_FLAG)
            except OSError:
                pass
            sys.exit(0)
        msg = fmt_report(state)
        print(msg)
        tg(msg)
    except Exception as e:
        err = f'❌ 큐 보고 실패: {e}'
        print(err, file=sys.stderr)
        tg(err)
        sys.exit(1)
