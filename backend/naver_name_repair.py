#!/usr/bin/env python3
"""v1.01 안전망을 기존 naver_product_name 에 LLM 호출 없이 일괄 재적용.

각 상품:
  1) 현재 상태(naver_product_name + name_version) 를 스냅샷 (롤백용)
  2) postprocess(product=ctx) 로 SET/COLOR 할루시네이션 제거
  3) 결과가 달라지면 naver_product_name 업데이트 + name_version='v1.01'

사용:
  python3 backend/naver_name_repair.py --dry-run                # 변경 미리보기
  python3 backend/naver_name_repair.py --apply --batch 1000     # 실제 적용
  python3 backend/naver_name_repair.py --apply --limit 50       # 50개만
  python3 backend/naver_name_repair.py --apply --folder 7       # 특정 폴더만
"""
from __future__ import annotations

import argparse
import os
import sys
import time

# Django 설정
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django  # noqa: E402
django.setup()

from django.db import connections  # noqa: E402
from smartstore import naver_name_generator as gen  # noqa: E402

DB = 'naverdb'

SCAN_FIELDS = (
    'id, product_code, product_name, naver_product_name, name_version, '
    'option1_name, option1_values, option2_name, option2_values, '
    'combined_option, product_attribute, keywords, model_name'
)


def _fetch_batch(cur, last_id: int, batch: int, folder_id: int | None) -> list[dict]:
    where = ['naver_product_name IS NOT NULL', 'id > %s']
    params: list = [last_id]
    if folder_id is not None:
        where.append('folder_id=%s')
        params.append(folder_id)
    where_sql = ' AND '.join(where)
    cur.execute(
        f"SELECT {SCAN_FIELDS} FROM naver_my_product "
        f"WHERE {where_sql} ORDER BY id ASC LIMIT %s",
        params + [batch],
    )
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _apply_safety_net(name: str, product: dict) -> str:
    """LLM 결과 후처리 단계만 재실행 — 핵심: SET/COLOR 안전망."""
    evidence = gen._build_evidence_blob(product)
    out = gen._strip_set_hallucination(name, evidence)
    out = gen._strip_color_hallucination(out, evidence)
    out = gen._normalize_whitespace(out)
    out = gen._dedupe_tokens(out)
    out = gen._truncate_to_naver_limit(out)
    return out


def run(apply: bool, batch: int, limit: int | None, folder_id: int | None) -> dict:
    t0 = time.time()
    scanned = 0
    changed = 0
    set_fixes = 0
    color_fixes = 0
    samples: list[dict] = []
    last_id = 0

    while True:
        with connections[DB].cursor() as cur:
            rows = _fetch_batch(cur, last_id, batch, folder_id)
        if not rows:
            break
        for r in rows:
            scanned += 1
            last_id = r['id']
            before = r['naver_product_name'] or ''
            after = _apply_safety_net(before, r)
            if after == before:
                continue
            # 차이가 세트/색상 어느 쪽인지 분류
            removed = set(before.split()) - set(after.split())
            had_set = any(
                ('세트' in t or '묶음' in t or '패키지' in t
                 or '개입' in t or '개세트' in t or t in ('1+1','2+1','3+1'))
                for t in removed
            ) or any(p.search(before) for p in gen.SET_NOISE_PATTERNS) and not any(p.search(after) for p in gen.SET_NOISE_PATTERNS)
            had_color = any(t in gen.COLOR_TOKENS for t in removed)
            if had_set:
                set_fixes += 1
            if had_color:
                color_fixes += 1
            changed += 1

            if len(samples) < 20:
                samples.append({
                    'id': r['id'], 'code': r['product_code'],
                    'before': before, 'after': after,
                    'set': had_set, 'color': had_color,
                })

            if apply:
                with connections[DB].cursor() as cur:
                    # 스냅샷 (현재 상태 보존)
                    cur.execute(
                        """INSERT INTO naver_name_version_snapshot
                             (product_id, product_code, version_tag, naver_product_name, source, note)
                           VALUES (%s, %s, %s, %s, 'auto', 'before v1.01 repair')""",
                        [r['id'], r['product_code'], r['name_version'] or 'unknown', before],
                    )
                    cur.execute(
                        """UPDATE naver_my_product
                              SET naver_product_name_before = naver_product_name,
                                  naver_product_name = %s,
                                  name_version = %s,
                                  updated_at = NOW()
                            WHERE id=%s""",
                        [after, gen.NAVER_NAME_VERSION, r['id']],
                    )
            if limit is not None and scanned >= limit:
                break
        if limit is not None and scanned >= limit:
            break
        # 진행 출력
        print(f'  scanned={scanned} changed={changed} '
              f'(set={set_fixes} color={color_fixes}) last_id={last_id}')

    return {
        'scanned': scanned,
        'changed': changed,
        'set_fixes': set_fixes,
        'color_fixes': color_fixes,
        'samples': samples,
        'elapsed_s': round(time.time() - t0, 2),
        'applied': apply,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='실제 DB 적용 (없으면 dry-run)')
    ap.add_argument('--dry-run', action='store_true', help='기본 — 변경만 카운트')
    ap.add_argument('--batch', type=int, default=1000)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--folder', type=int, default=None)
    args = ap.parse_args()

    apply = bool(args.apply)
    print(f'[v1.01 repair] mode={"APPLY" if apply else "DRY-RUN"} '
          f'batch={args.batch} limit={args.limit} folder={args.folder}')
    r = run(apply=apply, batch=args.batch, limit=args.limit, folder_id=args.folder)
    print()
    print('── 결과 ──────────────────────────────────────')
    print(f'  scanned     : {r["scanned"]:,}')
    print(f'  changed     : {r["changed"]:,}')
    print(f'  set_fixes   : {r["set_fixes"]:,}')
    print(f'  color_fixes : {r["color_fixes"]:,}')
    print(f'  elapsed     : {r["elapsed_s"]}s')
    print(f'  applied     : {r["applied"]}')
    print()
    print('── 샘플 변경 (최대 20개) ─────────────────────')
    for s in r['samples']:
        tag = ('S' if s['set'] else '') + ('C' if s['color'] else '')
        print(f'  [{tag:2}] W{s["code"]}')
        print(f'    before: {s["before"]}')
        print(f'    after : {s["after"]}')


if __name__ == '__main__':
    main()
