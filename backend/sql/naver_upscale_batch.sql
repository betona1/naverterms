-- 이미지 일괄 업스케일 시스템
-- 1) naver_my_product.upscaled_image_url — 218 서버 저장된 1.5x JPG URL
-- 2) naver_upscale_batch_job — 폴더별 일괄 작업 진행 상태
-- 3) naver_upscale_worker_log — 워커별 처리 로그 (분산 모니터링)

ALTER TABLE naver_my_product
  ADD COLUMN IF NOT EXISTS upscaled_image_url VARCHAR(500) NULL
    COMMENT 'AI 업스케일 1.5x JPG (218서버 ~/upscaled_thumbs/{code}_1.jpg)'
    AFTER edited_image_url,
  ADD COLUMN IF NOT EXISTS upscaled_at DATETIME NULL
    COMMENT '업스케일 처리 시각'
    AFTER upscaled_image_url,
  ADD COLUMN IF NOT EXISTS upscaled_bytes INT NULL
    COMMENT '업스케일 파일 바이트'
    AFTER upscaled_at;

CREATE INDEX IF NOT EXISTS ix_upscaled_at ON naver_my_product (upscaled_at);

-- 일괄 작업 (폴더별, 큐)
CREATE TABLE IF NOT EXISTS naver_upscale_batch_job (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  folder_id INT NULL COMMENT 'NULL = 전체 (미분류 제외)',
  scale FLOAT NOT NULL DEFAULT 1.5,
  model_family VARCHAR(20) NOT NULL DEFAULT 'sd15' COMMENT 'sd15 | flux',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending|running|paused|done|error',
  total_targets INT NOT NULL DEFAULT 0,
  done_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  bytes_total BIGINT NOT NULL DEFAULT 0,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  workers JSON NULL COMMENT '활용 워커 endpoint 목록',
  storage_host VARCHAR(50) NOT NULL DEFAULT '192.168.219.218',
  storage_path VARCHAR(200) NOT NULL DEFAULT '/home/joacham/upscaled_thumbs',
  filename_format VARCHAR(50) NOT NULL DEFAULT '{code}_1.jpg',
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_status (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 큐 큐 — 각 상품 단위 (대기/실행/완료/실패)
CREATE TABLE IF NOT EXISTS naver_upscale_queue (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  product_code VARCHAR(20) NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending|running|done|error|skip',
  worker_endpoint VARCHAR(80) NULL,
  attempts TINYINT NOT NULL DEFAULT 0,
  result_url VARCHAR(500) NULL,
  result_bytes INT NULL,
  elapsed_ms INT NULL,
  error_msg VARCHAR(500) NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_job_product (job_id, product_id),
  KEY ix_state (job_id, state),
  KEY ix_worker (worker_endpoint, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 워커 분산 처리 로그 (GpuMonitorModal 분산 탭용)
CREATE TABLE IF NOT EXISTS naver_upscale_worker_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT NOT NULL,
  worker_endpoint VARCHAR(80) NOT NULL,
  product_id BIGINT NULL,
  event VARCHAR(20) NOT NULL COMMENT 'start|complete|error|heartbeat',
  elapsed_ms INT NULL,
  bytes INT NULL,
  msg VARCHAR(300) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_job_worker (job_id, worker_endpoint, created_at DESC),
  KEY ix_event (event, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
