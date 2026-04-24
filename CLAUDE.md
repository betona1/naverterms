# CLAUDE.md — 네이버쇼핑 Term 분석기 (naverterms)

## 절대 금지 사항

- **원본 상품 DELETE 절대 금지** — 스마트스토어 원본 상품(origin product)은 어떤 경우에도 삭제(DELETE)하지 않는다. 테스트용 복사본만 삭제 가능.
- **포트 3000은 `901 플래너(ntplanic)` 전용**입니다. 이 프로젝트에서 3000번을 바인딩하지 마십시오.
- 신규 서비스 추가/포트 변경 시, `ss -tlnp | grep :3000` 로 충돌이 없는지 먼저 확인합니다.

> **네이버쇼핑 검색 키워드의 term 구조 분석, 순위추적, 스마트스토어 상품관리 통합 도구**

| 항목 | 내용 |
|------|------|
| Version | 3.4 |
| 최종 수정일 | 2026-04-17 |
| 대상 사이트 | search.shopping.naver.com, api.commerce.naver.com, api.naver.com(검색광고) |
| 프론트엔드 | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| 백엔드 | Django REST Framework |
| 크롤링 | Chrome 확장프로그램 + UC 크롤러 (undetected-chromedriver) |
| DB | MySQL (naverdb + myproduct) |

---

## 1. 프로젝트 아키텍처

### 1.1 포트 배정

| 서비스 | 포트 | PM2 프로세스명 |
|--------|------|----------------|
| Django 백엔드 | **8900** | naverterms-backend |
| Vite 프론트 개발서버 | **5174** | naverterms-frontend |

### 1.2 디렉토리 구조

```
naverterms/
├── .env                          # DB 자격증명 (naverdb, myproduct)
├── ecosystem.config.cjs          # PM2 설정
├── chrome-extension/             # 크롬 확장프로그램 소스
│
├── backend/
│   ├── manage.py
│   ├── config/
│   │   ├── __init__.py           # PyMySQL → MySQLdb 어댑터
│   │   ├── settings.py           # DB 2개: default(naverdb), myproduct
│   │   ├── db_router.py          # NaverDbRouter (naver 모델 → naverdb)
│   │   ├── urls.py               # /api/naver/, /api/smartstore/
│   │   └── wsgi.py, asgi.py
│   ├── naver/                    # 네이버 Term 분석 앱
│   │   ├── models.py             # 6개 모델 (Django ORM, naverdb)
│   │   ├── views.py              # 20개 API 뷰
│   │   ├── services.py           # 6가지 가중치 분석 + 연관키워드 + 순위추적
│   │   ├── uc_crawler.py         # UC 크롤러 (스레드 기반)
│   │   ├── serializers.py        # DRF 시리얼라이저
│   │   ├── urls.py               # 20개 엔드포인트
│   │   └── migrations/
│   └── smartstore/               # 스마트스토어 상품관리 앱
│       ├── views.py              # 12개 API 뷰
│       ├── smartstore_service.py # 상점 CRUD (raw SQL, myproduct DB)
│       ├── smartstore_product_service.py  # 상품 동기화/품절처리
│       └── urls.py               # 11개 엔드포인트
│
└── frontend/
    ├── package.json, vite.config.ts
    ├── src/
    │   ├── App.tsx               # TopNav + 7페이지 해시 라우팅
    │   ├── components/TopNav.tsx # 상단 탭 네비게이션
    │   ├── hooks/useTheme.ts     # 다크/라이트 모드
    │   ├── api/                  # API 클라이언트 (axios)
    │   │   ├── naverApi.ts       # baseURL: /api/naver
    │   │   ├── smartstoreApi.ts  # baseURL: /api/smartstore
    │   │   └── smartstoreProductApi.ts
    │   ├── components/
    │   │   ├── naver/            # ExtensionStatus, ProductPopup, useNaverExtension 등
    │   │   └── smartstore/       # StoreSettingsModal
    │   └── pages/
    │       ├── NaverTermsPage.tsx     # Term 분석 대시보드
    │       ├── NaverRankPage.tsx      # 순위추적 (네이버 검색 API)
    │       ├── NaverKeywordPage.tsx   # 연관키워드 검색 (검색광고 API)
    │       ├── SmartStoreProductsPage.tsx  # 스마트스토어 상품관리
    │       ├── SmartStoreAnalyticsPage.tsx # 스토어 분석 대시보드
    │       ├── OwnerClanProductsPage.tsx   # 오너클랜 상품관리
    │       └── NaverExtDownloadPage.tsx   # 확장프로그램 설치 가이드
    └── public/downloads/         # 확장프로그램 ZIP
```

