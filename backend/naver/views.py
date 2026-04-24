from collections import defaultdict
from datetime import timedelta
from django.utils import timezone
from django.db.models import Max, Q
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import (
    NaverKeyword, NaverSearchSnapshot, NaverTermAnalysis,
    NaverRankTarget, NaverRankHistory, NaverTrackingSchedule,
    NaverReport,
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
        # 순위추적 전용 키워드만 제외 (스냅샷/분석 없이 순위대상만 있는 키워드)
        keywords = NaverKeyword.objects.exclude(
            snapshots__isnull=True, analyses__isnull=True, rank_targets__isnull=False
        ).distinct().order_by('-created_at')
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

        target, created = NaverRankTarget.objects.get_or_create(
            keyword=kw, target_type=target_type, target_value=target_value,
            defaults=defaults,
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
        result = []
        for s in schedules:
            data = NaverTrackingScheduleSerializer(s).data
            # 타겟 상세 정보 추가
            targets = NaverRankTarget.objects.filter(id__in=s.target_ids).select_related('keyword')
            data['targets'] = []
            for t in targets:
                latest = t.history.order_by('-tracked_at').first()
                data['targets'].append({
                    'id': t.id,
                    'keyword': t.keyword.keyword,
                    'target_value': t.target_value,
                    'display_name': t.display_name or '',
                    'matched_product_id': t.matched_product_id or '',
                    'rank': latest.rank_position if latest else None,
                    'tracked_at': latest.tracked_at.isoformat() if latest else None,
                })
            result.append(data)
        return Response(result)

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


# ──── 상품별 그룹 순위 Summary ────

class RankGroupedSummaryView(APIView):
    """matched_product_id 기준으로 상품별 그룹핑된 순위 요약.
    같은 스토어라도 매칭된 상품이 다르면 별도 그룹."""
    def get(self, request):
        targets = NaverRankTarget.objects.filter(is_active=True).select_related('keyword')
        groups = defaultdict(list)
        for t in targets:
            if t.matched_product_id:
                key = t.matched_product_id
            else:
                key = f'_unmatched_{t.target_type}::{t.target_value}'
            groups[key].append(t)

        results = []
        for gkey, tlist in groups.items():
            first = tlist[0]
            keywords = []
            for t in tlist:
                records = list(t.history.order_by('-tracked_at')[:2])
                current = records[0].rank_position if records else None
                previous = records[1].rank_position if len(records) > 1 else None
                change = (previous - current) if (current and previous) else None
                keywords.append({
                    'target_id': t.id,
                    'keyword': t.keyword.keyword,
                    'keyword_id': t.keyword.id,
                    'current_rank': current,
                    'previous_rank': previous,
                    'change': change,
                    'tracked_at': records[0].tracked_at.isoformat() if records else None,
                })

            display = first.matched_product_name or first.display_name or first.target_value
            results.append({
                'group_key': gkey,
                'target_type': first.target_type,
                'target_value': first.target_value,
                'display_name': display,
                'matched_product_id': first.matched_product_id,
                'source_product_id': first.source_product_id,
                'source_product_name': first.source_product_name,
                'auto_track': first.auto_track,
                'auto_track_times': first.auto_track_times or [],
                'keyword_count': len(tlist),
                'keywords': keywords,
            })
        return Response(results)


class RankPivotView(APIView):
    """특정 상품 그룹의 키워드×날짜 피벗 데이터"""
    def get(self, request):
        group_key = request.query_params.get('group_key', '').strip()
        days = int(request.query_params.get('days', 30))

        if not group_key:
            return Response({'error': 'group_key 필요'}, status=400)

        since = timezone.now() - timedelta(days=days)

        if group_key.startswith('_unmatched_'):
            # 미매칭 그룹: target_type::target_value
            parts = group_key.replace('_unmatched_', '').split('::', 1)
            if len(parts) == 2:
                targets = NaverRankTarget.objects.filter(
                    target_type=parts[0], target_value=parts[1], is_active=True
                ).select_related('keyword')
            else:
                return Response({'keywords': [], 'dates': [], 'data': {}})
        else:
            targets = NaverRankTarget.objects.filter(
                matched_product_id=group_key, is_active=True
            ).select_related('keyword')

        if not targets.exists():
            return Response({'keywords': [], 'dates': [], 'data': {}})

        keyword_names = []
        target_map = {}
        for t in targets:
            kw = t.keyword.keyword
            keyword_names.append(kw)
            target_map[t.id] = kw

        histories = NaverRankHistory.objects.filter(
            target__in=targets, tracked_at__gte=since
        ).order_by('-tracked_at')

        # 같은 날짜(MM/DD)에 여러 기록 → 최적(가장 낮은) 순위만 표시
        date_map = {}  # day_key → max datetime (정렬용)
        data = defaultdict(dict)  # kw → {day_key: best_rank}
        for h in histories:
            kw = target_map[h.target_id]
            day_key = h.tracked_at.strftime('%m/%d')
            if day_key not in date_map or h.tracked_at > date_map[day_key]:
                date_map[day_key] = h.tracked_at
            rank = h.rank_position
            if rank is not None:
                prev = data[kw].get(day_key)
                if prev is None or rank < prev:
                    data[kw][day_key] = rank
            elif day_key not in data[kw]:
                data[kw][day_key] = None

        date_labels = sorted(date_map.keys(), key=lambda k: date_map[k], reverse=True)

        return Response({
            'keywords': keyword_names,
            'dates': date_labels,
            'data': dict(data),
        })


class RankTrackedProductsView(APIView):
    """순위추적 중인 source_product_id 목록 (스마트스토어 배지용)"""
    def get(self, request):
        product_ids = list(
            NaverRankTarget.objects.filter(
                is_active=True, source_product_id__isnull=False
            ).values_list('source_product_id', flat=True).distinct()
        )
        return Response(product_ids)


class RankToggleAutoView(APIView):
    """상품 그룹 단위 자동추적 토글 + 수집 시간 설정"""
    def post(self, request):
        group_key = request.data.get('group_key', '').strip()
        enabled = request.data.get('enabled', False)
        times = request.data.get('times')  # ["09:00","13:00"] 또는 None

        if not group_key:
            return Response({'error': 'group_key 필요'}, status=400)

        if group_key.startswith('_unmatched_'):
            parts = group_key.replace('_unmatched_', '').split('::', 1)
            if len(parts) == 2:
                qs = NaverRankTarget.objects.filter(
                    target_type=parts[0], target_value=parts[1]
                )
            else:
                return Response({'error': 'invalid group_key'}, status=400)
        else:
            qs = NaverRankTarget.objects.filter(matched_product_id=group_key)

        update_kwargs = {'auto_track': enabled}
        if times is not None:
            # 최대 4개, HH:MM 형식 검증
            valid_times = sorted(set(
                t.strip() for t in times[:4]
                if isinstance(t, str) and len(t.strip()) == 5
            ))
            update_kwargs['auto_track_times'] = valid_times

        updated = qs.update(**update_kwargs)
        return Response({
            'updated': updated,
            'auto_track': enabled,
            'auto_track_times': update_kwargs.get('auto_track_times', []),
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


# ──── 스마트 수집 / 분석 ────

class SmartCollectView(APIView):
    """스마트 수집 — HTTP 크롤링 + 자동 API fallback"""
    def post(self, request):
        keywords = request.data.get('keywords', [])
        method = request.data.get('method', 'auto')  # 'auto', 'http', 'api'
        tabs = request.data.get('tabs')

        if not keywords:
            return Response({'error': '키워드를 입력하세요'}, status=400)

        if method == 'api':
            # 공식 API 직행
            results = []
            for kw_text in keywords:
                kw_obj, _ = NaverKeyword.objects.get_or_create(keyword=kw_text)
                try:
                    api_data = services.fetch_products_via_api(kw_text, max_items=40)
                    NaverSearchSnapshot.objects.create(
                        keyword=kw_obj, tab_type='total',
                        products=api_data['products'], total=api_data['total'],
                    )
                    kw_obj.total_count = api_data['total']
                    kw_obj.last_searched_at = timezone.now()
                    kw_obj.save(update_fields=['total_count', 'last_searched_at'])
                    results.append({
                        'keyword': kw_text,
                        'tab': 'total',
                        'count': len(api_data['products']),
                        'total': api_data['total'],
                        'keyword_id': kw_obj.id,
                        'has_terms': bool(kw_obj.terms),
                    })
                except Exception as e:
                    results.append({'keyword': kw_text, 'error': str(e)})
                import time; time.sleep(0.2)

            return Response({
                'method_used': 'api',
                'terms_source': 'cache',
                'products_source': 'api',
                'results': results,
                'blocked': False,
            })

        # HTTP 크롤링 (auto 또는 http)
        from . import http_crawler
        logs = []

        def on_progress(event, data):
            logs.append({'event': event, **data})

        http_result = http_crawler.crawl_keywords(keywords, tabs=tabs, on_progress=on_progress)

        if not http_result['blocked']:
            return Response({
                'method_used': 'http',
                'terms_source': 'http',
                'products_source': 'http',
                'results': http_result['results'],
                'blocked': False,
                'logs': logs,
            })

        # 차단 감지 → API fallback (auto만)
        if method == 'http':
            return Response({
                'method_used': 'http',
                'results': http_result['results'],
                'blocked': True,
                'logs': logs,
            })

        # auto fallback → 남은 키워드를 API로
        done_kws = {r['keyword'] for r in http_result['results']}
        remaining = [kw for kw in keywords if kw not in done_kws]
        api_results = []

        for kw_text in remaining:
            kw_obj, _ = NaverKeyword.objects.get_or_create(keyword=kw_text)
            try:
                api_data = services.fetch_products_via_api(kw_text, max_items=40)
                NaverSearchSnapshot.objects.create(
                    keyword=kw_obj, tab_type='total',
                    products=api_data['products'], total=api_data['total'],
                )
                kw_obj.total_count = api_data['total']
                kw_obj.last_searched_at = timezone.now()
                kw_obj.save(update_fields=['total_count', 'last_searched_at'])
                api_results.append({
                    'keyword': kw_text, 'tab': 'total',
                    'count': len(api_data['products']),
                    'total': api_data['total'],
                    'keyword_id': kw_obj.id,
                    'has_terms': bool(kw_obj.terms),
                    'source': 'api',
                })
            except Exception as e:
                api_results.append({'keyword': kw_text, 'error': str(e), 'source': 'api'})
            import time; time.sleep(0.2)

        return Response({
            'method_used': 'auto',
            'terms_source': 'mixed',
            'products_source': 'mixed',
            'results': http_result['results'] + api_results,
            'blocked': True,
            'fallback_count': len(api_results),
            'logs': logs,
        })


class SmartAnalysisView(APIView):
    """스마트 분석 — 캐시된 terms + API products"""
    def post(self, request, keyword_id):
        method = request.data.get('method', 'auto')
        try:
            result = services.run_smart_analysis(keyword_id, method=method)
            if result.get('analysis'):
                from .serializers import NaverTermAnalysisSerializer
                result['analysis'] = NaverTermAnalysisSerializer(result['analysis']).data
            return Response(result)
        except NaverKeyword.DoesNotExist:
            return Response({'error': '키워드를 찾을 수 없습니다'}, status=404)
        except Exception as e:
            return Response({'error': str(e)}, status=500)


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


class ProductBuyKeywordProxyView(APIView):
    """order 시스템의 구매키워드 API를 프록시"""
    def get(self, request, product_code):
        import requests as http_requests
        try:
            resp = http_requests.get(
                f'http://localhost:8989/orders/api_product_buy_keyword/{product_code}/',
                timeout=10,
            )
            return Response(resp.json())
        except Exception as e:
            return Response({'success': False, 'error': str(e)}, status=502)


# ──── 보고서 ────

class ReportListView(APIView):
    def get(self, request):
        reports = NaverReport.objects.values('id', 'title', 'report_type', 'created_at')
        return Response(list(reports))

    def post(self, request):
        title = request.data.get('title', '').strip()
        content = request.data.get('content', '').strip()
        report_type = request.data.get('report_type', 'monthly')
        if not title or not content:
            return Response({'error': '제목과 내용을 입력하세요'}, status=400)
        report = NaverReport.objects.create(title=title, content=content, report_type=report_type)
        return Response({'id': report.id, 'title': report.title, 'report_type': report.report_type,
                         'created_at': report.created_at}, status=201)


class ReportDetailView(APIView):
    def get(self, request, pk):
        try:
            r = NaverReport.objects.get(pk=pk)
        except NaverReport.DoesNotExist:
            return Response({'error': '보고서를 찾을 수 없습니다'}, status=404)
        return Response({'id': r.id, 'title': r.title, 'content': r.content,
                         'report_type': r.report_type, 'created_at': r.created_at})

    def delete(self, request, pk):
        deleted, _ = NaverReport.objects.filter(pk=pk).delete()
        if not deleted:
            return Response({'error': '보고서를 찾을 수 없습니다'}, status=404)
        return Response(status=204)


class ReportDownloadView(APIView):
    def get(self, request, pk):
        from django.http import HttpResponse
        try:
            r = NaverReport.objects.get(pk=pk)
        except NaverReport.DoesNotExist:
            return Response({'error': '보고서를 찾을 수 없습니다'}, status=404)
        filename = f'{r.title}.md'
        resp = HttpResponse(r.content, content_type='text/markdown; charset=utf-8')
        resp['Content-Disposition'] = f"attachment; filename*=UTF-8''{__import__('urllib.parse', fromlist=['quote']).quote(filename)}"
        return resp


# ──── 순위컨닝 ────

class RankCunningListView(APIView):
    def get(self, request):
        import pymysql
        import os
        pw = os.environ.get('MYPRODUCT_DB_PASSWORD', '')
        conn = pymysql.connect(host='192.168.219.200', user='root', password=pw, database='naverdb', autocommit=True)
        cur = conn.cursor(pymysql.cursors.DictCursor)
        cur.execute('SELECT * FROM rank_cunning_product ORDER BY created_at DESC')
        rows = cur.fetchall()
        conn.close()
        for r in rows:
            if r.get('created_at'):
                r['created_at'] = r['created_at'].isoformat()
        return Response(rows)

    def post(self, request):
        import pymysql
        import os
        products = request.data.get('products', [])
        if not products:
            return Response({'error': 'products 필드 필요'}, status=400)
        pw = os.environ.get('MYPRODUCT_DB_PASSWORD', '')
        conn = pymysql.connect(host='192.168.219.200', user='root', password=pw, database='naverdb', autocommit=True)
        cur = conn.cursor()
        added = 0
        for p in products:
            try:
                cur.execute('''INSERT IGNORE INTO rank_cunning_product
                    (origin_product_no, store_name, store_id, product_name, sale_price, category_id, product_image_url, seller_management_code)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (p['origin_product_no'], p.get('store_name',''), p.get('store_id'),
                     p.get('product_name',''), p.get('sale_price',0), p.get('category_id',''),
                     p.get('product_image_url',''), p.get('seller_management_code','')))
                added += cur.rowcount
            except Exception:
                pass
        conn.close()
        return Response({'added': added, 'total': len(products)}, status=201)


class RankCunningDetailView(APIView):
    def delete(self, request, pk):
        import pymysql
        import os
        pw = os.environ.get('MYPRODUCT_DB_PASSWORD', '')
        conn = pymysql.connect(host='192.168.219.200', user='root', password=pw, database='naverdb', autocommit=True)
        cur = conn.cursor()
        cur.execute('DELETE FROM rank_cunning_product WHERE id=%s', (pk,))
        conn.close()
        return Response(status=204)
