from django.conf import settings
from django.conf.urls.static import static
from django.urls import path, include
from config.env_views import ApiKeyView

urlpatterns = [
    path('api/naver/', include('naver.urls')),
    path('api/smartstore/', include('smartstore.urls')),
    path('api/settings/api-keys/', ApiKeyView.as_view()),
] + static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])
