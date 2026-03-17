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

### 수집 전략 (v1.9.0) — URL 네비게이션 방식

```
키워드별 3회 URL 이동 (탭 클릭 대신 URL 직접 이동)
  ↓
1. chrome.tabs.update → ?productSet=total → 페이지 로드 → 데이터 캡처
  ↓ (1.5~3.5초 랜덤 대기)
2. chrome.tabs.update → ?productSet=model → 페이지 로드 → 데이터 캡처
  ↓ (1.5~3.5초 랜덤 대기)
3. chrome.tabs.update → ?productSet=checkout → 페이지 로드 → 데이터 캡처
  ↓
키워드 완료 → 2~5초 랜덤 대기 → 다음 키워드
```

**v1.8.x에서 탭 클릭 방식 문제**: SPA 탭 클릭 시 React Query 캐시로 인해
2번째/3번째 탭에서 새 fetch가 발생하지 않아 데이터 미수신. URL 직접 이동으로 해결.

### 데이터 캡처 방법

| 방법 | 우선순위 | 설명 |
|------|---------|------|
| `__NEXT_DATA__` 폴링 | 1순위 | SSR 렌더링 데이터 추출 |
| fetch hook | 2순위 | SPA hydration 시 API 호출 가로채기 |
| XHR hook | 3순위 | fetch 대신 XHR 사용 시 |

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

## UC 크롤러 (서버측)

### 파일
`ai100/viewer/gmarket_cpc/backend/naver/uc_crawler.py`

### 동작 방식
1. Django API로 시작 요청 (`POST /uc/start/`)
2. 백그라운드 스레드에서 undetected-chromedriver 실행
3. 키워드별 3개 URL 이동 (total/model/checkout)
4. `__NEXT_DATA__` 추출 → 실패 시 CDP fallback
5. Django ORM으로 직접 DB 저장

### API
```
POST /api/cpc/naver/uc/start/     UC 크롤링 시작 {keywords: [...]}
GET  /api/cpc/naver/uc/status/    진행 상태 조회
POST /api/cpc/naver/uc/stop/      크롤링 중지
```

### 환경
- Chrome: `/home/joacham/.local/share/google-chrome/chrome` (v145)
- UC: `undetected-chromedriver 3.5.5`
- Selenium: `4.41.0`

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
| v1.9.2 | 2026-03-17 | UC 검색을 웹 대시보드(NaverTermsPage)로 이동, 확장 팝업에서 UC 코드 제거, popup.js Chrome 전용으로 정리 |
| v1.9.1 | 2026-03-17 | UC 크롤러 추가 (서버측 undetected-chromedriver), Django API 엔드포인트 (uc/start, uc/status, uc/stop) |
| v1.9.0 | 2026-03-17 | URL 네비게이션 방식 전환 (탭 클릭 → URL 직접 이동), 프로그레스 심플화, 로그 통일 |
| v1.8.0 | 2026-03-17 | 7가지 크롤링 신뢰성 개선: productSet 검증, per-tab 중복방지, "만 검색" 자동클릭, SW 상태보존, 탭클릭 결과확인, CAPTCHA 일시정지/재개, 메시지 재시도 |
| v1.7.1 | 2026-03-16 | injected.js stale 데이터 버그 수정, 전체탭 명시적 클릭, 로그 복원, 데이터 초기화 API |
| v1.7.0 | 2026-03-16 | 심플 로직 재작성 (페이지→total→model→checkout) |
| v1.6.x | 2026-03-16 | 퀵클릭 시퀀스 시도 (실패) |
| v1.5.x | 2026-03-16 | 탭 클릭 방식 + race condition 수정 시도 |
| v1.4.x | 2026-03-16 | 초기 작동 버전 (injected.js + content-script.js) |

## 알려진 이슈

- 파트가중치(search5_partwt) 구현됨 (services.py) 단 UI 미연동
- nid.naver.com 2FA 리다이렉트 시 content-script 미작동 → background.js URL 감시로 대응
- React 웹 대시보드에서 실시간 데이터 반영하려면 페이지 새로고침 필요

### UC 크롤러 이슈 (2026-03-17)

| 이슈 | 상태 | 상세 |
|------|------|------|
| 네이버 IP 차단 | 미해결 | 서버(192.168.219.100)에서 네이버쇼핑 접속 시 "쇼핑 서비스 접속이 일시적으로 제한" 응답. 짧은 시간 내 다수 요청으로 IP 차단됨. 시간 경과 후 자동 해제 예상 |
| headless 모드 차단 | 해결 | UC headless 모드를 네이버가 감지하여 빈 페이지(body 693자) 반환 → `headless=False` + Xvfb 가상 디스플레이 사용 |
| ChromeDriver 버전 불일치 | 해결 | Chrome 145 vs UC 자동다운로드 ChromeDriver 146 → `version_main=145` 명시 |
| DISPLAY 미설정 | 해결 | Django 프로세스에 DISPLAY 환경변수 없음 → `os.environ['DISPLAY'] = ':0'` 설정 |
| 모달 깜빡임 | 해결 | UC 모드에서 Chrome 확장 폴링이 동시 실행되어 상태 충돌 → mode 체크로 분리 |
