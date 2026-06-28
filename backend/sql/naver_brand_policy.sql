-- 브랜드/제조사 화이트·블랙리스트 (naverdb)
-- 사용자가 직접 등록하거나, 일괄 처리 중 발견된 패턴을 누적

CREATE TABLE IF NOT EXISTS naver_brand_policy (
  name         VARCHAR(120) NOT NULL COMMENT '원본 표기 (보존용)',
  name_lower   VARCHAR(120) NOT NULL COMMENT 'lowercase + trim (PK)',
  policy       ENUM('white','black') NOT NULL,
  source       VARCHAR(40) NULL COMMENT 'user/auto/seed',
  note         VARCHAR(255) NULL,
  hit_count    INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name_lower),
  KEY ix_policy (policy),
  KEY ix_hit (hit_count DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 시드 — 알려진 공급사/도매상 (블랙)
INSERT IGNORE INTO naver_brand_policy (name, name_lower, policy, source, note) VALUES
  ('요비월드 협력사', '요비월드 협력사', 'black', 'seed', '오너클랜 도매 협력사'),
  ('더블요 협력사', '더블요 협력사', 'black', 'seed', '도매 협력사'),
  ('요비협력사', '요비협력사', 'black', 'seed', '도매 협력사'),
  ('요비 협력사', '요비 협력사', 'black', 'seed', '도매 협력사'),
  ('한플 파트너', '한플 파트너', 'black', 'seed', '도매 파트너'),
  ('한플파트너', '한플파트너', 'black', 'seed', '도매 파트너'),
  ('도매링크', '도매링크', 'black', 'seed', '도매업체'),
  ('hanmoiplus partner', 'hanmoiplus partner', 'black', 'seed', '도매 파트너'),
  ('hanmoiplus', 'hanmoiplus', 'black', 'seed', '도매 파트너'),
  ('소노스코리아', '소노스코리아', 'black', 'seed', '유통'),
  ('에프엔비글로벌', '에프엔비글로벌', 'black', 'seed', '유통'),
  ('지티글로벌', '지티글로벌', 'black', 'seed', '유통'),
  ('피스코리아', '피스코리아', 'black', 'seed', '유통'),
  ('글로벌이지', '글로벌이지', 'black', 'seed', '유통'),
  ('정다운상사', '정다운상사', 'black', 'seed', '도매업체');
