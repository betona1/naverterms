import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface NaverProductItem {
  id: number;
  product_code: string;
  source_id: number | null;
  folder_id: number;
  product_name: string | null;
  ai_product_name: string | null;
  ai_recommended_name: string | null;
  edited_product_name: string | null;
  naver_product_name: string | null;
  category_name: string | null;
  brand: string | null;
  manufacturer: string | null;
  origin: string | null;
  ownerclan_price: number;
  market_price: number;
  shipping_fee: number;
  return_fee: number;
  image_small: string | null;
  image_large: string | null;
  sale_status: string | null;
  sync_status: string | null;
  copied_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NaverProductFolder {
  id: number;
  store_id: number | null;
  name: string;
  color: string | null;
  sort_order: number;
  is_system: number;
  queue_position: number | null;
  description: string | null;
  product_count: number;
}

export interface NaverProductListResponse {
  items: NaverProductItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ImportState {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  processed: number;
  inserted: number;
  updated: number;
  error: string | null;
  message: string;
}

export async function fetchNaverProducts(
  page = 1, perPage = 50,
  opts: { folder_id?: number | null; search?: string } = {},
): Promise<NaverProductListResponse> {
  const params: Record<string, string | number> = { page, per_page: perPage };
  if (opts.folder_id != null) params.folder_id = opts.folder_id;
  if (opts.search) params.search = opts.search;
  const r = await api.get('/naver-products/', { params });
  return r.data;
}

export async function fetchNaverFolders(): Promise<{ items: NaverProductFolder[] }> {
  const r = await api.get('/naver-products/folders/');
  return r.data;
}

export async function syncNaverFolders(): Promise<{ ok: boolean; stores_total: number; folders_created: number; folders_updated: number }> {
  const r = await api.post('/naver-products/folders/sync/');
  return r.data;
}

export async function startImportFrom11st(batchSize = 1000): Promise<{ ok: boolean; error?: string; state: ImportState }> {
  const r = await api.post('/naver-products/import-from-11st/', { batch_size: batchSize });
  return r.data;
}

export async function fetchImportStatus(): Promise<ImportState> {
  const r = await api.get('/naver-products/import-status/');
  return r.data;
}

export interface GenerateNameResult {
  ok: boolean;
  naver_product_name?: string;
  model?: string;
  elapsed_ms?: number;
  byte_length?: number;
  raw_first_line?: string;
  error?: string;
}

export async function generateNaverName(productId: number): Promise<GenerateNameResult> {
  const r = await api.post(`/naver-products/${productId}/generate-name/`, {}, {
    validateStatus: () => true,  // 502 도 그대로 받기
  });
  return r.data;
}

export interface EnqueueResult {
  ok: boolean;
  queued: number;
  requested: number;
  already_queued?: number;
}

export interface QueueWorker {
  endpoint: string;
  running: number;
  done: number;
}

export interface QueueStatus {
  pending: number;
  running: number;
  done_recent: number;
  error: number;
  by_worker: QueueWorker[];
}

export async function enqueueGenerate(opts: {
  ids?: number[];
  folder_id?: number;
  only_missing?: boolean;
}): Promise<EnqueueResult> {
  const r = await api.post('/naver-products/enqueue/', opts);
  return r.data;
}

export async function fetchQueueStatus(): Promise<QueueStatus> {
  const r = await api.get('/naver-products/queue-status/');
  return r.data;
}
