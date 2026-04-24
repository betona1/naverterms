import os
from io import BytesIO
from urllib.parse import quote

from django.http import HttpResponse
from rest_framework.views import APIView
from rest_framework.response import Response

from . import smartstore_service
from . import smartstore_product_service
from . import smartstore_order_service
from . import smartstore_analytics_service
from . import product_audit_service


# ── 스마트스토어 상점 관리 ──

class SmartStoreStoreListView(APIView):
    def get(self, request):
        include_inactive = request.query_params.get('all') == '1'
        return Response(smartstore_service.get_stores(include_inactive))

    def post(self, request):
        d = request.data
        if not d.get('store_id') or not d.get('store_pw') or not d.get('store_name'):
            return Response({'error': 'store_id, store_pw, store_name required'}, status=400)
        try:
            store = smartstore_service.create_store(d)
            return Response(store, status=201)
        except Exception as e:
            msg = str(e)
            if 'Duplicate' in msg:
                return Response({'error': '이미 등록된 store_id입니다.'}, status=400)
            return Response({'error': msg}, status=400)


class SmartStoreStoreSampleExcelView(APIView):
    def get(self, request):
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill

        wb = Workbook()
        ws = wb.active
        ws.title = '상점목록'

        headers = ['store_id', 'store_pw', 'store_name', 'store_url', 'application_id', 'application_secret', 'memo']
        header_font = Font(bold=True, size=10)
        header_fill = PatternFill('solid', fgColor='D9D9D9')

        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.font = header_font
            cell.fill = header_fill

        stores = smartstore_service.get_stores(include_inactive=True)
        if stores:
            for row_idx, s in enumerate(stores, 2):
                ws.cell(row=row_idx, column=1, value=s.get('store_id', ''))
                ws.cell(row=row_idx, column=2, value=s.get('store_pw', ''))
                ws.cell(row=row_idx, column=3, value=s.get('store_name', ''))
                ws.cell(row=row_idx, column=4, value=s.get('store_url', '') or '')
                ws.cell(row=row_idx, column=5, value=s.get('commerce_api_key', '') or '')
                ws.cell(row=row_idx, column=6, value=s.get('commerce_secret_key', '') or '')
                ws.cell(row=row_idx, column=7, value=s.get('memo', '') or '')
        else:
            example = ['mystore', 'password123', '내상점', 'mystore-url', '', '', '테스트']
            for col, v in enumerate(example, 1):
                ws.cell(row=2, column=col, value=v)

        ws.column_dimensions['A'].width = 20
        ws.column_dimensions['B'].width = 20
        ws.column_dimensions['C'].width = 20
        ws.column_dimensions['D'].width = 25
        ws.column_dimensions['E'].width = 25
        ws.column_dimensions['F'].width = 25
        ws.column_dimensions['G'].width = 20

        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)

        filename = '스마트스토어_상점목록.xlsx'
        resp = HttpResponse(
            buf.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        resp['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(filename)}"
        return resp


class SmartStoreStoreBulkUploadView(APIView):
    HEADER_MAP = {
        'store_id': 'store_id', '스토어id': 'store_id', '스토어 id': 'store_id',
        'store_pw': 'store_pw', '비밀번호': 'store_pw', 'password': 'store_pw',
        'store_name': 'store_name', '상점명': 'store_name', '스토어명': 'store_name',
        'store_url': 'store_url', '스토어주소': 'store_url', '스토어url': 'store_url', '상점주소': 'store_url',
        'commerce_api_key': 'commerce_api_key', '커머스api키': 'commerce_api_key', 'api키': 'commerce_api_key', '애플리케이션id': 'commerce_api_key', '앱id': 'commerce_api_key', 'application_id': 'commerce_api_key',
        'commerce_secret_key': 'commerce_secret_key', '커머스시크릿키': 'commerce_secret_key', '시크릿키': 'commerce_secret_key', 'application_secret': 'commerce_secret_key', '애플리케이션시크릿': 'commerce_secret_key', '앱시크릿': 'commerce_secret_key',
        'memo': 'memo', '메모': 'memo',
    }

    def post(self, request):
        from openpyxl import load_workbook

        xls_file = request.FILES.get('file')
        if not xls_file:
            return Response({'error': '파일을 선택하세요.'}, status=400)

        try:
            wb = load_workbook(xls_file, read_only=True)
        except Exception:
            return Response({'error': 'xlsx 파일만 지원합니다.'}, status=400)

        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)

        try:
            header_row = next(rows_iter)
        except StopIteration:
            return Response({'error': '빈 파일입니다.'}, status=400)

        col_map = {}
        for idx, val in enumerate(header_row):
            if val is None:
                continue
            key = str(val).strip().lower().replace(' ', '')
            mapped = self.HEADER_MAP.get(key)
            if mapped:
                col_map[idx] = mapped

        if 'store_id' not in col_map.values():
            return Response({'error': 'store_id 컬럼을 찾을 수 없습니다.'}, status=400)

        data_rows = []
        for row in rows_iter:
            if all(v is None or str(v).strip() == '' for v in row):
                continue
            item = {}
            for idx, field in col_map.items():
                val = row[idx] if idx < len(row) else None
                item[field] = str(val).strip() if val is not None else ''
            data_rows.append(item)

        wb.close()

        if not data_rows:
            return Response({'error': '데이터가 없습니다.'}, status=400)

        result = smartstore_service.bulk_create_stores(data_rows)
        return Response(result)


class SmartStoreStoreDetailView(APIView):
    def put(self, request, pk):
        store = smartstore_service.get_store(pk)
        if not store:
            return Response({'error': 'not found'}, status=404)
        updated = smartstore_service.update_store(pk, request.data)
        return Response(updated)

    def delete(self, request, pk):
        store = smartstore_service.get_store(pk)
        if not store:
            return Response({'error': 'not found'}, status=404)
        if store.get('is_active'):
            smartstore_service.deactivate_store(pk)
        else:
            smartstore_service.delete_store(pk)
        return Response(status=204)


# ── 스마트스토어 상품 관리 ──

class SmartStoreProductListView(APIView):
    def _parse_params(self, src):
        store_id = src.get('store_id')
        if store_id is None:
            return None, Response({'error': 'store_id required'}, status=400)
        page = int(src.get('page', 1))
        per_page = int(src.get('per_page', 50))
        status = src.get('status') or None
        search = src.get('search') or None
        ownerclan_soldout = src.get('ownerclan_soldout')
        is_focus = src.get('is_focus')
        has_orders = src.get('has_orders')
        sort_by = src.get('sort_by') or None
        sort_dir = src.get('sort_dir') or None
        min_ss_amount = src.get('min_ss_amount')
        has_changes = src.get('has_changes')
        reverse_margin = src.get('reverse_margin')
        restock_unchecked = src.get('restock_unchecked')
        no_master = src.get('no_master')
        result = smartstore_product_service.get_products(
            int(store_id), page, per_page, status, search,
            ownerclan_soldout=int(ownerclan_soldout) if ownerclan_soldout is not None else None,
            is_focus=int(is_focus) if is_focus is not None else None,
            has_orders=int(has_orders) if has_orders is not None else None,
            sort_by=sort_by,
            sort_dir=sort_dir,
            min_ss_amount=int(min_ss_amount) if min_ss_amount is not None else None,
            has_changes=int(has_changes) if has_changes is not None else None,
            reverse_margin=int(reverse_margin) if reverse_margin is not None else None,
            restock_unchecked=int(restock_unchecked) if restock_unchecked is not None else None,
            no_master=int(no_master) if no_master is not None else None,
        )
        return result, None

    def get(self, request):
        result, err = self._parse_params(request.query_params)
        return err or Response(result)


class SmartStoreProductSearchView(APIView):
    """POST 검색 — 다수 코드 검색 시 URL 길이 제한 회피"""
    def post(self, request):
        result, err = SmartStoreProductListView()._parse_params(request.data)
        return err or Response(result)


class SmartStoreProductSyncView(APIView):
    def post(self, request):
        store_id = request.data.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        result = smartstore_product_service.sync_products(int(store_id))
        if 'error' in result:
            return Response(result, status=400)
        return Response(result)


class SmartStoreRefreshTrackingView(APIView):
    def post(self, request):
        from . import smartstore_order_service
        store_id = int(request.data.get('store_id', 0))
        count = smartstore_product_service.refresh_master_tracking(store_id)
        order_count = smartstore_order_service.update_product_sales_summary()
        return Response({'refreshed': count, 'orders_updated': order_count})


class SmartStoreSalesSnapshotView(APIView):
    def post(self, request):
        from . import smartstore_order_service
        saved = smartstore_order_service.save_daily_snapshot()
        return Response({'saved': saved})

    def get(self, request):
        from . import smartstore_order_service
        store_id = int(request.query_params.get('store_id', 0))
        delta = smartstore_order_service.get_sales_delta(store_id)
        return Response(delta or {})


class SmartStoreSyncLogView(APIView):
    def get(self, request):
        store_id = int(request.query_params.get('store_id', 0))
        limit = int(request.query_params.get('limit', 50))
        return Response(smartstore_product_service.get_sync_logs(store_id, limit))


class SmartStoreSyncLogDetailView(APIView):
    def get(self, request, pk):
        limit = int(request.query_params.get('limit', 500))
        return Response(smartstore_product_service.get_sync_log_changes(pk, limit))


class SmartStoreProductStatsView(APIView):
    def get(self, request):
        store_id = request.query_params.get('store_id')
        if store_id:
            result = smartstore_product_service.get_product_stats(int(store_id))
        else:
            result = smartstore_product_service.get_all_stores_stats()
        return Response(result)


class SmartStoreProductExcelView(APIView):
    def get(self, request):
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

        store_ids = request.query_params.getlist('store_ids')
        statuses = request.query_params.getlist('statuses')
        w_only = request.query_params.get('w_only') == '1'
        search = request.query_params.get('search') or None
        has_orders = request.query_params.get('has_orders') == '1'
        is_focus = request.query_params.get('is_focus') == '1'
        sort_by = request.query_params.get('sort_by') or None
        sort_dir = request.query_params.get('sort_dir') or None

        store_ids = [int(s) for s in store_ids] if store_ids else None
        statuses = statuses if statuses else None

        rows = smartstore_product_service.get_products_for_export(
            store_ids, statuses, w_only,
            search=search, has_orders=has_orders, is_focus=is_focus,
            sort_by=sort_by, sort_dir=sort_dir,
        )

        wb = Workbook()
        ws = wb.active
        ws.title = '상품목록'

        headers = ['상점명', '상품번호', '채널상품번호', '상품명', '판매가',
                    '재고', '상태', '노출상태', '관리코드', '카테고리ID',
                    '주문건수', '스마트주문건수', '판매금액', '스마트판매금액',
                    '판매수량', '스마트판매수량', '동기화일시']
        col_widths = [15, 14, 14, 40, 12, 8, 10, 10, 18, 14, 10, 12, 14, 14, 10, 12, 20]

        header_font = Font(bold=True, size=10)
        header_fill = PatternFill('solid', fgColor='F0F0F0')
        thin_border = Border(bottom=Side(style='thin', color='DDDDDD'))
        money_fmt = '#,##0'

        for col, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=h)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal='center')

        STATUS_LABELS = {
            'SALE': '판매중', 'SUSPENSION': '판매중지',
            'CLOSE': '판매종료', 'PROHIBITION': '판매금지',
            'WAIT': '대기',
        }

        for i, r in enumerate(rows, 2):
            ws.cell(row=i, column=1, value=r['store_name']).border = thin_border
            ws.cell(row=i, column=2, value=r['origin_product_no']).border = thin_border
            ws.cell(row=i, column=3, value=r['channel_product_no']).border = thin_border
            ws.cell(row=i, column=4, value=r['name']).border = thin_border
            c = ws.cell(row=i, column=5, value=r['sale_price'])
            c.number_format = money_fmt
            c.border = thin_border
            ws.cell(row=i, column=6, value=r['stock_quantity']).border = thin_border
            ws.cell(row=i, column=7, value=STATUS_LABELS.get(r['status_type'] or '', r['status_type'] or '')).border = thin_border
            ws.cell(row=i, column=8, value=r['channel_product_display_status_type'] or '').border = thin_border
            ws.cell(row=i, column=9, value=r['seller_management_code'] or '').border = thin_border
            ws.cell(row=i, column=10, value=r['category_id'] or '').border = thin_border
            c = ws.cell(row=i, column=11, value=r.get('all_order_count', 0))
            c.number_format = '#,##0'
            c.border = thin_border
            c = ws.cell(row=i, column=12, value=r.get('total_order_count', 0))
            c.number_format = '#,##0'
            c.border = thin_border
            c = ws.cell(row=i, column=13, value=r.get('all_order_amount', 0))
            c.number_format = money_fmt
            c.border = thin_border
            c = ws.cell(row=i, column=14, value=r.get('total_order_amount', 0))
            c.number_format = money_fmt
            c.border = thin_border
            c = ws.cell(row=i, column=15, value=r.get('all_order_qty', 0))
            c.number_format = '#,##0'
            c.border = thin_border
            c = ws.cell(row=i, column=16, value=r.get('total_order_qty', 0))
            c.number_format = '#,##0'
            c.border = thin_border
            synced = r['synced_at']
            if hasattr(synced, 'strftime'):
                synced = synced.strftime('%Y-%m-%d %H:%M:%S')
            ws.cell(row=i, column=17, value=synced or '').border = thin_border

        for j, w in enumerate(col_widths):
            ws.column_dimensions[chr(65 + j)].width = w

        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)

        filename = '스마트스토어_상품목록.xlsx'
        resp = HttpResponse(
            buf.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        resp['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(filename)}"
        return resp


class SmartStoreProductCountView(APIView):
    def get(self, request):
        store_ids = request.query_params.getlist('store_ids')
        statuses = request.query_params.getlist('statuses')
        w_only = request.query_params.get('w_only') == '1'

        store_ids = [int(s) for s in store_ids] if store_ids else None
        statuses = statuses if statuses else None

        from django.db import connections
        where = ['1=1']
        params = []
        if store_ids:
            ph = ','.join(['%s'] * len(store_ids))
            where.append(f'p.store_id IN ({ph})')
            params.extend(store_ids)
        if statuses:
            ph = ','.join(['%s'] * len(statuses))
            where.append(f'p.status_type IN ({ph})')
            params.extend(statuses)
        if w_only:
            where.append("p.seller_management_code LIKE 'W%%'")

        with connections['myproduct'].cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) FROM smartstore_product p "
                f"JOIN smartstoreIdList s ON s.id = p.store_id "
                f"WHERE {' AND '.join(where)}", params)
            count = cur.fetchone()[0]
        return Response({'count': count})


