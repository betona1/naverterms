"""네이버 나의상품 — 11번가 my_product를 가져와 naverdb에 미러링하고
   네이버 ID(스토어) 단위 폴더로 관리. GPU 워커가 네이버 전용 상품명을 생성.

흐름:
  1. ensure_folders_from_stores() — myproduct.smartstoreIdList → naver_my_product_folder UPSERT
  2. import_from_11st() — ads.my_product (11번가 워킹카피) → naverdb.naver_my_product UPSERT
     - 진행상황은 _IMPORT_STATE 에 기록, GET /import-status/ 로 폴링
"""
from __future__ import annotations

import re
import threading
import time
import traceback
from datetime import datetime
from typing import Iterable

from django.db import connections

NAVERDB = 'naverdb'
ADSDB = 'ads'
MYPRODUCT_DB = 'myproduct'

UNCLASSIFIED_FOLDER_ID = 1
QUEUE_PLATFORM = 'naver'  # ads.ai_keyword_task.platform 값

# ads.my_product 에서 가져올 컬럼 → naver_my_product 컬럼
MIRROR_COLUMNS = [
    'product_code', 'product_name', 'market_product_name',
    'ai_product_name', 'ai_recommended_name', 'edited_product_name',
    'category_code', 'category_name', 'manufacturer', 'brand',
    'model_name', 'origin', 'keywords',
    'ownerclan_price', 'consumer_price', 'market_price',
    'shipping_fee', 'return_fee',
    'image_large', 'image_medium', 'image_small',
    'option1_name', 'option1_values', 'option2_name', 'option2_values',
    'combined_option', 'product_attribute',
    'detail_html',
]


