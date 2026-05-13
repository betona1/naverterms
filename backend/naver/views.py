from datetime import timedelta
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
import re
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
    NaverRankTarget, NaverRankHistory, NaverTrackingSchedule,
    KeywordEnrichCache, NaverTrackingProduct,
    ItemScoutProduct, ItemScoutRecord,
)
from .serializers import (
    NaverKeywordSerializer, NaverTermAnalysisSerializer,
    NaverRankTargetSerializer, NaverRankHistorySerializer,
    NaverTrackingScheduleSerializer, NaverTrackingProductSerializer,
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
        product_id = request.data.get('product_id')
        # product_id 있으면 product 기준, 없으면 기존 방식
        if product_id:
            try:
                product = NaverTrackingProduct.objects.get(id=product_id)
            except NaverTrackingProduct.DoesNotExist:
                return Response({'error': '상품을 찾을 수 없습니다'}, status=404)
            target_type = product.target_type
            target_value = product.target_value
            display_name = product.display_name
        else:
            target_type = request.data.get('target_type', 'store')
            target_value = request.data.get('target_value', '').strip()
            display_name = request.data.get('display_name', '').strip()
            product = None

        source_product_id = request.data.get('source_product_id')
        source_product_name = request.data.get('source_product_name', '').strip()

        if not keyword_text or not target_value:
            return Response({'error': '키워드와 대상을 입력하세요'}, status=400)

        kw, _ = NaverKeyword.objects.get_or_create(keyword=keyword_text)
        defaults = {'display_name': display_name or target_value}
        if source_product_id is not None:
            defaults['source_product_id'] = source_product_id
        if source_product_name:
            defaults['source_product_name'] = source_product_name
        if product:
            defaults['product'] = product

        target, created = NaverRankTarget.objects.get_or_create(
            keyword=kw, target_type=target_type, target_value=target_value,
            defaults=defaults,
        )
        if not created and product and target.product is None:
            target.product = product
            target.save(update_fields=['product'])
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


# ──── 순위추적 실행 (네이버 API) ────

class RunRankTrackingView(APIView):
    def post(self, request):
        target_ids = request.data.get('target_ids')  # None = 전체
        try:
            result = services.run_rank_tracking(target_ids)
            return Response(result)
        except ValueError as e:
            return Response({'error': str(e)}, status=400)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


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


def _parse_target_url(url: str) -> dict:
    url = url.strip()
    ss = re.search(r'smartstore\.naver\.com/([^/?&#]+)', url)
    if ss:
        return {'target_type': 'store', 'target_value': ss.group(1)}
    sp = re.search(r'shopping\.naver\.com/product[s]?/(\d+)', url)
    if sp:
        return {'target_type': 'product_id', 'target_value': sp.group(1)}
    mid = re.search(r'nvMid=(\d+)', url)
    if mid:
        return {'target_type': 'product_id', 'target_value': mid.group(1)}
    if re.match(r'^\d{5,}$', url):
        return {'target_type': 'product_id', 'target_value': url}
    return {'target_type': 'store', 'target_value': url}


class TrackingProductListView(APIView):
    def get(self, request):
        products = NaverTrackingProduct.objects.all().order_by('-created_at')
        return Response(NaverTrackingProductSerializer(products, many=True).data)

    def post(self, request):
        url = request.data.get('url', '').strip()
        product_name = request.data.get('product_name', '').strip()
        display_name = request.data.get('display_name', '').strip()
        product_url = request.data.get('product_url', '').strip() or url

        if not url:
            return Response({'error': 'url 필요'}, status=400)

        parsed = _parse_target_url(url)
        target_type = parsed['target_type']
        target_value = parsed['target_value']

        product, created = NaverTrackingProduct.objects.get_or_create(
            target_type=target_type, target_value=target_value,
            defaults={
                'display_name': display_name or target_value,
                'product_name': product_name,
                'product_url': product_url,
            }
        )
        if not created and (product_name or display_name):
            if product_name:
                product.product_name = product_name
            if display_name:
                product.display_name = display_name
            product.save()

        return Response(NaverTrackingProductSerializer(product).data, status=201 if created else 200)


class TrackingProductDetailView(APIView):
    def put(self, request, pk):
        try:
            product = NaverTrackingProduct.objects.get(id=pk)
        except NaverTrackingProduct.DoesNotExist:
            return Response({'error': 'not found'}, status=404)
        for field in ('display_name', 'product_name', 'product_image', 'product_url'):
            if field in request.data:
                setattr(product, field, request.data[field])
        product.save()
        return Response(NaverTrackingProductSerializer(product).data)

    def delete(self, request, pk):
        try:
            NaverTrackingProduct.objects.get(id=pk).delete()
            return Response(status=204)
        except NaverTrackingProduct.DoesNotExist:
            return Response({'error': 'not found'}, status=404)


class TrackingProductParseView(APIView):
    def post(self, request):
        url = request.data.get('url', '').strip()
        if not url:
            return Response({'error': 'url 필요'}, status=400)
        return Response(_parse_target_url(url))


class RankGroupsView(APIView):
    def get(self, request):
        targets = NaverRankTarget.objects.filter(is_active=True).select_related('keyword')
        groups: dict = {}
        for t in targets:
            key = f'{t.target_type}::{t.target_value}'
            if key not in groups:
                groups[key] = {
                    'target_value': t.target_value,
                    'target_type': t.target_type,
                    'display_name': t.display_name,
                    'source_product_name': t.source_product_name,
                    'source_product_id': t.source_product_id,
                    'keyword_count': 0,
                }
            groups[key]['keyword_count'] += 1
        return Response(list(groups.values()))


class RankMatrixView(APIView):
    def get(self, request):
        product_id = request.query_params.get('product_id')
        days = int(request.query_params.get('days', 30))
        since = timezone.now() - timedelta(days=days)

        if not product_id:
            return Response({'error': 'product_id required'}, status=400)

        try:
            product = NaverTrackingProduct.objects.get(id=product_id)
        except NaverTrackingProduct.DoesNotExist:
            return Response({'error': 'product not found'}, status=404)

        targets = (
            NaverRankTarget.objects
            .filter(product=product, is_active=True)
            .select_related('keyword')
            .order_by('id')
        )

        product_info = {
            'id': product.id,
            'target_type': product.target_type,
            'target_value': product.target_value,
            'display_name': product.display_name,
            'product_name': product.product_name,
            'product_image': product.product_image,
            'product_url': product.product_url,
        }

        keyword_strs = [t.keyword.keyword for t in targets]
        enrich_map = {
            c.keyword: {'monthly_pc': c.monthly_pc_qc, 'monthly_mobile': c.monthly_mobile_qc}
            for c in KeywordEnrichCache.objects.filter(keyword__in=keyword_strs)
        }

        targets_data = []
        for t in targets:
            enc = enrich_map.get(t.keyword.keyword, {})
            targets_data.append({
                'id': t.id,
                'keyword': t.keyword.keyword,
                'keyword_id': t.keyword.id,
                'monthly_pc': enc.get('monthly_pc', 0),
                'monthly_mobile': enc.get('monthly_mobile', 0),
            })

        target_ids = [t.id for t in targets]
        history_qs = (
            NaverRankHistory.objects
            .filter(target_id__in=target_ids, tracked_at__gte=since)
            .order_by('-tracked_at')
            .values('target_id', 'rank_position', 'tracked_at', 'found_product_image')
        )
        history = []
        for h in history_qs:
            history.append({
                'target_id': h['target_id'],
                'rank_position': h['rank_position'],
                'tracked_at': h['tracked_at'].isoformat(),
                'found_product_image': h['found_product_image'] or '',
            })

        return Response({
            'product_info': product_info,
            'targets': targets_data,
            'history': history,
        })


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

# ──── 연관키워드 ────

class RelatedKeywordView(APIView):
    def get(self, request):
        keyword = request.query_params.get('keyword', '').strip()
        if not keyword:
            return Response({'error': '키워드를 입력하세요'}, status=400)
        try:
            keyword_list = services.search_related_keywords(keyword)
            return Response({'keywordList': keyword_list})
        except ValueError as e:
            return Response({'error': str(e)}, status=500)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


# ──── 카테고리키워드 (데이터랩) ────

class DatalabCategoryView(APIView):
    def get(self, request):
        parent_cid = request.query_params.get('cid', '0')
        try:
            categories = services.get_datalab_categories(parent_cid)
            return Response(categories)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class DatalabCategoryKeywordRankView(APIView):
    def get(self, request):
        cid = request.query_params.get('cid', '').strip()
        start_date = request.query_params.get('startDate', '').strip()
        end_date = request.query_params.get('endDate', '').strip()
        age = request.query_params.get('age', '')
        gender = request.query_params.get('gender', '')
        device = request.query_params.get('device', '')

        if not cid:
            return Response({'error': '카테고리를 선택하세요'}, status=400)
        if not start_date or not end_date:
            return Response({'error': '날짜 범위를 입력하세요'}, status=400)

        try:
            result = services.get_category_keyword_rank(
                cid, start_date, end_date, age, gender, device,
            )
            return Response(result)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class KeywordEnrichView(APIView):
    """키워드 목록에 대해 검색량/상품수/카테고리 데이터 보강"""
    def post(self, request):
        keywords = request.data.get('keywords', [])
        if not keywords or not isinstance(keywords, list):
            return Response({'error': '키워드 목록이 필요합니다'}, status=400)
        keywords = keywords[:50]  # 1회 최대 50개
        try:
            data = services.enrich_keywords(keywords)
            return Response({'data': data})
        except Exception as e:
            return Response({'error': str(e)}, status=500)


class KeywordAutoMatchView(APIView):
    """상품명 기반 키워드 자동매칭"""
    def post(self, request):
        product_name = request.data.get('product_name', '').strip()
        keywords = request.data.get('keywords', [])
        if not product_name or not keywords:
            return Response({'error': 'product_name, keywords 필요'}, status=400)
        matches = services.match_keywords_for_product(product_name, keywords[:500])
        return Response({'matches': matches})


class CategoryNameLookupView(APIView):
    """카테고리 CID → 이름 조회 (naver_category DB)"""
    def get(self, request):
        cids = request.query_params.get('cids', '').strip()
        if not cids:
            return Response({'error': 'cids 필요'}, status=400)
        cid_list = [c.strip() for c in cids.split(',') if c.strip()]
        from django.db import connections
        result = {}
        try:
            with connections['myproduct'].cursor() as c:
                placeholders = ','.join(['%s'] * len(cid_list))
                c.execute(f'SELECT category_id, name FROM naver_category WHERE category_id IN ({placeholders})', cid_list)
                for row in c.fetchall():
                    result[str(row[0])] = row[1]
        except Exception:
            pass
        return Response(result)


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


# ──── 아이템스카우트 판매량 추적 ────

class ItemScoutProductListView(APIView):
    def get(self, request):
        products = ItemScoutProduct.objects.filter(is_active=True).order_by('created_at')
        data = []
        for p in products:
            latest = p.records.order_by('-record_date').first()
            data.append({
                'id': p.id,
                'name': p.name,
                'url': p.url,
                'is_active': p.is_active,
                'created_at': p.created_at,
                'latest_purchase': latest.today_purchase if latest else None,
                'latest_date': latest.record_date if latest else None,
            })
        return Response(data)

    def post(self, request):
        name = request.data.get('name', '').strip()
        url = request.data.get('url', '').strip()
        if not name or not url:
            return Response({'error': '이름과 URL을 입력하세요'}, status=400)
        product, created = ItemScoutProduct.objects.get_or_create(url=url, defaults={'name': name})
        if not created:
            product.name = name
            product.is_active = True
            product.save()
        return Response({'id': product.id, 'name': product.name, 'url': product.url}, status=201 if created else 200)


class ItemScoutProductDetailView(APIView):
    def delete(self, request, pk):
        try:
            ItemScoutProduct.objects.get(id=pk).delete()
            return Response(status=204)
        except ItemScoutProduct.DoesNotExist:
            return Response({'error': 'not found'}, status=404)


class ItemScoutRecordView(APIView):
    def post(self, request):
        from datetime import date
        items = request.data.get('items', [])
        if not items:
            return Response({'error': 'items 필드가 비어있습니다'}, status=400)
        saved = []
        for item in items:
            url = item.get('url', '').strip()
            today_purchase = item.get('today_purchase', 0)
            record_date = item.get('record_date') or date.today().isoformat()
            try:
                product = ItemScoutProduct.objects.get(url=url)
            except ItemScoutProduct.DoesNotExist:
                continue
            record, _ = ItemScoutRecord.objects.update_or_create(
                product=product,
                record_date=record_date,
                defaults={'today_purchase': today_purchase},
            )
            saved.append({'url': url, 'today_purchase': today_purchase, 'record_date': record_date})
        return Response({'saved': saved, 'count': len(saved)})

    def get(self, request):
        product_id = request.query_params.get('product_id')
        days = int(request.query_params.get('days', 30))
        from datetime import date, timedelta
        since = date.today() - timedelta(days=days)
        qs = ItemScoutRecord.objects.select_related('product').filter(record_date__gte=since)
        if product_id:
            qs = qs.filter(product_id=product_id)
        qs = qs.order_by('product_id', 'record_date')
        data = [
            {
                'id': r.id,
                'product_id': r.product_id,
                'product_name': r.product.name,
                'product_url': r.product.url,
                'today_purchase': r.today_purchase,
                'record_date': r.record_date,
                'recorded_at': r.recorded_at,
            }
            for r in qs
        ]
        return Response(data)
