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
