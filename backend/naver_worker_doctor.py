#!/usr/bin/env python3
"""워커 자동 복구 데몬 (닥터 매니저).

5분마다 11개 워커 endpoint health check.
- HTTP fail → ICMP ping
- ICMP fail (박스 꺼짐) → WoL magic packet
- ICMP OK but ollama down → SSH systemctl restart ollama (best-effort)
- 회복/실패 모두 텔레그램 알림

PM2 autorestart=true 로 계속 도는 데몬.
"""
import os
import sys
import time
import json
import subprocess
import urllib.request

import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.conf import settings  # noqa: E402

sys.path.insert(0, '/home/joacham/projects/WOL')
import wol  # noqa: E402

TG_TOKEN = getattr(settings, 'TELEGRAM_BOT_TOKEN', None)
TG_CHAT = getattr(settings, 'TELEGRAM_CHAT_ID', None)

CHECK_INTERVAL = int(os.environ.get('DOCTOR_INTERVAL', '300'))  # 5분
HTTP_TIMEOUT = 4
PING_TIMEOUT = 2
WOL_WAIT = 90  # WoL 후 부팅 대기

# (이름, 호스트, ollama 포트, WoL 대상 IP, SSH 계정) — wol_ip None=WoL 안함, ssh_user None=SSH 안함
WORKERS = [
    ('80',     '192.168.219.80',   11434, '192.168.219.80',  'joacham'),
    # 88 = 본인 서버 localhost:11438 (RTX 3080 1장). 88-0/1/2 SSH 터널 제거됨 (2026-05-25).
    ('88',     'localhost',        11438, None,              None),
    ('108',    '192.168.219.108',  11434, '192.168.219.108', 'joacham'),
    ('111',    '192.168.219.111',  11434, '192.168.219.111', 'joacham'),
    # 140 은 Windows user 계정 (2026-05-25 SSH 신설 — setup130.bat 으로 키 등록)
    ('140',    '192.168.219.140',  11434, '192.168.219.140', 'user'),
    # 130 = bitcom (Windows, RTX 3080 10G) — 2026-05-25 신규 합류
    ('130',    '192.168.219.130',  11434, '192.168.219.130', 'user'),
    ('136',    '192.168.219.136',  11434, '192.168.219.136', 'joacham'),
    ('92',     '192.168.219.92',   11434, '192.168.219.92',  'joacham'),
    ('home',   '119.67.47.184',    11434, None,              None),  # 외부 — WoL 불가
]

# 마지막 상태 — alert 중복 방지
_LAST_STATE: dict = {}


def tg(msg: str) -> None:
    if not TG_TOKEN or not TG_CHAT:
        return
    try:
        urllib.request.urlopen(urllib.request.Request(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            data=json.dumps({'chat_id': TG_CHAT, 'text': msg, 'parse_mode': 'HTML'}).encode(),
            headers={'Content-Type': 'application/json'},
        ), timeout=10).read()
    except Exception as e:
        print(f'TG 실패: {e}', file=sys.stderr, flush=True)


def http_alive(host: str, port: int) -> bool:
    try:
        urllib.request.urlopen(f'http://{host}:{port}/api/tags', timeout=HTTP_TIMEOUT).read()
        return True
    except Exception:
        return False


def icmp_alive(host: str) -> bool:
    try:
        r = subprocess.run(['ping', '-c', '1', '-W', str(PING_TIMEOUT), host],
                           capture_output=True, timeout=PING_TIMEOUT + 2)
        return r.returncode == 0
    except Exception:
        return False


def find_mac(ip: str) -> str | None:
    """wol 등록부에서 MAC 조회 — hosts 는 {key: {ip, mac, wol_ui, ...}} dict"""
    try:
        reg = wol.load_registry()
        hosts = reg.get('hosts', {})
        for h in hosts.values():
            if not isinstance(h, dict):
                continue
            if str(h.get('ip')) == ip and h.get('mac') and h.get('wol_ui'):
                return h['mac']
    except Exception:
        pass
    return None


def wol_send(ip: str) -> bool:
    mac = find_mac(ip)
    if not mac:
        return False
    try:
        wol.wake(mac)
        return True
    except Exception as e:
        print(f'WoL 실패 {ip}: {e}', file=sys.stderr, flush=True)
        return False


