# 네이버쇼핑 Term 분석기 — 기술문서

> Chrome 확장프로그램 + Django Backend + React Frontend

## 아키텍처

```
┌─ Chrome 브라우저 ──────────────────────────────────────────┐
│                                                            │
│  [네이버쇼핑 탭]              [React 웹앱 탭 :5173]         │
│   ↑ injected.js (MAIN)       ↑ content_app_naver.js       │
│   ↑ content-script.js        │                             │
│   │ fetch/XHR/__NEXT_DATA__  │ React ↔ Extension 통신      │
│   └──────────┐  ┌────────────┘                             │
│              ▼  ▼                                          │
│        background.js (Service Worker)                      │
│        - 키워드 큐 관리                                     │
│        - 탭 열기/클릭/닫기                                  │
│        - Django API 호출                                    │
└────────────────────┬───────────────────────────────────────┘
                     │ fetch POST
                     ▼
┌─ Django Backend (:8003) ───────────────────────────────────┐
│  naver/ 앱                                                  │
│  ├── models.py     — 6개 테이블                              │
│  ├── views.py      — REST API (17개 엔드포인트)              │
│  ├── services.py   — 가중치 분석 로직                        │
│  └── urls.py       — /api/cpc/naver/*                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Chrome 확장프로그램 (chrome-extension/)

### 파일 구조

| 파일 | 역할 | World |
|------|------|-------|
| `manifest.json` | MV3 설정, 권한, content script 등록 | - |
| `background.js` | Service Worker — 큐 관리, 탭 제어, Django 통신 | SW |
| `injected.js` | fetch/XHR 가로채기, `__NEXT_DATA__` 추출 | MAIN |
| `content-script.js` | 탭 클릭 제어, CAPTCHA 감지, 메시지 브릿지 | ISOLATED |
| `content_app_naver.js` | React 웹앱 ↔ Extension 메시지 브릿지 | ISOLATED |
| `popup.html/js` | 확장프로그램 팝업 UI | - |

### 데이터 캡처 흐름

```
1. background.js → chrome.tabs.create(네이버쇼핑 URL)
2. 페이지 로드 → injected.js 실행 (MAIN world)
3. injected.js:
   ├── 초기: __NEXT_DATA__ 폴링 → products 추출 → window.postMessage
   └── SPA 탭클릭: fetch/XHR hook → response 파싱 → window.postMessage
4. content-script.js → window.message 수신 → chrome.runtime.sendMessage
5. background.js → onData() → Django POST /ext/search-result/
```

### 수집 전략 (v1.7.1)

```
페이지 열기 (total 탭 기본)
  ↓
초기 __NEXT_DATA__ 대기 (1.5초)
  ├── 성공 → total 데이터 캡처 → model 클릭
  └── 타임아웃 → model 클릭 (total은 마지막에)
  ↓
model 탭 클릭 → SPA fetch → 캡처
  ↓
checkout 탭 클릭 → SPA fetch → 캡처
  ↓
(total 미수집 시) total 탭 클릭 → SPA fetch → 캡처
  ↓
키워드 완료 → 1.5~3초 랜덤 대기 → 다음 키워드
```

### 핵심: SSR vs SPA

| 상황 | 데이터 소스 | 캡처 방법 |
|------|------------|-----------|
| 초기 페이지 로드 (SSR) | `__NEXT_DATA__` 스크립트 태그 | 폴링 추출 |
| 탭 클릭 (SPA) | client-side fetch (`/_next/data/`) | fetch hook |

**주의**: `onUrlChange()` 에서 `__NEXT_DATA__` 폴링을 재시작하면 안됨!
→ 이전 total 데이터가 model/checkout 데이터로 잘못 전송되는 버그 발생

### 메시지 프로토콜

| 방향 | type | 설명 |
|------|------|------|
| popup → BG | `NAVER_START_TERM_SEARCH` | 키워드 수집 시작 |
| popup → BG | `NAVER_CANCEL` | 수집 중지 |
| popup → BG | `NAVER_GET_STATUS` | 상태 조회 (폴링) |
| CS → BG | `NAVER_SHOPPING_DATA` | 캡처된 상품 데이터 |
| CS → BG | `NAVER_PAGE_READY` | 페이지 로드 완료 |
| CS → BG | `CAPTCHA_DETECTED` | CAPTCHA 감지 |
| BG → CS | `CLICK_NAVER_TAB` | 탭 클릭 명령 |

---

## Django Backend API

### 엔드포인트

```
Base: /api/cpc/naver/

# 키워드
GET    /keywords/                 키워드 목록
POST   /keywords/                 키워드 추가
DELETE /keywords/<id>/            키워드 삭제

