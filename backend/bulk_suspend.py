"""미판매 W코드 일괄 판매중지 — 23개 스토어 병렬 + 30분 보고 + 텔레그램"""
import os, sys, time, threading, signal, traceback
sys.path.insert(0, '/home/joacham/projects/naverterms/backend')
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
import django; django.setup()

from datetime import datetime
from collections import defaultdict
from django.db import connections, close_old_connections
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from smartstore.smartstore_product_service import _get_access_token, _change_product_status
from django.conf import settings

CUTOFF_DATE = '2025-03-01'
PROGRESS_FILE = '/home/joacham/projects/naverterms/backend/exports/bulk_suspend_progress.log'
PROGRESS_PUBLIC = '/home/joacham/projects/naverterms/frontend/public/downloads/bulk_suspend_progress.log'
TG_TOKEN = settings.TELEGRAM_BOT_TOKEN
TG_CHAT = settings.TELEGRAM_CHAT_ID

started_at = time.time()
progress = {'completed': 0, 'success': 0, 'errors': 0, 'skipped': 0}
progress_lock = threading.Lock()
stop_flag = threading.Event()
total_target = 0


def tg_send(msg):
    if not TG_TOKEN or not TG_CHAT:
        return
    try:
        requests.post(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            json={'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'HTML'},
            timeout=10,
        )
    except Exception:
        pass


def log_msg(msg, type_='progress'):
    line = f'[{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
    print(line, flush=True)
    for path in (PROGRESS_FILE, PROGRESS_PUBLIC):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'a') as f:
                f.write(line + '\n')
        except Exception:
            pass
    # NaverCrawlLog DB
    try:
        from naver.models import NaverCrawlLog
        NaverCrawlLog.objects.create(type=type_, message=msg, keyword='[bulk_suspend]')
        close_old_connections()
    except Exception:
        pass


def load_targets():
    global total_target
    sold = set()
    with connections['joacham'].cursor() as c:
        c.execute(
            "SELECT DISTINCT product_seller_code FROM orders_order "
            "WHERE order_date >= %s AND product_seller_code IS NOT NULL "
            "  AND product_seller_code != ''",
            [CUTOFF_DATE]
        )
        sold = {r[0] for r in c.fetchall()}
    log_msg(f'2025-03-01 이후 판매된 코드: {len(sold):,}개')

    store_targets = defaultdict(list)
    with connections['myproduct'].cursor() as c:
        c.execute(
            "SELECT id, store_id, origin_product_no, seller_management_code "
            "FROM smartstore_product "
            "WHERE seller_management_code LIKE 'W%%' AND status_type = 'SALE'"
        )
        for pid, sid, opn, code in c.fetchall():
            if code in sold:
                continue
            store_targets[sid].append({'id': pid, 'origin_product_no': opn, 'wcode': code})

    store_meta = {}
    with connections['myproduct'].cursor() as c:
        c.execute('SELECT id, store_name, memo, commerce_api_key, commerce_secret_key FROM smartstoreIdList WHERE is_active=1')
        for sid, sname, memo, ak, sk in c.fetchall():
            store_meta[sid] = {'name': sname, 'memo': memo, 'api_key': ak, 'secret_key': sk}

    total_target = sum(len(v) for v in store_targets.values())
    return store_targets, store_meta