class SmartStoreProductWCodesView(APIView):
    def get(self, request):
        store_ids = request.query_params.getlist('store_ids')
        statuses = request.query_params.getlist('statuses')

        store_ids = [int(s) for s in store_ids] if store_ids else None
        statuses = statuses if statuses else None

        codes = smartstore_product_service.get_w_codes(store_ids, statuses)
        return Response({'codes': codes})


class SmartStoreProductSuspendPreviewView(APIView):
    def post(self, request):
        product_ids = request.data.get('product_ids', [])
        select_all = request.data.get('select_all', False)
        filters = request.data.get('filters', {})
        result = smartstore_product_service.preview_suspend(product_ids, select_all, filters)
        return Response(result)


class SmartStoreProductSuspendView(APIView):
    def post(self, request):
        product_ids = request.data.get('product_ids', [])
        select_all = request.data.get('select_all', False)
        filters = request.data.get('filters', {})
        result = smartstore_product_service.suspend_products(product_ids, select_all, filters)
        return Response(result)


class SmartStoreProductFocusView(APIView):
    def post(self, request):
        product_ids = request.data.get('product_ids', [])
        is_focus = request.data.get('is_focus', 1)
        if not product_ids:
            return Response({'error': 'product_ids required'}, status=400)
        result = smartstore_product_service.toggle_focus(product_ids, is_focus)
        return Response(result)


