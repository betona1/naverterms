import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/products' });

export interface SmartStoreProduct {
  id: number;
  store_id: number;
  origin_product_no: number;
  channel_product_no: number | null;
  group_product_no: number | null;
  name: string;
  sale_price: number;
  discount_price: number;
  seller_discount: number;
  stock_quantity: number;
  status_type: string | null;
  display_status: string | null;
  channel_product_display_status_type: string | null;
  seller_management_code: string | null;
  category_id: string | null;
  product_image_url: string | null;
  ownerclan_soldout: number;
  is_focus: number;
  total_order_qty: number;
  total_order_amount: number;
  total_order_count: number;
  all_order_qty: number;
  all_order_amount: number;
  all_order_count: number;
  has_orders?: boolean;
  store_name?: string;
  // CSV 수집 상세 컬럼
  options: string | null;
  additional_products: string | null;
  delivery_fee_type: string | null;
  basic_delivery_fee: number;
  return_delivery_fee: number;
  exchange_delivery_fee: number;
  bundle_delivery: string | null;
  category1: string | null;
  category2: string | null;
  category3: string | null;
  category4: string | null;
  manufacturer: string | null;
  brand_name: string | null;
  model_name: string | null;
  naver_shopping_registered: string | null;
  seller_barcode: string | null;
  internal_code1: string | null;
  internal_code2: string | null;
  registered_at: string | null;
  last_modified_at: string | null;
  // 마스터 변경 추적
  has_pending_changes: number;
  pending_change_groups: string;
  pending_change_count: number;
  master_price: number | null;
  master_sale_status: number | null;
  price_diff: number;
  status_mismatch: number;
  restock_checked: number;
  restock_at: string | null;
  restock_price_changed: number;
  restock_reverse_margin: number;
  synced_at: string;
  created_at: string;
  updated_at: string | null;
}

