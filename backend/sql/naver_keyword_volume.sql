-- 네이버 키워드 조회수 캐시 (naverdb)
-- 출처: 네이버 검색광고 API (keywordstool) + 쇼핑 API (상품수, 카테고리)

CREATE TABLE IF NOT EXISTS naver_keyword_volume (
  keyword         VARCHAR(80) NOT NULL PRIMARY KEY,
  pc_count        INT NOT NULL DEFAULT 0       COMMENT 'monthlyPcQcCnt',
  mobile_count    INT NOT NULL DEFAULT 0       COMMENT 'monthlyMobileQcCnt',
  total_count     INT NOT NULL DEFAULT 0       COMMENT 'pc + mobile',
  comp_idx        VARCHAR(20) NULL             COMMENT 'HIGH / MEDIUM / LOW',
  product_count   BIGINT NULL                  COMMENT '쇼핑 검색 결과 상품 수 (정확)',
  category_path   VARCHAR(255) NULL            COMMENT '첫 결과 카테고리',
  fetched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NULL                COMMENT '캐시 만료 (보통 30일 후)',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_total    (total_count DESC),
  KEY ix_fetched  (fetched_at),
  KEY ix_comp     (comp_idx),
  KEY ix_category (category_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 카테고리별 핫 키워드 캐시 (선택 — L6 에서 사용)
CREATE TABLE IF NOT EXISTS naver_category_hot_keywords (
  category_path   VARCHAR(255) NOT NULL,
  rank_position   INT NOT NULL,
  keyword         VARCHAR(80) NOT NULL,
  total_count     INT NOT NULL DEFAULT 0,
  comp_idx        VARCHAR(20) NULL,
  fetched_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (category_path, rank_position),
  KEY ix_keyword (keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
