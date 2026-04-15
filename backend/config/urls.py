from django.conf import settings
from django.conf.urls.static import static
from django.urls import path, include

urlpatterns = [
    path('api/naver/', include('naver.urls')),
    path('api/smartstore/', include('smartstore.urls')),
] + static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])