class SmartStoreProductRestockCheckView(APIView):
    def post(self, request):
        product_ids = request.data.get('product_ids', [])
        checked = request.data.get('checked', 1)
        if not product_ids:
            return Response({'error': 'product_ids required'}, status=400)
        result = smartstore_product_service.toggle_restock_checked(product_ids, checked)
        return Response(result)


class SmartStoreProductOrphanWCodesView(APIView):
    def get(self, request):
        store_ids = request.query_params.getlist('store_ids')
        store_ids = [int(s) for s in store_ids] if store_ids else None
        codes = smartstore_product_service.get_orphan_w_codes(store_ids)
        return Response({'codes': codes, 'count': len(codes)})


class SmartStoreProductOrdersView(APIView):
    def get(self, request):
        code = request.query_params.get('code', '')
        product_name = request.query_params.get('product_name', '')
        start_date = request.query_params.get('start_date', '')
        end_date = request.query_params.get('end_date', '')
        if not code and not product_name:
            return Response({'error': 'code or product_name required'}, status=400)
        result = smartstore_order_service.get_product_orders(
            seller_code=code or None,
            product_name=product_name or None,
            start_date=start_date or None,
            end_date=end_date or None,
        )
        return Response(result)


# ── 스마트스토어 분석 ──

class SmartStoreAnalyticsOverviewView(APIView):
    def get(self, request):
        start_date = request.query_params.get('start_date') or None
        end_date = request.query_params.get('end_date') or None
        return Response(smartstore_analytics_service.get_overview(start_date, end_date))


