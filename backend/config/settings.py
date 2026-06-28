import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR.parent / '.env')

SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', 'django-insecure-dev-key')
DEBUG = True
ALLOWED_HOSTS = ['*']

INSTALLED_APPS = [
    'django.contrib.contenttypes',
    'django.contrib.staticfiles',
    'corsheaders',
    'rest_framework',
    'naver',
    'smartstore',
    'ownerclan',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('NAVER_DB_NAME', 'naverdb'),
        'HOST': os.getenv('NAVER_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('NAVER_DB_PORT', 3306)),
        'USER': os.getenv('NAVER_DB_USER', 'root'),
        'PASSWORD': os.getenv('NAVER_DB_PASSWORD', '').strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
    'naverdb': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('NAVER_DB_NAME', 'naverdb'),
        'HOST': os.getenv('NAVER_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('NAVER_DB_PORT', 3306)),
        'USER': os.getenv('NAVER_DB_USER', 'root'),
        'PASSWORD': os.getenv('NAVER_DB_PASSWORD', '').strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
    'myproduct': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('MYPRODUCT_DB_NAME', 'myproduct'),
        'HOST': os.getenv('MYPRODUCT_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('MYPRODUCT_DB_PORT', 3306)),
        'USER': os.getenv('MYPRODUCT_DB_USER', 'root'),
        'PASSWORD': os.getenv('MYPRODUCT_DB_PASSWORD', '').strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
    'joacham': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': 'joacham',
        'HOST': os.getenv('MYPRODUCT_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('MYPRODUCT_DB_PORT', 3306)),
        'USER': os.getenv('MYPRODUCT_DB_USER', 'root'),
        'PASSWORD': os.getenv('MYPRODUCT_DB_PASSWORD', '').strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
    'ads': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('ADS_DB_NAME', 'ads'),
        'HOST': os.getenv('ADS_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('ADS_DB_PORT', 3306)),
        'USER': os.getenv('ADS_DB_USER', 'root'),
        'PASSWORD': os.getenv('ADS_DB_PASSWORD', os.getenv('MYPRODUCT_DB_PASSWORD', '')).strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
    # owimage: good/bad 상품이미지 분류 DB (goodimage/badimage by W코드)
    'owimage': {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('OWIMAGE_DB_NAME', 'owimagedb'),
        'HOST': os.getenv('OWIMAGE_DB_HOST', '192.168.219.200'),
        'PORT': int(os.getenv('OWIMAGE_DB_PORT', 3306)),
        'USER': os.getenv('OWIMAGE_DB_USER', 'owlohas1'),
        'PASSWORD': os.getenv('OWIMAGE_DB_PASSWORD', '').strip("'"),
        'OPTIONS': {'charset': 'utf8mb4'},
    },
}

DATABASE_ROUTERS = ['config.db_router.NaverDbRouter']

REST_FRAMEWORK = {
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
    'UNAUTHENTICATED_USER': None,
    'UNICODE_JSON': True,
}

CORS_ALLOW_ALL_ORIGINS = True

LANGUAGE_CODE = 'ko-kr'
TIME_ZONE = 'Asia/Seoul'
USE_I18N = True
USE_TZ = False

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# 상품 일괄등록 대표이미지 공인 호스팅 (joacham 이미지 호스팅, 업스케일 W코드_1.jpg)
PUBLIC_MEDIA_BASE_URL = os.getenv('PUBLIC_MEDIA_BASE_URL', '')

# 이미지 AI 마이크로서비스 (port 8902)
IMAGE_AI_BASE_URL = os.getenv('IMAGE_AI_BASE_URL', 'http://localhost:8902')

# Telegram
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', '')
