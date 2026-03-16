# CLAUDE.md — 네이버쇼핑 Term 분석기 (naverterms)

> **네이버쇼핑 검색 키워드의 term 구조 분석 및 가중치 평가 도구**

| 항목 | 내용 |
|------|------|
| Version | 2.0 (betonaTerms2.py 기반) |
| 작성일 | 2026-03-15 |
| 대상 사이트 | search.shopping.naver.com |
| GUI | PySide6 (데스크톱 앱) |
| 크롤링 | Selenium + Chrome DevTools Protocol |

---

## 1. 프로젝트 개요

네이버쇼핑에서 키워드를 검색하면 내부적으로 해당 키워드를 **term 단위로 분해**(예: "베란다화분선반" → "베란다", "화분", "선반")합니다. 이 프로그램은 해당 term 구조를 추출하고, 상위 40개 상품의 상품명을 분석하여 **6가지 가중치**를 계산함으로써 키워드 최적화 전략을 수립하는 도구입니다.

### 1.1 핵심 기능

| 기능 | 설명 |
|------|------|
| term 추출 | 네이버쇼핑 API 응답에서 `shoppingResult.terms` 파싱 |
| 상품 데이터 수집 | 전체/가격비교/네이버페이 탭별 상위 40개 상품 수집 |
| 6가지 가중치 분석 | 순서고정/위치/상품명/파트/카테고리 가중치 계산 |
| 상품 팝업 뷰어 | 더블클릭 시 상품 상세 팝업 (탭 전환, 필터링, 하이라이트) |
| 엑셀 저장 | 키워드 분석표 + 상품 리스트 + 태그 통계 저장 |

---

## 2. 참조 원본 (200번 서버)

### 마운트 경로
```
/mnt/betona_python/python/TermSearch/   ← 192.168.219.200:/betona/python/TermSearch (읽기 전용)
```

> **원본 파일 절대 수정 금지** — 참조/분석 전용

### 파일 버전 히스토리

| 파일 | 버전 | 설명 |
|------|:----:|------|
| `termsearch.py` | v1.0 | 초기 버전 — 단일 키워드, term 추출만 |
| `betonaTerms.py` | v1.5 | 다중 키워드, 순서고정가중치 추가, 상품 데이터 저장 시작 |
| `betonaTerms2.py` | **v2.0** | **현재 최종본** — 봇 방지 우회, 탭별 수집, 팝업 뷰어, 6가지 가중치, 태그 분석 |

---

## 3. 크롤링 메커니즘 (핵심)

### 3.1 데이터 수집 방식

네이버쇼핑은 일반 HTML 파싱이 불가능합니다. **Chrome DevTools Protocol (CDP)**을 통해 네트워크 응답을 가로채서 JSON 데이터를 추출합니다.

```
Selenium Chrome 실행
  → search.shopping.naver.com 접속
  → 키워드 입력 (한 글자씩 랜덤 딜레이)
  → 탭 클릭 (전체/가격비교/네이버페이)
  → driver.get_log("performance") 로 네트워크 로그 수집
  → "search/all" + "sort=rel" URL 패턴 필터링
  → CDP Network.getResponseBody 로 JSON 응답 추출
  → shoppingResult.products (상품 리스트) + shoppingResult.terms (term 분해 결과)
```

### 3.2 봇 탐지 우회 (betonaTerms2.py)

| 기법 | 구현 |
|------|------|
| 모바일 UA | `SM-G991N` Android 11 모바일 User-Agent 사용 |
| 자동화 숨김 | `--disable-blink-features=AutomationControlled` |
| 스위치 제거 | `excludeSwitches: ["enable-automation"]` |
| webdriver 프로퍼티 | CDP로 `navigator.webdriver = undefined` 오버라이드 |
| 랜덤 타이핑 | 글자마다 `0.08~0.35초` 랜덤 딜레이 |

### 3.3 수집 탭 (3개)

| 탭 | XPath | 설명 |
|----|-------|------|
| 전체 | `li[1]/a` | 전체 상품 (term 정보 포함) |
| 가격비교 | `li[2]/a` | 가격비교 상품 |
| 네이버페이 | `li[3]/a` | 네이버페이 상품 |

### 3.4 "000만 검색하기" 버튼

