import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/missing-attrs' });

export interface MissingSummary {
  total_missing: number;
  skus_with_missing: number;
  unique_attrs: number;
  pending: number;
  registered: number;
  skipped: number;
  reviewed: number;
  auto_candidates: number;
}

export interface CandidateValue {
  seq: number;
  text: string;
  color: string | null;
  order: number;
}

export interface MissingAttrItem {
  attribute_seq: number;
  attribute_name: string;
  kind_type: string | null;
  attr_type: string | null;
  cls_type: string | null;
  candidate_count: number;
  candidate_values: CandidateValue[];
  missing_skus: number;
  pending_skus: number;
  registered_skus: number;
  needs_manual_skus?: number;
  failed_skus?: number;
  recommended_value_seq: number | null;
  recommended_value_text: string | null;
}

export interface MissingSkuItem {
  seller_management_code: string;
  store_id: number;
  category_id: string;
  status: string;
  detected_at: string;
  product_name: string;
  sale_price: number | null;
  origin_product_no: number;
  channel_product_no: number;
  store_name: string;
}

export async function fetchSummary(): Promise<MissingSummary> {
  const { data } = await api.get<MissingSummary>('/summary/');
  return data;
}

export async function fetchAttrList(params: {
  page?: number; per_page?: number; search?: string;
  kind?: 'all' | 'opt' | 'auto' | 'free';
  status?: 'all' | 'pending' | 'registered' | 'reviewed' | 'skipped';
  sort?: 'count' | 'name';
}): Promise<{ items: MissingAttrItem[]; total: number; page: number; per_page: number; total_pages: number }> {
  const { data } = await api.get('/', { params });
  return data;
}

export async function fetchAttrSkus(attributeSeq: number, params: {
  page?: number; per_page?: number; store_id?: number; status?: string;
  category_id?: string; search?: string;
}): Promise<{
  items: MissingSkuItem[]; total: number; page: number; per_page: number; total_pages: number;
  by_category: { category_id: string; cnt: number }[];
}> {
  const { data } = await api.get(`/${attributeSeq}/skus/`, { params });
  return data;
}

export async function refreshSummary(): Promise<{ attr_summary_rows: number; sku_summary_rows: number }> {
  const { data } = await api.post('/refresh-summary/', {});
  return data;
}

export async function registerFiltered(payload: {
  attribute_seq: number;
  value_seq: number;
  value_text?: string;
  store_id?: number;
  category_id?: string;
  search?: string;
  max_skus?: number;
  dry_run?: boolean;
}): Promise<{
  ok: number; fail: number; errors: string[];
  total_matched: number; aborted: boolean;
  updated_skus?: object[];
}> {
  const { data } = await api.post('/register-filtered/', payload);
  return data;
}

export async function registerBulk(payload: {
  attribute_seq: number;
  value_seq: number;
  value_text?: string;
  dry_run?: boolean;
  skus: { seller_management_code: string; store_id: number; origin_product_no: number }[];
}): Promise<{ ok: number; fail: number; errors: string[]; updated_skus: object[] }> {
  const { data } = await api.post('/register/', payload);
  return data;
}

export async function markBulk(payload: {
  attribute_seq: number;
  status: 'skipped' | 'reviewed';
  skus: { seller_management_code: string; store_id: number }[];
}): Promise<{ updated: number }> {
  const { data } = await api.post('/mark/', payload);
  return data;
}

// ── 상품별 (SKU-centric) ──

export interface SkuRow {
  seller_management_code: string;
  store_id: number;
  store_name: string;
  category_id: string;
  category_text: string;
  missing_count: number;
  auto_count: number;
  free_count: number;
  registered_count: number;
  pending_count: number;
  product_name: string | null;
  sale_price: number | null;
  origin_product_no: number | null;
  channel_product_no: number | null;
}

