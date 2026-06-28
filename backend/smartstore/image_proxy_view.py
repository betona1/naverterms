"""이미지 프록시 — 외부 CDN 이미지를 same-origin 으로 변환.

용도: html2canvas 가 외부 이미지를 canvas 에 그리려면 CORS 헤더 필요.
화이트리스트 도메인만 허용 (네이버/오너클랜/pstatic 등).
"""
import re
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from django.http import HttpResponse
from rest_framework.views import APIView


ALLOWED_HOST_RE = re.compile(
    r'^([a-z0-9-]+\.)?(ownerclan\.com|pstatic\.net|naver\.com|naver\.net|nstatic\.net|cafe24img\.com|s3\.amazonaws\.com|amazonaws\.com|imgur\.com|cloudfront\.net)$',
    re.IGNORECASE,
)
# LAN 내부 워커/저장서버 (업스케일 결과 등)
ALLOWED_LAN_RE = re.compile(r'^192\.168\.219\.\d+$')


class ImageProxyView(APIView):
    """GET /api/smartstore/image-proxy/?url=<encoded-url>

    응답 헤더:
      - Access-Control-Allow-Origin: * (html2canvas 가 canvas 에 그릴 수 있도록)
      - Cache-Control: public, max-age=3600 (재요청 시 브라우저 캐시 사용)
    """
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        url = request.query_params.get('url', '').strip()
        if not url:
            return HttpResponse('url required', status=400)
        try:
            parsed = urlparse(url)
        except Exception:
            return HttpResponse('invalid url', status=400)
        if parsed.scheme not in ('http', 'https'):
            return HttpResponse('http(s) only', status=400)
        host = parsed.hostname or ''
        if not (ALLOWED_HOST_RE.match(host) or ALLOWED_LAN_RE.match(host)):
            return HttpResponse(f'host not allowed: {host}', status=403)

        req = Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': f'{parsed.scheme}://{parsed.hostname}/',
        })
        try:
            with urlopen(req, timeout=15) as upstream:
                data = upstream.read(20 * 1024 * 1024)  # 20MB 상한
                content_type = upstream.headers.get('Content-Type', 'image/jpeg')
        except Exception as e:
            return HttpResponse(f'upstream error: {e}', status=502)

        resp = HttpResponse(data, content_type=content_type)
        resp['Access-Control-Allow-Origin'] = '*'
        resp['Cache-Control'] = 'public, max-age=3600'
        return resp