### 1.3 데이터베이스

| DB | 별칭 | 호스트 | 용도 | 접근 방식 |
|----|------|--------|------|-----------|
| naverdb | default / naverdb | 192.168.219.200:3306 | 키워드, 분석, 순위 | Django ORM |
| myproduct | myproduct | 192.168.219.200:3306 | 스마트스토어 상점/상품 | Raw SQL |

### 1.4 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 19 + TypeScript + Vite 7 + Tailwind CSS v4 |
| 차트 | Recharts |
| 백엔드 | Django 5 + Django REST Framework |
| DB 드라이버 | PyMySQL (MySQLdb 호환 어댑터) |
| 엑셀 | openpyxl (백엔드), xlsx (프론트엔드) |
| 크롤링 | undetected-chromedriver, Selenium |
| API 인증 | bcrypt (네이버 커머스 OAuth2), HMAC-SHA256 (검색광고 API) |
| 프로세스 관리 | PM2 |

---

## 2. 페이지 구성 (7개)

| # | 페이지 | 라우트 | 설명 |
|---|--------|--------|------|
| 1 | **스마트스토어상품** | `#products` | 상품 목록, 동기화, 품절처리, 순위추적 연동, Excel 내보내기 |
| 2 | **스토어분석** | `#analytics` | 스토어별 카테고리 분석, 사업자/스토어 토글 |
| 3 | **Term 분석** | `#terms` | 키워드 term 분해, 6가지 가중치, 상품 팝업, UC/확장프로그램 크롤링 |
| 4 | **순위추적** | `#rank` | 네이버 검색 API로 스토어/상품 순위 추적, 30일 차트, 히스토리 |
| 5 | **연관키워드** | `#keywords` | 네이버 검색광고 API 연관키워드 검색, 모두검색, 필터/엑셀 |
| 6 | **오너클랜상품** | `#ownerclan` | 오너클랜 상품 관리 |
| 7 | **도우미프로그램** | `#extension` | 크롬 확장프로그램 ZIP 다운로드 + 설치 가이드 |

추가 모달: **상점설정** (StoreSettingsModal) — TopNav 우측 기어 아이콘

---

## 3. API 엔드포인트

