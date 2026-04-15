from io import BytesIO
from urllib.parse import quote

from django.http import HttpResponse
from rest_framework.views import APIView
from rest_framework.response import Response

from . import smartstore_service
from . import smartstore_product_service
from . import smartstore_order_service


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
    def get(self, request):
        store_id = request.query_params.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        page = int(request.query_params.get('page', 1))
        per_page = int(request.query_params.get('per_page', 50))
        status = request.query_params.get('status') or None
        search = request.query_params.get('search') or None
        ownerclan_soldout = request.query_params.get('ownerclan_soldout')
        is_focus = request.query_params.get('is_focus')
        has_orders = request.query_params.get('has_orders')
        sort_by = request.query_params.get('sort_by') or None
        sort_dir = request.query_params.get('sort_dir') or None
        result = smartstore_product_service.get_products(
            int(store_id), page, per_page, status, search,
            ownerclan_soldout=int(ownerclan_soldout) if ownerclan_soldout is not None else None,
            is_focus=int(is_focus) if is_focus is not None else None,
            has_orders=int(has_orders) if has_orders is not None else None,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        return Response(result)


class SmartStoreProductSyncView(APIView):
    def post(self, request):
        store_id = request.data.get('store_id')
        if not store_id:
            return Response({'error': 'store_id required'}, status=400)
        result = smartstore_product_service.sync_products(int(store_id))
        if 'error' in result:
            return Response(result, status=400)
        return Response(result)


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

        store_ids = [int(s) for s in store_ids] if store_ids else None
        statuses = statuses if statuses else None

        rows = smartstore_product_service.get_products_for_export(store_ids, statuses, w_only)

        wb = Workbook()
        ws = wb.active
        ws.title = '상품목록'

        headers = ['상점명', '상품번호', '채널상품번호', '상품명', '판매가',
                    '재고', '상태', '노출상태', '관리코드', '카테고리ID', '동기화일시']
        col_widths = [15, 14, 14, 40, 12, 8, 10, 10, 18, 14, 20]

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
            synced = r['synced_at']
            if hasattr(synced, 'strftime'):
                synced = synced.strftime('%Y-%m-%d %H:%M:%S')
            ws.cell(row=i, column=11, value=synced or '').border = thin_border

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