def worker(sid, items, store_meta):
    meta = store_meta.get(sid, {})
    sname = meta.get('name', f'#{sid}')
    if not meta.get('api_key') or not meta.get('secret_key'):
        log_msg(f'[{sname}] API 키 없음 — {len(items)}개 건너뜀', 'error')
        with progress_lock:
            progress['errors'] += len(items)
            progress['completed'] += len(items)
        return

    log_msg(f'[{sname}] 시작 — {len(items):,}개')

    token = None
    token_at = 0
    consecutive_fails = 0

    for it in items:
        if stop_flag.is_set():
            log_msg(f'[{sname}] 중단됨')
            return
        try:
            now = time.time()
            if not token or (now - token_at) > 3000:  # 50분마다 갱신
                token = _get_access_token(meta['api_key'], meta['secret_key'])
                token_at = now

            _change_product_status(it['origin_product_no'], token, status='SUSPENSION')
            with connections['myproduct'].cursor() as cur:
                cur.execute(
                    "UPDATE smartstore_product SET status_type='SUSPENSION' WHERE id=%s",
                    [it['id']],
                )
            close_old_connections()
            with progress_lock:
                progress['success'] += 1
                progress['completed'] += 1
            consecutive_fails = 0
        except Exception as e:
            with progress_lock:
                progress['errors'] += 1
                progress['completed'] += 1
            consecutive_fails += 1
            err_str = str(e)[:120]
            # 토큰 만료나 401 이면 재발급
            if '401' in err_str or 'token' in err_str.lower() or 'unauthorized' in err_str.lower():
                token = None
            # 연속 실패시 잠시 대기
            if consecutive_fails >= 5:
                log_msg(f'[{sname}] 연속실패 5회 — 30초 대기 후 재시도 ({it["wcode"]} {err_str})', 'error')
                time.sleep(30)
                token = None
                consecutive_fails = 0

        time.sleep(1)  # rate limit (GET+PUT = 2req)

    log_msg(f'[{sname}] ✓ 완료')


def progress_reporter():
    """30분마다 진행상황 보고 + 텔레그램"""
    PERIOD = 30 * 60
    elapsed_marks = 0
    while not stop_flag.is_set():
        for _ in range(PERIOD):
            if stop_flag.is_set():
                return
            time.sleep(1)
        elapsed_marks += 1
        with progress_lock:
            done = progress['completed']
            ok = progress['success']
            err = progress['errors']
        elapsed_min = (time.time() - started_at) / 60
        rate_per_min = done / max(elapsed_min, 0.01)
        remaining = total_target - done
        eta_min = remaining / max(rate_per_min, 0.01)
        msg = (
            f'⏱️ <b>{elapsed_marks * 30}분 보고</b> · 진행 {done:,}/{total_target:,} '
            f'({done * 100 / max(total_target, 1):.1f}%)\n'
            f'성공 {ok:,} 실패 {err:,} · 속도 {rate_per_min:.1f}/분 · '
            f'ETA {eta_min:.0f}분 ({eta_min / 60:.1f}h)'
        )
        log_msg(msg.replace('<b>', '').replace('</b>', ''))
        tg_send(msg)


def signal_handler(signum, frame):
    log_msg(f'⚠ SIGNAL {signum} — 종료중...', 'error')
    stop_flag.set()


def main():
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    log_msg('━━━ 일괄 판매중지 시작 ━━━', 'info')
    store_targets, store_meta = load_targets()
    if total_target == 0:
        log_msg('대상 0개 — 종료')
        tg_send('일괄 판매중지: 대상 0개')
        return

    biggest = max(len(v) for v in store_targets.values())
    eta_h = biggest * 2 / 3600
    msg_start = (
        f'🚀 <b>스마트스토어 일괄 판매중지 시작</b>\n'
        f'대상: {total_target:,}개 / {len(store_targets)}개 스토어 병렬\n'
        f'가장 큰 스토어: {biggest:,}개\n'
        f'예상 시간(병렬): ~{eta_h:.1f}시간\n'
        f'30분마다 진행보고, 완료 시 알림'
    )
    log_msg(msg_start.replace('<b>', '').replace('</b>', ''))
    tg_send(msg_start)

    reporter = threading.Thread(target=progress_reporter, daemon=True)
    reporter.start()

    try:
        with ThreadPoolExecutor(max_workers=len(store_targets)) as ex:
            futures = {
                ex.submit(worker, sid, items, store_meta): sid
                for sid, items in store_targets.items()
            }
            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    log_msg(f'워커 예외: {e}\n{traceback.format_exc()}', 'error')
    finally:
        stop_flag.set()
        elapsed_min = (time.time() - started_at) / 60
        msg_end = (
            f'✅ <b>일괄 판매중지 완료</b>\n'
            f'경과: {elapsed_min:.0f}분 ({elapsed_min / 60:.1f}h)\n'
            f'성공 {progress["success"]:,} / 실패 {progress["errors"]:,} / 대상 {total_target:,}'
        )
        log_msg(msg_end.replace('<b>', '').replace('</b>', ''), 'success')
        tg_send(msg_end)


if __name__ == '__main__':
    main()
