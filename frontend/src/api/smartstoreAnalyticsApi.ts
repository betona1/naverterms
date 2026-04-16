import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/analytics' });

// ── Types ──

export interface MiniCategory {
  name: string;
  amount: number;
}

export interface BusinessSummary {
  code: string;
  name: string;
  store_ids: number[];
  store_names: string[];
  total_revenue: number;
  total_orders: number;
  total_profit: number;
  total_products: number;
  sold_products: number;
  recent_sold_products: number;
  top_categories: MiniCategory[];
}

export interface StoreOverviewItem {
  id: number;
  store_name: string;
  memo: string;
  revenue: number;
  orders: number;
  profit: number;
  total_products: number;
  sold_products: number;
  recent_sold_products: number;
  top_categories: MiniCategory[];
}

export interface OverviewData {
  totals: {
    total_revenue: number;
    total_orders: number;
    total_cost: number;
    total_profit: number;
    total_products: number;
    sold_products: number;
  };
  businesses: BusinessSummary[];
  all_stores: StoreOverviewItem[];
  top_products: TopProductRow[];
}

export interface StoreSummaryDetail {
  id: number;
  store_name: string;
  memo: string;
  revenue: number;
  orders: number;
  profit: number;
}

export interface TrendRow {
  period: string;
  order_count: number;
  qty: number;
  revenue: number;
  settle: number;
  cost: number;
  profit: number;
}

export interface CategoryNode {
  id: string;
  name: string;
  product_count: number;
  sold_count: number;
  total_qty: number;
  total_amount: number;
  children?: CategoryNode[];
}

export interface TopProductRow {
  product_name: string;
  seller_code: string;
  qty: number;
  revenue: number;
  cost: number;
  profit: number;
  order_count: number;
  channel_product_no?: string | null;
  product_url?: string | null;
  status?: string | null;
  status_type?: string | null;
  store_name?: string | null;
}

export interface StoreDetailData {
  store: { id: number; store_name: string; memo: string };
  summary: {
    revenue: number;
    orders: number;
    profit: number;
    products: number;
    sold_products: number;
  };
  trend: TrendRow[];
  top_products: TopProductRow[];
  categories: CategoryNode[];
}

export interface BusinessDetailData {
  code: string;
  name: string;
  stores: StoreSummaryDetail[];
  trend: TrendRow[];
  top_products: TopProductRow[];
  categories: CategoryNode[];
}

// ── API Functions ──

export async function fetchOverview(
  startDate?: string, endDate?: string,
): Promise<OverviewData> {
  const params: Record<string, string> = {};
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const { data } = await api.get<OverviewData>('/overview/', { params });
  return data;
}

export async function fetchStoreDetail(
  storeId: number, startDate?: string, endDate?: string, period?: string,
): Promise<StoreDetailData> {
  const params: Record<string, string> = {};
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  if (period) params.period = period;
  const { data } = await api.get<StoreDetailData>(`/store/${storeId}/`, { params });
  return data;
}

export async function fetchBusinessDetail(
  code: string, startDate?: string, endDate?: string, period?: string,
): Promise<BusinessDetailData> {
  const params: Record<string, string> = {};
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  if (period) params.period = period;
  const { data } = await api.get<BusinessDetailData>(`/business/${code}/`, { params });
  return data;
}

export async function syncCategories(): Promise<{ synced: number; errors: number; total: number }> {
  const { data } = await api.post('/sync-categories/');
  return data;
}

// ── 상품등록한도 ──

export interface RegistrationLimitStore {
  store_id: number;
  store_name: string;
  transaction_amount: number;
  order_count: number;
  recent_sold_products: number;
  total_products: number;
  sales_ratio: number;
  current_limit: number;
  next_limit: number | null;
  needed_amount: number | null;
  needed_orders: number | null;
  period_label: string;
}

export interface RegistrationLimitTier {
  amount: number;
  orders: number;
  ratio: number;
  limit: number;
}

export interface RegistrationLimitData {
  stores: RegistrationLimitStore[];
  tiers: RegistrationLimitTier[];
  period_label: string;
  calculated_at: string;
}

export async function fetchRegistrationLimits(): Promise<RegistrationLimitData> {
  const { data } = await api.get<RegistrationLimitData>('/registration-limits/');
  return data;
}
