# naverterms — 네이버쇼핑 Term 분석기 & 스마트스토어 통합 도구

네이버쇼핑 검색 키워드의 **term 구조 분석**, **순위추적**, **연관키워드 조사**,
**스마트스토어 상품관리**를 하나로 묶은 웹 도구입니다.

| 항목 | 내용 |
|------|------|
| 프론트엔드 | React 19 + TypeScript + Vite + Tailwind CSS v4 |
| 백엔드 | Django 5 + Django REST Framework |
| 크롤링 | Chrome 확장프로그램 + UC 크롤러 (undetected-chromedriver) |
| DB | MySQL (naverdb + myproduct) |
| 프로세스 관리 | PM2 |

> ⚠️ **보안 안내**
> 이 저장소에는 **API 키·비밀번호·DB 자격증명이 포함되어 있지 않습니다.**
> 모든 비밀값은 `.env` 파일(깃 제외)과 DB 테이블에서 읽어옵니다.
> 설정 방법은 아래 [4. 환경변수 설정](#4-환경변수-설정-env)을 참고하세요.

---

## 1. 주요 기능

| 페이지 | 라우트 | 설명 |
|--------|--------|------|
| 스마트스토어상품 | `#products` | 상품 동기화 · 품절처리 · 순위추적 연동 · Excel 내보내기 |
| 스토어분석 | `#analytics` | 스토어별 카테고리 분석 (사업자/스토어 토글) |
| Term 분석 | `#terms` | 키워드 term 분해 + 6가지 가중치 분석 + 상품 팝업 |
| 순위추적 | `#rank` | 네이버 검색 API로 순위 추적 (200위), 30일 차트 |
| 연관키워드 | `#keywords` | 네이버 검색광고 API 연관키워드 검색 |
| 오너클랜상품 | `#ownerclan` | 오너클랜 상품 관리 |
| 도우미프로그램 | `#extension` | 크롬 확장프로그램 다운로드 + 설치 가이드 |

---

## 2. 사전 준비물

- Python **3.12+**
- Node.js **20+** (Vite 7 권장)
- MySQL 8.x — `naverdb`, `myproduct` 두 개의 데이터베이스
- Google Chrome (UC 크롤러 / 확장프로그램용)
- (선택) PM2 — 프로세스 관리: `npm i -g pm2`

---

## 3. 설치

```bash
git clone https://github.com/betona1/naverterms.git
cd naverterms

# ── 백엔드 ──────────────────────────────
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# ── 프론트엔드 ──────────────────────────
cd ../frontend
npm install
```

---

## 4. 환경변수 설정 (.env)

루트의 `.env.example` 을 복사해 `.env` 를 만들고 값을 채웁니다.

```bash
cp .env.example .env
```

> `.env` 는 `.gitignore` 에 의해 **절대 깃에 올라가지 않습니다.**
> 키 이름과 발급 방법은 `.env.example` 안에 모두 주석으로 적혀 있습니다.

### 4.1 DB 자격증명

`NAVER_DB_*`, `MYPRODUCT_DB_*` (선택: `OWIMAGE_DB_*`) 에 MySQL 접속 정보를 입력합니다.

### 4.2 API 키 발급 방법

| 키 | 용도 | 발급처 |
|----|------|--------|
| `NAVER_SEARCH_CLIENT_ID` / `_SECRET` | 순위추적 (검색 API) | https://developers.naver.com/apps — 애플리케이션 등록 후 *검색* API 추가 |
| `NAVER_AD_CUSTOMER_ID` / `_ACCESS_KEY` / `_SECRET_KEY` | 연관키워드 (검색광고 API) | https://manage.searchad.naver.com → **도구 → API 사용 관리** |
| 커머스 API (`commerce_api_key` / `commerce_secret_key`) | 스마트스토어 상품 | https://apicenter.commerce.naver.com — 판매자센터 API 신청 |

> **커머스 API 키는 `.env` 가 아닙니다.**
> 상점별로 다르므로 `myproduct` DB 의 `smartstoreIdList` 테이블
> (`commerce_api_key`, `commerce_secret_key` 컬럼)에 저장합니다.
> 실행 후 프론트 우상단 **[상점설정] (⚙)** 모달에서 상점을 추가하며 입력하면 됩니다.

### 4.3 Django SECRET_KEY 생성

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```
출력값을 `DJANGO_SECRET_KEY=` 에 붙여넣습니다.

---

## 5. DB 마이그레이션 & 실행

```bash
# 백엔드 (포트 8901)
cd backend
source .venv/bin/activate
python manage.py migrate
python manage.py runserver 0.0.0.0:8901

# 프론트엔드 (포트 8900) — 다른 터미널
cd frontend
npm run dev
```

브라우저에서 **http://localhost:8900** 접속.

### PM2 로 운영 (권장)

```bash
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs naverterms-backend
```

| PM2 프로세스 | 포트 | 설명 |
|--------------|------|------|
| `naverterms-backend` | 8901 | Django REST API |
| `naverterms-frontend` | 8900 | Vite 개발 서버 |

> ⚠️ **포트 3000 은 다른 서비스 전용입니다. 바인딩하지 마세요.**

---

## 6. 네이버치트키 확장프로그램 (Chrome Extension)

> **네이버치트키 확장프로그램** — 네이버쇼핑/스마트스토어/지마켓 데이터를
> 브라우저에서 직접 수집해 백엔드로 전송하는 크롬 확장프로그램입니다.
> (소스: `chrome-extension/`, manifest 표기명 "쇼핑 통합 도우미", v3.0.26)

### 6.1 설치 방법

1. 크롬 주소창에 `chrome://extensions` 입력 → 우상단 **개발자 모드** 켜기
2. **압축해제된 확장프로그램을 로드** 클릭 → 이 프로젝트의 `chrome-extension/` 폴더 선택
3. (또는) 앱의 **도구 → 도우미프로그램(`#extension`)** 페이지에서 ZIP 다운로드 후 압축해제하여 로드
4. 설치 후 브라우저 우상단 퍼즐 아이콘에서 **네이버치트키**를 고정(📌)

### 6.2 주요 기능

| 기능 | 대상 사이트 | 설명 |
|------|------------|------|
| Term 수집 | search.shopping.naver.com | 검색결과 `__NEXT_DATA__` 파싱 → term/상품 수집 |
| 순위추적 | search.shopping.naver.com | 키워드별 상품/스토어 순위 수집 |
| 구매수 추적 | search.shopping.naver.com | 상품 구매수/리뷰수 수집 |
| 스마트스토어 | smartstore.naver.com | 상품 페이지 데이터 수집 (`content_smartstore.js`) |
| 로하스 | com.exponet.co.kr | 로하스 상품 수집 (`bg_lohas.js`, `crawl_lohas.js`) |
| 지마켓 | gmarket.co.kr | 지마켓 순위추적 (`bg_gmarket.js`) |

### 6.3 내부/외부 듀얼 모드

확장프로그램 팝업에서 **저장 모드**를 전환할 수 있습니다.

| 모드 | 전송 대상 | 용도 |
|------|----------|------|
| **외부(external)** | 현재 열려 있는 웹앱 페이지로 `postMessage` 전달 | 일반 사용자 — 웹 UI 에서 직접 수집 |
| **내부(internal)** | 내부 API(`INTERNAL_API`)로 직접 POST | 운영 서버 자동 수집 |

> 내부 모드 전송 주소는 `chrome-extension/background.js` 상단 `INTERNAL_API`
> 상수에 정의돼 있습니다. 다른 환경에서 쓰려면 이 값을 자신의 백엔드 주소로 바꾸세요.

### 6.4 동작 흐름

```
[외부 모드] 확장프로그램 → 네이버쇼핑 검색 → __NEXT_DATA__ 파싱
  → window.postMessage → 프론트엔드 useNaverExtension 훅
  → POST /api/naver/ext/search-result/ → DB 저장

[내부 모드] 확장프로그램 → 네이버쇼핑 검색 → __NEXT_DATA__ 파싱
  → 직접 POST {INTERNAL_API}/ext/search-result/ → DB 저장
```

> ⚠️ 확장프로그램은 봇 탐지 우회를 위해 모바일 UA·랜덤 딜레이를 사용합니다.
> 과도한 수집은 IP 차단/CAPTCHA 를 유발할 수 있으니 딜레이 설정을 유지하세요.

---

## 7. 아키텍처 요약

```
naverterms/
├── ecosystem.config.cjs       # PM2 설정
├── .env.example               # 환경변수 템플릿 (실제 .env 는 깃 제외)
├── chrome-extension/          # 크롬 확장프로그램
├── backend/                   # Django REST (포트 8901)
│   ├── config/                # settings · urls · db_router
│   ├── naver/                 # Term 분석 · 순위추적 · 연관키워드
│   ├── smartstore/            # 스마트스토어 상품/분석 서비스
│   └── requirements.txt
└── frontend/                  # React + Vite (포트 8900)
    └── src/{pages,components,api,hooks}
```

| DB | 호스트 | 용도 | 접근 |
|----|--------|------|------|
| `naverdb` | MySQL | 키워드 · 분석 · 순위 | Django ORM |
| `myproduct` | MySQL | 스마트스토어 상점/상품 | Raw SQL |

자세한 내부 설계(가중치 분석 6종, 모델 스키마, API 엔드포인트 전체 목록)는
저장소의 [`CLAUDE.md`](./CLAUDE.md) 를 참고하세요.

---

## 8. 보안 체크리스트

- [x] `.env`, DB 자격증명, API 키는 깃에 커밋하지 않음 (`.gitignore` 적용)
- [x] 소스코드의 모든 비밀값은 `os.getenv()` / DB 조회로만 접근
- [x] 대용량 바이너리(`media/`, 모델 가중치, `.venv/`)는 추적 제외
- [ ] 운영 배포 시 `DEBUG=False`, `ALLOWED_HOSTS` 제한 권장

---

## 9. 라이선스

개인/내부용 프로젝트. 별도 명시 전까지 무단 재배포를 제한합니다.