### 3.1 Naver API (`/api/naver/`)

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/keywords/` | GET, POST | 키워드 목록/추가 |
| `/keywords/<id>/` | DELETE | 키워드 삭제 |
| `/ext/search-result/` | POST | 확장프로그램 → 검색결과 저장 |
| `/ext/captcha-status/` | POST | CAPTCHA 상태 보고 |
| `/ext/rank-result/` | POST | 확장프로그램 → 순위결과 저장 |
| `/analysis/<keyword_id>/` | GET, POST | 가중치 분석 조회/실행 |
| `/products/<keyword_id>/` | GET | 탭별 상품 조회 (?tab=total/model/checkout) |
| `/tags/<keyword_id>/` | GET | 태그 통계 |
| `/rank/targets/` | GET, POST | 순위추적 대상 관리 (source_product_id/name 지원) |
| `/rank/targets/<id>/` | DELETE | 대상 삭제 |
| `/rank/track/` | POST | 순위추적 실행 (네이버 검색 API, 200위까지) |
| `/rank/history/` | GET | 순위 이력 (?target_id, ?days) |
| `/rank/summary/` | GET | 순위 요약 (최근 변화) |
| `/related-keywords/` | GET | 연관키워드 검색 (?keyword, 검색광고 API) |
| `/schedules/` | GET, POST | 스케줄 관리 |
| `/schedules/<id>/` | PUT, DELETE | 스케줄 수정/삭제 |
| `/uc/start/` | POST | UC 크롤러 시작 |
| `/uc/status/` | GET | UC 크롤러 상태/로그 |
| `/uc/stop/` | POST | UC 크롤러 중지 |
| `/export/terms/` | GET | Term 분석 Excel 다운로드 |
| `/export/rank/` | GET | 순위 이력 Excel 다운로드 |
| `/reset-data/` | POST | 스냅샷/분석/순위 초기화 |

### 3.2 SmartStore API (`/api/smartstore/`)

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/stores/` | GET, POST | 상점 목록/생성 |
| `/stores/sample-excel/` | GET | 샘플 Excel 다운로드 |
| `/stores/upload/` | POST | Excel 일괄 등록 |
| `/stores/<id>/` | PUT, DELETE | 상점 수정/삭제 |
| `/products/` | GET | 상품 목록 (페이지네이션, 필터) |
| `/products/sync/` | POST | 네이버 API → DB 동기화 |
| `/products/stats/` | GET | 상태별 통계 |
| `/products/excel/` | GET | 상품 Excel 내보내기 |
| `/products/wcodes/` | GET | W코드 추출 |
| `/products/suspend-preview/` | POST | 품절처리 미리보기 |
| `/products/suspend/` | POST | 실제 품절처리 (네이버 API 호출) |

---

## 4. Django 모델 (naver 앱, naverdb)

| 모델 | 주요 필드 | 설명 |
|------|-----------|------|
| NaverKeyword | keyword(unique), terms(JSON), total_count, naverpay_count, price_compare_count | 키워드 + term 분해 |
| NaverSearchSnapshot | keyword(FK), tab_type, products(JSON), total | 탭별 상품 스냅샷 |
| NaverTermAnalysis | keyword(FK), term1~4, order/position/name/part_weight(JSON), category_priority(JSON) | 6가지 가중치 분석 결과 |
| NaverRankTarget | keyword(FK), target_type(store/product_id), target_value, source_product_id, source_product_name | 순위추적 대상 (상품 연결) |
| NaverRankHistory | target(FK), rank_position, found_product_name/price/id/url/image | 순위 이력 |
| NaverTrackingSchedule | name, target_ids(JSON), schedule_type, schedule_time | 자동 추적 스케줄 |

---

## 5. SmartStore DB 테이블 (myproduct, Raw SQL)

| 테이블 | 주요 컬럼 | 설명 |
|--------|-----------|------|
| smartstoreIdList | store_id, store_pw, store_name, commerce_api_key, commerce_secret_key | 스마트스토어 계정 |
| smartstore_product | origin_product_no(unique), name, sale_price, status_type, seller_management_code, ownerclan_soldout | 상품 카탈로그 |

---

## 6. 크롤링 메커니즘

### 6.1 Chrome 확장프로그램 방식

```
확장프로그램 → 네이버쇼핑 검색 → __NEXT_DATA__ 파싱
  → window.postMessage → 프론트엔드 useNaverExtension 훅
  → POST /api/naver/ext/search-result/ → DB 저장
```

### 6.2 UC 크롤러 방식 (서버사이드)

```
POST /api/naver/uc/start/ → 백그라운드 스레드
  → undetected-chromedriver 145
  → 탭 순회 (total → model → checkout)
  → __NEXT_DATA__ 또는 CDP fallback
  → DB 저장 + 실시간 로그
```

### 6.3 봇 탐지 우회

