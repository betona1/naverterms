-- 네이버 나의상품 (11번가 my_product 미러 + 네이버 전용 필드)
-- DB: naverdb
-- 11번가 my_product 패턴을 따르되, 폴더는 스마트스토어 ID(smartstoreIdList) 단위

-- 폴더: 네이버 ID(스토어) 1개 = 폴더 1개. 미분류 폴더(id=1)도 포함.
CREATE TABLE IF NOT EXISTS naver_my_product_folder (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_id INT NULL COMMENT 'myproduct.smartstoreIdList.id (NULL=미분류)',
  name VARCHAR(100) NOT NULL COMMENT '폴더명 (보통 store_name)',
  color VARCHAR(20) NULL,
  sort_order INT NULL DEFAULT 0,
  is_system TINYINT(1) NULL DEFAULT 0 COMMENT '1=미분류(삭제불가)',
  queue_position INT NULL COMMENT 'AI 처리 큐 순서',
  description VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_store_id (store_id),
  KEY ix_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 미분류 폴더 시드
INSERT IGNORE INTO naver_my_product_folder (id, store_id, name, is_system, sort_order)
VALUES (1, NULL, '미분류', 1, 0);

-- 상품: 11st ads.my_product 핵심 컬럼 + 네이버 전용 필드
CREATE TABLE IF NOT EXISTS naver_my_product (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(20) NOT NULL COMMENT 'W코드',
  source_id BIGINT NULL COMMENT '11st ads.my_product.id (import 원본)',
  folder_id INT NOT NULL DEFAULT 1 COMMENT 'naver_my_product_folder.id',

  -- 11st my_product 미러 (핵심)
  product_name VARCHAR(500) NULL COMMENT '원본 상품명',
  market_product_name VARCHAR(500) NULL,
  ai_product_name VARCHAR(500) NULL COMMENT '11st AI 상품명 (transformer)',
  ai_recommended_name VARCHAR(500) NULL COMMENT '11st 최종 추천명',
  edited_product_name VARCHAR(500) NULL COMMENT '사용자 편집명',

  -- 네이버 전용 (GPU 생성 결과)
  naver_product_name VARCHAR(500) NULL COMMENT '네이버 전용 GPU 생성 상품명',
  naver_keywords TEXT NULL COMMENT '네이버 전용 키워드',

  -- 분류/메타
  category_code VARCHAR(20) NULL,
  category_name VARCHAR(300) NULL,
  manufacturer VARCHAR(200) NULL,
  brand VARCHAR(200) NULL,
  model_name VARCHAR(200) NULL,
  origin VARCHAR(100) NULL,
  keywords TEXT NULL COMMENT '11st 원본 keywords',

  -- 가격/배송
  ownerclan_price INT NOT NULL DEFAULT 0,
  consumer_price INT NOT NULL DEFAULT 0,
  market_price INT NOT NULL DEFAULT 0,
  shipping_fee INT NOT NULL DEFAULT 0,
  return_fee INT NOT NULL DEFAULT 0,

  -- 이미지
  image_large VARCHAR(500) NULL,
  image_medium VARCHAR(500) NULL,
  image_small VARCHAR(500) NULL,

  -- 옵션
  option1_name VARCHAR(50) NULL,
  option1_values TEXT NULL,
  option2_name VARCHAR(50) NULL,
  option2_values TEXT NULL,
  combined_option TEXT NULL,
  product_attribute TEXT NULL,

  -- 상세
  detail_html MEDIUMTEXT NULL,

  -- 상태/타임스탬프
  sale_status VARCHAR(20) NULL DEFAULT 'active',
  is_modified TINYINT(1) NOT NULL DEFAULT 0,
  sync_status VARCHAR(20) NULL,
  copied_at DATETIME NULL COMMENT '11st에서 가져온 시각',
  synced_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_product_code (product_code),
  KEY ix_folder (folder_id),
  KEY ix_source (source_id),
  KEY ix_sale_status (sale_status),
  KEY ix_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
