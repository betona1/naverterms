"""bulk_suspend_v2: 사후 GET 검증 + 상세 jsonl 로그 + 30분 보고
- 매 건 PUT(SUSPENSION) 후 즉시 GET → SUSPENSION 확인된 것만 verified 카운트
- 모든 처리 결과(시각/스토어/W코드/originNo/PUT결과/사후상태/DB업데이트/오류)를 jsonl로 기록
- 30분마다 progress 로그 + 텔레그램 보고
"""
import os, sys, time, threading, signal, json, traceback
sys.path.insert(0, '/home/joacham/projects/naverterms/backend')
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
import django; django.setup()

from datetime import datetime
from collections import defaultdict
from django.db import connections, close_old_connections
from concurrent.futures import ThreadPoolExecutor, as_completed
from django.conf import settings
from smartstore.smartstore_product_service import _get_access_token, _change_product_status
import requests

CUTOFF = '2025-03-01'
LOG_DIR = '/home/joacham/projects/naverterms/backend/logs'
RUN_TS = datetime.now().strftime('%Y%m%d_%H%M%S')
DETAIL_LOG = f'{LOG_DIR}/bulk_suspend_v2_{RUN_TS}.jsonl'
PROGRESS_LOG = f'{LOG_DIR}/bulk_suspend_v2_{RUN_TS}.progress.log'
TG_TOKEN = settings.TELEGRAM_BOT_TOKEN
TG_CHAT = settings.TELEGRAM_CHAT_ID

started_at = time.time()
counts = {'attempted': 0, 'verified': 0, 'reverted': 0, 'other': 0,
          'put_error': 0, 'completed': 0}
counts_lock = threading.Lock()
stop_flag = threading.Event()
total_target = 0

os.makedirs(LOG_DIR, exist_ok=True)
detail_lock = threading.Lock()


def write_detail(rec):
    with detail_lock, open(DETAIL_LOG, 'a') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def log_progress(msg):
    line = f'[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}'
    print(line, flush=True)
    try:
        with open(PROGRESS_LOG, 'a') as f:
            f.write(line + '\n')
    except Exception:
        pass


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


def load_targets():
    global total_target
    with connections['joacham'].cursor() as c:
        c.execute(
            "SELECT DISTINCT product_seller_code FROM orders_order "
            "WHERE order_date >= %s AND product_seller_code LIKE 'W%%'", [CUTOFF])
        sold = {r[0] for r in c.fetchall()}
    log_progress(f'2025-03-01 이후 판매 W코드(보존): {len(sold):,}개')

    store_targets = defaultdict(list)
    with connections['myproduct'].cursor() as c:
        c.execute(
            "SELECT id, store_id, origin_product_no, seller_management_code "
            "FROM smartstore_product "
            "WHERE seller_management_code LIKE 'W%%' AND status_type='SALE'")
        for pid, sid, opn, code in c.fetchall():
            if code in sold:
                continue
            store_targets[sid].append({'id': pid, 'opn': opn, 'wcode': code})

    store_meta = {}
    with connections['myproduct'].cursor() as c:
        c.execute(
            'SELECT id, store_name, commerce_api_key, commerce_secret_key '
            'FROM smartstoreIdList WHERE is_active=1')
        for sid, sname, ak, sk in c.fetchall():
            store_meta[sid] = {'name': sname, 'api_key': ak, 'secret_key': sk}

    total_target = sum(len(v) for v in store_targets.values())
    return store_targets, store_meta


