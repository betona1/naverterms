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
    'competitor',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
]

ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

_DB_HOST = os.getenv('DB_HOST', 'localhost')
_DB_PORT = int(os.getenv('DB_PORT', 3306))
_DB_USER = os.getenv('DB_USER', 'mueres')
_DB_PASS = os.getenv('DB_PASSWORD', 'mueres').strip("'")

def _db(name):
    return {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': name,
        'HOST': _DB_HOST,
        'PORT': _DB_PORT,
        'USER': _DB_USER,
        'PASSWORD': _DB_PASS,
        'OPTIONS': {'charset': 'utf8mb4'},
    }

DATABASES = {
    'default':   _db(os.getenv('NAVER_DB_NAME', 'naver')),
    'naverdb':   _db(os.getenv('NAVER_DB_NAME', 'naver')),
    'myproduct': _db(os.getenv('MYPRODUCT_DB_NAME', 'myproduct')),
    'joacham':   _db(os.getenv('MYPRODUCT_DB_NAME', 'myproduct')),
    'ads':       _db(os.getenv('NAVER_DB_NAME', 'naver')),
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
