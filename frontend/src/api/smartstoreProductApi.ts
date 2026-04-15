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
): Promise<ProductListResponse> {
  const params: Record<string, string | number> = { store_id: storeId, page, per_page: perPage };
  if (status) params.status = status;
  if (search) params.search = search;
  if (ownerclanSoldout !== undefined) params.ownerclan_soldout = ownerclanSoldout;
  const { data } = await api.get<ProductListResponse>('/', { params });
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

function _buildParams(params: { storeIds?: number[]; statuses?: string[]; wOnly?: boolean }): string {
  const sp = new URLSearchParams();
  if (params.storeIds) params.storeIds.forEach(id => sp.append('store_ids', String(id)));
  if (params.statuses) params.statuses.forEach(s => sp.append('statuses', s));
  if (params.wOnly) sp.append('w_only', '1');
  return sp.toString();
}

export async function downloadProductExcel(
  params: { storeIds?: number[]; statuses?: string[]; wOnly?: boolean },
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
