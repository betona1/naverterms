-- 일반 크롤링 워커 모니터링 (GPU 워커는 ads.gpu_worker_status 별도 사용)
-- DB: naverdb

-- 워커 상태 — worker_key 단위 upsert (워커가 30초마다 heartbeat)
CREATE TABLE IF NOT EXISTS crawl_worker_status (
  worker_key VARCHAR(64) NOT NULL PRIMARY KEY COMMENT '예: register_auto_candidates / category_schema_crawl / attr_label_crawl',
  worker_name VARCHAR(120) NULL COMMENT '사람용 라벨',
  worker_type VARCHAR(40) NULL DEFAULT 'crawl' COMMENT 'crawl/etl/sync/...',
  host_name VARCHAR(80) NULL,
  pid INT NULL,
  status VARCHAR(20) NULL DEFAULT 'ok' COMMENT 'ok | degraded | dead | unknown',
  last_log_line VARCHAR(500) NULL COMMENT '한줄 요약 (UI 첫 줄)',
  started_at DATETIME NULL,
  last_heartbeat_at DATETIME NULL,
  consecutive_failures INT NOT NULL DEFAULT 0,
  meta JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_status (status),
  KEY ix_heartbeat (last_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 워커 로그 — 모달에서 ▼ 펼치면 보일 로그 (최근 N건)
CREATE TABLE IF NOT EXISTS crawl_worker_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  worker_key VARCHAR(64) NOT NULL,
  level VARCHAR(10) NOT NULL DEFAULT 'INFO' COMMENT 'DEBUG/INFO/WARN/ERROR',
  message VARCHAR(1000) NOT NULL,
  meta JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_worker_time (worker_key, created_at),
  KEY ix_level (level),
  KEY ix_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
