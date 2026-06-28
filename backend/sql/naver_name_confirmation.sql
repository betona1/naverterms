-- 네이버 상품명 AI 컨펌 학습 DB (naverdb)
-- 사용자가 AI 생성 상품명을 컨펌하면서 남기는 raw 이벤트 + 카테고리별 누적 정책

-- 0) 원본 백업 컬럼 (AI 생성 직전 → naver_product_name 이 갱신될 때 백업)
ALTER TABLE naver_my_product
  ADD COLUMN IF NOT EXISTS naver_product_name_before VARCHAR(500) NULL
    COMMENT '직전 AI 생성 상품명 (컨펌 diff 비교용)' AFTER naver_product_name;


-- 1) raw 컨펌 이벤트 — W코드 단위로 모든 컨펌 누적
CREATE TABLE IF NOT EXISTS naver_name_confirmation (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_code   VARCHAR(20) NOT NULL COMMENT 'W코드 (naver_my_product.product_code)',
  product_id     BIGINT NULL COMMENT 'naver_my_product.id (조회 편의)',
  category_code  VARCHAR(20) NULL,
  category_name  VARCHAR(300) NULL,
  category_type  VARCHAR(40) NULL COMMENT 'apparel/food/kitchen/... (generator._infer_category_type)',

  before_name    VARCHAR(500) NULL COMMENT 'AI 생성 시점 원본',
  after_name     VARCHAR(500) NULL COMMENT '사용자 컨펌 후',

  bad_keywords   JSON NULL COMMENT '삭제된 토큰(블랙)',
  white_keywords JSON NULL COMMENT '유지/추가된 핵심 토큰(화이트)',

  ai_comment     TEXT NULL COMMENT '사용자 입력 코멘트(프롬프트 학습용)',
  comment_type   ENUM('wrong','missing','overall') NOT NULL DEFAULT 'overall',

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_product_code (product_code),
  KEY ix_category_type (category_type),
  KEY ix_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 2) 카테고리별 화/흑 키워드 누적 — 향후 프롬프트 컨텍스트로 주입
CREATE TABLE IF NOT EXISTS naver_name_keyword_policy (
  category_type VARCHAR(40) NOT NULL COMMENT 'apparel/food/...',
  keyword       VARCHAR(80) NOT NULL,
  policy        ENUM('white','black') NOT NULL,
  hit_count     INT NOT NULL DEFAULT 1,
  source        VARCHAR(20) NULL DEFAULT 'user' COMMENT 'user/auto',
  last_product_code VARCHAR(20) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (category_type, keyword, policy),
  KEY ix_cat_policy (category_type, policy, hit_count DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