키워드에 유사 상품이 포함될 경우 네이버가 "찾으시는 상품과 유사한 상품도 함께 노출합니다" 메시지를 표시합니다. 이때 해당 키워드만 검색하는 버튼을 자동 클릭합니다.

---

## 4. 데이터 구조

### 4.1 전역 products 딕셔너리

```python
products = {
    "키워드": {
        "전체": {
            "items": [상품1, 상품2, ...],  # 최대 40개
            "total": 총검색수
        },
        "가격비교": { ... },
        "네이버페이": { ... }
    }
}
```

### 4.2 상품 데이터 항목

| 필드 | API 키 | 설명 |
|------|--------|------|
| productName | `productName` | 상품명 |
| mallName | `mallName` | 스토어명 |
| reviewCount | `reviewCount` | 리뷰 수 |
| manuTag | `manuTag` | 태그 목록 |
| attributeValue | `attributeValue` | 속성 항목 |
| characterValue | `characterValue` | 속성 값 |
| openDate | `openDate` | 등록일 |
| category1~4Name | `category1Name` ~ `category4Name` | 카테고리 (4단계) |
| imageUrl | `imageUrl` | 대표 이미지 URL |
| brand | `brand` | 브랜드 |
| maker | `maker` | 제조사 |

### 4.3 테이블 컬럼 구조 (12컬럼)

| 인덱스 | 컬럼명 | 설명 |
|:------:|--------|------|
| 0 | 키워드 | 검색 키워드 |
| 1~4 | 1term ~ 4term | 네이버 term 분해 결과 |
| 5 | 순서고정가중치 | term 쌍이 순서대로 붙어있는 비율 |
| 6 | 위치가중치 | term 쌍의 위치 관계 (1=정순, 2=역순) |
| 7 | 상품명가중치 | 상위 40개 중 term 쌍 포함 상품 수 |
| 8 | 파트가중치및비고 | (미구현) |
| 9 | 카테고리우선여부 | 동일 카테고리 상품 수 |
| 10 | 총검색수 | 네이버 전체 검색 결과 수 |
| 11 | 상품수 | 수집된 상품 수 |

---

## 5. 6가지 가중치 분석 상세

### 5.1 term검색 (search1_term)

네이버쇼핑 API에서 `shoppingResult.terms`를 추출하여 1term~4term 컬럼에 기록합니다.

### 5.2 순서고정가중치 (search2_orderwt)

**인접한 term 쌍(AB, BC, CD)**에 대해 상위 10개 상품의 상품명에서:
- 공백 제거 후 `term1+term2`가 **붙어있는** 경우를 카운트
- 결과: `term1term2(순서고정수/전체포함수)`

### 5.3 위치가중치 (search3_positionwt)

인접 term 쌍에 대해:
- 상품명에서 `term1` 바로 다음에 `term2`가 오면 → **1 (정순)**
- `term2` 다음에 `term1`이 오면 → **2 (역순)**
- 결과로 네이버가 어느 순서를 선호하는지 판단

### 5.4 상품명가중치 (search4_namewt)

상위 **40개** 상품 중 term 쌍을 **모두 포함**하는 상품 수를 카운트합니다.
- 결과: `term1term2(포함수/40)`

### 5.5 파트가중치 (search5_partwt)

현재 **미구현** (`pass`).

### 5.6 카테고리우선여부 (search6_catwt)

상위 상품들의 카테고리가 **동일 카테고리에 집중**되어 있는지 확인합니다.
- 1위 상품의 카테고리와 동일한 카테고리의 상품 수를 카운트

---

## 6. GUI 구성

### 6.1 메인 윈도우 (MainWindow)

```
┌──────────────────────────────────────┐
│ [키워드 입력 (엔터로 구분)]           │
│ [검색어추가] [CLEAR] [엑셀저장]       │
│                                      │
│ ┌────────────────────────────────┐   │
│ │ 키워드 │1term│2term│...│상품수│   │
│ │ ─────────────────────────────  │   │
│ │ 베란다화분선반│베란다│화분│...│   │
│ │ 마우스장패드  │마우스│장 │...│   │
│ └────────────────────────────────┘   │
│                                      │
│ [term검색][순서고정][위치][상품명]     │
│ [파트][카테고리][검색버튼]            │
└──────────────────────────────────────┘
```

