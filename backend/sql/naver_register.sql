-- 네이버 상품 일괄등록 (엑셀 일괄등록 양식 기반) — naverdb
-- 레퍼런스 3종(카테고리/택배사/원산지) + 등록 세트(프로파일)

-- 1) 카테고리 레퍼런스 (docs/category_*.xls)
CREATE TABLE IF NOT EXISTS naver_category_ref (
  category_code VARCHAR(20) NOT NULL PRIMARY KEY,
  cat1 VARCHAR(100) NULL COMMENT '대분류',
  cat2 VARCHAR(100) NULL COMMENT '중분류',
  cat3 VARCHAR(100) NULL COMMENT '소분류',
  cat4 VARCHAR(100) NULL COMMENT '세분류',
  full_name VARCHAR(400) NULL COMMENT '대>중>소>세',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_cat1 (cat1),
  KEY ix_full (full_name(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) 택배사 코드 레퍼런스 (docs/delivery-companies_*.xls)
CREATE TABLE IF NOT EXISTS naver_delivery_company_ref (
  code VARCHAR(40) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) 원산지 코드 레퍼런스 (docs/originarea_*.xls)
CREATE TABLE IF NOT EXISTS naver_origin_area_ref (
  code VARCHAR(20) NOT NULL PRIMARY KEY,
  region VARCHAR(200) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) 등록 세트 (스토어=폴더 단위, 1개 필수)
--   판매가 = round10( 목표가 × (1 + discount_rate) )
--   목표가 = 원가×margin_rate + 원가×fee_rate + 배송비조정 + 리뷰포인트합
--   배송비조정 = (원본배송비 − set_ship_fee);  free_shipping 이면 +set_ship_fee 환원
CREATE TABLE IF NOT EXISTS naver_register_set (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  folder_id INT NOT NULL COMMENT 'naver_my_product_folder.id (스토어 단위)',
  name VARCHAR(100) NOT NULL DEFAULT '기본세트',

  -- 가격
  margin_rate   DECIMAL(6,3) NOT NULL DEFAULT 1.500 COMMENT '마진율(곱), 예 1.5',
  fee_rate      DECIMAL(6,4) NOT NULL DEFAULT 0.0700 COMMENT '수수료율, 예 0.07',
  set_ship_fee  INT NOT NULL DEFAULT 3000 COMMENT '세트 기준 배송비 S',
  free_shipping TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=무료배송(판매가에 흡수)',
  discount_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0000 COMMENT '할인율 d, 정가=목표×(1+d)',
  review_point_text  INT NOT NULL DEFAULT 0 COMMENT '텍스트리뷰 포인트',
  review_point_photo INT NOT NULL DEFAULT 0 COMMENT '포토/동영상리뷰 포인트',

  -- 배송 (템플릿 미사용, 엑셀 직접기입)
  delivery_company_code VARCHAR(40) NOT NULL DEFAULT 'CJGLS' COMMENT '택배사코드',
  delivery_fee_type VARCHAR(20) NOT NULL DEFAULT '무료' COMMENT '무료/조건부 무료/유료/수량별/구간별',
  base_ship_fee   INT NOT NULL DEFAULT 0 COMMENT '기본배송비(유료/조건부)',
  free_cond_amount INT NULL COMMENT '조건부무료 기준 상품판매가 합계',
  return_fee   INT NOT NULL DEFAULT 5000 COMMENT '반품배송비',
  exchange_fee INT NOT NULL DEFAULT 10000 COMMENT '교환배송비',

  -- 기타 등록 기본값
  default_stock INT NOT NULL DEFAULT 999,
  vat_type      VARCHAR(20) NOT NULL DEFAULT '과세상품',
  product_state VARCHAR(20) NOT NULL DEFAULT '신상품',
  origin_code   VARCHAR(20) NOT NULL DEFAULT '03' COMMENT '기본 원산지(03=상세설명에 표시)',
  as_phone VARCHAR(40) NULL,
  as_guide VARCHAR(500) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_folder (folder_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