def worker(sid, items, store_meta):
    meta = store_meta.get(sid, {})
    sname = meta.get('name', f'#{sid}')
    if not meta.get('api_key') or not meta.get('secret_key'):
        log_progress(f'[{sname}] API 키 없음 — {len(items)}개 건너뜀')
        with counts_lock:
            counts['put_error'] += len(items)
            counts['completed'] += len(items)
        return

    log_progress(f'[{sname}] 시작 — {len(items):,}개')
    token = None
    token_at = 0
    consecutive_fails = 0

    for it in items:
        if stop_flag.is_set():
            log_progress(f'[{sname}] 중단됨')
            return
        rec = {
            'time': datetime.now().isoformat(timespec='seconds'),
            'store': sname, 'wcode': it['wcode'], 'opn': it['opn'],
            'put': None, 'after': None, 'db_updated': False, 'error': None,
        }
        try:
            now = time.time()
            if not token or (now - token_at) > 3000:
                token = _get_access_token(meta['api_key'], meta['secret_key'])
                token_at = now

            _change_product_status(it['opn'], token, status='SUSPENSION')
            rec['put'] = 'OK'
            time.sleep(0.3)

            url = f"https://api.commerce.naver.com/external/v2/products/origin-products/{it['opn']}"
            H = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
            after = requests.get(url, headers=H, timeout=10).json()['originProduct'].get('statusType')
            rec['after'] = after

            try:
                with connections['myproduct'].cursor() as c:
                    c.execute(
                        "UPDATE smartstore_product SET status_type=%s WHERE id=%s",
                        [after, it['id']])
                close_old_connections()
                rec['db_updated'] = True
            except Exception as e:
                rec['error'] = f'db: {str(e)[:80]}'

            with counts_lock:
                if after == 'SUSPENSION':
                    counts['verified'] += 1
                elif after == 'SALE':
                    counts['reverted'] += 1
                else:
                    counts['other'] += 1
                counts['attempted'] += 1
                counts['completed'] += 1
            consecutive_fails = 0
        except Exception as e:
            err_str = str(e)[:120]
            rec['error'] = err_str
            with counts_lock:
                counts['put_error'] += 1
                counts['completed'] += 1
            consecutive_fails += 1
            if '401' in err_str or 'token' in err_str.lower() or 'unauthorized' in err_str.lower():
                token = None
            if consecutive_fails >= 5:
                log_progress(
                    f'[{sname}] 연속실패 5회 — 30초 대기 ({it["wcode"]} {err_str})')
                time.sleep(30)
                token = None
                consecutive_fails = 0
        write_detail(rec)
        time.sleep(0.7)

    log_progress(f'[{sname}] ✓ 완료')


def reporter():
    PERIOD = 30 * 60
    marks = 0
    while not stop_flag.is_set():
        for _ in range(PERIOD):
            if stop_flag.is_set():
                return
            time.sleep(1)
        marks += 1
        with counts_lock:
            done = counts['completed']
            ok = counts['verified']
            rev = counts['reverted']
            oth = counts['other']
            err = counts['put_error']
        elapsed_min = (time.time() - started_at) / 60
        rate = done / max(elapsed_min, 0.01)
        rem = total_target - done
        eta = rem / max(rate, 0.01)
        msg = (
            f'⏱️ <b>{marks * 30}분 보고</b> · 진행 {done:,}/{total_target:,} '
            f'({done * 100 / max(total_target, 1):.1f}%)\n'
            f'검증OK {ok:,} · 복원 {rev:,} · 기타 {oth:,} · 오류 {err:,}\n'
            f'속도 {rate:.1f}/분 · ETA {eta:.0f}분 ({eta / 60:.1f}h)'
        )
        log_progress(msg.replace('<b>', '').replace('</b>', ''))
        tg_send(msg)


def signal_handler(signum, frame):
    log_progress(f'⚠ SIGNAL {signum}')
    stop_flag.set()


def main():
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    log_progress(f'━━━ bulk_suspend_v2 시작 ━━━')
    log_progress(f'상세로그: {DETAIL_LOG}')
    log_progress(f'진행로그: {PROGRESS_LOG}')

    store_targets, store_meta = load_targets()
    if total_target == 0:
        log_progress('대상 0개 — 종료')
        tg_send('bulk_suspend_v2: 대상 0개')
        return

    biggest = max(len(v) for v in store_targets.values())
    eta_h = biggest * 1.0 / 3600  # 1초/건 + GET 추가
    msg_start = (
        f'🚀 <b>bulk_suspend_v2 시작</b>\n'
        f'대상 {total_target:,}개 / {len(store_targets)}스토어 병렬\n'
        f'가장 큰 스토어 {biggest:,}개 / 예상 ~{eta_h:.1f}h\n'
        f'사후 GET 검증 + 상세 jsonl 로그\n'
        f'cron 차단 상태에서 진행'
    )
    log_progress(msg_start.replace('<b>', '').replace('</b>', ''))
    tg_send(msg_start)

    rep = threading.Thread(target=reporter, daemon=True)
    rep.start()

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
                    log_progress(f'워커 예외: {e}\n{traceback.format_exc()}')
    finally:
        stop_flag.set()
        elapsed_min = (time.time() - started_at) / 60
        msg_end = (
            f'✅ <b>bulk_suspend_v2 완료</b>\n'
            f'경과 {elapsed_min:.0f}분 ({elapsed_min / 60:.1f}h)\n'
            f'검증OK {counts["verified"]:,} · 복원 {counts["reverted"]:,} · '
            f'기타 {counts["other"]:,} · 오류 {counts["put_error"]:,}\n'
            f'대상 {total_target:,}'
        )
        log_progress(msg_end.replace('<b>', '').replace('</b>', ''))
        tg_send(msg_end)


if __name__ == '__main__':
    main()
