-- naver_my_product: 썸네일 AI 편집본 URL 컬럼 추가
-- 원본 image_large 는 보존하고 편집 결과만 별도 컬럼에 저장.
-- DB: naverdb

ALTER TABLE naver_my_product
  ADD COLUMN edited_image_url VARCHAR(500) NULL
    COMMENT 'AI 편집된 썸네일 URL (배경제거/글씨제거/선명도/회전 등)'
    AFTER image_small;