class SmartStoreAnalyticsStoreDetailView(APIView):
    def get(self, request, store_id):
        start_date = request.query_params.get('start_date') or None
        end_date = request.query_params.get('end_date') or None
        period = request.query_params.get('period', 'monthly')
        return Response(smartstore_analytics_service.get_store_detail(
            store_id, start_date, end_date, period,
        ))


class SmartStoreAnalyticsBusinessDetailView(APIView):
    def get(self, request, code):
        start_date = request.query_params.get('start_date') or None
        end_date = request.query_params.get('end_date') or None
        period = request.query_params.get('period', 'monthly')
        return Response(smartstore_analytics_service.get_business_detail(
            code, start_date, end_date, period,
        ))


class SmartStoreAnalyticsSyncCategoriesView(APIView):
    def post(self, request):
        result = smartstore_analytics_service.sync_category_names()
        status_code = 400 if 'error' in result else 200
        return Response(result, status=status_code)


class SmartStoreRegistrationLimitView(APIView):
    def get(self, request):
        return Response(smartstore_analytics_service.get_registration_limits())


# ── 스토어 상품수집 (브라우저 자동화) ──

from . import store_collector


class StoreCollectStartView(APIView):
    def post(self, request):
        store_ids = request.data.get('store_ids')
        if store_ids is not None and not isinstance(store_ids, list):
            store_ids = [int(store_ids)]
        ok, msg = store_collector.start(store_ids)
        if not ok:
            return Response({'ok': False, 'message': msg}, status=409)
        return Response({'ok': True, 'message': msg})


