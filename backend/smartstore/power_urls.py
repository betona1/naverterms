from django.urls import path
from .power_views import PowerWorkersView, PowerStatusView, PowerWakeView, PowerShutdownView

urlpatterns = [
    path('workers/', PowerWorkersView.as_view()),
    path('status/', PowerStatusView.as_view()),
    path('wake/', PowerWakeView.as_view()),
    path('shutdown/', PowerShutdownView.as_view()),
]