### 6.2 상품 팝업 (ProductPopup)

테이블 행 더블클릭 시 열림:
- **탭 버튼**: 전체(총검색수) / 가격비교(총검색수) / 네이버페이(총검색수)
- **필터 버튼**: `term1+term2 상품10위까지` / `40위까지 전체보기`
- **상품 테이블**: 상품명(하이라이트), 스토어명, 카테고리, 속성, 태그, 브랜드, 제조사, 리뷰수, 등록일, 이미지URL
- **저장**: 엑셀저장(탭별/전체) + 태그저장(중복수 내림차순)

### 6.3 하이라이트 규칙

| 색상 | 용도 |
|------|------|
| 파란색 볼드 | 필터링된 주요 term (primary) |
| 빨간색 볼드 | 나머지 term (secondary) |

---

## 7. 네이버쇼핑 API 구조 (핵심 레퍼런스)

> 원본: `/mnt/betona_python/python/TermSearch/naverurl.txt`, `products.txt`, `shoppingResult.txt`

### 7.1 검색 URL 구조

```
baseurl = "https://search.shopping.naver.com/search/all?"
```

| 파라미터 | 예시 값 | 설명 |
|----------|---------|------|
| `query` | 매트리스 | **검색어 (필수)** |
| `adQuery` | 매트리스 | 광고 추적용 검색어 |
| `origQuery` | 매트리스 | 원래 사용자 입력 검색어 |
| `pagingIndex` | 1 | 페이지 번호 |
| `pagingSize` | 40 | 한 페이지당 결과 수 (기본 40, **최대 100**) |
| `productSet` | total | 필터 탭 구분 |
| `sort` | rel | 정렬 방식 |
| `viewType` | list | 결과 보기 형식 |
| `minPrice` | 40000 | 최소 가격 필터 (원) |
| `maxPrice` | 323000000 | 최대 가격 필터 (원) |

### 7.2 productSet 탭 매핑

| 탭 이름 | productSet 값 |
|---------|---------------|
| 전체 | `total` |
| 가격비교 | `model` |
| 네이버페이 | `checkout` |
| 백화점/홈쇼핑 | `department` |
| 쇼핑윈도(브랜드스토어) | `window` |
| 해외직구 | `overseas` |

### 7.3 sort 정렬 방식

| 정렬 조건 | sort 값 |
|-----------|---------|
| 네이버 랭킹순 (기본) | `rel` |
| 낮은 가격순 | `price_asc` |
| 높은 가격순 | `price_dsc` |
| 리뷰 많은 순 | `review` |
| 리뷰 좋은 순 | `review_rel` |
| 등록일순 | `date` |

### 7.4 배송/혜택 필터 파라미터

| 항목 | 파라미터 | 값 |
|------|----------|-----|
| 빠른배송 | `fastDelivery` | `true` |
| 무료배송 | `freeDelivery` | `true` |
| 희망일배송 | `hopeDelivery` | `true` |
| 정기구독 | `subscriptionDelivery` | `true` |
| 무료교환반품 | `freeReturnDelivery` | `true` |
| 핫딜 | `hotdeal` | `true` |
| 카드할인 | `cardDiscount` | `true` |
| 쿠폰 | `coupon` | `true` |
| 적립 | `point` | `true` |

### 7.5 API 응답 전체 트리 구조

```
root
├── productSetFilter              # 판매처 필터 정보
│   ├── title: "판매처"
│   ├── filterValues[]            # 탭별 상품 수 (productCount) 포함
│   └── filterAction.paramName: "productSet"
│
├── searchAdResult                # 광고 상품
│   ├── adMeta                    # 광고 메타 정보
│   └── products[]                # 광고 포함 상품 리스트
│
├── searchParam                   # 검색 파라미터 에코
│   ├── sort, pagingIndex, pagingSize
│   ├── viewType, productSet
│   └── ...
│
├── shoppingResult                # ★ 핵심 검색 결과
│   ├── status.code: "0"          # 0 = 정상
│   ├── query                     # 검색어
│   ├── stopwordQuery             # 불용어 제거 후 검색어
│   ├── strQueryType              # 검색어 인식 타입 ("카테고리" 등)
│   ├── nluTerms[]                # 자연어 분석 키워드
│   ├── total                     # ★ 전체 검색 결과 수
│   ├── termCount                 # ★ term 개수
│   ├── terms[]                   # ★ term 분해 결과 ["베란다", "화분", "선반"]
│   ├── searchTime                # 검색 응답 시간 (초)
│   ├── cmpOrg                    # 카테고리 체계 (1~4차)
│   └── products[]                # ★ 상품 리스트 (최대 100개)
│
└── queryValidateResult           # 검색어 유효성/성인인증 필요 여부
```