class StoreCollectStatusView(APIView):
    def get(self, request):
        since = int(request.query_params.get('logSince', 0))
        st = store_collector.get_status()
        if since > 0:
            st['logs'] = [l for i, l in enumerate(st['logs']) if i >= since]
        return Response(st)


class StoreCollectStopView(APIView):
    def post(self, request):
        store_collector.stop()
        return Response({'ok': True})


class StoreCollectCsvView(APIView):
    def get(self, request):
        # store_name 또는 log_id로 CSV 다운로드
        store_name = request.query_params.get('store_name', '')
        log_id = request.query_params.get('log_id')

        file_path = None
        if log_id:
            # DB에서 파일 경로 조회
            logs = store_collector.get_collect_logs(limit=100)
            for log in logs:
                if str(log['id']) == str(log_id):
                    file_path = log.get('csv_file_path')
                    break
        elif store_name:
            file_path = store_collector.get_csv_file(store_name)

        if not file_path or not os.path.exists(file_path):
            return Response({'error': 'CSV 파일이 없습니다.'}, status=404)
        with open(file_path, 'rb') as f:
            response = HttpResponse(f.read(), content_type='text/csv; charset=utf-8-sig')
            fname = quote(os.path.basename(file_path))
            response['Content-Disposition'] = f"attachment; filename*=UTF-8''{fname}"
            return response


class StoreCollectLogsView(APIView):
    def get(self, request):
        limit = int(request.query_params.get('limit', 20))
        logs = store_collector.get_collect_logs(limit=limit)
        # datetime 직렬화
        for log in logs:
            if log.get('completed_at'):
                log['completed_at'] = str(log['completed_at'])
        return Response(logs)

    def delete(self, request):
        """실패 로그 삭제"""
        from django.db import connections
        with connections['myproduct'].cursor() as cur:
            cur.execute("DELETE FROM store_collect_log WHERE status = 'error'")
            deleted = cur.rowcount
        return Response({'deleted': deleted})


