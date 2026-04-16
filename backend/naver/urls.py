from django.urls import path
from . import views

urlpatterns = [
    # 키워드
    path('keywords/', views.KeywordListView.as_view()),
    path('keywords/<int:pk>/', views.KeywordDetailView.as_view()),

    # 확장프로그램 데이터 수신
    path('ext/search-result/', views.ExtSearchResultView.as_view()),
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

    # 스케줄
    path('schedules/', views.ScheduleListView.as_view()),
    path('schedules/<int:pk>/', views.ScheduleDetailView.as_view()),

    # 데이터 초기화
    path('reset-data/', views.DataResetView.as_view()),

    # UC 크롤러
    path('uc/start/', views.UCStartView.as_view()),
    path('uc/status/', views.UCStatusView.as_view()),
    path('uc/stop/', views.UCStopView.as_view()),

    # 엑셀
    path('export/terms/', views.ExportTermsView.as_view()),
    path('export/rank/', views.ExportRankView.as_view()),
]