export interface SkuMissingAttr {
  attribute_seq: number;
  attribute_name: string;
  attribute_kind_type: string | null;
  attribute_type: string | null;
  classification_type: string | null;
  candidate_count: number;
  candidate_values: CandidateValue[];
  recommended_value_seq: number | null;
  recommended_value_text: string | null;
  status: string;
  registered_value_seq: number | null;
  registered_value_text: string | null;
}

export interface SkuMissingResponse {
  info: {
    seller_management_code: string;
    store_id: number;
    store_name: string;
    category_id: string;
    name: string | null;
    sale_price: number | null;
    origin_product_no: number;
    channel_product_no: number;
  } | null;
  missing_attrs: SkuMissingAttr[];
}

export async function fetchSkuList(params: {
  page?: number; per_page?: number; search?: string;
  store_id?: number; status?: string; category_id?: string;
}): Promise<{ items: SkuRow[]; total: number; page: number; per_page: number; total_pages: number }> {
  const { data } = await api.get('/skus/', { params });
  return data;
}

export async function fetchSkuDetail(sellerCode: string, storeId: number): Promise<SkuMissingResponse> {
  const { data } = await api.get(`/skus/${encodeURIComponent(sellerCode)}/`, { params: { store_id: storeId } });
  return data;
}

export async function registerForSku(payload: {
  seller_management_code: string;
  store_id: number;
  selections: { attribute_seq: number; value_seq: number; value_text: string }[];
  dry_run?: boolean;
}): Promise<{ ok: boolean; error?: string; attrs_set?: number; dry_run?: boolean }> {
  const { data } = await api.post(`/skus/${encodeURIComponent(payload.seller_management_code)}/register/`, {
    store_id: payload.store_id,
    selections: payload.selections,
    dry_run: payload.dry_run || false,
  });
  return data;
}

// ── 속성 AI 자동체크 ──
const attrApi = axios.create({ baseURL: '/api/smartstore' });

export interface AutoCheckSelection { attr_seq: number; attr_name: string; value: string; source: string; }
export interface AutoCheckResult { seller_code: string; store_id: number; name: string; selections: AutoCheckSelection[]; }
export interface AutoCheckPreview {
  ok: boolean; scanned: number; matched_skus: number; attr_total: number;
  sources: Record<string, number>; mode: string; results: AutoCheckResult[];
}
export interface AutoCheckStatus {
  running: boolean;
  worker: null | { key: string; name: string; status: string; log: string; heartbeat_at: string; idle_sec: number | null };
  counts: Record<string, number>;
}

export async function autoCheckPreview(payload: { store_id?: number; limit?: number; codes?: string[]; mode?: string }): Promise<AutoCheckPreview> {
  const { data } = await attrApi.post('/attr/auto-check/preview/', payload);
  return data;
}
export async function autoCheckStart(payload: { store_id?: number; limit?: number; mode?: string }): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await attrApi.post('/attr/auto-check/start/', payload);
  return data;
}
export async function autoCheckStatus(): Promise<AutoCheckStatus> {
  const { data } = await attrApi.get('/attr/auto-check/status/');
  return data;
}

export interface VisionStatus {
  running: boolean;
  worker: null | { key: string; name: string; status: string; log: string; heartbeat_at: string; idle_sec: number | null };
  pending_targets: number;
  gpus: string[];
}
export async function visionStart(payload: { store_id?: number; limit?: number }): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await attrApi.post('/attr/vision/start/', payload);
  return data;
}
export async function visionStatus(): Promise<VisionStatus> {
  const { data } = await attrApi.get('/attr/vision/status/');
  return data;
}

// ── 속성 파이프라인 (수집→추론→동기화) + 상품별 속성 조회 ──
export interface PipelineStore { store_id: number; store_name: string; pending: number; classified: number; registered: number; sale_skus: number; crawled_skus: number; }
export interface ProductAttrItem { attribute_name: string; classification_type: string | null; status: string; candidate_values: { seq: number; text: string }[]; recommended_value_text: string | null; registered_value_text: string | null; }