def _dictfetchall(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def _serialize_row(row: dict) -> dict:
    for key in ('copied_at', 'synced_at', 'created_at', 'updated_at'):
        v = row.get(key)
        if isinstance(v, datetime):
            row[key] = v.isoformat()
    return row


# ── 폴더 ──────────────────────────────────────────────────────────

def list_folders() -> list[dict]:
    """폴더 목록 + 각 폴더 상품수."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            """
            SELECT f.id, f.store_id, f.name, f.color, f.sort_order,
                   f.is_system, f.queue_position, f.description,
                   COALESCE(c.cnt, 0) AS product_count
              FROM naver_my_product_folder f
              LEFT JOIN (
                SELECT folder_id, COUNT(*) AS cnt
                  FROM naver_my_product GROUP BY folder_id
              ) c ON c.folder_id = f.id
             ORDER BY f.is_system DESC, f.sort_order, f.id
            """
        )
        return _dictfetchall(cur)


def ensure_folders_from_stores() -> dict:
    """myproduct.smartstoreIdList 의 활성 스토어마다 폴더 자동 생성.
    store_id(myproduct PK)를 폴더의 store_id 컬럼에 저장 → UNIQUE.
    """
    # 1) 활성 스토어 목록
    with connections[MYPRODUCT_DB].cursor() as cur:
        cur.execute(
            "SELECT id, store_name FROM smartstoreIdList "
            "WHERE is_active=1 ORDER BY id"
        )
        stores = cur.fetchall()

    created = 0
    updated = 0
    with connections[NAVERDB].cursor() as cur:
        for idx, (sid, sname) in enumerate(stores, start=1):
            cur.execute(
                """
                INSERT INTO naver_my_product_folder
                  (store_id, name, sort_order, is_system)
                VALUES (%s, %s, %s, 0)
                ON DUPLICATE KEY UPDATE
                  name=VALUES(name),
                  sort_order=VALUES(sort_order),
                  updated_at=CURRENT_TIMESTAMP
                """,
                [sid, sname, idx],
            )
            # rowcount: 1=insert, 2=update (mysql)
            if cur.rowcount == 1:
                created += 1
            elif cur.rowcount == 2:
                updated += 1

    return {'ok': True, 'stores_total': len(stores),
            'folders_created': created, 'folders_updated': updated}


# ── Import from 11st ────────────────────────────────────────────

_IMPORT_LOCK = threading.Lock()
_IMPORT_STATE: dict = {
    'running': False,
    'started_at': None,
    'finished_at': None,
    'total': 0,
    'processed': 0,
    'inserted': 0,
    'updated': 0,
    'error': None,
    'message': '',
}


def get_import_status() -> dict:
    with _IMPORT_LOCK:
        return dict(_IMPORT_STATE)


def _set_state(**kwargs):
    with _IMPORT_LOCK:
        _IMPORT_STATE.update(kwargs)


def _iter_11st_products(batch_size: int = 1000) -> Iterable[list[dict]]:
    """ads.my_product 를 청크 단위로 SELECT."""
    cols_sql = ', '.join(['id'] + MIRROR_COLUMNS)
    offset = 0
    while True:
        with connections[ADSDB].cursor() as cur:
            cur.execute(
                f"SELECT {cols_sql} FROM my_product "
                f"ORDER BY id LIMIT %s OFFSET %s",
                [batch_size, offset],
            )
            rows = _dictfetchall(cur)
        if not rows:
            return
        yield rows
        if len(rows) < batch_size:
            return
        offset += batch_size


def _upsert_naverdb(rows: list[dict], folder_id: int) -> tuple[int, int]:
    """naver_my_product 에 UPSERT. (inserted, updated) 반환."""
    if not rows:
        return 0, 0

    # MIRROR_COLUMNS 의 첫 컬럼이 product_code(UNIQUE). 추가 컬럼은 source_id/folder_id/copied_at.
    insert_cols = MIRROR_COLUMNS + ['source_id', 'folder_id', 'copied_at']
    placeholders = ', '.join(['%s'] * len(insert_cols))
    # product_code 는 UNIQUE 이므로 UPDATE 절에서는 제외.
    update_cols = [c for c in MIRROR_COLUMNS if c != 'product_code'] + ['source_id', 'folder_id', 'copied_at']
    update_clause = ', '.join([f"{c}=VALUES({c})" for c in update_cols])
    sql = (
        f"INSERT INTO naver_my_product ({', '.join(insert_cols)}) "
        f"VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )
    now = datetime.now()
    inserted = updated = 0
    with connections[NAVERDB].cursor() as cur:
        for r in rows:
            params = [r.get(c) for c in MIRROR_COLUMNS]
            params += [r['id'], folder_id, now]
            cur.execute(sql, params)
            # rowcount: 1=insert, 2=update
            if cur.rowcount == 1:
                inserted += 1
            elif cur.rowcount == 2:
                updated += 1
            else:
                # 0=값 동일(no-op)
                pass
    return inserted, updated


def _import_worker(batch_size: int):
    try:
        # 폴더 자동 생성 (스토어별)
        ensure_folders_from_stores()

        with connections[ADSDB].cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM my_product")
            total = cur.fetchone()[0]
        _set_state(total=total, message=f'{total:,}건 import 시작')

        ins_total = upd_total = proc = 0
        for batch in _iter_11st_products(batch_size=batch_size):
            ins, upd = _upsert_naverdb(batch, folder_id=UNCLASSIFIED_FOLDER_ID)
            ins_total += ins
            upd_total += upd
            proc += len(batch)
            _set_state(
                processed=proc, inserted=ins_total, updated=upd_total,
                message=f'{proc:,}/{total:,} 처리 ({ins_total:,} 신규 / {upd_total:,} 갱신)'
            )

        _set_state(
            running=False, finished_at=datetime.now().isoformat(),
            message=f'완료 — {ins_total:,} 신규 / {upd_total:,} 갱신 / 총 {proc:,}건'
        )
    except Exception as e:
        _set_state(
            running=False, finished_at=datetime.now().isoformat(),
            error=str(e), message=f'에러: {e}'
        )
        traceback.print_exc()


def start_import_from_11st(batch_size: int = 1000) -> dict:
    """11st my_product → naverdb naver_my_product 백그라운드 import 시작."""
    with _IMPORT_LOCK:
        if _IMPORT_STATE['running']:
            return {'ok': False, 'error': 'already_running',
                    'state': dict(_IMPORT_STATE)}
        _IMPORT_STATE.update({
            'running': True,
            'started_at': datetime.now().isoformat(),
            'finished_at': None,
            'total': 0, 'processed': 0,
            'inserted': 0, 'updated': 0,
            'error': None, 'message': '준비 중...',
        })

    t = threading.Thread(target=_import_worker, args=(batch_size,), daemon=True)
    t.start()
    return {'ok': True, 'state': get_import_status()}


# ── 상품 조회 ────────────────────────────────────────────────────

DETAIL_FIELDS = (
    'id, product_code, source_id, folder_id, '
    'product_name, market_product_name, '
    'ai_product_name, ai_recommended_name, edited_product_name, naver_product_name, '
    'naver_keywords, keywords, comment, '
    'category_code, category_name, manufacturer, brand, model_name, origin, '
    'ownerclan_price, consumer_price, market_price, shipping_fee, return_fee, '
    'image_large, image_medium, image_small, '
    'option1_name, option1_values, option2_name, option2_values, combined_option, product_attribute, '
    'detail_html, '
    'sale_status, sync_status, is_modified, '
    'image_analysis, image_analyzed_at, '
    'copied_at, synced_at, created_at, updated_at'
)

# 편집 허용 필드 (UI 폼에서 보낼 수 있는 것만 화이트리스트)
PATCHABLE_FIELDS = {
    'product_name', 'naver_product_name', 'edited_product_name',
    'naver_keywords', 'keywords', 'comment',
    'category_name', 'brand', 'manufacturer', 'origin', 'model_name',
    'folder_id',
}


def get_product_detail(product_id: int) -> dict | None:
    import json
    from datetime import datetime as _dt
    with connections[NAVERDB].cursor() as cur:
        cur.execute(f"SELECT {DETAIL_FIELDS} FROM naver_my_product WHERE id=%s", [product_id])
        row = cur.fetchone()
        if not row:
            return None
        cols = [c[0] for c in cur.description]
        d = dict(zip(cols, row))
    # 직렬화
    for k, v in list(d.items()):
        if isinstance(v, _dt):
            d[k] = v.isoformat()
    # image_analysis JSON → dict
    ia = d.get('image_analysis')
    if isinstance(ia, str) and ia:
        try:
            d['image_analysis'] = json.loads(ia)
        except json.JSONDecodeError:
            pass
    return d


def patch_product(product_id: int, payload: dict) -> dict:
    """편집 허용 필드만 UPDATE. 빈 문자열은 NULL 로 변환 (CHAR 컬럼 NULL 허용)."""
    sets: list[str] = []
    params: list = []
    for k, v in (payload or {}).items():
        if k not in PATCHABLE_FIELDS:
            continue
        # folder_id 는 INT
        if k == 'folder_id':
            try:
                params.append(int(v))
            except (ValueError, TypeError):
                return {'ok': False, 'error': f'invalid folder_id: {v!r}'}
        else:
            params.append(v if v not in ('', None) else None)
        sets.append(f"{k}=%s")
    if not sets:
        return {'ok': False, 'error': '편집 가능한 필드가 없음'}
    sets.append('is_modified=1')
    sets.append('updated_at=NOW()')
    params.append(int(product_id))
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"UPDATE naver_my_product SET {', '.join(sets)} WHERE id=%s",
            params,
        )
        affected = cur.rowcount
    if affected == 0:
        return {'ok': False, 'error': 'not_found'}
    return {'ok': True, 'updated': True, 'detail': get_product_detail(product_id)}


_HANGUL_WORD_RE = None

# 자주 등장하는 조사 — 어절에서 떼어내면 의미있는 명사/형용사가 남음
_KOREAN_PARTICLES = (
    '으로서', '으로부터', '에서는', '에서도', '에서의', '으로써', '에서',
    '에게', '에는', '에도', '에의', '에게서', '에게는',
    '으로', '로서', '로부터', '로의', '로써', '까지', '에서',
    '는', '은', '이', '가', '을', '를', '의', '와', '과', '도',
    '만', '에', '로', '랑', '에', '며', '면', '서', '함',
    '이며', '이고', '이라', '이라는', '이라서', '이라고',
    '입니다', '습니다', '됩니다', '있습니다', '없습니다', '드립니다',
    '하면', '하는', '하여', '하고',
)


def _strip_particle(word: str) -> str:
    """어절 끝의 조사를 떼어내 어간만 반환. 가능한 한 긴 조사 먼저 시도."""
    for p in _KOREAN_PARTICLES:
        if word.endswith(p) and len(word) > len(p) + 1:
            return word[:-len(p)]
    return word


def _extract_html_keywords(html: str | None, max_words: int = 40) -> list[str]:
    """detail_html 에서 한글 명사/형용사 추출 (2~14자, 빈도순).
    HTML/style 제거 → 한글 단어 어절 → 조사 stripping → 빈도 + stopword 필터.
    """
    if not html:
        return []
    import re as _re
    global _HANGUL_WORD_RE
    if _HANGUL_WORD_RE is None:
        _HANGUL_WORD_RE = _re.compile(r'[가-힣]{2,14}')
    # style 속성 폭탄 우선 제거
    h = _re.sub(r' style="[^"]*"', '', html)
    h = _re.sub(r"<(script|style)[^>]*>.*?</\1>", ' ', h,
                flags=_re.DOTALL | _re.IGNORECASE)
    # <img src="..."> / data-original="..." 의 URL 안에 한글 파일명이 박힌 경우 (오너클랜 흔함)
    # → URL decode 해서 텍스트에 합류
    try:
        from urllib.parse import unquote as _unquote
        url_paths = _re.findall(r'(?:src|href|data-[\w-]*?(?:src|url|image))="([^"]+)"', h)
        url_text_parts = []
        for u in url_paths:
            try:
                decoded = _unquote(u)
                # 경로/파일명에서 확장자/경로 제거하고 한글만 추출
                # %20 (공백) → space, 영문/숫자/슬래시는 그대로
                url_text_parts.append(decoded)
            except Exception:
                pass
        url_text = ' '.join(url_text_parts)
    except Exception:
        url_text = ''
    text = _re.sub(r'<[^>]+>', ' ', h)
    text = _re.sub(r'&[a-z]+;|&#\d+;', ' ', text)
    text = (text + ' ' + url_text).strip()
    raw_words = _HANGUL_WORD_RE.findall(text)
    # 조사 stripping
    words = []
    for w in raw_words:
        s = _strip_particle(w)
        if len(s) >= 2:
            words.append(s)
    if not words:
        return []
    # 빈도 카운트
    freq: dict[str, int] = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    # 빈도 desc, 같은 빈도면 등장 순서
    seen_order = {w: i for i, w in enumerate(words)}
    ranked = sorted(freq.items(), key=lambda x: (-x[1], seen_order.get(x[0], 9999)))
    # 흔한 운영 문구/조사/일반어 제외 (e-commerce 상세페이지 boilerplate)
    skip = {
        # 조사/접속/일반어
        '있는', '같은', '하는', '되어', '주는', '있어', '있습', '됩니', '드리',
        '여러', '많은', '모든', '다양', '다른', '이런', '저런', '그런',
        '및', '또는', '하지만', '하여', '입니다',
        # e-commerce boilerplate
        '상품', '상세정보에', '별도', '표기', '관련', '연락처', '아닌',
        '교환', '반품', '처리', '관한', '또는', '재질입니다',
        '상품정보제공', '공정위', '고시', '상품군', '기타', '품명',
        '모델명', '허가', '제조자', '수입자', '제조국',
        '판매자', '구매', '주문', '배송', '안내', '문의',
        '확인', '참고', '주의', '바랍니다', '드립니다', '드리며',
        '아래', '위의', '본', '해당', '경우', '있을', '없을',
        '관련법', '소비자', '분쟁',
    }
    out: list[str] = []
    for w, _ in ranked:
        if w in skip:
            continue
        out.append(w)
        if len(out) >= max_words:
            break
    return out


def _split_kws(text) -> list[str]:
    if not text:
        return []
    if isinstance(text, list):
        return [str(k).strip() for k in text if str(k).strip()]
    return [k.strip() for k in str(text).replace('\n', ',').replace('/', ',').split(',') if k.strip()]


# 한글 색상 동의어 정규화 (네이버/비전 추론을 같은 토큰으로 묶기)
_COLOR_ALIASES = {
    '블랙': {'블랙', '검정', '검정색', '까만', '검은색', 'black'},
    '화이트': {'화이트', '흰색', '하얀', '하얀색', 'white'},
    '네이비': {'네이비', 'navy', '남색', '딥블루'},
    '블루': {'블루', '파랑', '파란', '파란색', 'blue'},
    '레드': {'레드', '빨강', '빨간', '빨간색', 'red'},
    '핑크': {'핑크', '분홍', '분홍색', 'pink'},
    '그레이': {'그레이', '회색', '쥐색', 'gray', 'grey'},
    '베이지': {'베이지', '베이쥐', 'beige'},
    '브라운': {'브라운', '갈색', '밤색', 'brown'},
    '카키': {'카키', '카키색', 'khaki'},
    '차콜': {'차콜', '진회색', '진그레이', 'charcoal'},
    '아이보리': {'아이보리', '미백', 'ivory'},
    '머스타드': {'머스타드', '겨자색', 'mustard'},
    '옐로우': {'옐로우', '노랑', '노란', '노란색', 'yellow'},
    '오렌지': {'오렌지', '주황', '주황색', 'orange'},
    '그린': {'그린', '초록', '초록색', '녹색', 'green'},
    '퍼플': {'퍼플', '보라', '보라색', 'purple'},
    '와인': {'와인', 'wine'},
    '실버': {'실버', '은색', 'silver'},
    '골드': {'골드', '금색', 'gold'},
}
_COLOR_NORMALIZE: dict[str, str] = {}
for canonical, aliases in _COLOR_ALIASES.items():
    for a in aliases:
        _COLOR_NORMALIZE[a.lower()] = canonical


def _normalize_color(s: str | None) -> str | None:
    if not s:
        return None
    return _COLOR_NORMALIZE.get(s.strip().lower(), s.strip())


def _first_option_color(option1_name: str | None, option1_values: str | None) -> str | None:
    """option1_name 이 색상 류면 첫 번째 값(정규화)."""
    if not option1_name or not option1_values:
        return None
    if not re.search(r'색상|컬러|color', option1_name, re.IGNORECASE):
        return None
    first = option1_values.split(',')[0].strip()
    return _normalize_color(first)


# 의류 시즌 키워드 셋 — 시즌별 호환 단어
_SEASON_KEYWORDS = {
    'summer': {
        '여름', '여름용', '하계', '시원', '시원한', '냉감', '쿨링', '쿨', '쿨해', '쿨한',
        '반팔', '민소매', '나시', '슬리브리스', '탱크', '탑',
        '린넨', '리넨', '시어서커', '메쉬', '망사', '아이스', '드라이',
        '비치', '바닷가', '수영복', '래쉬가드', '비키니', '워터',
        '얇은', '얇아', '가벼운', '땀흡수', '통풍', '통기성', '쿨매쉬',
        '레이온', '모달', '에어리즘',
    },
    'winter': {
        '겨울', '겨울용', '동계', '방한', '한파', '보온', '따뜻', '따스', '따뜻한',
        '패딩', '다운', '구스다운', '덕다운', '롱패딩', '숏패딩', '벤치파카',
        '코트', '울코트', '캐시미어', '플리스', '폴라플리스', '양털', '무스탕',
        '기모', '안감', '내피', '두꺼운', '두툼한', '핫팩',
        '히트텍', '발열', '온도조절', '극세사', '울', '캐시미어',
        '머플러', '목도리', '장갑', '비니', '귀마개',
    },
    'spring_fall': {  # 봄/가을 = 간절기
        '봄', '가을', '봄가을', '간절기', '환절기', '시즌리스',
        '긴팔', '7부', '9부', '7부소매', '9부소매', '롱슬리브',
        '가디건', '재킷', '자켓', '점퍼', '바람막이', '윈드브레이커',
        '아우터', '경량', '얇은아우터', '루즈핏', '오버핏',
    },
    'all_season': {
        '사계절', '올시즌', '봄여름가을겨울', '데일리',
    },
}

# 시즌 단서 단어 — 원본명에 있으면 그 시즌으로 추론
_SEASON_TRIGGERS = {
    'summer': {'여름', '여름용', '하계', '반팔', '민소매', '나시', '쿨링', '냉감',
               '메쉬', '비치', '수영복', '래쉬가드', '아이스', '쿨매쉬'},
    'winter': {'겨울', '겨울용', '동계', '방한', '패딩', '다운', '벤치파카',
               '코트', '울코트', '플리스', '양털', '무스탕', '기모', '히트텍',
               '롱패딩', '숏패딩', '캐시미어'},
    'spring_fall': {'봄', '가을', '봄가을', '간절기', '환절기', '긴팔', '7부', '9부',
                    '가디건', '바람막이', '윈드브레이커'},
}


def _infer_season(product_name: str, ai_name: str = '',
                  category_name: str = '') -> str | None:
    """상품의 주 시즌 추론. 'summer' / 'winter' / 'spring_fall' / None.
    여러 단서 있으면 가장 강한 시즌. 의류 한정으로 적용 (caller가 카테고리 체크).
    """
    blob = ' '.join(filter(None, [product_name, ai_name, category_name]))
    scores: dict[str, int] = {'summer': 0, 'winter': 0, 'spring_fall': 0}
    for season, triggers in _SEASON_TRIGGERS.items():
        for t in triggers:
            if t in blob:
                # 강한 트리거 (패딩/반팔/긴팔) 는 가중치 2배
                weight = 2 if t in {'패딩', '반팔', '긴팔', '여름용', '겨울용'} else 1
                scores[season] += weight
    best = max(scores, key=lambda k: scores[k])
    if scores[best] == 0:
        return None
    return best


# 시즌 단어 중에서도 '강한 단서' — 합성어 안에 들어가면 그 시즌 우선 (예: '여름바람막이'의 '여름')
_STRONG_SEASON_MARKERS = {
    'summer': {'여름', '여름용', '하계', '반팔', '민소매', '나시', '쿨링', '냉감', '메쉬', '비치', '수영복', '래쉬가드', '아이스'},
    'winter': {'겨울', '겨울용', '동계', '패딩', '다운', '벤치파카', '코트', '플리스', '양털', '무스탕', '기모', '히트텍', '롱패딩', '숏패딩', '캐시미어', '방한'},
    'spring_fall': {'봄가을', '간절기', '환절기'},  # '봄', '가을' 단독은 약함 (여름가을 같은 합성도 있어서)
}


def _season_incompatible(kw: str, product_season: str | None) -> bool:
    """이 키워드가 추론된 시즌과 비호환?
    우선순위: 다른 시즌의 강한 단서 단어가 kw 안에 들어있으면 비호환 (먼저 체크).
    """
    if not product_season or not kw:
        return False

    # 1. 다른 시즌 강한 단서 substring → 비호환
    for season, markers in _STRONG_SEASON_MARKERS.items():
        if season == product_season:
            continue
        for m in markers:
            if m in kw:
                return True

    # 2. 완전 일치는 내 시즌이면 호환
    my_set = _SEASON_KEYWORDS.get(product_season, set()) | _SEASON_KEYWORDS.get('all_season', set())
    if kw in my_set:
        return False
    for w in my_set:
        if w in kw:
            return False

    # 3. 다른 시즌 일반 단어
    for season, kws in _SEASON_KEYWORDS.items():
        if season == product_season or season == 'all_season':
            continue
        if kw in kws:
            return True
    return False


def _ensure_seasonal_cache_col() -> None:
    """seasonal_meta JSON 컬럼 보장 (멱등). 첫 호출 시점에 ALTER."""
    try:
        with connections[NAVERDB].cursor() as cur:
            cur.execute("SHOW COLUMNS FROM naver_my_product LIKE 'seasonal_meta'")
            if cur.fetchone():
                return
            cur.execute("ALTER TABLE naver_my_product ADD COLUMN seasonal_meta JSON NULL AFTER image_analysis")
    except Exception:
        pass


_SEASONAL_COL_READY = False


def _get_or_infer_seasonal(product_id, product_name: str, ai_name: str,
                           category_name: str) -> dict:
    """캐시 hit 우선. miss 면 LLM 호출 + DB 저장."""
    global _SEASONAL_COL_READY
    if not _SEASONAL_COL_READY:
        _ensure_seasonal_cache_col()
        _SEASONAL_COL_READY = True

    import json as _json
    if product_id:
        try:
            with connections[NAVERDB].cursor() as cur:
                cur.execute("SELECT seasonal_meta FROM naver_my_product WHERE id=%s", [product_id])
                row = cur.fetchone()
                if row and row[0]:
                    cached = row[0] if isinstance(row[0], dict) else _json.loads(row[0])
                    if cached and 'is_seasonal' in cached:
                        return cached
        except Exception:
            pass

    info = _llm_infer_seasonal(product_name, ai_name, category_name)
    if product_id:
        try:
            with connections[NAVERDB].cursor() as cur:
                cur.execute(
                    "UPDATE naver_my_product SET seasonal_meta=%s WHERE id=%s",
                    [_json.dumps(info, ensure_ascii=False), product_id],
                )
        except Exception:
            pass
    return info


def _llm_infer_seasonal(product_name: str, ai_name: str, category_name: str) -> dict:
    """LLM 으로 상품의 시즌성 판단.
    반환: {is_seasonal: bool, season: 'summer'/'winter'/'spring_fall'/'all'/'none', confidence: 'high'/'medium'/'low'}
    """
    import json as _json
    import requests as _req
    import os as _os

    url = (_os.environ.get('NAVER_OLLAMA_URL') or 'http://localhost:11438').rstrip('/')
    system = (
        "당신은 한국 의류·잡화 카테고리 분류 전문가입니다.\n"
        "주어진 상품 정보를 보고 시즌성 여부와 주 시즌을 판단하세요.\n"
        "\n"
        "[is_seasonal 판단]\n"
        "- true: 특정 시즌(여름/겨울/간절기)에만 적합한 상품 (예: 반팔티, 패딩, 수영복, 가디건)\n"
        "- false: 사계절 모두 사용 가능 (예: 양말, 속옷, 운동복 일부, 가방, 신발 일부)\n"
        "- 의류가 아니면 false\n"
        "\n"
        "[season 후보]\n"
        "- summer: 여름 (반팔/민소매/린넨/메쉬/수영복/래쉬가드 등)\n"
        "- winter: 겨울 (패딩/코트/털/플리스/방한)\n"
        "- spring_fall: 봄·가을 간절기 (긴팔/가디건/얇은아우터/바람막이/자켓)\n"
        "- all: 사계절\n"
        "- none: 의류 아님\n"
        "\n"
        "[출력]\n"
        '{"is_seasonal": true/false, "season": "summer|winter|spring_fall|all|none", "confidence": "high|medium|low"}\n'
        "JSON 한 객체만. ```json``` fence 금지. 설명 금지."
    )
    user = '\n'.join(filter(None, [
        f'원본 상품명: {product_name or ""}',
        f'AI 상품명: {ai_name}' if ai_name else None,
        f'카테고리: {category_name}' if category_name else None,
        '\n시즌성 분석:',
    ]))
    payload = {
        'model': 'exaone3.5:7.8b',
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'stream': False,
        'options': {'temperature': 0.1, 'num_predict': 200},
    }
    try:
        r = _req.post(f'{url}/api/chat', json=payload, timeout=20)
        r.raise_for_status()
        content = (r.json().get('message') or {}).get('content', '') or ''
        content = re.sub(r'^```(?:json)?\s*|\s*```\s*$', '', content.strip())
        m = re.search(r'\{[\s\S]*\}', content)
        if not m:
            return {'is_seasonal': False, 'season': 'none', 'confidence': 'low'}
        data = _json.loads(m.group(0))
        # 정규화
        season = (data.get('season') or 'none').lower()
        if season not in ('summer', 'winter', 'spring_fall', 'all', 'none'):
            season = 'none'
        return {
            'is_seasonal': bool(data.get('is_seasonal', False)),
            'season': season,
            'confidence': (data.get('confidence') or 'low').lower(),
        }
    except Exception:
        return {'is_seasonal': False, 'season': 'none', 'confidence': 'low'}


_FEMALE_RE = re.compile(r'(여성|여자|레이디|레디|걸리쉬|걸리시|와이프|wmn|women|woman|female|lady|girls?|ms\.)', re.IGNORECASE)
_MALE_RE = re.compile(r'(남성|남자|맨즈|men|man|male|mr\.)', re.IGNORECASE)


def _infer_gender(product_name: str, ai_name: str, naver_name: str) -> str | None:
    """상품의 주 성별 추론 — 'female' / 'male' / None.
    원본/AI/네이버 상품명에 명시된 단어 빈도 우선.
    """
    blob = ' '.join(filter(None, [product_name, ai_name, naver_name]))
    fc = len(_FEMALE_RE.findall(blob))
    mc = len(_MALE_RE.findall(blob))
    if fc > mc:
        return 'female'
    if mc > fc:
        return 'male'
    return None


def _is_opposite_gender_kw(kw: str, gender: str | None) -> bool:
    """이 키워드가 추론된 성별과 반대인가? (혼성 단어 '남여공용' 같은 건 reject 안 함)"""
    if not gender or not kw:
        return False
    has_f = bool(_FEMALE_RE.search(kw))
    has_m = bool(_MALE_RE.search(kw))
    if has_f and has_m:
        return False  # 혼성 단어
    if gender == 'female' and has_m and not has_f:
        return True
    if gender == 'male' and has_f and not has_m:
        return True
    return False


def get_keyword_pool(product_id: int) -> dict:
    """편집 모달의 키워드 풀.
    - vision_features: image_analysis.key_features (qwen2.5vl 시각 키워드)
    - vision_meta: color/material/form/package_qty/readable_text (참고 정보)
    - 11번가 my_product_ad_keyword: best/good/ad/functional (source_id 로 cross-DB)
    - preset_keywords: naver_my_product.keywords / naver_keywords (원본 + 사용자 편집)
    - detail_keywords: detail_html 한글 단어 빈도순 (있을 때만)
    """
    import json as _json
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "SELECT source_id, image_analysis, keywords, naver_keywords, "
            "product_name, naver_product_name, detail_html, "
            "option1_name, option1_values "
            "FROM naver_my_product WHERE id=%s",
            [product_id],
        )
        row = cur.fetchone()
        if not row:
            return {'ok': False, 'error': 'not_found'}
        (source_id, vision_raw, kw, naver_kw, product_name, naver_name,
         detail_html, option1_name, option1_values) = row

    # vision
    vision_features: list = []
    vision_meta: dict = {}
    if vision_raw:
        try:
            v = _json.loads(vision_raw) if isinstance(vision_raw, str) else vision_raw
            kf = v.get('key_features') or []
            if isinstance(kf, list):
                vision_features = [str(k) for k in kf if k]
            for k in ('color', 'material', 'form', 'package_qty', 'readable_text'):
                vision_meta[k] = v.get(k)
            # color 가 list 면 평탄화 → 칩 후보
            if isinstance(vision_meta.get('color'), list):
                vision_features = vision_features + [c for c in vision_meta['color'] if c]
        except (ValueError, TypeError):
            pass

    # 11번가 키워드 풀 (source_id 가 11st my_product.id 와 매핑)
    pool_11st = {
        'best_picks': [], 'good_picks': [], 'ad_keywords': [], 'functional_keywords': [],
    }
    if source_id:
        try:
            with connections[ADSDB].cursor() as cur:
                cur.execute(
                    "SELECT best_picks, good_picks, ad_keywords, functional_keywords "
                    "FROM my_product_ad_keyword WHERE my_product_id=%s",
                    [int(source_id)],
                )
                row2 = cur.fetchone()
                if row2:
                    pool_11st['best_picks'] = _split_kws(row2[0])
                    pool_11st['good_picks'] = _split_kws(row2[1])
                    pool_11st['ad_keywords'] = _split_kws(row2[2])
                    pool_11st['functional_keywords'] = _split_kws(row2[3])
        except Exception:
            pass

    # 추론 성별 — 상품명에 여성/남성 명시되어 있으면 반대 단어는 banned 로
    gender = _infer_gender(product_name or '', product_name or '', naver_name or '')

    raw_pool = {
        'best_picks': pool_11st['best_picks'],
        'good_picks': pool_11st['good_picks'],
        'ad_keywords': pool_11st['ad_keywords'],
        'functional_keywords': pool_11st['functional_keywords'],
        'preset_keywords': _split_kws(kw),
        'naver_keywords': _split_kws(naver_kw),
        'detail_keywords': _extract_html_keywords(
            (detail_html or '') + ' ' + (vision_meta.get('readable_text') or ''),
            max_words=40,
        ),
        'vision_features': vision_features,
    }

    banned: list[str] = []
    if gender:
        for key, arr in list(raw_pool.items()):
            keep = []
            for k in arr:
                if _is_opposite_gender_kw(k, gender):
                    banned.append(k)
                else:
                    keep.append(k)
            raw_pool[key] = keep

    # 의류/패션잡화 — AI 시즌성 판단 (1차: LLM, 캐시) + 룰 기반 fallback
    season_info = _get_or_infer_seasonal(product_id, product_name or '', '', '')
    is_seasonal = season_info.get('is_seasonal', False)
    product_season = season_info.get('season') if season_info.get('season') not in ('none', 'all') else None
    season_banned: list[str] = []
    if is_seasonal and product_season:
        for key, arr in list(raw_pool.items()):
            keep = []
            for k in arr:
                if _season_incompatible(k, product_season):
                    season_banned.append(k)
                else:
                    keep.append(k)
            raw_pool[key] = keep

    # 자동 추천 키워드 — 발견되면 사용자에게 "꼭 넣으세요" 강조
    # (네이버 SEO 룰: '국산/국내산' 은 검색 우대, 사용자가 빼먹기 쉬움)
    must_have: list[str] = []
    blob = ' '.join(filter(None, [
        product_name, vision_meta.get('readable_text') or '',
        ' '.join(raw_pool['detail_keywords']),
        ' '.join(raw_pool['preset_keywords']),
        ' '.join(raw_pool['vision_features']),
    ]))
    for kw in ('국산', '국내산', '핸드메이드', '수제', '무료배송'):
        # '국산' 류는 detail/preset 에 명시되어 있으면 must_have 로 추천
        # (단, naver_product_name 에 이미 있으면 추천 X)
        if kw in blob and kw not in (naver_name or ''):
            if kw not in must_have:
                must_have.append(kw)

    # 옵션1번 색상 = 비전 색상 일치 검증
    option_color = _first_option_color(option1_name, option1_values)
    vision_colors_raw = vision_meta.get('color')
    if isinstance(vision_colors_raw, str):
        vision_colors_raw = [vision_colors_raw]
    vision_colors_norm = [_normalize_color(c) for c in (vision_colors_raw or []) if c]
    vision_colors_norm = [c for c in vision_colors_norm if c]
    color_mismatch = None
    if option_color and vision_colors_norm:
        if option_color not in vision_colors_norm:
            color_mismatch = {
                'option_color': option_color,
                'vision_colors': vision_colors_norm,
                'option1_values': option1_values,
            }
    # 옵션 색상이 명시되어 있는데 현재 네이버명에 없으면 must_have 에 추가
    if option_color and naver_name and option_color not in naver_name:
        if option_color not in must_have:
            must_have.append(option_color)

    # 모든 풀의 unique 키워드 → 조회수 캐시 lookup (miss 는 백그라운드 fetch)
    all_kws: list[str] = []
    seen_kw: set = set()
    for arr_key in ('best_picks', 'good_picks', 'ad_keywords', 'functional_keywords',
                    'preset_keywords', 'naver_keywords', 'detail_keywords', 'vision_features'):
        for k in raw_pool.get(arr_key, []) or []:
            if k and k.lower() not in seen_kw:
                seen_kw.add(k.lower())
                all_kws.append(k)
    # 네이버 상품명 토큰도 조회수 알면 좋음
    for tok in (naver_name or '').split():
        if tok and tok.lower() not in seen_kw:
            seen_kw.add(tok.lower())
            all_kws.append(tok)

    keyword_volumes: dict = {}
    try:
        from . import keyword_volume_service as kvs
        keyword_volumes = kvs.get_volumes(all_kws)
    except Exception:
        pass

    return {
        'ok': True,
        'product_name': product_name,
        'naver_product_name': naver_name,
        'vision_meta': vision_meta,
        **raw_pool,
        'banned_keywords': sorted(set(banned)),
        'must_have_keywords': must_have,
        'inferred_gender': gender,
        'inferred_season': product_season,
        'season_banned_keywords': sorted(set(season_banned)),
        'option_color': option_color,
        'color_mismatch': color_mismatch,
        'detail_html_length': len(detail_html or ''),
        'image_ocr_text': vision_meta.get('readable_text') or '',
        'keyword_volumes': keyword_volumes,
    }


def clear_image_analysis(product_id: int) -> dict:
    """비전 분석 캐시 삭제 — 다음 generate 시 재분석."""
    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            "UPDATE naver_my_product "
            "SET image_analysis=NULL, image_analyzed_at=NULL "
            "WHERE id=%s",
            [int(product_id)],
        )
        affected = cur.rowcount
    if affected == 0:
        return {'ok': False, 'error': 'not_found'}
    return {'ok': True}


def move_products(ids: list[int], folder_id: int) -> dict:
    """선택된 상품들을 지정 폴더로 이동."""
    if not ids:
        return {'ok': False, 'error': 'ids 비어있음'}
    folder_id = int(folder_id)

    with connections[NAVERDB].cursor() as cur:
        # 폴더 존재 검증
        cur.execute("SELECT id FROM naver_my_product_folder WHERE id=%s", [folder_id])
        if not cur.fetchone():
            return {'ok': False, 'error': f'폴더 {folder_id} 없음'}

        ph = ','.join(['%s'] * len(ids))
        cur.execute(
            f"UPDATE naver_my_product SET folder_id=%s WHERE id IN ({ph})",
            [folder_id] + list(ids),
        )
        moved = cur.rowcount

    return {'ok': True, 'moved': moved, 'folder_id': folder_id}


## ── 듀얼 워커 큐 (ads.ai_keyword_task, platform='naver') ────────────

def enqueue_products(ids: list[int] | None = None,
                     folder_id: int | None = None,
                     only_missing: bool = True,
                     top_sales: int | None = None) -> dict:
    """네이버 상품명 생성 task 를 ads.ai_keyword_task 에 enqueue.

    Args:
        ids: 직접 지정 (priority 1)
        folder_id: 폴더 단위 (priority 2)
        top_sales: 매출 상위 N개 (priority 3) — myproduct.eleven_sales_w_stats 기준
        only_missing: True 면 naver_product_name 이 NULL/'' 인 것만
    """
    target_ids: list[int] = []

    if ids:
        target_ids = [int(x) for x in ids]
    elif top_sales is not None and top_sales > 0:
        # 매출 상위 W코드 → naver_my_product.id 매핑
        # eleven_sales_w_stats 는 myproduct DB, naver_my_product 는 naverdb → 분리 쿼리
        with connections[MYPRODUCT_DB].cursor() as cur:
            cur.execute(
                "SELECT w_code FROM eleven_sales_w_stats "
                "WHERE w_code IS NOT NULL AND w_code <> '' "
                "ORDER BY total_amount DESC LIMIT %s",
                [int(top_sales) * 3],  # only_missing 필터 손실 대비 3배 후보
            )
            top_wcodes = [r[0] for r in cur.fetchall()]
        if not top_wcodes:
            return {'ok': True, 'queued': 0, 'requested': 0}

        with connections[NAVERDB].cursor() as cur:
            ph = ','.join(['%s'] * len(top_wcodes))
            where = [f'product_code IN ({ph})']
            params: list = list(top_wcodes)
            if only_missing:
                where.append("(naver_product_name IS NULL OR naver_product_name='')")
            # 매출 순서 보존: FIELD(product_code, ...) 로 정렬
            order_field = ', '.join(['%s'] * len(top_wcodes))
            cur.execute(
                f"SELECT id FROM naver_my_product WHERE {' AND '.join(where)} "
                f"ORDER BY FIELD(product_code, {order_field}) LIMIT %s",
                params + list(top_wcodes) + [int(top_sales)],
            )
            target_ids = [r[0] for r in cur.fetchall()]
    elif folder_id is not None:
        with connections[NAVERDB].cursor() as cur:
            where = ['folder_id=%s']
            params: list = [int(folder_id)]
            if only_missing:
                where.append("(naver_product_name IS NULL OR naver_product_name='')")
            cur.execute(
                f"SELECT id FROM naver_my_product WHERE {' AND '.join(where)} ORDER BY id",
                params,
            )
            target_ids = [r[0] for r in cur.fetchall()]
    else:
        # all_missing: 모든 미생성
        with connections[NAVERDB].cursor() as cur:
            cur.execute(
                "SELECT id FROM naver_my_product "
                "WHERE naver_product_name IS NULL OR naver_product_name=''"
            )
            target_ids = [r[0] for r in cur.fetchall()]

    if not target_ids:
        return {'ok': True, 'queued': 0, 'requested': 0}

    # 이미 큐에 들어가 있는 (pending/running) 것은 중복 INSERT 방지
    with connections[ADSDB].cursor() as cur:
        ph = ','.join(['%s'] * len(target_ids))
        cur.execute(
            f"SELECT product_id FROM ai_keyword_task "
            f"WHERE platform=%s AND product_id IN ({ph}) AND status IN ('pending','running')",
            [QUEUE_PLATFORM] + target_ids,
        )
        existing = {r[0] for r in cur.fetchall()}

    to_insert = [pid for pid in target_ids if pid not in existing]
    if not to_insert:
        return {'ok': True, 'queued': 0, 'requested': len(target_ids), 'already_queued': len(existing)}

    with connections[ADSDB].cursor() as cur:
        # ON DUPLICATE: 이미 done/error 인 task 도 platform='naver' 면 pending 으로 재투입
        # (only_missing=False 일 때 강제 재생성 의도. uniq_product 인덱스 회피)
        cur.executemany(
            "INSERT INTO ai_keyword_task "
            "(product_id, folder_id, folder_queue_position, claimed_by, platform, status) "
            "VALUES (%s, 1, 0, NULL, %s, 'pending') "
            "ON DUPLICATE KEY UPDATE "
            "  platform=VALUES(platform), status='pending', "
            "  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, "
            "  completed_at=NULL, error=NULL, retry_count=0",
            [(pid, QUEUE_PLATFORM) for pid in to_insert],
        )
        inserted = cur.rowcount

    return {
        'ok': True,
        'queued': inserted,
        'requested': len(target_ids),
        'already_queued': len(existing),
    }


def get_queue_status() -> dict:
    """현재 platform='naver' 큐 상태 + 워커별 진행 현황."""
    out = {'pending': 0, 'running': 0, 'done_recent': 0, 'error': 0, 'by_worker': []}
    with connections[ADSDB].cursor() as cur:
        cur.execute(
            "SELECT status, COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s GROUP BY status",
            [QUEUE_PLATFORM],
        )
        for status, n in cur.fetchall():
            if status == 'done':
                # done 은 최근 1시간만 세서 노이즈 줄임
                continue
            out[status] = n
        cur.execute(
            "SELECT COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s AND status='done' AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)",
            [QUEUE_PLATFORM],
        )
        out['done_recent'] = cur.fetchone()[0]
        cur.execute(
            "SELECT claimed_by, status, COUNT(*) FROM ai_keyword_task "
            "WHERE platform=%s AND claimed_by IS NOT NULL AND status IN ('running','done') "
            "AND COALESCE(completed_at, claimed_at) >= DATE_SUB(NOW(), INTERVAL 1 HOUR) "
            "GROUP BY claimed_by, status ORDER BY claimed_by",
            [QUEUE_PLATFORM],
        )
        worker_map: dict = {}
        for ep, status, n in cur.fetchall():
            if ep not in worker_map:
                worker_map[ep] = {'endpoint': ep, 'running': 0, 'done': 0}
            worker_map[ep][status] = n
        out['by_worker'] = list(worker_map.values())
    return out


def get_products(page: int = 1, per_page: int = 50,
                 folder_id: int | None = None,
                 search: str | None = None,
                 sort: str = 'id_desc',
                 include_sales: bool = False) -> dict:
    """상품 목록.

    sort:
        'id_desc'   (기본)
        'sales'     매출액 desc (eleven_sales_w_stats.total_amount)
        'updated'   updated_at desc
    include_sales: 응답에 sales (total_amount, total_quantity, order_count) 포함
    """
    page = max(1, int(page))
    per_page = max(1, min(int(per_page), 500))
    offset = (page - 1) * per_page

    where = ['1=1']
    params: list = []
    if folder_id is not None:
        where.append('p.folder_id=%s')
        params.append(int(folder_id))
    if search:
        where.append("(p.product_code LIKE %s OR p.product_name LIKE %s OR p.ai_product_name LIKE %s)")
        like = f'%{search}%'
        params += [like, like, like]
    where_sql = ' AND '.join(where)

    fields = (
        'p.id, p.product_code, p.source_id, p.folder_id, p.product_name, '
        'p.ai_product_name, p.ai_recommended_name, p.edited_product_name, '
        'p.naver_product_name, p.category_name, p.brand, p.manufacturer, p.origin, '
        'p.ownerclan_price, p.market_price, p.shipping_fee, p.return_fee, '
        'p.image_small, p.image_large, p.sale_status, p.sync_status, '
        'p.copied_at, p.synced_at, p.created_at, p.updated_at'
    )

    # 매출 정렬 또는 매출 정보 표시 시 — 매출 W코드를 미리 가져와 IN 절로 좁힘 (cross-DB JOIN 불가)
    sales_map: dict = {}
    if sort == 'sales' or include_sales:
        # 1차: 매출 정렬이면 매출 상위 W코드 추출
        if sort == 'sales':
            with connections[MYPRODUCT_DB].cursor() as cur:
                cur.execute(
                    "SELECT w_code, total_amount, total_quantity, order_count "
                    "FROM eleven_sales_w_stats "
                    "WHERE w_code IS NOT NULL AND total_amount > 0 "
                    "ORDER BY total_amount DESC LIMIT %s",
                    [per_page * page + 1000],  # 충분히 가져와서 페이지네이션 안정화
                )
                for r in cur.fetchall():
                    sales_map[r[0]] = {'total_amount': r[1], 'total_quantity': r[2], 'order_count': r[3]}
            wcodes = list(sales_map.keys())
            if not wcodes:
                return {'items': [], 'total': 0, 'page': page, 'per_page': per_page, 'total_pages': 0}
            ph = ','.join(['%s'] * len(wcodes))
            where.append(f'p.product_code IN ({ph})')
            params.extend(wcodes)
            where_sql = ' AND '.join(where)
            # 매출액 순서 보존
            order_clause = f"FIELD(p.product_code, {','.join(['%s'] * len(wcodes))})"
            order_params = list(wcodes)
        else:
            order_clause = 'p.id DESC'
            order_params = []
    else:
        order_clause = {
            'id_desc': 'p.id DESC',
            'updated': 'p.updated_at DESC, p.id DESC',
        }.get(sort, 'p.id DESC')
        order_params = []

    with connections[NAVERDB].cursor() as cur:
        cur.execute(
            f"SELECT COUNT(*) FROM naver_my_product p WHERE {where_sql}", params)
        total = cur.fetchone()[0]
        cur.execute(
            f"SELECT {fields} FROM naver_my_product p "
            f"WHERE {where_sql} ORDER BY {order_clause} LIMIT %s OFFSET %s",
            params + order_params + [per_page, offset],
        )
        items = [_serialize_row(r) for r in _dictfetchall(cur)]

    # 페이지 항목에만 매출 정보 lookup (include_sales=True 일 때 sales_map 비어있으면 채움)
    if include_sales:
        if not sales_map:
            wcodes_page = [it['product_code'] for it in items if it.get('product_code')]
            if wcodes_page:
                with connections[MYPRODUCT_DB].cursor() as cur:
                    ph = ','.join(['%s'] * len(wcodes_page))
                    cur.execute(
                        f"SELECT w_code, total_amount, total_quantity, order_count "
                        f"FROM eleven_sales_w_stats WHERE w_code IN ({ph})",
                        wcodes_page,
                    )
                    for r in cur.fetchall():
                        sales_map[r[0]] = {'total_amount': r[1], 'total_quantity': r[2], 'order_count': r[3]}
        for it in items:
            s = sales_map.get(it.get('product_code'))
            if s:
                it['sales'] = s

    return {
        'items': items,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': (total + per_page - 1) // per_page if total else 0,
    }