def ssh_restart_ollama(host: str, ssh_user: str | None) -> bool:
    """SSH 로 ollama 프로세스 재시작 시도 (실패해도 무시). ssh_user None 이면 스킵."""
    if not ssh_user:
        return False
    # Windows(user) 와 Linux(joacham) 둘 다 동작하는 명령:
    #   POSIX shell: pkill + nohup
    #   PowerShell : Get-Process | Stop-Process + Start-Process
    is_windows = ssh_user == 'user'
    if is_windows:
        cmd_str = ('powershell -NoProfile -Command "Get-Process ollama -EA SilentlyContinue | Stop-Process -Force; '
                   'Start-Sleep 2; Start-Process ollama -ArgumentList serve -WindowStyle Hidden"')
    else:
        cmd_str = 'pkill -f "ollama serve" 2>/dev/null; nohup ollama serve >/dev/null 2>&1 &'
    try:
        r = subprocess.run(
            ['ssh', '-o', 'ConnectTimeout=4', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
             f'{ssh_user}@{host}', cmd_str],
            capture_output=True, timeout=10)
        return r.returncode == 0
    except Exception:
        return False


def check_worker(name: str, host: str, port: int, wol_ip: str | None, ssh_user: str | None) -> dict:
    """워커 점검 + 자동 복구. 반환: {state, action, recovered}"""
    if http_alive(host, port):
        return {'state': 'ok', 'action': None, 'recovered': False}

    print(f'[{time.strftime("%H:%M:%S")}] [{name}] HTTP fail — 진단 시작', flush=True)

    # ICMP 체크
    host_alive = icmp_alive(host)

    if host_alive:
        # 박스는 켜져있고 ollama 만 죽음
        print(f'[{name}] ICMP OK — ollama 만 죽음. SSH 재시작 시도 (user={ssh_user})', flush=True)
        ssh_ok = ssh_restart_ollama(host, ssh_user)
        time.sleep(15)
        if http_alive(host, port):
            return {'state': 'ok', 'action': 'ssh_restart', 'recovered': True}
        return {'state': 'http_dead', 'action': 'ssh_restart_failed' if ssh_ok else 'ssh_unavailable', 'recovered': False}

    # 박스가 꺼져있음 → WoL
    if wol_ip is None:
        print(f'[{name}] ICMP fail · WoL 대상 아님 (외부/로컬)', flush=True)
        return {'state': 'host_dead', 'action': 'no_wol_target', 'recovered': False}

    mac = find_mac(wol_ip)
    if not mac:
        return {'state': 'host_dead', 'action': 'no_mac', 'recovered': False}

    print(f'[{name}] ICMP fail — WoL 송신 (MAC {mac})', flush=True)
    wol_send(wol_ip)
    print(f'[{name}] WoL 후 {WOL_WAIT}초 대기', flush=True)
    time.sleep(WOL_WAIT)

    if http_alive(host, port):
        return {'state': 'ok', 'action': 'wol', 'recovered': True}
    if icmp_alive(host):
        # 부팅됐지만 ollama 아직 안 떠있음 — SSH 시도
        ssh_restart_ollama(host, ssh_user)
        time.sleep(15)
        if http_alive(host, port):
            return {'state': 'ok', 'action': 'wol+ssh', 'recovered': True}
    return {'state': 'host_dead', 'action': 'wol_failed', 'recovered': False}


def alert_state_change(name: str, prev: dict | None, curr: dict) -> None:
    """상태 변화 시에만 텔레그램 알림"""
    cs = curr['state']
    ps = (prev or {}).get('state')
    if cs == 'ok' and ps and ps != 'ok':
        tg(f'✅ <b>워커 {name}</b> 회복됨 (action: {curr.get("action") or "-"})')
    elif cs != 'ok' and ps != cs:
        tg(f'❌ <b>워커 {name}</b> 다운 ({cs}) — action: {curr.get("action") or "-"}')


def tick():
    print(f'[{time.strftime("%H:%M:%S")}] === Doctor tick ===', flush=True)
    for name, host, port, wol_ip, ssh_user in WORKERS:
        curr = check_worker(name, host, port, wol_ip, ssh_user)
        prev = _LAST_STATE.get(name)
        alert_state_change(name, prev, curr)
        _LAST_STATE[name] = curr
        if curr['state'] != 'ok':
            print(f'  [{name}] {curr["state"]} (action={curr.get("action")})', flush=True)


if __name__ == '__main__':
    print(f'Doctor 시작 — {len(WORKERS)} 워커 점검 (interval {CHECK_INTERVAL}s)', flush=True)
    while True:
        try:
            tick()
        except Exception as e:
            print(f'tick 실패: {e}', file=sys.stderr, flush=True)
        time.sleep(CHECK_INTERVAL)
