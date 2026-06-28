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
  login_id: string | null;        // 원본 로그인 아이디
  business_name: string | null;   // 원본 사업자명
  transaction_amount: number;
  order_count: number;
  recent_sold_products: number;
  total_products: number;
  sales_ratio: number;
  current_limit: number;
  limit_source: 'api' | 'estimate';
  next_limit: number | null;
  needed_amount: number | null;
  needed_orders: number | null;
  period_label: string;
  // 네이버 내부 API 실제값 (limit_source==='api' 일 때 유효)
  applied_ymd: string | null;
  api_sale_amount: number | null;        // 거래액(최근 3개월)
  api_sale_count: number | null;         // 판매 건수(최근 3개월)
  api_monthly_ratio: number | null;      // 판매상품비중(이번달) %
  api_daily_ratio: number | null;        // 판매상품비중(전일) %
  api_90d_avg: number | null;            // 평균 등록 상품수(90일)
  api_sale_product_count: number | null; // 판매 상품수(13개월)
  ratio_ok: boolean;                     // 비중 >= 3% 충족 여부
  reg_target_3pct: number | null;        // 3% 도달 목표 평균등록수
  reg_reduce_avg: number | null;         // 90일평균 기준 줄여야 할 양
  reg_current_ok: boolean;               // 현재 등록수가 이미 목표 이하
  // 90일 평균 추세 → 3% 도달 예상시점
  trend_points: number;                  // 보유 스냅샷 일수
  avg_slope_per_day: number | null;      // 평균등록 일별 변화량
  eta_days: number | null;               // 3% 도달까지 예상 일수
  eta_date: string | null;               // 예상 도달 날짜
  eta_status: 'met' | 'projected' | 'collecting' | 'need_reduce' | 'no_decline';
  captured_date: string | null;
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

// ── 상품등록한도 실측 수집 (네이버 내부 API) ──

export interface PolicyCollectStatus {
  running: boolean;
  phase: string;
  login_idx: number;
  total_logins: number;
  store_idx: number;
  current_login: string | null;
  current_store: string | null;
  logs: string[];
  error: string | null;
}

export async function startPolicyCollect(loginIds?: number[]): Promise<{ ok: boolean; error?: string }> {
  const { data } = await api.post('/policy/collect/', loginIds ? { login_ids: loginIds } : {});
  return data;
}

export async function fetchPolicyStatus(): Promise<PolicyCollectStatus> {
  const { data } = await api.get<PolicyCollectStatus>('/policy/status/');
  return data;
}
