import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface WorkerStatus {
  host: string;
  ip: string;
  group: string;
  reachable: boolean;
  load: number | null;
  uptime: string | null;
  tasks: Record<string, number>;
  last_log: string;
  log_age_s: number | null;
  error: string | null;
  cached_age_s: number;
}

export interface AggregateStatus {
  total: number;
  online: number;
  offline: number;
  busy: number;
  idle: number;
  task_totals: Record<string, number>;
}

export async function fetchWorkers(): Promise<{ workers: WorkerStatus[]; aggregate: AggregateStatus }> {
  const { data } = await api.get('/workers/');
  return data;
}
