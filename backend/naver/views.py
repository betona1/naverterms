from datetime import timedelta
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
    NaverRankTarget, NaverRankHistory, NaverTrackingSchedule,
)
from .serializers import (
    NaverKeywordSerializer, NaverTermAnalysisSerializer,
    NaverRankTargetSerializer, NaverRankHistorySerializer,
    NaverTrackingScheduleSerializer,
)
from . import services
from . import uc_crawler


# ──── 키워드 ────

class KeywordListView(APIView):
    def get(self, request):
        keywords = NaverKeyword.objects.all().order_by('-created_at')
        return Response(NaverKeywordSerializer(keywords, many=True).data)

    def post(self, request):
        keyword_text = request.data.get('keyword', '').strip()
        if not keyword_text:
            return Response({'error': '키워드를 입력하세요'}, status=400)
        kw, created = NaverKeyword.objects.get_or_create(keyword=keyword_text)
        return Response(NaverKeywordSerializer(kw).data, status=201 if created else 200)


class KeywordDetailView(APIView):
    def delete(self, request, pk):
        try:
            NaverKeyword.objects.get(id=pk).delete()
            return Response(status=204)
        except NaverKeyword.DoesNotExist:
            return Response({'error': 'not found'}, status=404)


# ──── 확장프로그램 → 검색결과 저장 ────

class ExtSearchResultView(APIView):
    def post(self, request):
        keyword_text = request.data.get('keyword', '').strip()
        tab_type = request.data.get('tab_type', 'total')
        products = request.data.get('products', [])
        total = request.data.get('total', 0)
        terms = request.data.get('terms', [])
        term_count = request.data.get('term_count', 0)

        kw, _ = NaverKeyword.objects.get_or_create(keyword=keyword_text)
        kw.last_searched_at = timezone.now()

        if terms:
            kw.terms = terms
            kw.term_count = term_count or len(terms)

        if tab_type == 'total':
            kw.total_count = total
        elif tab_type == 'checkout':
            kw.naverpay_count = total
        elif tab_type == 'model':
            kw.price_compare_count = total
        kw.save()

        NaverSearchSnapshot.objects.create(
            keyword=kw,
            tab_type=tab_type,
            products=products,
            total=total,
        )

        return Response({'status': 'ok', 'keyword_id': kw.id})


class ExtCaptchaStatusView(APIView):
    def post(self, request):
        captcha_type = request.data.get('type', 'unknown')
        resolved = request.data.get('resolved', False)
        return Response({'status': 'ok', 'type': captcha_type, 'resolved': resolved})


# ──── 가중치 분석 ────

class AnalysisView(APIView):
    def get(self, request, keyword_id):
        analyses = NaverTermAnalysis.objects.filter(keyword_id=keyword_id).order_by('-analyzed_at')
        return Response(NaverTermAnalysisSerializer(analyses, many=True).data)

    def post(self, request, keyword_id):
        analysis = services.run_full_analysis(keyword_id)
        if not analysis:
            return Response({'error': '분석할 데이터가 없습니다'}, status=400)
        return Response(NaverTermAnalysisSerializer(analysis).data)


# ──── 상품 데이터 조회 ────

class ProductsView(APIView):
    def get(self, request, keyword_id):
        tab = request.query_params.get('tab', 'total')
        snapshot = NaverSearchSnapshot.objects.filter(
            keyword_id=keyword_id, tab_type=tab
        ).order_by('-collected_at').first()
        if not snapshot:
            return Response({'products': [], 'total': 0})
        return Response({'products': snapshot.products, 'total': snapshot.total, 'collected_at': snapshot.collected_at})


# ──── 태그 통계 ────

class TagStatsView(APIView):
    def get(self, request, keyword_id):
        stats = services.get_tag_statistics(keyword_id)
        return Response(stats)


# ──── 순위추적 대상 ────