export async function pipelineStatus(storeId?: number): Promise<{ ok: boolean; stores: PipelineStore[]; totals: any }> {
  const { data } = await attrApi.get('/attr/pipeline/status/', { params: storeId ? { store_id: storeId } : {} });
  return data;
}
export async function productAttrs(sellerCode: string, storeId?: number): Promise<{ ok: boolean; seller_code: string; store_id: number; attributes: ProductAttrItem[] }> {
  const { data } = await attrApi.get('/attr/product/', { params: { seller_code: sellerCode, store_id: storeId || undefined } });
  return data;
}

// ── 상품 실물 컨텍스트 (상품명/대표이미지/상세) — 모달 오픈/SKU 선택 시에만 호출 ──
export interface ProductContext {
  ok: boolean;
  seller_code: string;
  store_id: number;
  name?: string | null;
  category_name?: string;
  representative_image?: string | null;
  option_images?: string[];
  detail_images?: string[];
  detail_text?: string;
  error?: string;
}
export async function productContext(sellerCode: string, storeId?: number): Promise<ProductContext> {
  const { data } = await attrApi.get<ProductContext>('/attr/product-context/', { params: { seller_code: sellerCode, store_id: storeId || undefined } });
  return data;
}

// ── status별 SKU 드릴다운 + 수동검토 ──
export interface StatusSkuItem { seller_code: string; store_id: number; store_name: string; name: string | null; status_type: string | null; is_sale: boolean; attr_count: number; }
export async function listByStatus(status: string, storeId?: number, limit = 200, search = ''): Promise<{ ok: boolean; status: string; items: StatusSkuItem[]; error?: string }> {
  const { data } = await attrApi.get('/attr/list-by-status/', { params: { status, store_id: storeId || undefined, limit, search: search || undefined } });
  return data;
}

export interface ManualAttrItem { attribute_seq: number; attribute_name: string; classification_type: string | null; candidate_values: { seq: number; text: string }[]; recommended_value_seq: number | null; recommended_value_text: string | null; last_error: string | null; }
export async function needsManualForSku(sellerCode: string, storeId?: number): Promise<{ ok: boolean; seller_code: string; store_id: number; attributes: ManualAttrItem[] }> {
  const { data } = await attrApi.get('/attr/needs-manual-sku/', { params: { seller_code: sellerCode, store_id: storeId || undefined } });
  return data;
}

export interface RecentChange { id: number; seller_code: string; store_id: number; store_name: string; added_count: number; status: string; changed_at: string | null; }
export async function recentChanges(storeId?: number, limit = 100): Promise<{ ok: boolean; changes: RecentChange[] }> {
  const { data } = await attrApi.get('/attr/changes/recent/', { params: { store_id: storeId || undefined, limit } });
  return data;
}
export async function syncStart(payload: { store_id?: number; limit?: number }): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await attrApi.post('/attr/sync/start/', payload);
  return data;
}
export async function syncStatusReq(): Promise<{ running: boolean; worker: any; counts: Record<string, number> }> {
  const { data } = await attrApi.get('/attr/sync/status/');
  return data;
}

// ── 파이프라인 단계 실행 (수집/추론) + 워커 상태 ──
export interface PipelineWorkers { crawl: { running: boolean; log: string | null; name: string | null }; stage: { running: boolean; log: string | null; name: string | null }; sync: { running: boolean; log: string | null; name: string | null }; }
export async function pipelineCrawlStart(storeId?: number): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await attrApi.post('/attr/pipeline/crawl/start/', storeId ? { store_id: storeId } : {});
  return data;
}
export async function pipelineStageStart(payload: { store_id?: number; limit?: number }): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await attrApi.post('/attr/pipeline/stage/start/', payload);
  return data;
}
export async function pipelineWorkers(): Promise<PipelineWorkers> {
  const { data } = await attrApi.get('/attr/pipeline/workers/');
  return data;
}
