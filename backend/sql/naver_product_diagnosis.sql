-- 상품등록정보검토(memopan) 수집 결과 — naverdb
CREATE TABLE IF NOT EXISTS naver_product_diagnosis (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL COMMENT 'smartstoreIdList.id',
  login_id VARCHAR(100) NULL,
  store_name VARCHAR(100) NULL,
  product_name VARCHAR(500) NULL,
  category_text VARCHAR(400) NULL,
  thumbnail VARCHAR(500) NULL,
  seller_management_code VARCHAR(40) NULL COMMENT 'W코드 (상품명 매칭)',
  brand_value VARCHAR(200) NULL,
  brand_missing TINYINT(1) NOT NULL DEFAULT 0,
  mfr_value VARCHAR(200) NULL,
  mfr_missing TINYINT(1) NOT NULL DEFAULT 0,
  attr_value VARCHAR(1000) NULL,
  attr_missing TINYINT(1) NOT NULL DEFAULT 0,
  tag_missing TINYINT(1) NOT NULL DEFAULT 0,
  page_no INT NULL,
  captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_store_name (store_id, product_name),
  KEY ix_store (store_id),
  KEY ix_wcode (seller_management_code),
  KEY ix_missing (store_id, attr_missing, tag_missing)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
