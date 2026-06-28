"""상품 일괄등록 레퍼런스 적재.

docs/*.xls (카테고리/택배사/원산지) → naverdb 레퍼런스 테이블 upsert.
naver_register.sql 의 테이블도 함께 보장(없으면 생성).

사용:
  python3 import_register_refs.py
  python3 import_register_refs.py --docs ../docs
"""
import os, sys, glob, argparse

import django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.db import connections
from python_calamine import CalamineWorkbook

NAVERDB = 'naverdb'
HERE = os.path.dirname(os.path.abspath(__file__))


def _latest(docs_dir: str, pattern: str) -> str | None:
    hits = sorted(glob.glob(os.path.join(docs_dir, pattern)))
    return hits[-1] if hits else None


def _rows(path: str) -> list[list]:
    wb = CalamineWorkbook.from_path(path)
    data = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
    return data


def ensure_tables() -> None:
    sql_path = os.path.join(HERE, 'sql', 'naver_register.sql')
    with open(sql_path, encoding='utf-8') as f:
        ddl = f.read()
    # 주석(-- ...) 라인 먼저 제거 (주석 안의 ; 로 인한 오분리 방지)
    clean = '\n'.join(l for l in ddl.splitlines() if not l.lstrip().startswith('--'))
    stmts = [s.strip() for s in clean.split(';') if s.strip()]
    with connections[NAVERDB].cursor() as cur:
        for s in stmts:
            cur.execute(s)
    print('[ddl] tables ensured')


def load_category(docs_dir: str) -> int:
    path = _latest(docs_dir, 'category_*.xls')
    if not path:
        print('[category] 파일 없음 — 스킵')
        return 0
    rows = _rows(path)[1:]  # 헤더 제외
    n = 0
    with connections[NAVERDB].cursor() as cur:
        for r in rows:
            if not r or not str(r[0]).strip():
                continue
            code = str(r[0]).strip()
            c1, c2, c3, c4 = (str(r[i]).strip() if i < len(r) and r[i] is not None else None
                              for i in (1, 2, 3, 4))
            full = '>'.join([x for x in (c1, c2, c3, c4) if x])
            cur.execute(
                """INSERT INTO naver_category_ref (category_code, cat1, cat2, cat3, cat4, full_name)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON DUPLICATE KEY UPDATE cat1=VALUES(cat1), cat2=VALUES(cat2),
                     cat3=VALUES(cat3), cat4=VALUES(cat4), full_name=VALUES(full_name)""",
                [code, c1, c2, c3, c4, full])
            n += 1
    print(f'[category] {n:,}건 ({os.path.basename(path)})')
    return n


def load_delivery(docs_dir: str) -> int:
    path = _latest(docs_dir, 'delivery-companies_*.xls')
    if not path:
        print('[delivery] 파일 없음 — 스킵')
        return 0
    rows = _rows(path)[1:]
    n = 0
    with connections[NAVERDB].cursor() as cur:
        for r in rows:
            if not r or not str(r[0]).strip():
                continue
            cur.execute(
                """INSERT INTO naver_delivery_company_ref (code, name) VALUES (%s,%s)
                   ON DUPLICATE KEY UPDATE name=VALUES(name)""",
                [str(r[0]).strip(), str(r[1]).strip() if len(r) > 1 and r[1] else ''])
            n += 1
    print(f'[delivery] {n:,}건 ({os.path.basename(path)})')
    return n


def load_origin(docs_dir: str) -> int:
    path = _latest(docs_dir, 'originarea_*.xls')
    if not path:
        print('[origin] 파일 없음 — 스킵')
        return 0
    rows = _rows(path)[1:]
    n = 0
    with connections[NAVERDB].cursor() as cur:
        for r in rows:
            if not r or not str(r[0]).strip():
                continue
            cur.execute(
                """INSERT INTO naver_origin_area_ref (code, region) VALUES (%s,%s)
                   ON DUPLICATE KEY UPDATE region=VALUES(region)""",
                [str(r[0]).strip(), str(r[1]).strip() if len(r) > 1 and r[1] else ''])
            n += 1
    print(f'[origin] {n:,}건 ({os.path.basename(path)})')
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--docs', default=os.path.join(HERE, '..', 'docs'))
    args = ap.parse_args()
    docs_dir = os.path.abspath(args.docs)
    print(f'[docs] {docs_dir}')
    ensure_tables()
    load_category(docs_dir)
    load_delivery(docs_dir)
    load_origin(docs_dir)
    print('=== DONE ===')


if __name__ == '__main__':
    main()