# 확장프로그램 데이터 수신
POST   /ext/search-result/        검색결과 저장 (키워드+탭+상품)
POST   /ext/rank-result/          순위결과 저장
POST   /ext/captcha-status/       CAPTCHA 상태

# 분석
GET    /analysis/<kw_id>/         가중치 분석 결과
POST   /analysis/<kw_id>/         가중치 분석 실행
GET    /products/<kw_id>/         상품 데이터 (?tab=total|model|checkout)
GET    /tags/<kw_id>/             태그 통계

# 순위추적
GET    /rank/targets/             추적 대상 목록
POST   /rank/targets/             추적 대상 추가
DELETE /rank/targets/<id>/        추적 대상 삭제
GET    /rank/history/             순위 이력 (?target_id=&days=)
GET    /rank/summary/             순위 요약

# 관리
POST   /reset-data/               데이터 초기화 (키워드 유지)

# 엑셀
GET    /export/terms/             Term 분석 엑셀
GET    /export/rank/              순위 이력 엑셀
```

### DB 테이블 (6개, ads DB)

| 테이블 | 설명 |
|--------|------|
| `naver_keyword` | 키워드 + terms + 탭별 검색수 |
| `naver_search_snapshot` | 탭별 상품 데이터 (JSON, 최대 40개) |
| `naver_term_analysis` | 6가지 가중치 분석 결과 |
| `naver_rank_target` | 순위추적 대상 (스토어/상품ID) |
| `naver_rank_history` | 순위 이력 |
| `naver_tracking_schedule` | 자동 스케줄 |

### 가중치 분석 (services.py)

| 가중치 | 설명 | 대상 |
|--------|------|------|
| 순서고정 | term 쌍이 붙어있는 비율 | 상위 10개 |
| 위치 | 1=정순, 2=역순 | 상위 10개 |
| 상품명 | term 쌍 포함 상품 수 | 상위 40개 |
| 파트 | 앞/중간/뒤 위치 비율 | 상위 40개 |
| 카테고리 | 동일 카테고리 집중도 | 상위 40개 |

---

## 네이버쇼핑 API 구조

### 검색 URL

```
https://search.shopping.naver.com/search/all?query=키워드&sort=rel&productSet=total
```

| productSet | 탭 |
|------------|-----|
| total (기본) | 전체 |
| model | 가격비교 |
| checkout | 네이버페이 |

### shoppingResult 핵심 필드

```json
{
  "query": "베개커버",
  "terms": ["베개", "커버"],
  "termCount": 2,
  "total": 73065,
  "products": [
    {
      "productName": "상품명",
      "mallName": "스토어명",
      "reviewCount": 3626,
      "lowPrice": "13900",
      "category1Name": "홈인테리어",
      "category2Name": "침구",
      "manuTag": "무료배송,빠른배송",
      "imageUrl": "https://...",
      "nvMid": "35227195618",
      "rank": 1
    }
  ]
}
```

---

## 설치 및 실행

### Chrome 확장프로그램

1. `chrome://extensions` → 개발자 모드 ON
2. "압축해제된 확장 프로그램을 로드합니다" → `chrome-extension/` 폴더 선택
3. 팝업에서 Django 연결 확인

### Django Backend

```bash
cd ai100/viewer/gmarket_cpc/backend
python3 manage.py runserver 0.0.0.0:8003
```

### React Frontend

```bash
cd ai100/viewer/gmarket_cpc/frontend
npm run dev  # :5173
```

---

## 버전 이력

| 버전 | 날짜 | 변경 |
|------|------|------|
| v1.8.0 | 2026-03-17 | 7가지 크롤링 신뢰성 개선: productSet 검증, per-tab 중복방지, "만 검색" 자동클릭, SW 상태보존, 탭클릭 결과확인, CAPTCHA 일시정지/재개, 메시지 재시도 |
| v1.7.1 | 2026-03-16 | injected.js stale 데이터 버그 수정, 전체탭 명시적 클릭, 로그 복원, 데이터 초기화 API |
| v1.7.0 | 2026-03-16 | 심플 로직 재작성 (페이지→total→model→checkout) |
| v1.6.x | 2026-03-16 | 퀵클릭 시퀀스 시도 (실패) |
| v1.5.x | 2026-03-16 | 탭 클릭 방식 + race condition 수정 시도 |
| v1.4.x | 2026-03-16 | 초기 작동 버전 (injected.js + content-script.js) |

## 알려진 이슈

- `__NEXT_DATA__` 구조 변경 시 초기 total 캡처 실패 가능 → 명시적 탭 클릭으로 fallback
- 파트가중치(search5_partwt) 구현됨 (services.py) 단 UI 미연동
- nid.naver.com 2FA 리다이렉트 시 content-script 미작동 → background.js URL 감시로 대응
