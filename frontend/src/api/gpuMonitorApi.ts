import axios from 'axios';

const api = axios.create({ baseURL: '/api/gpu' });

export interface GpuWorker {
  endpoint: string;
  worker_name: string;
  host_name: string;
  status: 'ok' | 'degraded' | 'dead' | 'unknown';
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
  completions_5min: number;
  completions_10min: number;
  completions_30min: number;
  completions_1h: number;
  errors_1h: number;
  avg_ms_1h: number | null;
}

export type WorkerRateWindow = '5min' | '10min' | '30min' | '1h';

export interface GpuLog {
  id: number;
  endpoint: string;
  event_type: 'start' | 'complete' | 'error' | 'model_fallback' | 'timeout' | 'health_check' | 'recovered' | 'dead';
  product_id: number | null;
  model_used: string | null;
  elapsed_ms: number | null;
  error_msg: string | null;
  created_at: string;
  folder_id: number | null;
  folder_name: string | null;
}

export async function fetchGpuStatus(): Promise<{ ok: boolean; workers: GpuWorker[]; dead_count: number }> {
  const r = await api.get('/status/');
  return r.data;
}

export interface FolderProgress {
  folder_id: number;
  folder_name: string;
  queue_position: number | null;
  total: number;
  done: number;
  remaining: number;
  pct: number;
  status: 'done' | 'progress' | 'pending';
}
export interface BulkProgress {
  ok: boolean;
  folders: FolderProgress[];
  main_queue?: FolderProgress[];
  total: number;
  done: number;
  remaining: number;
  pct: number;
  rate_1h: number;
  rate_10min: number;
  stalled: boolean;
  avg_ms: number;
  eta_hours: number | null;
}

export async function fetchBulkProgress(): Promise<BulkProgress> {
  const r = await api.get('/bulk-progress/');
  return r.data;
}

export async function fetchGpuLogs(endpoint?: string, limit = 50, eventTypes?: string[]): Promise<{ ok: boolean; logs: GpuLog[] }> {
  const params: Record<string, string | number> = { limit };
  if (endpoint) params.endpoint = endpoint;
  if (eventTypes && eventTypes.length) params.event_types = eventTypes.join(',');
  const r = await api.get('/logs/', { params });
  return r.data;
}
