import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

// ── 상점 관리 ──

export interface SmartStore {
  id: number;
  store_id: string;
  store_pw: string;
  store_name: string;
  store_url: string | null;
  commerce_api_key: string | null;
  commerce_secret_key: string | null;
  is_active: number;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchStores(all = false): Promise<SmartStore[]> {
  const { data } = await api.get<SmartStore[]>('/stores/', { params: all ? { all: '1' } : {} });
  return data;
}

export async function createStore(payload: {
  store_id: string;
  store_pw: string;
  store_name: string;
  store_url?: string;
  commerce_api_key?: string;
  commerce_secret_key?: string;
  memo?: string;
}): Promise<SmartStore> {
  const { data } = await api.post<SmartStore>('/stores/', payload);
  return data;
}

export async function updateStore(
  id: number,
  payload: Partial<{
    store_id: string;
    store_pw: string;
    store_name: string;
    store_url: string;
    commerce_api_key: string;
    commerce_secret_key: string;
    is_active: number;
    memo: string;
  }>,
): Promise<SmartStore> {
  const { data } = await api.put<SmartStore>(`/stores/${id}/`, payload);
  return data;
}

export async function deleteStore(id: number): Promise<void> {
  await api.delete(`/stores/${id}/`);
}

export function getStoreSampleExcelUrl(): string {
  return '/api/smartstore/stores/sample-excel/';
}

export async function uploadStoresExcel(file: File): Promise<{
  created: number; updated: number; skipped: number; errors: string[];
}> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/stores/upload/', form);
  return data;
}

// ── 스토어 상품수집 (브라우저 자동화) ──

export interface CollectStatus {
  running: boolean;
  store_name: string | null;
  store_idx: number;
  total_stores: number;
  phase: string;
  progress_pct: number;
  logs: { t: number; msg: string }[];
  error: string | null;
  last_result: Record<string, { synced: number; file?: string; error?: string }> | null;
  csv_files: Record<string, string>;
}

export async function startCollect(storeIds?: number[]): Promise<{ ok: boolean; message: string }> {
  const { data } = await api.post('/collect/start/', { store_ids: storeIds || null });
  return data;
}

export async function getCollectStatus(logSince = 0): Promise<CollectStatus> {
  const { data } = await api.get<CollectStatus>('/collect/status/', { params: { logSince } });
  return data;
}

export async function stopCollect(): Promise<{ ok: boolean }> {
  const { data } = await api.post('/collect/stop/');
  return data;
}

export function getCollectCsvUrl(storeName: string): string {
  return `/api/smartstore/collect/csv/?store_name=${encodeURIComponent(storeName)}`;
}

export function getCollectCsvByLogId(logId: number): string {
  return `/api/smartstore/collect/csv/?log_id=${logId}`;
}

export interface CollectLog {
  id: number;
  store_id: number;
  store_name: string;
  login_id: string;
  total_products: number;
  csv_file_path: string | null;
  status: string;
  error_msg: string | null;
  completed_at: string;
}

export async function getCollectLogs(limit = 20): Promise<CollectLog[]> {
  const { data } = await api.get<CollectLog[]>('/collect/logs/', { params: { limit } });
  return data;
}

export async function deleteErrorLogs(): Promise<{ deleted: number }> {
  const { data } = await api.delete<{ deleted: number }>('/collect/logs/');
  return data;
}
