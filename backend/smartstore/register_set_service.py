"""네이버 상품 일괄등록 — 등록 세트(프로파일) CRUD + 판매가 계산.

판매가 공식:
  목표가 = 원가×margin_rate + 원가×fee_rate + 배송비조정 + 리뷰포인트합
    배송비조정 = (원본배송비 − set_ship_fee);  free_shipping 이면 +set_ship_fee 환원
                 ⇒ 무료배송: +원본배송비 / 유료배송: +(원본배송비 − set_ship_fee)
  정가     = round10( 목표가 × (1 + discount_rate) )       # 11000 올려 10000 판매
  즉시할인 = 정가 − 목표가 (정액)                          # 고객 실결제 = 목표가
"""
from __future__ import annotations

from django.db import connections

NAVERDB = 'naverdb'

SET_FIELDS = [
    'id', 'folder_id', 'name',
    'margin_rate', 'fee_rate', 'set_ship_fee', 'free_shipping',
    'discount_rate', 'review_point_text', 'review_point_photo',
    'delivery_company_code', 'delivery_fee_type', 'base_ship_fee',
    'free_cond_amount', 'return_fee', 'exchange_fee',
    'default_stock', 'vat_type', 'product_state', 'origin_code',
    'as_phone', 'as_guide',
]
# 사용자 수정 가능 컬럼 (id/folder_id/타임스탬프 제외)
EDITABLE = [f for f in SET_FIELDS if f not in ('id', 'folder_id')]

DEFAULTS = {
    'name': '기본세트',
    'margin_rate': 1.5, 'fee_rate': 0.07, 'set_ship_fee': 3000, 'free_shipping': 1,
    'discount_rate': 0.0, 'review_point_text': 0, 'review_point_photo': 0,
    'delivery_company_code': 'CJGLS', 'delivery_fee_type': '무료', 'base_ship_fee': 0,
    'free_cond_amount': None, 'return_fee': 5000, 'exchange_fee': 10000,
    'default_stock': 999, 'vat_type': '과세상품', 'product_state': '신상품',
    'origin_code': '03', 'as_phone': None, 'as_guide': None,
}


def _round10(v: float) -> int:
    """10원 단위 반올림 (네이버 판매가 규칙)."""
    return int(round(v / 10.0)) * 10


def compute_price(set_row: dict, cost: int, orig_ship_fee: int = 0) -> dict:
    """세트 + 상품 원가/원본배송비 → 가격 계산 결과 dict.

    cost           : 오너클랜 원가
    orig_ship_fee  : 상품 원본배송비 (B)
    """
    cost = int(cost or 0)
    B = int(orig_ship_fee or 0)
    m = float(set_row.get('margin_rate') or 0)
    f = float(set_row.get('fee_rate') or 0)
    S = int(set_row.get('set_ship_fee') or 0)
    free = int(set_row.get('free_shipping') or 0) == 1
    d = float(set_row.get('discount_rate') or 0)
    rp = int(set_row.get('review_point_text') or 0) + int(set_row.get('review_point_photo') or 0)

    margin_amt = cost * m
    fee_amt = cost * f
    ship_adj = (B - S) + (S if free else 0)   # 무료: +B / 유료: +(B-S)
    review_amt = rp

    target = margin_amt + fee_amt + ship_adj + review_amt          # 고객 실결제 목표가
    list_price = _round10(target * (1 + d))                        # 등록 판매가(정가)
    discount_amt = max(0, list_price - _round10(target))           # 즉시할인 정액
    net_margin = target - cost - fee_amt - (B if free else 0)      # 대략 순마진(배송원가 차감)

    return {
        'cost': cost,
        'orig_ship_fee': B,
        'margin_amount': round(margin_amt),
        'fee_amount': round(fee_amt),
        'ship_adjust': round(ship_adj),
        'review_amount': review_amt,
        'target_price': _round10(target),     # 고객 결제가(10원 정렬)
        'list_price': list_price,             # 상품 판매가(정가)
        'discount_amount': discount_amt,      # 즉시할인 정액
        'discount_rate': d,
        'net_margin': round(net_margin),
    }


# ── CRUD ──────────────────────────────────────────────────────────────

def _row_to_dict(cur, row) -> dict:
    cols = [c[0] for c in cur.description]
    return dict(zip(cols, row))


def get_set(folder_id: int) -> dict | None:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"SELECT {', '.join(SET_FIELDS)} FROM naver_register_set WHERE folder_id=%s",
            [int(folder_id)])
        row = cur.fetchone()
        return _row_to_dict(cur, row) if row else None


def get_or_create_set(folder_id: int, store_name: str | None = None) -> dict:
    existing = get_set(folder_id)
    if existing:
        return existing
    name = (store_name or '기본세트')[:100]
    cols = ['folder_id', 'name']
    vals = [int(folder_id), name]
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"INSERT INTO naver_register_set ({', '.join(cols)}) VALUES (%s, %s)",
            vals)
    return get_set(folder_id)


def upsert_set(folder_id: int, payload: dict) -> dict:
    """folder_id 기준 UPSERT. payload 의 EDITABLE 키만 반영."""
    folder_id = int(folder_id)
    data = {k: payload[k] for k in EDITABLE if k in payload}
    if not get_set(folder_id):
        # 신규 → 기본값 + payload 머지
        merged = dict(DEFAULTS)
        merged.update(data)
        cols = ['folder_id'] + list(merged.keys())
        ph = ', '.join(['%s'] * len(cols))
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                f"INSERT INTO naver_register_set ({', '.join(cols)}) VALUES ({ph})",
                [folder_id] + list(merged.values()))
    elif data:
        set_clause = ', '.join(f"{k}=%s" for k in data)
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                f"UPDATE naver_register_set SET {set_clause} WHERE folder_id=%s",
                list(data.values()) + [folder_id])
    return get_set(folder_id)


def ensure_set(folder_id: int, store_name: str | None = None,
               ref_folder_id: int = 17) -> dict:
    """세트 없으면 기준 스토어(기본 행원만물상=17) 세트를 복제해 생성."""
    folder_id = int(folder_id)
    existing = get_set(folder_id)
    if existing:
        return existing
    ref = get_set(ref_folder_id)
    if ref:
        payload = {k: ref[k] for k in EDITABLE}
        payload['name'] = (store_name or ref.get('name') or '기본세트')[:100]
        return upsert_set(folder_id, payload)
    return get_or_create_set(folder_id, store_name)


def list_sets() -> list[dict]:
    with connections[NAVERDB].cursor() as cur:
        cur.execute(f"SELECT {', '.join(SET_FIELDS)} FROM naver_register_set ORDER BY folder_id")
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
