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