### 7.6 shoppingResult 상세 필드

| 필드 | 설명 | 예시 |
|------|------|------|
| `status.code` | 응답 코드 (0=정상) | `"0"` |
| `query` | 실제 검색어 | `"매트리스"` |
| `stopwordQuery` | 불용어 필터 후 검색어 | `"매트리스"` |
| `strQueryType` | 검색어 인식 타입 | `"카테고리"` |
| `nluTerms[]` | 자연어 분석 키워드+타입 | `[{keyword:"매트리스", type:"카테고리"}]` |
| `total` | **전체 상품 수** | `73065` |
| `orgQueryTotal` | 원 검색어 기반 전체 수 | `1939502` |
| `termCount` | **term 개수** | `1` |
| `terms[]` | **term 분해 배열** | `["매트리스"]` |
| `intersectionTermCount` | 교집합 검색어 수 | `0` |
| `exclusionTermCount` | 제외어 수 | `0` |
| `searchTime` | 검색 응답 시간 | `0.081981` |
| `cmpOrg.category1~4` | 카테고리 체계 (4단계) | `[ID, name, relevance]` |
| `products[]` | **상품 배열** | 아래 7.7 참조 |

### 7.7 products[] 상품 객체 전체 필드

| 필드 | 설명 | 예시 |
|------|------|------|
| `id`, `nvMid` | 상품 고유 ID | `"35227195618"` |
| `rank` | 페이지 내 순위 | `1` |
| `productName`, `productTitle` | 상품명 | `"잠스쿨 접이식 매트리스..."` |
| `imageUrl` | 대표 이미지 URL | `https://shopping-phinf.pstatic.net/...` |
| `additionalImageCount` | 추가 이미지 수 | `10` |
| `openDate` | 최초 등록일 (yyyymmddhhmmss) | `"20221014113748"` |
| `brand` | 브랜드명 | `"잠스쿨"` |
| `maker` | 제조사명 | `"휴먼링스"` |
| `lowPrice`, `price` | 최저가 / 대표가격 (원) | `"139000"` |
| `priceUnit` | 통화 단위 | `"KRW"` |
| `reviewCount`, `reviewCountSum` | 리뷰 수 | `3626` |
| `scoreInfo` | 리뷰 평점 | `4.82` |
| `category1Name` ~ `category4Name` | 카테고리 (4단계) | `"가구/인테리어"` → `"매트리스"` |
| `attributeValue` | 속성명 리스트 | `"두께_M"` |
| `characterValue` | 속성값 리스트 | `"7cm"` |
| `manuTag` | 태그 목록 | `"무료배송,빠른배송"` |
| `smryReview` | 리뷰 요약 키워드 | `"쿠션감 좋고 포장도 깔끔"` |
| `isHotDeal` | 핫딜 여부 | `0` / `1` |
| `isNaverPay` | 네이버페이 여부 | `"1"` / `"0"` |
| `lnchYm` | 출시 연월 | `"202210"` |
| `keepCnt` | 찜 수 | `547` |
| `mallName` | 판매 쇼핑몰명 | `"잠스쿨"` |
| `mallCount` | 연결된 쇼핑몰 수 | `17` |
| `dlvryPrice` | 배송비 | `"0"` |
| `isAdult` | 성인 인증 필요 여부 | `0` / `1` |
| `productColor` | 색상 정보 | (있을 경우) |

### 7.8 lowMallList[] (가격비교용 쇼핑몰 정보)

| 필드 | 설명 |
|------|------|
| `mallSeq` | 쇼핑몰 고유번호 |
| `mallPid` | 쇼핑몰 내 상품 ID |
| `price` | 해당 몰에서의 가격 |
| `name` | 쇼핑몰 이름 (쿠팡, 오늘의집 등) |
| `naverPay` | 네이버페이 지원 여부 |
| `chnlType`, `chnlName` | 채널 정보 (스토어팜 등) |

