-- naver_thumbnail_variant: 상품별 썸네일 변형 풀 (최대 20개)
-- 편집/캡쳐/생성된 모든 이미지를 보관, 사용자가 활성본을 선택해서 edited_image_url 로 반영.
-- DB: naverdb

CREATE TABLE IF NOT EXISTS naver_thumbnail_variant (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL COMMENT 'naver_my_product.id',
  image_url VARCHAR(500) NOT NULL COMMENT '/media/edited_thumbs/<file>',
  source_type VARCHAR(30) NOT NULL COMMENT 'ai_edit | gemini | flux | detail_capture | flip | manual',
  source_meta JSON NULL COMMENT '{prompt, ops, model, ...}',
  width INT NULL,
  height INT NULL,
  bytes INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=현재 활성 (edited_image_url 과 동일)',
  label VARCHAR(100) NULL COMMENT '사용자 메모/제목',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_product_created (product_id, created_at DESC),
  KEY ix_product_active (product_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