export interface ProductListResponse {
  items: SmartStoreProduct[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ProductStats {
  total: number;
  by_status: Record<string, number>;
  sold_count: number;
  ss_sold_count: number;
  sold_by_status: Record<string, number>;
  ss_sold_by_status: Record<string, number>;
  changes_count: number;
  status_mismatch_count: number;
  field_changes_count: number;
  reverse_margin_count: number;
  restock_unchecked_count: number;
  no_master_count: number;
  last_synced_at: string | null;
}

export interface SyncResult {
  synced: number;
  total_from_api: number;
  store_name: string;
  synced_at: string;
}

export async function fetchProducts(
  storeId: number,
  page = 1,
  perPage = 50,
  status?: string,
  search?: string,
  ownerclanSoldout?: number,
  isFocus?: number,
  hasOrders?: number,
  sortBy?: string,
  sortDir?: string,
  minSsAmount?: number,
  hasChanges?: number,
  reverseMargin?: number,
  restockUnchecked?: number,
  noMaster?: number,
): Promise<ProductListResponse> {
  const params: Record<string, string | number> = { store_id: storeId, page, per_page: perPage };
  if (status) params.status = status;
  if (search) params.search = search;
  if (ownerclanSoldout !== undefined) params.ownerclan_soldout = ownerclanSoldout;
  if (isFocus !== undefined) params.is_focus = isFocus;
  if (hasOrders !== undefined) params.has_orders = hasOrders;
  if (sortBy) params.sort_by = sortBy;
  if (sortDir) params.sort_dir = sortDir;
  if (minSsAmount !== undefined) params.min_ss_amount = minSsAmount;
  if (hasChanges !== undefined) params.has_changes = hasChanges;
  if (reverseMargin !== undefined) params.reverse_margin = reverseMargin;
  if (restockUnchecked !== undefined) params.restock_unchecked = restockUnchecked;
  if (noMaster !== undefined) params.no_master = noMaster;
  // 검색어가 길면 POST로 전환 (URL 길이 제한 회피)
  if (search && search.length > 200) {
    const { data } = await api.post<ProductListResponse>('/search/', params);
    return data;
  }
  const { data } = await api.get<ProductListResponse>('/', { params });
  return data;
}

export async function toggleFocus(productIds: number[], isFocus: number): Promise<{ updated: number }> {
  const { data } = await api.post<{ updated: number }>('/focus/', {
    product_ids: productIds,
    is_focus: isFocus,
  });
  return data;
}

export async function syncProducts(storeId: number): Promise<SyncResult> {
  const { data } = await api.post<SyncResult>('/sync/', { store_id: storeId });
  return data;
}

export async function fetchProductStats(storeId: number): Promise<ProductStats> {
  const { data } = await api.get<ProductStats>('/stats/', { params: { store_id: storeId } });
  return data;
}

export async function fetchAllStoresStats(): Promise<Record<number, ProductStats>> {
  const { data } = await api.get<Record<number, ProductStats>>('/stats/');
  return data;
}

export interface RestockSummary {
  candidates: number;         // 재입고 대기 (판매중지+재고복귀) 총수
  reactivatable: number;      // 지금 한도여유 내 전환 가능 수
  blocked_over_limit: number; // 한도초과로 대기 중인 수
  per_store: {
    store_id: number; store_name: string; candidates: number;
    limit: number; active: number; headroom: number; reactivatable: number;
  }[];
}

export async function fetchRestockSummary(storeId: number): Promise<RestockSummary> {
  const { data } = await api.get<RestockSummary>('/restock-summary/', { params: { store_id: storeId } });
  return data;
}

function _buildParams(params: {
  storeIds?: number[]; statuses?: string[]; wOnly?: boolean;
  search?: string; hasOrders?: boolean; isFocus?: boolean;
  sortBy?: string; sortDir?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.storeIds) params.storeIds.forEach(id => sp.append('store_ids', String(id)));
  if (params.statuses) params.statuses.forEach(s => sp.append('statuses', s));
  if (params.wOnly) sp.append('w_only', '1');
  if (params.search) sp.append('search', params.search);
  if (params.hasOrders) sp.append('has_orders', '1');
  if (params.isFocus) sp.append('is_focus', '1');
  if (params.sortBy) sp.append('sort_by', params.sortBy);
  if (params.sortDir) sp.append('sort_dir', params.sortDir);
  return sp.toString();
}

export async function downloadProductExcel(
  params: {
    storeIds?: number[]; statuses?: string[]; wOnly?: boolean;
    search?: string; hasOrders?: boolean; isFocus?: boolean;
    sortBy?: string; sortDir?: string;
  },
  _onProgress?: (pct: number) => void,
): Promise<void> {
  const qs = _buildParams(params);
  // 브라우저 다운로드로 직접 열기 (저장 위치 선택 가능)
  window.open(`/api/smartstore/products/excel/?${qs}`, '_blank');
}

export async function fetchProductCount(
  params: { storeIds?: number[]; statuses?: string[]; wOnly?: boolean },
): Promise<number> {
  const qs = _buildParams(params);
  const { data } = await api.get<{ count: number }>(`/count/?${qs}`);
  return data.count;
}

export async function fetchWCodes(
  params: { storeIds?: number[]; statuses?: string[] },
  onProgress?: (pct: number) => void,
): Promise<string[]> {
  const qs = _buildParams(params);
  const { data } = await api.get<{ codes: string[] }>(`/wcodes/?${qs}`, {
    onDownloadProgress: (e) => {
      if (onProgress && e.total && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      } else if (onProgress && e.loaded) {
        onProgress(-1);
      }
    },
  });
  return data.codes;
}

export async function toggleRestockChecked(productIds: number[], checked: number): Promise<{ updated: number }> {
  const { data } = await api.post<{ updated: number }>('/restock-check/', {
    product_ids: productIds,
    checked,
  });
  return data;
}

export async function refreshTracking(storeId = 0): Promise<{ refreshed: number }> {
  const { data } = await api.post<{ refreshed: number }>('/refresh-tracking/', { store_id: storeId });
  return data;
}

// ── 주문이력 ──

export interface ProductOrderRow {
  order_date: string;
  site_name: string;
  order_status: string;
  quantity: number;
  payment_price: number;
  settlement_price: number;
  cost: number;
  profit: number;
  receiver_name: string;
  order_option: string;
  bid_number: string;
  product_name: string;
  product_seller_code: string;
}

export interface SiteSummary {
  site_name: string;
  count: number;
  qty: number;
  amount: number;
}

export interface ProductOrdersResponse {
  orders: ProductOrderRow[];
  summary: {
    count: number;
    total_qty: number;
    total_payment: number;
    total_settle: number;
    total_cost: number;
    total_profit: number;
  };
  by_site: SiteSummary[];
}

export async function fetchProductOrders(
  code: string,
  startDate: string,
  endDate: string,
  productName?: string,
): Promise<ProductOrdersResponse> {
  const params: Record<string, string> = { start_date: startDate, end_date: endDate };
  if (code) params.code = code;
  if (productName) params.product_name = productName;
  const { data } = await api.get<ProductOrdersResponse>('/orders/', { params });
  return data;
}

// ── 품절처리 ──

export interface SuspendPreviewResult {
  total_count: number;
  by_store: { store_name: string; count: number }[];
  w_codes: string[];
}

export interface SuspendResult {
  success_count: number;
  fail_count: number;
  errors: { origin_product_no: number; error: string }[];
}

export async function previewSuspend(
  productIds: number[],
  selectAll: boolean,
  filters: { store_id: number; status?: string; search?: string; ownerclan_soldout?: number },
): Promise<SuspendPreviewResult> {
  const { data } = await api.post<SuspendPreviewResult>('/suspend-preview/', {
    product_ids: productIds,
    select_all: selectAll,
    filters,
  });
  return data;
}

export async function suspendProducts(
  productIds: number[],
  selectAll: boolean,
  filters: { store_id: number; status?: string; search?: string; ownerclan_soldout?: number },
): Promise<SuspendResult> {
  const { data } = await api.post<SuspendResult>('/suspend/', {
    product_ids: productIds,
    select_all: selectAll,
    filters,
  });
  return data;
}

export async function fetchOrphanWCodes(
  storeIds?: number[],
): Promise<{ codes: string[]; count: number }> {
  const sp = new URLSearchParams();
  if (storeIds) storeIds.forEach(id => sp.append('store_ids', String(id)));
  const { data } = await api.get<{ codes: string[]; count: number }>(`/orphan-wcodes/?${sp.toString()}`);
  return data;
}

// ── 전상품 API 검증 ──

export interface AuditStatus {
  running: boolean;
  progress_pct: number;
  checked: number;
  total: number;
  match: number;
  mismatch: number;
  fixed: number;
  closed: number;
  errors: number;
  current_api_key: string;
  logs: string[];
  elapsed: number;
  audit_log_id: number;
}

export interface AuditLog {
  id: number;
  started_at: string;
  completed_at: string | null;
  source: string;
  total_target: number;
  checked: number;
  match_count: number;
  mismatch_count: number;
  fixed_count: number;
  api_error_count: number;
  closed_count: number;
  by_api_key: Record<string, { total: number; match: number; mismatch: number; closed: number; errors: number }> | null;
  elapsed_sec: number;
}

export interface AuditLogDetail {
  summary: { action: string; cnt: number }[];
  changes: {
    id: number;
    origin_product_no: number;
    seller_management_code: string;
    store_name: string;
    db_status: string;
    api_status: string;
    action: string;
    new_status: string;
    error_detail: string | null;
    checked_at: string;
  }[];
}

export async function startAudit(source: 'api' | 'ownerclan' = 'api'): Promise<{ ok: boolean; message: string }> {
  const { data } = await api.post<{ ok: boolean; message: string }>('/audit/start/', { source });
  return data;
}

export async function getAuditStatus(): Promise<AuditStatus> {
  const { data } = await api.get<AuditStatus>('/audit/status/');
  return data;
}

export async function stopAudit(): Promise<void> {
  await api.post('/audit/stop/');
}

export async function getAuditLogs(limit = 20): Promise<AuditLog[]> {
  const { data } = await api.get<AuditLog[]>('/audit/logs/', { params: { limit } });
  return data;
}

export async function getAuditLogDetail(id: number): Promise<AuditLogDetail> {
  const { data } = await api.get<AuditLogDetail>(`/audit/logs/${id}/`);
  return data;
}


// ── 0마진 처리 ──

export interface ZeroMarginPreviewItem {
  origin_product_no: number;
  name: string;
  store_name: string;
  sale_price: number;
  master_price: number;
  settle: number;
  margin: number;
  new_price: number;
  new_margin: number;
}

export interface ZeroMarginPreviewResult {
  count: number;
  items: ZeroMarginPreviewItem[];
}

export interface ZeroMarginUpdateResult {
  total: number;
  success: number;
  fail: number;
  items: {
    origin_product_no: number;
    name: string;
    old_price: number;
    new_price: number;
    ok: boolean;
    error?: string;
  }[];
}

export async function fetchZeroMarginPreview(storeId = 0): Promise<ZeroMarginPreviewResult> {
  const { data } = await api.get<ZeroMarginPreviewResult>('/zero-margin/preview/', {
    params: storeId ? { store_id: storeId } : {},
  });
  return data;
}

export async function executeZeroMarginUpdate(storeId = 0): Promise<ZeroMarginUpdateResult> {
  const { data } = await api.post<ZeroMarginUpdateResult>('/zero-margin/update/', {
    store_id: storeId,
  });
  return data;
}

export interface ZeroMarginLog {
  id: number;
  total: number;
  success_count: number;
  fail_count: number;
  total_diff: number;
  created_at: string;
}

export interface ZeroMarginLogItem {
  origin_product_no: number;
  name: string;
  store_name: string;
  old_price: number;
  new_price: number;
  master_price: number;
  ok: number;
  error_msg: string | null;
}

export async function fetchZeroMarginLogs(limit = 20): Promise<ZeroMarginLog[]> {
  const { data } = await api.get<ZeroMarginLog[]>('/zero-margin/logs/', { params: { limit } });
  return data;
}

export async function fetchZeroMarginLogDetail(id: number): Promise<{ items: ZeroMarginLogItem[] }> {
  const { data } = await api.get<{ items: ZeroMarginLogItem[] }>(`/zero-margin/logs/${id}/`);
  return data;
}

// ── 상품 편집 ──

export interface ProductFullDetail {
  origin_product_no: number;
  store_id: number;
  store_name: string;
  name: string;
  status_type: string;
  sale_type: string;
  sale_price: number;
  stock_quantity: number;
  leaf_category_id: string;
  detail_content: string;
  representative_image: { url?: string } | null;
  optional_images: { url?: string }[];
  origin_area: { originAreaCode?: string; content?: string };
  after_service: { tel?: string; guide?: string };
  delivery_info: Record<string, any>;
  seller_tags: { text?: string }[];
  tax_type: string;
  option_info: Record<string, any>;
  product_info_notice: Record<string, any>;
}

export async function fetchProductFullDetail(
  opno: number, storeId: number,
): Promise<ProductFullDetail> {
  const { data } = await api.get<ProductFullDetail>(`/${opno}/detail/`, {
    params: { store_id: storeId },
  });
  return data;
}

export async function updateProduct(
  opno: number, storeId: number, updates: Record<string, any>,
): Promise<{ ok: boolean; origin_product_no: number }> {
  const { data } = await api.put(`/${opno}/update/`, { store_id: storeId, updates });
  return data;
}

export async function uploadProductImage(
  storeId: number, imageFile: File, onProgress?: (pct: number) => void,
): Promise<{ url: string }> {
  const form = new FormData();
  form.append('store_id', String(storeId));
  form.append('image', imageFile);
  const { data } = await api.post<{ url: string }>('/upload-image/', form, {
    timeout: 60000,
    onUploadProgress: (e) => {
      if (onProgress && e.total && e.total > 0)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

// ─── 오너클랜 이탈 SALE 박제(고아 품절) ───
export interface OrphanSoldoutProduct {
  id: number;
  store_id: number;
  store_name: string;
  origin_product_no: number;
  channel_product_no: number;
  seller_management_code: string;
  name: string;
  sale_price: number;
  stock_quantity: number;
  registered_at: string | null;
  last_modified_at: string | null;
}
export interface OrphanSoldoutResult {
  count: number;
  by_store: { store_id: number; store_name: string; count: number }[];
  products: OrphanSoldoutProduct[];
}
export async function fetchOrphanSoldout(storeId = 0): Promise<OrphanSoldoutResult> {
  const { data } = await api.get<OrphanSoldoutResult>('/orphan-soldout/', { params: { store_id: storeId } });
  return data;
}

// ─── 전체동기화(리콘실) ───
export interface ReconcileStoreResult {
  store_id: number;
  name: string;
  status: string;          // ok | preview | ratio_block | api_error | empty_skip
  live: number;
  db_before: number;
  to_delete: number;
  to_add: number;
  deleted: number;
  upserted: number | null;
  db_after: number;
  matched: boolean;
  del_ratio?: number;
  error?: string;
  sync_error?: string;
}
export interface ReconcileStatus {
  running: boolean;
  phase: 'idle' | 'running' | 'done' | 'error';
  total: number;
  done: number;
  started_at: string | null;
  finished_at: string | null;
  apply: boolean;
  results: ReconcileStoreResult[];
  error: string | null;
  summary: {
    stores: number;
    total_deleted: number;
    total_upserted: number;
    matched: number;
    blocked: number[];
    errors: number[];
    db_total: number;
  };
}
export async function startReconcile(opts?: { apply?: boolean; force?: boolean; max_delete_ratio?: number }): Promise<{ ok: boolean; started?: boolean; error?: string }> {
  const { data } = await api.post('/reconcile/', opts || {});
  return data;
}
export async function fetchReconcileStatus(): Promise<ReconcileStatus> {
  const { data } = await api.get<ReconcileStatus>('/reconcile/');
  return data;
}
