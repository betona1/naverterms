import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/products' });

export interface SmartStoreProduct {
  id: number;
  store_id: number;
  origin_product_no: number;
  channel_product_no: number | null;
  name: string;
  sale_price: number;
  stock_quantity: number;
  status_type: string | null;
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
  onProgress?: (pct: number) => void,
): Promise<void> {
  const qs = _buildParams(params);
  const { data, headers } = await api.get(`/excel/?${qs}`, {
    responseType: 'blob',
    onDownloadProgress: (e) => {
      if (onProgress && e.total && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      } else if (onProgress && e.loaded) {
        onProgress(-1);
      }
    },
  });

  const cd = headers['content-disposition'] || '';
  const match = cd.match(/filename\*?=(?:UTF-8'')?(.+)/i);
  const filename = match ? decodeURIComponent(match[1]) : '스마트스토어_상품목록.xlsx';

  const url = URL.createObjectURL(data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
