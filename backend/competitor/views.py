import io
import threading
from datetime import datetime, timedelta

import openpyxl
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from .crawler import crawl_and_save, crawl_all, parse_product_no_from_url, parse_store_alias_from_url
from .models import CompetitorProduct, CompetitorSnapshot
from .serializers import CompetitorProductSerializer, CompetitorSnapshotSerializer

_crawl_lock = threading.Lock()
_crawl_state = {'running': False, 'results': [], 'error': None, 'finished_at': None}


def _run_crawl_all():
    global _crawl_state
    try:
        results = crawl_all()
        with _crawl_lock:
            _crawl_state['results'] = results
    except Exception as e:
        with _crawl_lock:
            _crawl_state['error'] = str(e)
    finally:
        with _crawl_lock:
            _crawl_state['running'] = False
            _crawl_state['finished_at'] = timezone.now().isoformat()


class CompetitorProductListView(APIView):
    def get(self, request):
        products = CompetitorProduct.objects.filter(is_active=True).order_by('-created_at')
        return Response(CompetitorProductSerializer(products, many=True).data)

    def post(self, request):
        url = request.data.get('url', '').strip()
        keyword = request.data.get('track_keyword', '').strip()
        if not url:
            return Response({'error': 'url 필수'}, status=400)
        if not url.startswith('http'):
            return Response({'error': '올바른 URL 형식이 아닙니다'}, status=400)

        product_no = parse_product_no_from_url(url)
        store_alias = parse_store_alias_from_url(url)

        product, created = CompetitorProduct.objects.get_or_create(
            url=url,
            defaults={
                'product_no': product_no,
                'store_alias': store_alias,
                'track_keyword': keyword,
                'is_active': True,
            }
        )
        if not created:
            if not product.is_active:
                product.is_active = True
                product.save(update_fields=['is_active'])
            return Response({'message': '이미 등록된 상품입니다', 'product': CompetitorProductSerializer(product).data})

        return Response(CompetitorProductSerializer(product).data, status=201)


class CompetitorProductDetailView(APIView):
    def delete(self, request, pk):
        try:
            p = CompetitorProduct.objects.get(pk=pk)
            p.is_active = False
            p.save(update_fields=['is_active'])
            return Response({'ok': True})
        except CompetitorProduct.DoesNotExist:
            return Response({'error': '없음'}, status=404)

    def patch(self, request, pk):
        try:
            p = CompetitorProduct.objects.get(pk=pk)
            if 'track_keyword' in request.data:
                p.track_keyword = request.data['track_keyword']
            if 'product_name' in request.data:
                p.product_name = request.data['product_name']
            p.save()
            return Response(CompetitorProductSerializer(p).data)
        except CompetitorProduct.DoesNotExist:
            return Response({'error': '없음'}, status=404)


class CompetitorCrawlView(APIView):
    def post(self, request):
        product_id = request.data.get('product_id')
        if product_id:
            ok, result = crawl_and_save(int(product_id))
            if ok:
                return Response(CompetitorSnapshotSerializer(result).data)
            return Response({'error': result}, status=400)

        with _crawl_lock:
            if _crawl_state['running']:
                return Response({'message': '이미 크롤링 중'}, status=409)
            _crawl_state['running'] = True
            _crawl_state['results'] = []
            _crawl_state['error'] = None

        t = threading.Thread(target=_run_crawl_all, daemon=True)
        t.start()
        return Response({'message': '크롤링 시작'})


class CompetitorCrawlStatusView(APIView):
    def get(self, request):
        with _crawl_lock:
            return Response({
                'running': _crawl_state['running'],
                'results': _crawl_state['results'],
                'error': _crawl_state['error'],
                'finished_at': _crawl_state['finished_at'],
            })


class CompetitorSnapshotView(APIView):
    def get(self, request, pk):
        days = int(request.query_params.get('days', 30))
        since = timezone.now() - timedelta(days=days)
        snaps = CompetitorSnapshot.objects.filter(
            product_id=pk, crawled_at__gte=since
        ).order_by('crawled_at')
        return Response(CompetitorSnapshotSerializer(snaps, many=True).data)


