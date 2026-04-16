import axios from 'axios';

const api = axios.create({ baseURL: '/api/ownerclan/products' });

export interface OwnerClanProductItem {
  id: number;
  product_code: string;
  product_name: string;
  orig_product_name: string;
  market_product_name: string;
  orig_market_product_name: string;
  ownerclan_price: number;
  orig_ownerclan_price: number;
  market_price: number;
  orig_market_price: number;
  shipping_fee: number;
  orig_shipping_fee: number;
  return_fee: number;
  orig_return_fee: number;
  image_large: string;
  orig_image_large: string;
  image_small: string;
  sale_status: number;
  is_synced: number;
  category_name: string;
  manufacturer: string;
  origin: string;
  uploaded_at: string | null;
  synced_at: string | null;
  created_at: string;
}

export interface ProductListResponse {
  items: OwnerClanProductItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ProductDetail {
  id: number;
  product_code: string;
  sale_status: number;
  is_synced: number;
  synced_at: string | null;
  uploaded_at: string | null;
  changed_fields: string[];
  [key: string]: unknown;
}

export interface ProductStats {
  total: number;
  selling: number;
  soldout: number;
  discontinued: number;
  changed: number;
}

export interface UploadTaskStart {
  task_id: number;
  status: string;
}

export interface UploadTaskStatus {
  task_id: number;
  status: string;
  result_data: {
    progress?: number;
    inserted?: number;
    updated?: number;
    skipped?: number;
    total_rows?: number;
    total?: number;
    suspended_count?: number;
    error?: string;
  };
}

export async function fetchProducts(
  page = 1,
  perPage = 50,
  saleStatus?: number,
  isSynced?: number,
  search?: string,
  changedField?: string,
): Promise<ProductListResponse> {
  const params: Record<string, string | number> = { page, per_page: perPage };
  if (saleStatus !== undefined) params.sale_status = saleStatus;
  if (isSynced !== undefined) params.is_synced = isSynced;
  if (search) params.search = search;
  if (changedField) params.changed_field = changedField;
  const { data } = await api.get<ProductListResponse>('/', { params });
  return data;
}

export async function fetchProductDetail(id: number): Promise<ProductDetail> {
  const { data } = await api.get<ProductDetail>(`/${id}/`);
  return data;
}

export async function fetchStats(): Promise<ProductStats> {
  const { data } = await api.get<ProductStats>('/stats/');
  return data;
}

export async function uploadExcel(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadTaskStart> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<UploadTaskStart>('/upload/', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total && e.total > 0)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

export async function fetchUploadTask(taskId: number): Promise<UploadTaskStatus> {
  const { data } = await api.get<UploadTaskStatus>('/upload/', { params: { task_id: taskId } });
  return data;
}

export async function uploadCsv(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ updated: number }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<{ updated: number }>('/csv-upload/', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total && e.total > 0)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

export async function uploadSoldoutTxt(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ total_codes: number; ownerclan_matched: number; ownerclan_updated: number; smartstore_updated: number }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/soldout-txt/', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
    onUploadProgress: (e) => {
      if (onProgress && e.total && e.total > 0)
        onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

export async function activateSuspended(taskId: number): Promise<{ activated: number }> {
  const { data } = await api.post<{ activated: number }>('/activate/', { task_id: taskId });
  return data;
}

export async function syncProducts(productIds?: number[]): Promise<{ synced: number }> {
  const { data } = await api.post<{ synced: number }>('/sync/', {
    product_ids: productIds || null,
  });
  return data;
}

export async function fetchChangedFieldCounts(): Promise<Record<string, number>> {
  const { data } = await api.get<Record<string, number>>('/changed-fields/');
  return data;
}

interface ExportParams {
  saleStatus?: number;
  isSynced?: number;
  search?: string;
  changedField?: string;
}

function _buildExportParams(p: ExportParams): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (p.saleStatus !== undefined) params.sale_status = p.saleStatus;
  if (p.isSynced !== undefined) params.is_synced = p.isSynced;
  if (p.search) params.search = p.search;
  if (p.changedField) params.changed_field = p.changedField;
  return params;
}

export async function downloadProductExcel(
  p: ExportParams,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const resp = await api.get('/excel/', {
    params: _buildExportParams(p),
    responseType: 'blob',
    onDownloadProgress: (e) => {
      if (onProgress) {
        if (e.total && e.total > 0) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        } else {
          onProgress(-1);
        }
      }
    },
  });
  const url = window.URL.createObjectURL(new Blob([resp.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ownerclan_products.xlsx';
  a.click();
  window.URL.revokeObjectURL(url);
}

export async function downloadSampleExcel(): Promise<void> {
  const resp = await api.get('/sample-excel/', { responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([resp.data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ownerclan_upload_sample.xlsx';
  a.click();
  window.URL.revokeObjectURL(url);
}

export async function fetchWCodes(
  p: ExportParams,
  onProgress?: (pct: number) => void,
): Promise<string[]> {
  const { data } = await api.get<{ codes: string[]; count: number }>('/wcodes/', {
    params: _buildExportParams(p),
    onDownloadProgress: (e) => {
      if (onProgress) {
        if (e.total && e.total > 0) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        } else {
          onProgress(-1);
        }
      }
    },
  });
  return data.codes;
}