class RankTargetListView(APIView):
    def get(self, request):
        targets = NaverRankTarget.objects.filter(is_active=True).select_related('keyword')
        return Response(NaverRankTargetSerializer(targets, many=True).data)

    def post(self, request):
        keyword_text = request.data.get('keyword', '').strip()
        target_type = request.data.get('target_type', 'store')
        target_value = request.data.get('target_value', '').strip()
        display_name = request.data.get('display_name', '').strip()

        if not keyword_text or not target_value:
            return Response({'error': '키워드와 대상을 입력하세요'}, status=400)

        kw, _ = NaverKeyword.objects.get_or_create(keyword=keyword_text)
        target, created = NaverRankTarget.objects.get_or_create(
            keyword=kw, target_type=target_type, target_value=target_value,
            defaults={'display_name': display_name or target_value}
        )
        return Response(NaverRankTargetSerializer(target).data, status=201 if created else 200)


class RankTargetDetailView(APIView):
    def delete(self, request, pk):
        try:
            NaverRankTarget.objects.get(id=pk).delete()
            return Response(status=204)
        except NaverRankTarget.DoesNotExist:
            return Response({'error': 'not found'}, status=404)


# ──── 확장프로그램 → 순위결과 저장 ────

class ExtRankResultView(APIView):
    def post(self, request):
        target_id = request.data.get('target_id')
        rank_position = request.data.get('rank_position')  # None = 미발견
        tab_type = request.data.get('tab_type', 'total')
        total_results = request.data.get('total_results', 0)
        found_product_name = request.data.get('found_product_name', '')
        found_product_price = request.data.get('found_product_price')
        found_review_count = request.data.get('found_review_count')

        try:
            target = NaverRankTarget.objects.get(id=target_id)
        except NaverRankTarget.DoesNotExist:
            return Response({'error': 'target not found'}, status=404)

        history = NaverRankHistory.objects.create(
            target=target,
            rank_position=rank_position,
            tab_type=tab_type,
            total_results=total_results,
            found_product_name=found_product_name,
            found_product_price=found_product_price,
            found_review_count=found_review_count,
        )
        return Response(NaverRankHistorySerializer(history).data, status=201)


# ──── 순위 이력 ────

class RankHistoryView(APIView):
    def get(self, request):
        target_id = request.query_params.get('target_id')
        days = int(request.query_params.get('days', 30))
        since = timezone.now() - timedelta(days=days)

        qs = NaverRankHistory.objects.filter(tracked_at__gte=since)
        if target_id:
            qs = qs.filter(target_id=target_id)
        qs = qs.order_by('-tracked_at')
        return Response(NaverRankHistorySerializer(qs, many=True).data)


class RankSummaryView(APIView):
    def get(self, request):
        targets = NaverRankTarget.objects.filter(is_active=True).select_related('keyword')
        results = []
        for target in targets:
            records = list(target.history.order_by('-tracked_at')[:2])
            current = records[0].rank_position if records else None
            previous = records[1].rank_position if len(records) > 1 else None
            change = (previous - current) if (current and previous) else None
            results.append({
                'id': target.id,
                'keyword': target.keyword.keyword,
                'target_type': target.target_type,
                'target_value': target.target_value,
                'display_name': target.display_name,
                'current_rank': current,
                'previous_rank': previous,
                'change': change,
                'tracked_at': records[0].tracked_at.isoformat() if records else None,
            })
        return Response(results)


# ──── 스케줄 ────

class ScheduleListView(APIView):
    def get(self, request):
        schedules = NaverTrackingSchedule.objects.all().order_by('-created_at')
        return Response(NaverTrackingScheduleSerializer(schedules, many=True).data)

    def post(self, request):
        serializer = NaverTrackingScheduleSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)


class ScheduleDetailView(APIView):
    def put(self, request, pk):
        try:
            schedule = NaverTrackingSchedule.objects.get(id=pk)
        except NaverTrackingSchedule.DoesNotExist:
            return Response({'error': 'not found'}, status=404)
        serializer = NaverTrackingScheduleSerializer(schedule, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)

    def delete(self, request, pk):
        try:
            NaverTrackingSchedule.objects.get(id=pk).delete()
            return Response(status=204)
        except NaverTrackingSchedule.DoesNotExist:
            return Response({'error': 'not found'}, status=404)


# ──── 데이터 초기화 ────

