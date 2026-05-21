"""원격 전원 관리 API — /home/joacham/projects/WOL/wol.py 공통 모듈 사용.
11번가 프로젝트의 eleven/power_views.py 와 동일한 동작.
"""
import sys
from pathlib import Path

from rest_framework.views import APIView
from rest_framework.response import Response

_WOL_DIR = Path('/home/joacham/projects/WOL')
if str(_WOL_DIR) not in sys.path:
    sys.path.insert(0, str(_WOL_DIR))

import wol  # noqa: E402


def _public_registry() -> dict:
    reg = wol.load_registry()
    groups = reg['groups']
    hosts = reg['hosts']
    out_groups = []
    for gkey, g in groups.items():
        members = []
        for hkey in g['hosts']:
            h = hosts.get(hkey)
            if not h:
                continue
            if not (h.get('wol_ui') or h.get('shutdown_ui')):
                continue
            members.append({
                'key': hkey,
                'name': h['name'],
                'ip': h['ip'],
                'os': h.get('os'),
                'has_mac': bool(h.get('mac')),
                'wol_enabled': h.get('wol_ui', False) and bool(h.get('mac')),
                'shutdown_enabled': h.get('shutdown_ui', False) and h.get('os') == 'linux',
                'note': h.get('note', ''),
            })
        if members:
            out_groups.append({
                'key': gkey, 'label': g['label'], 'icon': g.get('icon', ''),
                'hosts': members,
            })
    return {'groups': out_groups}


class PowerWorkersView(APIView):
    authentication_classes = []
    permission_classes = []
    def get(self, request):
        return Response({'ok': True, **_public_registry()})


class PowerStatusView(APIView):
    authentication_classes = []
    permission_classes = []
    def get(self, request):
        rows = wol.status_all()
        rows = [r for r in rows if r.get('wol_ui') or r.get('shutdown_ui')]
        return Response({'ok': True, 'hosts': rows})


class PowerWakeView(APIView):
    authentication_classes = []
    permission_classes = []
    def post(self, request):
        key = (request.data.get('key') or '').strip()
        if not key:
            return Response({'ok': False, 'error': 'key required'}, status=400)
        reg = wol.load_registry()
        h = reg['hosts'].get(key)
        if not h:
            return Response({'ok': False, 'error': f'unknown host: {key}'}, status=404)
        mac = h.get('mac')
        if not mac:
            return Response({'ok': False, 'error': f'{key} MAC 미등록'}, status=400)
        if not h.get('wol_ui'):
            return Response({'ok': False, 'error': f'{key} WOL UI 비활성'}, status=403)
        try:
            r = wol.wake(mac)
        except Exception as e:
            return Response({'ok': False, 'error': str(e)[:300]}, status=500)
        return Response({'ok': True, 'key': key, 'name': h['name'], **r})


class PowerShutdownView(APIView):
    authentication_classes = []
    permission_classes = []
    def post(self, request):
        import os
        key = (request.data.get('key') or '').strip()
        if not key:
            return Response({'ok': False, 'error': 'key required'}, status=400)
        reg = wol.load_registry()
        h = reg['hosts'].get(key)
        if not h:
            return Response({'ok': False, 'error': f'unknown host: {key}'}, status=404)
        if h.get('os') != 'linux':
            return Response({'ok': False, 'error': '리눅스 호스트만 지원'}, status=400)
        if not h.get('shutdown_ui'):
            return Response({'ok': False, 'error': f'{key} shutdown UI 비활성'}, status=403)
        token = os.environ.get('WOL_AGENT_TOKEN') or None
        r = wol.shutdown_via_agent(h['ip'], token=token)
        status = 200 if r.get('ok') else 502
        return Response({'key': key, 'name': h['name'], **r}, status=status)
