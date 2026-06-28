"""SMS Admin (192.168.219.227:9999) API 클라이언트.

매뉴얼: http://192.168.219.227:9998/docs/INTEGRATION_GUIDE
환경변수: SMS_ADMIN_URL, SMS_ADMIN_KEY (.env)
"""
import logging
import os

import requests

log = logging.getLogger(__name__)

SMS_ADMIN_URL = os.environ.get('SMS_ADMIN_URL', 'http://192.168.219.227:9999')
SMS_ADMIN_KEY = os.environ.get('SMS_ADMIN_KEY', 'ai100-7e9b3a')
DEFAULT_SENDER = os.environ.get('SMS_ADMIN_DEFAULT_SENDER', '01075502753')


def _post(path: str, body: dict, timeout: int = 5) -> dict | None:
    if not SMS_ADMIN_KEY:
        log.warning('SMS_ADMIN_KEY 미설정 — sms_client 비활성')
        return None
    try:
        r = requests.post(
            f'{SMS_ADMIN_URL}{path}',
            headers={'X-API-Key': SMS_ADMIN_KEY, 'Content-Type': 'application/json'},
            json=body, timeout=timeout,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning(f'sms-admin {path} 실패: {e}')
        return None


def send_sms(phone: str, message: str, sender: str | None = None) -> dict | None:
    return _post('/api/v1/send/', {
        'phone_number': phone, 'message': message,
        'sender_phone': sender or DEFAULT_SENDER,
    })


def send_bulk(phones: list[str], message: str, sender: str | None = None) -> dict | None:
    return _post('/api/v1/send/', {
        'phone_numbers': phones, 'message': message,
        'sender_phone': sender or DEFAULT_SENDER,
    })


def send_template(template_id: int, vars: dict, phone: str, sender: str | None = None) -> dict | None:
    return _post('/api/v1/send-template/', {
        'template_id': template_id, 'vars': vars,
        'phone_number': phone, 'sender_phone': sender or DEFAULT_SENDER,
    })
