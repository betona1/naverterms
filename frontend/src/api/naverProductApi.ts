import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface ProductSalesInfo {
  total_amount: number;
  total_quantity: number;
  order_count: number;
}

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
  sales?: ProductSalesInfo;
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
  opts: { folder_id?: number | null; search?: string; sort?: string; include_sales?: boolean } = {},
): Promise<NaverProductListResponse> {
  const params: Record<string, string | number> = { page, per_page: perPage };
  if (opts.folder_id != null) params.folder_id = opts.folder_id;
  if (opts.search) params.search = opts.search;
  if (opts.sort) params.sort = opts.sort;
  if (opts.include_sales) params.include_sales = '1';
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

export async function generateNaverName(
  productId: number, useVision = true,  // 모달의 단건 [🤖] 은 비전 ON
): Promise<GenerateNameResult> {
  const r = await api.post(`/naver-products/${productId}/generate-name/`,
    { use_vision: useVision },
    { validateStatus: () => true });
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
  top_sales?: number;
  only_missing?: boolean;
}): Promise<EnqueueResult> {
  const r = await api.post('/naver-products/enqueue/', opts);
  return r.data;
}

export async function fetchQueueStatus(): Promise<QueueStatus> {
  const r = await api.get('/naver-products/queue-status/');
  return r.data;
}

export async function moveNaverProducts(
  ids: number[], folderId: number,
): Promise<{ ok: boolean; moved?: number; folder_id?: number; error?: string }> {
  const r = await api.post('/naver-products/move/', { ids, folder_id: folderId });
  return r.data;
}

export interface VisionAnalysis {
  color?: string[] | null;
  material?: string | null;
  form?: string | null;
  package_qty?: string | null;
  key_features?: string[] | null;
  readable_text?: string | null;
}

export interface NaverProductDetail extends NaverProductItem {
  market_product_name: string | null;
  naver_keywords: string | null;
  keywords: string | null;
  category_code: string | null;
  model_name: string | null;
  consumer_price: number;
  option1_name: string | null;
  option1_values: string | null;
  option2_name: string | null;
  option2_values: string | null;
  combined_option: string | null;
  product_attribute: string | null;
  detail_html: string | null;
  is_modified: number;
  image_medium: string | null;
  image_analysis: VisionAnalysis | null;
  image_analyzed_at: string | null;
}

export async function fetchNaverProductDetail(id: number): Promise<NaverProductDetail> {
  const r = await api.get(`/naver-products/${id}/`);
  return r.data;
}

export async function patchNaverProduct(
  id: number, payload: Partial<NaverProductDetail>,
): Promise<{ ok: boolean; detail?: NaverProductDetail; error?: string }> {
  const r = await api.patch(`/naver-products/${id}/`, payload, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function clearVisionCache(id: number): Promise<{ ok: boolean; error?: string }> {
  const r = await api.post(`/naver-products/${id}/clear-vision/`);
  return r.data;
}

export interface KeywordVolume {
  pc: number;
  mobile: number;
  total: number;
  comp: string;          // 높음/중간/낮음
  product_count?: number;
  category?: string;
  fetched_at?: string;
  fresh: boolean;
}

export interface KeywordPool {
  ok: boolean;
  product_name: string;
  naver_product_name: string | null;
  vision_features: string[];
  vision_meta: {
    color?: string[] | string | null;
    material?: string | null;
    form?: string | null;
    package_qty?: string | null;
    readable_text?: string | null;
  };
  best_picks: string[];
  good_picks: string[];
  ad_keywords: string[];
  functional_keywords: string[];
  preset_keywords: string[];
  naver_keywords: string[];
  detail_keywords?: string[];
  detail_html_length?: number;
  banned_keywords?: string[];
  must_have_keywords?: string[];
  inferred_gender?: 'female' | 'male' | null;
  inferred_season?: 'summer' | 'winter' | 'spring_fall' | null;
  season_banned_keywords?: string[];
  image_ocr_text?: string;
  option_color?: string | null;
  color_mismatch?: { option_color: string; vision_colors: string[] } | null;
  keyword_volumes?: Record<string, KeywordVolume>;
  error?: string;
}

export interface RelatedKeyword {
  keyword: string;
  pc: number;
  mobile: number;
  total: number;
  comp: string;
}

export async function fetchRelatedKeywords(seed: string, limit = 30): Promise<{ ok: boolean; seed: string; items: RelatedKeyword[] }> {
  const r = await api.get('/naver-keyword-related/', { params: { seed, limit } });
  return r.data;
}

export async function fetchRelatedKeywordsMulti(seeds: string[], limit = 1500): Promise<{ ok: boolean; seeds: string[]; items: RelatedKeyword[] }> {
  const r = await api.get('/naver-keyword-related/', { params: { seeds: seeds.join(','), limit } });
  return r.data;
}

export async function fetchHotKeywords(category: string, limit = 20): Promise<{ ok: boolean; items: Array<{ keyword: string; total: number; comp: string }> }> {
  const r = await api.get('/naver-keyword-hot/', { params: { category, limit } });
  return r.data;
}

export interface KeywordRelevance {
  ok: boolean;
  relevant: string[];
  irrelevant: string[];
  cached: boolean;
  model?: string;
  elapsed_ms?: number;
  error?: string;
}

export async function fetchKeywordRelevance(productId: number, keywords: string[], force = false): Promise<KeywordRelevance> {
  const r = await api.post(`/naver-products/${productId}/keyword-relevance/`, { keywords, force });
  return r.data;
}

export async function fetchKeywordPool(id: number): Promise<KeywordPool> {
  const r = await api.get(`/naver-products/${id}/keyword-pool/`);
  return r.data;
}
