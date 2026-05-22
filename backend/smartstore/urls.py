from django.urls import path
from . import views

urlpatterns = [
    # Store management
    path('stores/', views.SmartStoreStoreListView.as_view()),
    path('stores/counts/', views.SmartStoreStoreCountsView.as_view()),
    path('stores/sample-excel/', views.SmartStoreStoreSampleExcelView.as_view()),
    path('stores/upload/', views.SmartStoreStoreBulkUploadView.as_view()),
    path('stores/<int:pk>/', views.SmartStoreStoreDetailView.as_view()),

    # Product management
    path('products/', views.SmartStoreProductListView.as_view()),
    path('products/search/', views.SmartStoreProductSearchView.as_view()),
    path('products/sync/', views.SmartStoreProductSyncView.as_view()),
    path('products/stats/', views.SmartStoreProductStatsView.as_view()),
    path('products/refresh-tracking/', views.SmartStoreRefreshTrackingView.as_view()),
    path('products/excel/', views.SmartStoreProductExcelView.as_view()),
    path('products/count/', views.SmartStoreProductCountView.as_view()),
    path('products/wcodes/', views.SmartStoreProductWCodesView.as_view()),
    path('products/suspend-preview/', views.SmartStoreProductSuspendPreviewView.as_view()),
    path('products/suspend/', views.SmartStoreProductSuspendView.as_view()),
    path('products/focus/', views.SmartStoreProductFocusView.as_view()),
    path('products/restock-check/', views.SmartStoreProductRestockCheckView.as_view()),
    path('products/orders/', views.SmartStoreProductOrdersView.as_view()),
    path('products/orphan-wcodes/', views.SmartStoreProductOrphanWCodesView.as_view()),
    path('products/sales-snapshot/', views.SmartStoreSalesSnapshotView.as_view()),
    path('products/sync-logs/', views.SmartStoreSyncLogView.as_view()),
    path('products/sync-logs/<int:pk>/', views.SmartStoreSyncLogDetailView.as_view()),

    # Analytics
    path('analytics/overview/', views.SmartStoreAnalyticsOverviewView.as_view()),
    path('analytics/store/<int:store_id>/', views.SmartStoreAnalyticsStoreDetailView.as_view()),
    path('analytics/business/<str:code>/', views.SmartStoreAnalyticsBusinessDetailView.as_view()),
    path('analytics/sync-categories/', views.SmartStoreAnalyticsSyncCategoriesView.as_view()),
    path('analytics/registration-limits/', views.SmartStoreRegistrationLimitView.as_view()),

    # Store collection (browser automation)
    path('collect/start/', views.StoreCollectStartView.as_view()),
    path('collect/status/', views.StoreCollectStatusView.as_view()),
    path('collect/stop/', views.StoreCollectStopView.as_view()),
    path('collect/csv/', views.StoreCollectCsvView.as_view()),
    path('collect/logs/', views.StoreCollectLogsView.as_view()),

    # Product audit (전상품 API 검증)
    path('products/audit/start/', views.ProductAuditStartView.as_view()),
    path('products/audit/status/', views.ProductAuditStatusView.as_view()),
    path('products/audit/stop/', views.ProductAuditStopView.as_view()),
    path('products/audit/logs/', views.ProductAuditLogsView.as_view()),
    path('products/audit/logs/<int:pk>/', views.ProductAuditLogDetailView.as_view()),

    # Detail crawl (상세페이지 병렬 크롤링)
    path('products/detail-crawl/start/', views.DetailCrawlStartView.as_view()),
    path('products/detail-crawl/status/', views.DetailCrawlStatusView.as_view()),
    path('products/detail-crawl/stop/', views.DetailCrawlStopView.as_view()),

    # Zero margin (0마진 처리)
    path('products/zero-margin/preview/', views.ZeroMarginPreviewView.as_view()),
    path('products/zero-margin/update/', views.ZeroMarginUpdateView.as_view()),
    path('products/zero-margin/logs/', views.ZeroMarginLogsView.as_view()),
    path('products/zero-margin/logs/<int:pk>/', views.ZeroMarginLogDetailView.as_view()),

    # Product editing (상품 편집)
    path('products/<int:opno>/detail/', views.ProductFullDetailView.as_view()),
    path('products/<int:opno>/update/', views.ProductUpdateView.as_view()),
    path('products/upload-image/', views.ProductImageUploadView.as_view()),

    # 상품속성 분석 (Stage A/B/C 크롤 결과)
    path('attr/stats/', views.AttrStatsView.as_view()),
    path('attr/products/', views.AttrProductsListView.as_view()),
    path('attr/products/<str:seller_code>/', views.AttrProductDetailView.as_view()),
    path('attr/tags/top/', views.AttrTopTagsView.as_view()),
    path('attr/quality/issues/', views.AttrQualityIssuesView.as_view()),
    path('attr/categories/', views.AttrCategorySummaryView.as_view()),
    path('attr/attributes/top/', views.AttrTopAttributesView.as_view()),
    path('attr/attributes/values/', views.AttrValuesView.as_view()),

    # 빈 속성 검토 + 등록
    path('missing-attrs/summary/', views.MissingAttrsSummaryView.as_view()),
    path('missing-attrs/refresh-summary/', views.MissingAttrsRefreshSummaryView.as_view()),
    path('missing-attrs/', views.MissingAttrsListView.as_view()),
    path('missing-attrs/skus/', views.MissingAttrsSkuListView.as_view()),
    path('missing-attrs/skus/<str:seller_code>/', views.MissingAttrsForSkuView.as_view()),
    path('missing-attrs/skus/<str:seller_code>/register/', views.MissingAttrsRegisterSkuView.as_view()),
    path('missing-attrs/<int:attribute_seq>/', views.MissingAttrsDetailView.as_view()),
    path('missing-attrs/<int:attribute_seq>/skus/', views.MissingAttrsSkusView.as_view()),
    path('missing-attrs/register/', views.MissingAttrsRegisterView.as_view()),
    path('missing-attrs/register-filtered/', views.MissingAttrsRegisterFilteredView.as_view()),
    path('missing-attrs/mark/', views.MissingAttrsMarkView.as_view()),

    # 워커 대시보드
    path('workers/', views.WorkerDashboardView.as_view()),

    # 네이버 나의상품 (11번가 my_product 미러)
    path('naver-products/', views.NaverMyProductListView.as_view()),
    path('naver-products/folders/', views.NaverMyProductFolderListView.as_view()),
    path('naver-products/folders/sync/', views.NaverMyProductFolderSyncView.as_view()),
    path('naver-products/import-from-11st/', views.NaverMyProductImportFrom11stView.as_view()),
    path('naver-products/import-status/', views.NaverMyProductImportStatusView.as_view()),
    path('naver-products/<int:pk>/generate-name/', views.NaverMyProductGenerateNameView.as_view()),
    path('naver-products/<int:pk>/analyze-image/', views.NaverMyProductAnalyzeImageView.as_view()),
    path('naver-products/enqueue/', views.NaverMyProductEnqueueView.as_view()),
    path('naver-products/queue-status/', views.NaverMyProductQueueStatusView.as_view()),
    path('naver-products/excel/', views.NaverMyProductExcelView.as_view()),
    path('naver-products/move/', views.NaverMyProductMoveView.as_view()),
    path('naver-products/<int:pk>/', views.NaverMyProductDetailView.as_view()),
    path('naver-products/<int:pk>/clear-vision/', views.NaverMyProductClearVisionView.as_view()),
    path('naver-products/<int:pk>/keyword-pool/', views.NaverMyProductKeywordPoolView.as_view()),
]
