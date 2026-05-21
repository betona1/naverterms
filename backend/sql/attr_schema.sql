-- ──────────────────────────────────────────────────────────────────────────
-- SmartStore 상품속성 크롤 결과 저장 스키마 (myproduct DB, 판매자상품코드 기준)
-- ──────────────────────────────────────────────────────────────────────────

-- (A) 카테고리별 속성 스키마: 새 속성이 발견되면 자동 누적
CREATE TABLE IF NOT EXISTS smartstore_category_attr_schema (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  category_id     VARCHAR(64)  NOT NULL,                 -- '50000000>50000167>50000803'
  category_text   VARCHAR(255),                          -- '패션의류>여성의류>티셔츠'
  section         VARCHAR(64),                           -- '상품주요정보'|'상품속성'|'추가속성'|'검색설정'|'공통'
  attr_key        VARCHAR(160) NOT NULL,                 -- 정규화 키 (sha1 16자 또는 라벨기반)
  attr_label      VARCHAR(255) NOT NULL,                 -- '면', '판매가' 원문
  attr_type       VARCHAR(32)  NOT NULL,                 -- 'checkbox'|'radio'|'text'|'tel'|'number'|'select-one'|'textarea'
  options_json    JSON,                                  -- select/radio 옵션 목록 (최근 관측)
  unit            VARCHAR(32),                           -- 'cm'|'kg' 등 단위
  is_recommended  TINYINT(1) DEFAULT 0,                  -- 네이버 추천 속성('추천' 라벨)
  is_required     TINYINT(1) DEFAULT 0,
  first_seen_at   DATETIME,
  last_seen_at    DATETIME,
  sample_count    INT DEFAULT 0,                         -- 이 카테고리에서 이 속성 관측된 상품 수
  UNIQUE KEY ux_cat_attr (category_id, attr_key),
  KEY ix_cat (category_id),
  KEY ix_section (section),
  KEY ix_label (attr_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='카테고리별 속성 정의 누적';

-- (B) 상품별 속성값: 판매자상품코드 × 속성 (체크/미체크 무관 모든 상태 저장)
CREATE TABLE IF NOT EXISTS smartstore_product_attr_value (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  seller_management_code   VARCHAR(64)  NOT NULL,        -- 'W000312' (판매자상품코드)
  origin_product_no        BIGINT,
  channel_product_no       VARCHAR(32),
  category_id              VARCHAR(64)  NOT NULL,
  store_id                 INT,                          -- smartstoreIdList.id
  section                  VARCHAR(64),
  attr_key                 VARCHAR(160) NOT NULL,
  attr_label               VARCHAR(255),
  attr_type                VARCHAR(32),
  value_text               TEXT,                         -- 텍스트/select 텍스트값
  value_bool               TINYINT(1),                   -- 체크박스/라디오: 1=체크 0=미체크
  value_number             DECIMAL(20,4),                -- 숫자 입력 (parsed)
  value_unit               VARCHAR(32),
  is_extra                 TINYINT(1) DEFAULT 0,         -- 추가속성(자유입력) 여부
  is_recommended           TINYINT(1) DEFAULT 0,
  crawled_at               DATETIME,
  UNIQUE KEY ux_code_attr (seller_management_code, attr_key),
  KEY ix_code (seller_management_code),
  KEY ix_attr (attr_key),
  KEY ix_cat_attr (category_id, attr_key),
  KEY ix_checked (value_bool)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='판매자상품코드×속성 값 (체크/미체크 모두 저장)';

-- (T) 상품 태그 (1:N 정규화 — 태그 빈도/검색용)
CREATE TABLE IF NOT EXISTS smartstore_product_tag (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  seller_management_code   VARCHAR(64)  NOT NULL,
  category_id              VARCHAR(64),
  store_id                 INT,
  tag                      VARCHAR(120) NOT NULL,
  position                 SMALLINT,                     -- 입력순서 1~10
  crawled_at               DATETIME,
  UNIQUE KEY ux_code_tag (seller_management_code, tag),
  KEY ix_tag (tag),
  KEY ix_cat_tag (category_id, tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='상품 검색태그 (정규화)';

-- (L) 크롤 이력 + 원본 JSON
CREATE TABLE IF NOT EXISTS smartstore_attr_crawl_log (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  seller_management_code   VARCHAR(64)  NOT NULL,
  origin_product_no        BIGINT,
  channel_product_no       VARCHAR(32),
  category_id              VARCHAR(64),
  category_text            VARCHAR(255),
  store_id                 INT,
  status                   VARCHAR(16),                  -- 'ok'|'fail'|'no_edit_button'
  field_count              INT,
  tag_count                INT,
  raw_json                 LONGTEXT,                     -- extract.fields 원본
  html_path                VARCHAR(500),
  url                      VARCHAR(500),
  error                    VARCHAR(500),
  crawled_at               DATETIME,
  KEY ix_code (seller_management_code),
  KEY ix_crawled (crawled_at),
  KEY ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='크롤 이력 (판매자상품코드 단위)';

-- (Q) 검색품질 체크 결과 (2차 크롤 적재 예정 — 구조 미정이라 JSON 보관)
CREATE TABLE IF NOT EXISTS smartstore_product_search_quality (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  seller_management_code   VARCHAR(64)  NOT NULL,
  category_id              VARCHAR(64),
  store_id                 INT,
  total_score              INT,                          -- 종합 점수 (구조 확인 후 채움)
  grade                    VARCHAR(16),                  -- 'A'|'B'|'C' 같은 등급
  raw_json                 JSON,                         -- 결과 원본 (전체 항목/권장사항)
  crawled_at               DATETIME,
  UNIQUE KEY ux_code (seller_management_code),
  KEY ix_grade (grade)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='검색품질 체크 결과';
