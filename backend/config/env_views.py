import os
import re
from pathlib import Path
from rest_framework.views import APIView
from rest_framework.response import Response

ENV_PATH = Path(__file__).resolve().parent.parent.parent / '.env'

API_KEY_FIELDS = [
    'NAVER_CLIENT_ID',
    'NAVER_CLIENT_SECRET',
    'NAVER_AD_API_KEY',
    'NAVER_AD_SECRET_KEY',
    'NAVER_AD_CUSTOMER_ID',
]


def read_env_values():
    result = {k: '' for k in API_KEY_FIELDS}
    if not ENV_PATH.exists():
        return result
    for line in ENV_PATH.read_text().splitlines():
        for key in API_KEY_FIELDS:
            if line.startswith(f'{key}='):
                result[key] = line[len(key) + 1:].strip()
    return result


def write_env_key(key, value):
    content = ENV_PATH.read_text() if ENV_PATH.exists() else ''
    pattern = re.compile(rf'^{re.escape(key)}=.*$', re.MULTILINE)
    new_line = f'{key}={value}'
    if pattern.search(content):
        content = pattern.sub(new_line, content)
    else:
        content = content.rstrip('\n') + f'\n{new_line}\n'
    ENV_PATH.write_text(content)


class ApiKeyView(APIView):
    def get(self, request):
        return Response(read_env_values())

    def post(self, request):
        data = request.data
        for key in API_KEY_FIELDS:
            if key in data:
                write_env_key(key, str(data[key]).strip())
        return Response({'ok': True, 'values': read_env_values()})