### 7.9 데이터 활용 매핑

| 목적 | 사용 필드 |
|------|-----------|
| term 분석 | `shoppingResult.terms[]`, `termCount` |
| 가격비교 | `lowPrice`, `lowMallList[]` |
| 리뷰 분석 | `reviewCount`, `smryReview`, `scoreInfo` |
| 카테고리 분류 | `category1~4Name`, `cmpOrg` |
| 상품 속성 태깅 | `attributeValue`, `characterValue` |
| 이미지 다운로드 | `imageUrl`, `additionalImageCount` |
| 마켓별 비교 | `mallCount`, `mallName`, `lowMallList[]` |
| 키워드 최적화 | `terms[]`, `total`, `orgQueryTotal` |

---

## 8. 기술 스택

| 영역 | 기술 |
|------|------|
| GUI | PySide6 |
| 크롤링 | Selenium + ChromeDriver |
| 데이터 가로채기 | Chrome DevTools Protocol (CDP) — `Network.getResponseBody` |
| 데이터 파싱 | `json` (API 응답) |
| 엑셀 | pandas + openpyxl + xlsxwriter |
| HTML 파싱 | `re.sub` (태그 제거용) |

---

## 9. 기존 코드 문제점 및 개선 방향

### 9.1 현재 문제점

| No | 문제 | 상세 |
|:--:|------|------|
| 1 | **봇 탐지 취약** | 매 검색마다 Chrome 새로 실행/종료 → 세션 유지 불가 |
| 2 | **XPath 하드코딩** | 네이버 UI 변경 시 전체 XPath 수정 필요 |
| 3 | **에러 처리 미흡** | CDP 응답 실패 시 전체 중단, 재시도 로직 불완전 |
| 4 | **데이터 메모리 only** | `products` 전역변수에만 저장, 프로그램 종료 시 소멸 |
| 5 | **중복 코드** | `search1~6` 함수들의 행 선택 로직이 반복됨 |
| 6 | **파트가중치 미구현** | `search5_partwt`가 `pass` 상태 |
| 7 | **카테고리 분석 버그** | `categoryWt`에서 `products[keyword][0]` 접근 — dict인데 인덱스로 접근 |
| 8 | **위치가중치 로직 오류** | `searchABtermPosition`에서 `break` 위치가 잘못됨 — 첫 매칭 term 쌍에서 즉시 탈출 |
| 9 | **총검색수/상품수 미기록** | 테이블 10~11컬럼에 값이 채워지지 않음 |

### 9.2 개선 방향 (이 프로젝트)

| 순서 | 작업 | 설명 |
|:----:|------|------|
| 1 | 모듈 분리 | 크롤링/분석/GUI를 별도 모듈로 분리 |
| 2 | 브라우저 재사용 | Chrome 세션 유지하여 봇 탐지 회피율 향상 |
| 3 | DB 연동 | 수집 데이터 MySQL 저장 (키워드별 히스토리 관리) |
| 4 | 버그 수정 | 카테고리/위치가중치 로직 오류 수정 |
| 5 | 파트가중치 구현 | term이 상품명의 어느 파트(앞/중간/뒤)에 위치하는지 분석 |
| 6 | XPath 설정화 | config 파일로 XPath 관리 |
| 7 | 에러 핸들링 | 재시도 로직 개선, 로깅 추가 |

---

## 10. 크롤링 공통 원칙

> ai100 프로젝트 공통 규칙 준수

| No | 규칙 | 상세 |
|:--:|------|------|
| 1 | User-Agent | 실제 모바일 브라우저 값 사용 |
| 2 | 요청 딜레이 | 탭 전환 1~3초, 타이핑 0.08~0.35초 랜덤 |
| 3 | 에러 재시도 | 최대 3회, 지수 백오프 |
| 4 | 환경변수 | `.env` 파일로 설정 관리 (하드코딩 금지) |
| 5 | 저장 파일명 | `{keyword}_{YYYYMMDD_HHMMSS}.xlsx` |

---

## 11. UI/UX 디자인 가이드라인 (필수)

> **UI는 항상 신경써서 만들 것** — 기능만 돌아가는 수준은 허용하지 않음