class DataResetView(APIView):
    """키워드는 유지하고 스냅샷/분석/순위 데이터만 삭제"""
    def post(self, request):
        snap_cnt = NaverSearchSnapshot.objects.count()
        anal_cnt = NaverTermAnalysis.objects.count()
        rank_cnt = NaverRankHistory.objects.count()

        NaverSearchSnapshot.objects.all().delete()
        NaverTermAnalysis.objects.all().delete()
        NaverRankHistory.objects.all().delete()

        # 키워드 카운트 초기화
        NaverKeyword.objects.all().update(
            total_count=0, naverpay_count=0, price_compare_count=0,
            term_count=0, terms=[], last_searched_at=None,
        )

        return Response({
            'status': 'ok',
            'deleted': {
                'snapshots': snap_cnt,
                'analyses': anal_cnt,
                'rank_history': rank_cnt,
            }
        })


# ──── 엑셀 다운로드 ────

class ExportTermsView(APIView):
    def get(self, request):
        import openpyxl
        from django.http import HttpResponse

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'Term 분석'
        headers = ['키워드', '1term', '2term', '3term', '4term',
                    '순서고정가중치', '위치가중치', '상품명가중치',
                    '파트가중치', '카테고리우선여부', '총검색수', '상품수']
        ws.append(headers)

        keywords = NaverKeyword.objects.all()
        for kw in keywords:
            analysis = NaverTermAnalysis.objects.filter(keyword=kw).order_by('-analyzed_at').first()
            snapshot = NaverSearchSnapshot.objects.filter(keyword=kw, tab_type='total').order_by('-collected_at').first()

            row = [kw.keyword]
            terms = kw.terms or []
            for i in range(4):
                row.append(terms[i] if i < len(terms) else '')

            if analysis:
                row.append(str(analysis.order_weight))
                row.append(str(analysis.position_weight))
                row.append(str(analysis.name_weight))
                row.append(str(analysis.part_weight))
                row.append(str(analysis.category_priority))
            else:
                row.extend([''] * 5)

            row.append(kw.total_count)
            row.append(len(snapshot.products) if snapshot else 0)
            ws.append(row)

        response = HttpResponse(content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        response['Content-Disposition'] = 'attachment; filename="naver_terms.xlsx"'
        wb.save(response)
        return response


class ExportRankView(APIView):
    def get(self, request):
        import openpyxl
        from django.http import HttpResponse

        days = int(request.query_params.get('days', 30))
        since = timezone.now() - timedelta(days=days)

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = '순위 이력'
        headers = ['날짜시간', '키워드', '대상', '순위', '탭', '상품명', '가격', '리뷰수']
        ws.append(headers)

        records = NaverRankHistory.objects.filter(
            tracked_at__gte=since
        ).select_related('target__keyword').order_by('-tracked_at')

        for r in records:
            ws.append([
                r.tracked_at.strftime('%Y-%m-%d %H:%M'),
                r.target.keyword.keyword,
                r.target.display_name or r.target.target_value,
                r.rank_position,
                r.tab_type,
                r.found_product_name,
                r.found_product_price,
                r.found_review_count,
            ])

        response = HttpResponse(content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        response['Content-Disposition'] = 'attachment; filename="naver_rank.xlsx"'
        wb.save(response)
        return response


# ──── UC 크롤러 ────

class UCStartView(APIView):
    def post(self, request):
        keywords = request.data.get('keywords', [])
        if not keywords:
            return Response({'error': '키워드를 입력하세요'}, status=400)
        headless = request.data.get('headless', False)
        ok, msg = uc_crawler.start(keywords, headless=headless)
        if not ok:
            return Response({'ok': False, 'message': msg}, status=409)
        return Response({'ok': True, 'message': msg, 'count': len(keywords)})


class UCStatusView(APIView):
    def get(self, request):
        since = int(request.query_params.get('logSince', 0))
        st = uc_crawler.get_status()
        if since > 0:
            st['logs'] = [l for i, l in enumerate(st['logs']) if i >= since]
        return Response(st)


class UCStopView(APIView):
    def post(self, request):
        uc_crawler.stop()
        return Response({'ok': True})
