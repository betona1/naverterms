from django.urls import path
from .workers_unified_views import (
    WorkersGpuView, WorkersCrawlView, WorkersCrawlLogsView, WorkersCrawlHeartbeatView,
)

urlpatterns = [
    path('gpu/', WorkersGpuView.as_view()),
    path('crawl/', WorkersCrawlView.as_view()),
    path('crawl/heartbeat/', WorkersCrawlHeartbeatView.as_view()),
    path('crawl/<str:key>/logs/', WorkersCrawlLogsView.as_view()),
]
