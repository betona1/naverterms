from django.urls import path
from . import views

urlpatterns = [
    # Store management
    path('stores/', views.SmartStoreStoreListView.as_view()),
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
]
