from django.urls import path
from .gpu_monitor_views import GpuStatusView, GpuLogsView, GpuBulkProgressStubView

urlpatterns = [
    path('status/', GpuStatusView.as_view()),
    path('logs/', GpuLogsView.as_view()),
    path('bulk-progress/', GpuBulkProgressStubView.as_view()),
]
