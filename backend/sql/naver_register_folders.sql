-- 상품 일괄등록 단계 폴더(등록후보/작업대기) + 등록완료 상태 — naverdb
-- naver_my_product_folder 계층화 + naver_my_product 등록 라이프사이클

ALTER TABLE naver_my_product_folder
  ADD COLUMN IF NOT EXISTS parent_id INT NULL COMMENT '상위 스토어 폴더 id' AFTER store_id,
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'store'
    COMMENT 'store / candidate(등록후보) / queue(작업대기)' AFTER parent_id,
  ADD KEY IF NOT EXISTS ix_parent (parent_id);

ALTER TABLE naver_my_product
  ADD COLUMN IF NOT EXISTS registered TINYINT(1) NOT NULL DEFAULT 0 COMMENT '상품등록완료',
  ADD COLUMN IF NOT EXISTS registered_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS register_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '네이버 존재 검증됨',
  ADD COLUMN IF NOT EXISTS register_checked_at DATETIME NULL,
  ADD KEY IF NOT EXISTS ix_registered (registered);