### 11.1 다크모드 / 화이트모드 필수 지원

- 모든 페이지, 컴포넌트, 팝업은 **다크모드와 화이트모드를 모두 지원**해야 함
- `useTheme()` 훅의 `dark` 값을 기준으로 스타일 분기
- Tailwind `dark:` 프리픽스 또는 조건부 클래스 방식 사용

### 11.2 색상 체계

| 요소 | 다크모드 | 화이트모드 |
|------|----------|------------|
| 배경 (페이지) | `bg-[#0f0f1a]` ~ `bg-[#1a1a2e]` | `bg-white` ~ `bg-gray-50` |
| 배경 (카드/패널) | `bg-[#1e1e2e]` ~ `bg-[#2d2d2d]` | `bg-white` + `shadow-sm` |
| 배경 (테이블 헤더) | `bg-[#2d2d2d]` | `bg-gray-100` |
| 배경 (테이블 행 hover) | `hover:bg-[#2a2a3e]` | `hover:bg-gray-50` |
| 배경 (입력필드) | `bg-[#2d2d2d] border-[#444]` | `bg-white border-gray-300` |
| 텍스트 (기본) | `text-white` | `text-gray-900` |
| 텍스트 (보조) | `text-gray-400` | `text-gray-500` |
| 텍스트 (비활성) | `text-gray-500` | `text-gray-400` |
| 구분선 | `border-[#333]` ~ `border-[#444]` | `border-gray-200` |
| 강조 (네이버 그린) | `#03c75a` | `#03c75a` |
| 강조 (블루) | `#0078d7` | `#2563eb` |
| 위험 (빨강) | `text-red-400` | `text-red-600` |
| 성공 (초록) | `text-green-400` | `text-green-600` |

### 11.3 컴포넌트 스타일 규칙

| 컴포넌트 | 규칙 |
|----------|------|
| **버튼** | 배경색 + 흰색 텍스트, hover 시 약간 어두운 색, disabled 시 `opacity-50` |
| **테이블** | 헤더 고정, 행 hover 효과, 선택 행 하이라이트, 텍스트 크기 `text-[12px]` |
| **입력필드** | 모드별 배경/테두리 분기, focus 시 `ring-2 ring-blue-500` |
| **팝업/모달** | 반투명 오버레이 `bg-black/60`, 카드 `rounded-lg shadow-2xl`, 닫기 버튼 |
| **상태 표시** | 연결: 초록 dot, 에러: 빨간 dot, 진행중: animate-pulse, CAPTCHA: 노란 배너 |
| **차트** | 다크모드 배경에 맞는 그리드/텍스트 색상, 범례 가독성 확보 |

### 11.4 반응형 (Responsive)

- PC(≥768px): 테이블 전체 표시, 사이드 여백
- 모바일(<768px): 가로 스크롤, 컬럼 축소, 터치 친화적 버튼 크기
- 팝업: `max-w-[1400px] max-h-[85vh]`, 모바일에서는 전체화면

### 11.5 금지 사항

- 하드코딩 색상만 사용하지 말 것 → 반드시 다크/라이트 분기
- 텍스트가 배경에 묻히는 조합 금지 (대비율 WCAG AA 이상)
- 기능만 되고 못생긴 UI 금지 — 항상 깔끔하고 정돈된 레이아웃

---

## 12. 관리자 참고

- **파이썬 크롤링 전문가** — 리눅스 환경 숙련, 초보 설명 불필요
- **코드는 바로 동작하는 완성본**으로 제시할 것 (설명용 예시 코드 금지)
- 불필요한 주석/설명 최소화
- GUI는 **PySide6**로 통일
- DB 스키마 변경 시 반드시 먼저 확인
- `.env` 내용 코드에 하드코딩 금지
- **포트/서버 설정 변경 시 반드시 사용자에게 확인 먼저**

---

## 12. 변경 이력

| 날짜 | 버전 | 변경 내용 |
|------|:----:|-----------|
| 2026-03-15 | v1.0 | 초기 기술문서 작성 (betonaTerms2.py 분석 기반) |
| 2026-03-15 | v1.1 | UI/UX 디자인 가이드라인 추가 (섹션 11) — 다크/화이트 모드 필수 지원 |