class CompetitorExtStockView(APIView):
    """확장프로그램 → 옵션 재고 + purchaseCount 수신"""
    def post(self, request):
        url = request.data.get('url', '').strip()
        options = request.data.get('options', [])  # [{name, stock}]
        price = request.data.get('price')
        purchase_count = request.data.get('purchaseCount')
        recent_purchase_count = request.data.get('recentPurchaseCount')
        review_count_in = request.data.get('reviewCount')
        product_name_in = request.data.get('productName', '').strip()

        if not url or not isinstance(options, list):
            return Response({'error': '잘못된 데이터'}, status=400)

        import re
        url_clean = re.sub(r'\?.*$', '', url.strip('/'))

        try:
            product = None
            for p in CompetitorProduct.objects.filter(is_active=True):
                p_clean = re.sub(r'\?.*$', '', p.url.strip('/'))
                if p_clean == url_clean or p.url.rstrip('/') == url.rstrip('/'):
                    product = p
                    break

            if not product:
                return Response({'error': '등록되지 않은 상품'}, status=404)

            total_stock = sum(o.get('stock', 0) for o in options) if options else None

            prev = CompetitorSnapshot.objects.filter(product=product).order_by('-crawled_at').first()

            # 추정 판매량: purchaseCount 차이 우선, 없으면 재고 감소량
            estimated_sales = 0
            pc = int(purchase_count) if purchase_count is not None else None
            if prev and prev.purchase_count is not None and pc is not None:
                diff = pc - prev.purchase_count
                if diff > 0:
                    estimated_sales = diff
            elif prev and prev.options and options:
                prev_map = {o['name']: o['stock'] for o in prev.options}
                for opt in options:
                    d = prev_map.get(opt['name'], opt['stock']) - opt['stock']
                    if d > 0:
                        estimated_sales += d

            snap = CompetitorSnapshot.objects.create(
                product=product,
                price=int(price) if price else (prev.price if prev else None),
                review_count=int(review_count_in) if review_count_in is not None else (prev.review_count if prev else None),
                total_stock=total_stock,
                options=options,
                rank_position=prev.rank_position if prev else None,
                purchase_count=pc,
                recent_purchase_count=int(recent_purchase_count) if recent_purchase_count is not None else None,
                estimated_sales=estimated_sales,
                naver_product_id=prev.naver_product_id if prev else '',
            )
            if product_name_in and not product.product_name:
                product.product_name = product_name_in
            product.last_crawled_at = snap.crawled_at
            product.save(update_fields=['product_name', 'last_crawled_at'])

            return Response({'ok': True, 'estimated_sales': estimated_sales, 'total_stock': total_stock, 'purchase_count': pc})

        except Exception as e:
            return Response({'error': str(e)}, status=500)


class CompetitorExportView(APIView):
    def get(self, request):
        product_id = request.query_params.get('product_id')
        days = int(request.query_params.get('days', 30))
        since = timezone.now() - timedelta(days=days)

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = '타사상품분석'

        if product_id:
            products = CompetitorProduct.objects.filter(pk=product_id, is_active=True)
        else:
            products = CompetitorProduct.objects.filter(is_active=True)

        ws.append(['상품명', 'URL', '수집일시', '가격', '리뷰수', '순위', '추정판매량(리뷰증가)'])
        for p in products:
            snaps = CompetitorSnapshot.objects.filter(product=p, crawled_at__gte=since).order_by('crawled_at')
            for s in snaps:
                ws.append([
                    p.product_name,
                    p.url,
                    s.crawled_at.strftime('%Y-%m-%d %H:%M'),
                    s.price or '',
                    s.review_count or '',
                    s.rank_position or '',
                    s.estimated_sales,
                ])

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)

        resp = HttpResponse(buf.read(), content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        resp['Content-Disposition'] = 'attachment; filename="competitor_analysis.xlsx"'
        return resp
