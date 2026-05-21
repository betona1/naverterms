import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/attr' });

export interface AttrStats {
  attr_skus: number;
  attr_crawl_rows: number;
  tag_rows: number;
  tag_standard: number;
  tag_freeform: number;
  attr_value_rows: number;
  categories: number;
  schema_rows: number;
  quality_skus: number;
  quality_rows: number;
  quality_review: number;
}

export interface AttrProduct {
  seller_management_code: string;
  origin_product_no: number | null;
  channel_product_no: number | null;
  category_id: string | null;
  category_text: string | null;
  store_id: number;
  store_name: string | null;
  crawled_at: string | null;
  name: string | null;
  sale_price: number | null;
  stock_quantity: number | null;
  tag_count: number;
  attr_count: number;
  review_count: number | null;
  quality_done: number;
}

export interface AttrProductsResponse {
  items: AttrProduct[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface AttrTag {
  position: number;
  tag: string;
  search_volume: number | null;
  search_volume_label: string | null;
  is_standard: number;
  tag_raw: string | null;
}

export interface AttrValue {
  section: string;
  attr_label: string;
  attr_type: string;
  value_text: string | null;
  value_bool: number | null;
  value_number: number | null;
  is_recommended: number;
}

export interface QualityItem {
  item_name: string;
  result_text: string | null;
  status: string | null;
  needs_review: number;
  input_count: number | null;
  applied_count: number | null;
  crawled_at: string | null;
}

export interface AttrGroupValue {
  seq: number;
  text: string | null;
  color: string | null;
  order: number;
  selected: boolean;
}

export interface AttrGroup {
  attribute_seq: number;
  attribute_name: string;
  classification_type: string | null;
  attribute_kind_type: string | null;
  attribute_type: string | null;
  source: string | null;
  values: AttrGroupValue[];
}

export interface AttrProductDetail {
  info: {
    seller_management_code: string;
    origin_product_no: number | null;
    channel_product_no: number | null;
    category_id: string | null;
    category_text: string | null;
    store_id: number;
    store_name: string | null;
    crawled_at: string | null;
    name: string | null;
    sale_price: number | null;
    stock_quantity: number | null;
  };
  tags: AttrTag[];
  attrs_by_section: Record<string, AttrValue[]>;
  attribute_groups: AttrGroup[];
  quality: QualityItem[];
}

export interface TopTag {
  tag: string;
  cnt: number;
  sv: number | null;
  std: number | null;
}

export interface QualityIssue {
  seller_management_code: string;
  store_id: number;
  store_name: string | null;
  issues: string;
  issue_count: number;
  product_name: string | null;
  category_id: string | null;
}

export interface CategorySummary {
  category_id: string;
  category_text: string | null;
  sku_count: number;
  attr_def_count: number;
}

export async function fetchAttrStats(): Promise<AttrStats> {
  const { data } = await api.get<AttrStats>('/stats/');
  return data;
}

export async function fetchAttrProducts(params: {
  page?: number;
  per_page?: number;
  search?: string;
  store_id?: number;
  needs_review?: number;
  has_quality?: number;
}): Promise<AttrProductsResponse> {
  const { data } = await api.get<AttrProductsResponse>('/products/', { params });
  return data;
}

export async function fetchAttrProductDetail(
  sellerCode: string,
  storeId?: number,
): Promise<AttrProductDetail> {
  const { data } = await api.get<AttrProductDetail>(
    `/products/${encodeURIComponent(sellerCode)}/`,
    { params: storeId ? { store_id: storeId } : {} },
  );
  return data;
}

export async function fetchTopTags(params: {
  limit?: number;
  by?: 'count' | 'volume';
  category_id?: string;
}): Promise<{ items: TopTag[] }> {
  const { data } = await api.get<{ items: TopTag[] }>('/tags/top/', { params });
  return data;
}

export async function fetchQualityIssues(limit = 200): Promise<{ items: QualityIssue[] }> {
  const { data } = await api.get<{ items: QualityIssue[] }>('/quality/issues/', { params: { limit } });
  return data;
}

export async function fetchCategorySummary(limit = 50): Promise<{ items: CategorySummary[] }> {
  const { data } = await api.get<{ items: CategorySummary[] }>('/categories/', { params: { limit } });
  return data;
}

export interface TopAttribute {
  section: string;
  attr_label: string;
  attr_type: string;
  use_count: number;
  sku_count: number;
  distinct_values: number;
  recommended_count: number | null;
  true_count: number | null;
  false_count: number | null;
  resolved_label: string | null;
}

export interface AttrValueRow {
  value: string | null;
  resolved_value: string | null;
  attr_type: string;
  cnt: number;
  sku_count: number;
  recommended_count: number | null;
}

export async function fetchTopAttributes(params: {
  limit?: number;
  section?: string;
  category_id?: string;
}): Promise<{ items: TopAttribute[] }> {
  const { data } = await api.get<{ items: TopAttribute[] }>('/attributes/top/', { params });
  return data;
}

export async function fetchAttributeValues(params: {
  attr_label: string;
  section?: string;
  category_id?: string;
  limit?: number;
}): Promise<{ items: AttrValueRow[] }> {
  const { data } = await api.get<{ items: AttrValueRow[] }>('/attributes/values/', { params });
  return data;
}
