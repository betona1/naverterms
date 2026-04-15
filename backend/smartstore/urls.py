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
    path('products/sync/', views.SmartStoreProductSyncView.as_view()),
    path('products/stats/', views.SmartStoreProductStatsView.as_view()),
    path('products/excel/', views.SmartStoreProductExcelView.as_view()),
    path('products/wcodes/', views.SmartStoreProductWCodesView.as_view()),
    path('products/suspend-preview/', views.SmartStoreProductSuspendPreviewView.as_view()),
    path('products/suspend/', views.SmartStoreProductSuspendView.as_view()),
    path('products/focus/', views.SmartStoreProductFocusView.as_view()),
    path('products/orders/', views.SmartStoreProductOrdersView.as_view()),
]
