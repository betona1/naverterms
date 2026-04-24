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

# Telegram
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', '')
