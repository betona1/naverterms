from django.urls import path
from . import views

urlpatterns = [
    path('products/', views.OwnerClanProductListView.as_view()),
    path('products/<int:pk>/', views.OwnerClanProductDetailView.as_view()),
    path('products/upload/', views.OwnerClanProductUploadView.as_view()),
    path('products/csv-upload/', views.OwnerClanProductCsvUploadView.as_view()),
    path('products/soldout-txt/', views.OwnerClanSoldoutTxtUploadView.as_view()),
    path('products/activate/', views.OwnerClanProductActivateView.as_view()),
    path('products/sync/', views.OwnerClanProductSyncView.as_view()),
    path('products/stats/', views.OwnerClanProductStatsView.as_view()),
    path('products/changed-fields/', views.OwnerClanProductChangedFieldsView.as_view()),
    path('products/excel/', views.OwnerClanProductExcelExportView.as_view()),
    path('products/sample-excel/', views.OwnerClanProductSampleExcelView.as_view()),
    path('products/wcodes/', views.OwnerClanProductWCodesView.as_view()),
    path('products/soldout-sync-status/', views.OwnerClanSoldoutSyncStatusView.as_view()),
    path('products/sync-status/', views.OwnerClanSyncStatusPreviewView.as_view()),
    path('products/sync-status/execute/', views.OwnerClanSyncStatusExecuteView.as_view()),
    path('products/change-log/', views.OwnerClanChangeLogView.as_view()),
    path('products/change-log/dates/', views.OwnerClanChangeLogDatesView.as_view()),
    path('products/<int:pk>/change-log/', views.OwnerClanProductChangeLogView.as_view()),
]
