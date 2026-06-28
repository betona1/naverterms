-- W코드 블랙리스트 (naverdb)
-- 도매/마켓 카탈로그에서 보이지 않게 하고 싶은 W코드들을 누적.
-- naverdb.naver_my_product / ads.preliminary_product / ads.ownerclan_product
-- 3곳을 동시에 W코드 OR 매칭하여 모달 UI 로 검토 후 일괄 삭제.

CREATE TABLE IF NOT EXISTS naver_wcode_blacklist (
  product_code VARCHAR(20) NOT NULL PRIMARY KEY COMMENT 'W코드',
  reason       VARCHAR(255) NULL COMMENT '블랙리스트 사유 (사용자 메모)',
  source       VARCHAR(16) NOT NULL DEFAULT 'manual'
                 COMMENT 'manual / excel / api',
  is_processed TINYINT(1) NOT NULL DEFAULT 0
                 COMMENT '체크되어 삭제까지 완료된 항목 (1=완료)',
  processed_at DATETIME NULL,
  matched_my   TINYINT(1) NOT NULL DEFAULT 0
                 COMMENT '직전 매칭 결과 — naver_my_product 에서 발견',
  matched_pre  TINYINT(1) NOT NULL DEFAULT 0
                 COMMENT '직전 매칭 결과 — ads.preliminary_product 에서 발견',
  matched_oc   TINYINT(1) NOT NULL DEFAULT 0
                 COMMENT '직전 매칭 결과 — ads.ownerclan_product 에서 발견',
  matched_at   DATETIME NULL COMMENT '직전 매칭 실행 시각',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_processed (is_processed),
  KEY ix_created (created_at DESC),
  KEY ix_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
