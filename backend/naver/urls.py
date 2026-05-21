from django.urls import path
from . import views

urlpatterns = [
    # 키워드
    path('keywords/', views.KeywordListView.as_view()),
    path('keywords/<int:pk>/', views.KeywordDetailView.as_view()),
    path('keywords/<int:pk>/favorite/', views.KeywordFavoriteView.as_view()),

    # 결과보기 (최근 업데이트순 + 탭별 수집상태 + 즐겨찾기)
    path('results/keywords/', views.ResultsKeywordListView.as_view()),

    # 시계열 (스냅샷 list + 상품ID별 변동 history)
    path('snapshots/<int:keyword_id>/', views.SnapshotListView.as_view()),
    path('product-history/<int:keyword_id>/', views.ProductHistoryView.as_view()),

    # 수집 로그
    path('crawl-logs/', views.CrawlLogView.as_view()),

    # 확장프로그램 데이터 수신
    path('ext/search-result/', views.ExtSearchResultView.as_view()),
    path('ext/purchase-result/', views.ExtPurchaseResultView.as_view()),
    path('ext/captcha-status/', views.ExtCaptchaStatusView.as_view()),
    path('ext/rank-result/', views.ExtRankResultView.as_view()),

    # 분석
    path('analysis/<int:keyword_id>/', views.AnalysisView.as_view()),
    path('products/<int:keyword_id>/', views.ProductsView.as_view()),
    path('tags/<int:keyword_id>/', views.TagStatsView.as_view()),

    # 순위추적
    path('rank/track/', views.RunRankTrackingView.as_view()),
    path('rank/targets/', views.RankTargetListView.as_view()),
    path('rank/targets/<int:pk>/', views.RankTargetDetailView.as_view()),
    path('rank/history/', views.RankHistoryView.as_view()),
    path('rank/summary/', views.RankSummaryView.as_view()),
    path('rank/summary-grouped/', views.RankGroupedSummaryView.as_view()),
    path('rank/pivot/', views.RankPivotView.as_view()),
    path('rank/tracked-products/', views.RankTrackedProductsView.as_view()),
    path('rank/toggle-auto/', views.RankToggleAutoView.as_view()),

    # 스케줄
    path('schedules/', views.ScheduleListView.as_view()),
    path('schedules/<int:pk>/', views.ScheduleDetailView.as_view()),

    # 스마트 수집/분석
    path('collect/', views.SmartCollectView.as_view()),
    path('smart-analysis/<int:keyword_id>/', views.SmartAnalysisView.as_view()),

    # 데이터 초기화
    path('reset-data/', views.DataResetView.as_view()),

    # 연관키워드
    path('related-keywords/', views.RelatedKeywordView.as_view()),

    # 카테고리키워드 (데이터랩)
    path('datalab/categories/', views.DatalabCategoryView.as_view()),
    path('datalab/category-keywords/', views.DatalabCategoryKeywordRankView.as_view()),
    path('datalab/enrich-keywords/', views.KeywordEnrichView.as_view()),
    path('datalab/category-names/', views.CategoryNameLookupView.as_view()),
    path('datalab/auto-match/', views.KeywordAutoMatchView.as_view()),

    # UC 크롤러
    path('uc/start/', views.UCStartView.as_view()),
    path('uc/status/', views.UCStatusView.as_view()),
    path('uc/stop/', views.UCStopView.as_view()),

    # 구매키워드 (order 시스템 프록시)
    path('buy-keywords/<str:product_code>/', views.ProductBuyKeywordProxyView.as_view()),

    # 보고서
    path('reports/', views.ReportListView.as_view()),
    path('reports/<int:pk>/', views.ReportDetailView.as_view()),
    path('reports/<int:pk>/download/', views.ReportDownloadView.as_view()),

    # 순위컨닝
    path('rank-cunning/', views.RankCunningListView.as_view()),
    path('rank-cunning/<int:pk>/', views.RankCunningDetailView.as_view()),

    # 엑셀
    path('export/terms/', views.ExportTermsView.as_view()),
    path('export/rank/', views.ExportRankView.as_view()),
    path('export/products/<int:keyword_id>/', views.ExportProductsView.as_view()),

    # 동의어 (키워드별)
    path('synonyms/<int:keyword_id>/', views.SynonymListView.as_view()),
    path('synonyms/<int:keyword_id>/lookup/', views.SynonymLookupView.as_view()),
    path('synonyms/<int:keyword_id>/verify/', views.SynonymVerifyView.as_view()),
    path('synonyms/item/<int:pk>/', views.SynonymDetailView.as_view()),

    # 자동완성 (마켓별)
    path('autocomplete/', views.AutocompleteView.as_view()),

    # 구매수추적
    path('purchase/targets/', views.PurchaseTargetListView.as_view()),
    path('purchase/targets/<int:pk>/', views.PurchaseTargetDetailView.as_view()),
    path('purchase/track/', views.RunPurchaseTrackingView.as_view()),
    path('purchase/status/', views.PurchaseTrackStatusView.as_view()),
    path('purchase/stop/', views.PurchaseTrackStopView.as_view()),
    path('purchase/history/', views.PurchaseHistoryView.as_view()),
    path('purchase/summary/', views.PurchaseSummaryView.as_view()),
    path('purchase/toggle-auto/', views.PurchaseToggleAutoView.as_view()),
]