# ── 전상품 API 검증 ──

class ProductAuditStartView(APIView):
    def post(self, request):
        source = request.data.get('source', 'api')
        result = product_audit_service.start_audit(source=source)
        status = 200 if result['ok'] else 409
        return Response(result, status=status)


class ProductAuditStatusView(APIView):
    def get(self, request):
        return Response(product_audit_service.get_audit_status())


class ProductAuditStopView(APIView):
    def post(self, request):
        product_audit_service.stop_audit()
        return Response({'ok': True})


class ProductAuditLogsView(APIView):
    def get(self, request):
        limit = int(request.query_params.get('limit', 20))
        return Response(product_audit_service.get_audit_logs(limit=limit))


class ProductAuditLogDetailView(APIView):
    def get(self, request, pk):
        return Response(product_audit_service.get_audit_log_detail(pk))


# ── 상세페이지 크롤링 ──

class DetailCrawlStartView(APIView):
    def post(self, request):
        from smartstore.smartstore_product_service import start_detail_crawl
        batch_size = int(request.data.get('batch_size', 0))
        result = start_detail_crawl(batch_size=batch_size)
        status = 200 if result['ok'] else 409
        return Response(result, status=status)


class DetailCrawlStatusView(APIView):
    def get(self, request):
        from smartstore.smartstore_product_service import get_detail_crawl_status
        return Response(get_detail_crawl_status())


class DetailCrawlStopView(APIView):
    def post(self, request):
        from smartstore.smartstore_product_service import stop_detail_crawl
        stop_detail_crawl()
        return Response({'ok': True})


# ── 상품 편집 ──

class ProductFullDetailView(APIView):
    """상품 편집용 전체 상세 조회 (네이버 API v2 실시간)"""
    def get(self, request, opno):
        store_id = request.query_params.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        try:
            result = smartstore_product_service.get_product_full_detail(int(opno), int(store_id))
        except Exception as e:
            return Response({'error': str(e)}, status=500)
        if 'error' in result:
            return Response(result, status=400)
        return Response(result)


class ProductUpdateView(APIView):
    """상품 필드 수정 (GET→modify→PUT)"""
    def put(self, request, opno):
        store_id = request.data.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        updates = request.data.get('updates', {})
        if not updates:
            return Response({'error': 'updates required'}, status=400)
        try:
            result = smartstore_product_service.update_product_fields(int(opno), int(store_id), updates)
        except Exception as e:
            return Response({'error': str(e)}, status=500)
        if 'error' in result:
            return Response(result, status=400)
        return Response(result)


class ProductImageUploadView(APIView):
    """상품 이미지 네이버 CDN 업로드"""
    def post(self, request):
        store_id = request.data.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        image_file = request.FILES.get('image')
        if not image_file:
            return Response({'error': 'image file required'}, status=400)
        try:
            result = smartstore_product_service.upload_product_image(int(store_id), image_file)
        except Exception as e:
            return Response({'error': str(e)}, status=500)
        if 'error' in result:
            return Response(result, status=400)
        return Response(result)


class ZeroMarginPreviewView(APIView):
    """역마진 상품 0마진 가격 미리보기"""
    def get(self, request):
        store_id = request.query_params.get('store_id', 0)
        result = smartstore_product_service.zero_margin_preview(int(store_id))
        return Response(result)


class ZeroMarginUpdateView(APIView):
    """역마진 상품 가격을 0마진으로 일괄 수정"""
    def post(self, request):
        store_id = request.data.get('store_id', 0)
        try:
            result = smartstore_product_service.zero_margin_update(int(store_id))
        except Exception as e:
            return Response({'error': str(e)}, status=500)
        return Response(result)


class ZeroMarginLogsView(APIView):
    """0마진 처리 이력"""
    def get(self, request):
        limit = int(request.query_params.get('limit', 20))
        return Response(smartstore_product_service.zero_margin_logs(limit))


class ZeroMarginLogDetailView(APIView):
    """0마진 처리 상세"""
    def get(self, request, pk):
        items = smartstore_product_service.zero_margin_log_detail(pk)
        return Response({'items': items})