| 기법 | 구현 |
|------|------|
| 모바일 UA | Android 실제 User-Agent |
| 자동화 숨김 | `--disable-blink-features=AutomationControlled` |
| 스위치 제거 | `excludeSwitches: ["enable-automation"]` |
| webdriver 오버라이드 | CDP `navigator.webdriver = undefined` |
| 랜덤 딜레이 | 탭 간 1.5~3.5초, 키워드 간 2~5초 |

---

## 7. 네이버쇼핑 API 구조 (핵심 레퍼런스)

### 7.1 검색 URL

```
https://search.shopping.naver.com/search/all?query=키워드&sort=rel&pagingSize=40
```

### 7.2 productSet 탭 매핑

| 탭 | productSet |
|----|-----------|
| 전체 | `total` |
| 가격비교 | `model` |
| 네이버페이 | `checkout` |

### 7.3 shoppingResult 핵심 필드

| 필드 | 설명 |
|------|------|
| `total` | 전체 검색 결과 수 |
| `termCount` | term 개수 |
| `terms[]` | term 분해 배열 |
| `products[]` | 상품 배열 (최대 100개) |

### 7.4 products[] 주요 필드

`productName`, `mallName`, `reviewCount`, `manuTag`, `attributeValue`, `characterValue`, `openDate`, `category1~4Name`, `imageUrl`, `brand`, `maker`, `lowPrice`, `scoreInfo`

---

## 8. 6가지 가중치 분석

| # | 가중치 | 함수 | 설명 |
|---|--------|------|------|
| 1 | term검색 | - | `shoppingResult.terms` 추출 |
| 2 | 순서고정 | `calculate_order_weight` | 인접 term 쌍이 붙어있는 비율 (top 10) |
| 3 | 위치 | `calculate_position_weight` | 정순(1)/역순(2) 판단 (top 10) |
| 4 | 상품명 | `calculate_name_weight` | term 쌍 포함 상품 수 (top 40) |
| 5 | 파트 | `calculate_part_weight` | front/mid/back 분포 (top 40) |
| 6 | 카테고리 | `calculate_category_priority` | 1위 카테고리 집중도 |

---

## 9. 네이버 커머스 API (스마트스토어)

### 9.1 인증 (OAuth2 bcrypt)

```python
timestamp = int(time.time() * 1000)
password = f'{client_id}_{timestamp}'
signature = base64(bcrypt.hashpw(password, client_secret))
# POST api.commerce.naver.com/external/v1/oauth2/token
```

### 9.2 주요 엔드포인트

| 용도 | URL |
|------|-----|
| 상품 검색 | POST `/external/v1/products/search` |
| 상품 조회 | GET `/external/v2/products/origin-products/{no}` |
| 상품 수정 | PUT `/external/v2/products/origin-products/{no}` |

### 9.3 네이버 검색광고 API (연관키워드)

```python
# HMAC-SHA256 인증
timestamp = str(int(time.time() * 1000))
message = f'{timestamp}.GET./keywordstool'
signature = base64(hmac.new(SECRET_KEY, message, sha256))
# GET https://api.naver.com/keywordstool?hintKeywords=키워드&showDetail=1
# Headers: X-Timestamp, X-API-KEY, X-Customer, X-Signature
```

| 응답 필드 | 설명 |
|-----------|------|
| `relKeyword` | 연관 키워드명 |
| `monthlyPcQcCnt` | 월간 PC 검색수 |
| `monthlyMobileQcCnt` | 월간 모바일 검색수 |
| `monthlyAvePcClkCnt` | 월평균 PC 클릭수 |
| `monthlyAveMobileClkCnt` | 월평균 모바일 클릭수 |
| `monthlyAvePcCtr` | 월평균 PC 클릭률 |
| `monthlyAveMobileCtr` | 월평균 모바일 클릭률 |
| `compIdx` | 경쟁도 (HIGH/MEDIUM/LOW) |
| `plAvgDepth` | 월평균 노출 광고수 |

