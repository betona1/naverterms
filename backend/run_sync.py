#!/usr/bin/env python3
import os, sys, django, json, time, logging

os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
sys.path.insert(0, os.path.dirname(__file__))

logging.basicConfig(level=logging.INFO, format='%(message)s', stream=sys.stdout)

django.setup()

from ownerclan.ownerclan_product_service import sync_status_execute

print(f'[{time.strftime("%H:%M:%S")}] 동기화 시작...', flush=True)
result = sync_status_execute(mode='all')
print(f'[{time.strftime("%H:%M:%S")}] 동기화 완료', flush=True)
print(json.dumps({
    'success': result['success'],
    'fail': result['fail'],
    'skipped': result['skipped'],
    'detail': result['detail'],
    'skipped_items': result['skipped_items'][:30],
    'errors': result['errors'][:30],
}, ensure_ascii=False, indent=2), flush=True)
