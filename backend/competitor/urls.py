from django.urls import path
from . import views

urlpatterns = [
    path('products/', views.CompetitorProductListView.as_view()),
    path('products/<int:pk>/', views.CompetitorProductDetailView.as_view()),
    path('crawl/', views.CompetitorCrawlView.as_view()),
    path('crawl/status/', views.CompetitorCrawlStatusView.as_view()),
    path('snapshots/<int:pk>/', views.CompetitorSnapshotView.as_view()),
    path('ext/stock/', views.CompetitorExtStockView.as_view()),
    path('export/', views.CompetitorExportView.as_view()),
]