---

## 10. UI/UX 디자인 가이드라인 (필수)

> **UI는 항상 신경써서 만들 것** — 기능만 돌아가는 수준은 허용하지 않음

### 10.1 다크모드 / 화이트모드 필수 지원

- `useTheme()` 훅의 `dark` 값을 기준으로 스타일 분기
- Tailwind `dark:` 프리픽스 또는 조건부 클래스 방식 모두 사용
- App.tsx에서 `<div className={dark ? 'dark' : ''}>` 래퍼로 두 패턴 동시 지원

### 10.2 색상 체계

| 요소 | 다크모드 | 화이트모드 |
|------|----------|------------|
| 배경 (페이지) | `bg-[#0f0f1a]` | `bg-[#f7f8fa]` |
| 배경 (카드) | `bg-[#1c1c2e]` | `bg-white` |
| 텍스트 (기본) | `text-white` | `text-gray-900` |
| 텍스트 (보조) | `text-gray-400` | `text-gray-500` |
| 구분선 | `border-[#2a2a40]` | `border-gray-200` |
| 강조 (네이버 그린) | `#03c75a` | `#03c75a` |

### 10.3 금지 사항

- 하드코딩 색상만 사용하지 말 것 → 반드시 다크/라이트 분기
- 텍스트가 배경에 묻히는 조합 금지 (WCAG AA 이상)
- 기능만 되고 못생긴 UI 금지

---

## 11. 크롤링 공통 원칙

| No | 규칙 | 상세 |
|:--:|------|------|
| 1 | User-Agent | 실제 모바일 브라우저 값 사용 |
| 2 | 요청 딜레이 | 탭 전환 1~3초, 타이핑 0.08~0.35초 랜덤 |
| 3 | 에러 재시도 | 최대 3회, 지수 백오프 |
| 4 | 환경변수 | `.env` 파일로 설정 관리 (하드코딩 금지) |

---

## 12. 관리자 참고

- **파이썬 크롤링 전문가** — 리눅스 환경 숙련, 초보 설명 불필요
- **코드는 바로 동작하는 완성본**으로 제시할 것 (설명용 예시 코드 금지)
- 불필요한 주석/설명 최소화
- DB 스키마 변경 시 반드시 먼저 확인
- `.env` 내용 코드에 하드코딩 금지
- **포트/서버 설정 변경 시 반드시 사용자에게 확인 먼저**

---

## 13. 참조 원본 (200번 서버)

```
/mnt/betona_python/python/TermSearch/   ← 192.168.219.200:/betona/python/TermSearch (읽기 전용)
```

> **원본 파일 절대 수정 금지** — 참조/분석 전용

| 파일 | 버전 | 설명 |
|------|:----:|------|
| `termsearch.py` | v1.0 | 초기 버전 — 단일 키워드 |
| `betonaTerms.py` | v1.5 | 다중 키워드, 순서고정가중치 추가 |
| `betonaTerms2.py` | v2.0 | 봇 방지 우회, 탭별 수집, 6가지 가중치 |

---

## 14. 변경 이력

| 날짜 | 버전 | 변경 내용 |
|------|:----:|-----------|
| 2026-03-15 | v1.0 | 초기 기술문서 작성 (betonaTerms2.py 분석 기반) |
| 2026-03-15 | v1.1 | UI/UX 디자인 가이드라인 추가 |
| 2026-04-16 | **v3.0** | **ai100에서 독립 프로젝트로 분리** — Django+React 웹앱, 포트 8900, 스마트스토어 상품관리 추가 |
| 2026-04-16 | v3.3 | 순위추적 네이버API 전환, 상품등록한도 계산기, PDF내보내기, 오너클랜 |
| 2026-04-17 | **v3.4** | **Term 분석 5가지 버그 수정**, 스마트스토어 상품→순위추적 연동 모달, **연관키워드 검색**(검색광고 API), 확장프로그램 v2.2.0 |
