import axios from 'axios';

const api = axios.create({ baseURL: '/api/competitor' });

export interface CompetitorSnapshot {
  id: number;
  price: number | null;
  review_count: number | null;
  total_stock: number | null;
  options: { name: string; stock: number }[];
  rank_position: number | null;
  purchase_count: number | null;
  recent_purchase_count: number | null;
  estimated_sales: number;
  naver_product_id: string;
  crawled_at: string;
}

export interface CompetitorProduct {
  id: number;
  url: string;
  product_no: string;
  store_alias: string;
  product_name: string;
  track_keyword: string;
  is_active: boolean;
  created_at: string;
  last_crawled_at: string | null;
  latest_snapshot: CompetitorSnapshot | null;
}

export const competitorApi = {
  list: () => api.get<CompetitorProduct[]>('/products/'),
  add: (url: string, track_keyword: string) => api.post<CompetitorProduct>('/products/', { url, track_keyword }),
  remove: (id: number) => api.delete(`/products/${id}/`),
  update: (id: number, data: { track_keyword?: string; product_name?: string }) =>
    api.patch<CompetitorProduct>(`/products/${id}/`, data),
  crawlOne: (product_id: number) => api.post('/crawl/', { product_id }),
  crawlAll: () => api.post('/crawl/'),
  crawlStatus: () => api.get('/crawl/status/'),
  snapshots: (id: number, days = 30) => api.get<CompetitorSnapshot[]>(`/snapshots/${id}/?days=${days}`),
  exportExcel: (product_id?: number) => {
    const params = product_id ? `?product_id=${product_id}` : '';
    window.open(`/api/competitor/export/${params}`, '_blank');
  },
};
