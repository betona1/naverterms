"""중복 상품 초과분 품절처리(판매중지).

같은 스토어 내 동일 W코드(seller_management_code)가 2개 이상이면,
매출/판매상태 기준 1개만 유지하고 나머지(초과분)를 품절처리(SUSPENSION).
원본 DELETE 금지(CLAUDE.md) → 삭제 대신 판매중지.
"""
from __future__ import annotations

import time
from django.db import connections

from . import smartstore_product_service as sps

MYPRODUCT_DB = 'myproduct'

# 유지 우선순위: SALE > 그 외. 그 다음 매출 큰 것.
_STATUS_RANK = {'SALE': 3, 'OUTOFSTOCK': 2, 'WAIT': 1}


def scan_excess(store_id: int | None = None) -> dict:
    """중복 W코드 그룹 → 유지 1개 + 초과분(품절대상) 산출."""
    where = "s.seller_management_code<>'' AND s.seller_management_code IS NOT NULL"
    params: list = []
    if store_id:
        where += " AND s.store_id=%s"; params.append(int(store_id))
    with connections[MYPRODUCT_DB].cursor() as cur:
        # 중복 그룹
        cur.execute(
            f"SELECT s.store_id, s.seller_management_code FROM smartstore_product s "
            f"WHERE {where} GROUP BY s.store_id, s.seller_management_code HAVING COUNT(*)>1",
            params)
        groups = cur.fetchall()
        result = []
        excess_total = 0
        for sid, code in groups:
            cur.execute(
                "SELECT s.origin_product_no, s.name, s.status_type, "
                "COALESCE(s.all_order_amount,0), i.store_name "
                "FROM smartstore_product s LEFT JOIN smartstoreIdList i ON i.id=s.store_id "
                "WHERE s.store_id=%s AND s.seller_management_code=%s",
                [sid, code])
            rows = [{'origin_product_no': r[0], 'name': r[1], 'status_type': r[2],
                     'sales': float(r[3] or 0), 'store_name': r[4]} for r in cur.fetchall()]
            # 유지: SALE 우선 → 매출 큰 것 → opno 작은 것
            rows.sort(key=lambda x: (_STATUS_RANK.get(x['status_type'], 0), x['sales'], -x['origin_product_no']),
                      reverse=True)
            keep = rows[0]
            excess = [r for r in rows[1:] if r['status_type'] not in ('SUSPENSION', 'CLOSE', 'PROHIBITION')]
            excess_total += len(excess)
            result.append({'store_id': sid, 'store_name': keep['store_name'], 'product_code': code,
                           'keep': keep, 'excess': excess})
    return {'groups': result, 'group_count': len(result), 'excess_total': excess_total}


def suspend_excess(store_id: int | None = None, items: list[dict] | None = None) -> dict:
    """초과분 품절처리(SUSPENSION). items=[{store_id, origin_product_no}] 명시 가능,
    없으면 scan_excess 전체 초과분 대상."""
    if items is None:
        scan = scan_excess(store_id)
        items = [{'store_id': g['store_id'], 'origin_product_no': e['origin_product_no']}
                 for g in scan['groups'] for e in g['excess']]
    # 스토어별 토큰 캐시
    tokens: dict = {}
    ok = fail = 0
    results = []
    for it in items:
        sid = int(it['store_id']); opno = it['origin_product_no']
        try:
            if sid not in tokens:
                api, sec, _ = sps._get_store_credentials(sid)
                tokens[sid] = sps._get_access_token(api, sec)
            sps._change_product_status(opno, tokens[sid], status='SUSPENSION')
            with connections[MYPRODUCT_DB].cursor() as cur:
                cur.execute("UPDATE smartstore_product SET status_type='SUSPENSION' "
                            "WHERE store_id=%s AND origin_product_no=%s", [sid, opno])
            ok += 1; results.append({'origin_product_no': opno, 'ok': True})
        except Exception as e:
            fail += 1; results.append({'origin_product_no': opno, 'ok': False, 'error': str(e)[:150]})
        time.sleep(1)  # rate limit (GET+PUT)
    return {'ok': True, 'suspended': ok, 'failed': fail, 'results': results}
