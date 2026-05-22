import axios from 'axios';

const api = axios.create({ baseURL: '/api/workers' });

// ── GPU ──
export interface GpuWorkerRow {
  endpoint: string;
  worker_name: string | null;
  host_name: string | null;
  status: string;
  available_models: string[] | null;
  gpu_name: string | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  gpu_util_pct: number | null;
  consecutive_failures: number;
  last_check_at: string | null;
  last_check_age_sec: number | null;
  last_error: string | null;
  stale: boolean;
  total_1h: number;
  errors_1h: number;
  avg_ms_1h: number | null;
  naver_1h: number;
  eleven_1h: number;
}

export async function fetchGpuWorkers(): Promise<{ ok: boolean; workers: GpuWorkerRow[]; dead_count: number }> {
  const r = await api.get('/gpu/');
  return r.data;
}

// ── 크롤 워커 ──
export interface CrawlWorkerRow {
  worker_key: string;
  worker_name: string | null;
  worker_type: string | null;
  host_name: string | null;
  pid: number | null;
  status: string | null;
  effective_status: 'ok' | 'degraded' | 'dead' | 'unknown';
  last_log_line: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  hb_age_sec: number | null;
  consecutive_failures: number;
  meta: Record<string, unknown> | null;
  logs_1h: number;
  errors_1h: number;
}

export async function fetchCrawlWorkers(): Promise<{ ok: boolean; workers: CrawlWorkerRow[] }> {
  const r = await api.get('/crawl/');
  return r.data;
}

export interface CrawlLogEntry {
  id: number;
  worker_key: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export async function fetchCrawlLogs(workerKey: string, limit = 50, levels?: string[]): Promise<{ ok: boolean; logs: CrawlLogEntry[] }> {
  const params: Record<string, string | number> = { limit };
  if (levels?.length) params.levels = levels.join(',');
  const r = await api.get(`/crawl/${encodeURIComponent(workerKey)}/logs/`, { params });
  return r.data;
}
