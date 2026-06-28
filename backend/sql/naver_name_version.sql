-- 네이버 상품명 버전 관리 + 스냅샷 (롤백용)
-- DB: naverdb

-- 1) 현재 적용 버전 컬럼
ALTER TABLE naver_my_product
  ADD COLUMN IF NOT EXISTS name_version VARCHAR(16) NULL
    COMMENT '현재 naver_product_name 의 생성/패치 버전 (예: v1.00, v1.01)'
    AFTER naver_product_name_before;


-- 2) 버전 스냅샷 — 각 패치 직전 상태 자동 저장 (롤백용)
CREATE TABLE IF NOT EXISTS naver_name_version_snapshot (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id     BIGINT NOT NULL,
  product_code   VARCHAR(20) NOT NULL,
  version_tag    VARCHAR(16) NOT NULL COMMENT '이 스냅샷이 담은 상태의 버전 (예: 패치 v1.01 직전이라면 v1.00)',
  naver_product_name VARCHAR(500) NULL,
  source         VARCHAR(20) NULL DEFAULT 'auto' COMMENT 'auto/manual',
  note           VARCHAR(200) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_product (product_id, created_at DESC),
  KEY ix_product_code (product_code),
  KEY ix_version (version_tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
