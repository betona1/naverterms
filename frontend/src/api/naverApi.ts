import axios from 'axios';

const api = axios.create({ baseURL: '/api/naver' });

// ── 키워드 ──
export async function getKeywords() {
  const { data } = await api.get('/keywords/');
  return data;
}
export async function addKeyword(keyword: string) {
  const { data } = await api.post('/keywords/', { keyword });
  return data;
}
export async function deleteKeyword(id: number) {
  await api.delete(`/keywords/${id}/`);
}

// ── 분석 ──
export async function getAnalysis(keywordId: number) {
  const { data } = await api.get(`/analysis/${keywordId}/`);
  return data;
}
export async function runAnalysis(keywordId: number) {
  const { data } = await api.post(`/analysis/${keywordId}/`);
  return data;
}

// ── 상품 ──
export async function getProducts(keywordId: number, tab = 'total') {
  const { data } = await api.get(`/products/${keywordId}/`, { params: { tab } });
  return data;
}

// ── 태그 ──
export async function getTagStats(keywordId: number) {
  const { data } = await api.get(`/tags/${keywordId}/`);
  return data;
}

// ── 순위추적 대상 ──
export async function getRankTargets() {
  const { data } = await api.get('/rank/targets/');
  return data;
}
export async function addRankTarget(payload: {
  keyword: string; target_type: string; target_value: string; display_name?: string;
  source_product_id?: number; source_product_name?: string;
}) {
  const { data } = await api.post('/rank/targets/', payload);
  return data;
}
export async function deleteRankTarget(id: number) {
  await api.delete(`/rank/targets/${id}/`);
}

// ── 순위추적 실행 (서버 API) ──
export async function runRankTracking(targetIds?: number[]) {
  const { data } = await api.post('/rank/track/', { target_ids: targetIds || null });
  return data;
}

// ── 순위 이력 ──
export async function getRankHistory(targetId?: number, days = 30) {
  const { data } = await api.get('/rank/history/', { params: { target_id: targetId, days } });
  return data;
}
export async function getRankSummary() {
  const { data } = await api.get('/rank/summary/');
  return data;
}

// ── 순위추적 그룹/피벗/자동 ──
export interface RankGroupKeyword {
  target_id: number;
  keyword: string;
  keyword_id: number;
  current_rank: number | null;
  previous_rank: number | null;
  change: number | null;
  tracked_at: string | null;
}
export interface RankGroup {
  group_key: string;
  target_type: string;
  target_value: string;
  display_name: string;
  matched_product_id: string;
  source_product_id: number | null;
  source_product_name: string;
  auto_track: boolean;
  auto_track_times: string[];
  keyword_count: number;
  keywords: RankGroupKeyword[];
}
export async function getRankGroupedSummary(): Promise<RankGroup[]> {
  const { data } = await api.get('/rank/summary-grouped/');
  return data;
}
export interface RankPivotData {
  keywords: string[];
  dates: string[];
  data: Record<string, Record<string, number | null>>;
}
export async function getRankPivot(groupKey: string, days = 30): Promise<RankPivotData> {
  const { data } = await api.get('/rank/pivot/', { params: { group_key: groupKey, days } });
  return data;
}
export async function getTrackedProductIds(): Promise<number[]> {
  const { data } = await api.get('/rank/tracked-products/');
  return data;
}
export async function toggleRankAutoTrack(groupKey: string, enabled: boolean, times?: string[]) {
  const payload: any = { group_key: groupKey, enabled };
  if (times !== undefined) payload.times = times;
  const { data } = await api.post('/rank/toggle-auto/', payload);
  return data;
}

// ── 스케줄 ──
export async function getSchedules() {
  const { data } = await api.get('/schedules/');
  return data;
}
export async function addSchedule(payload: any) {
  const { data } = await api.post('/schedules/', payload);
  return data;
}
export async function updateSchedule(id: number, payload: any) {
  const { data } = await api.put(`/schedules/${id}/`, payload);
  return data;
}
export async function deleteSchedule(id: number) {
  await api.delete(`/schedules/${id}/`);
}

// ── UC 크롤러 ──
export async function ucStart(keywords: string[], headless = true) {
  const { data } = await api.post('/uc/start/', { keywords, headless });
  return data;
}
export async function ucStatus(logSince = 0) {
  const { data } = await api.get('/uc/status/', { params: { logSince } });
  return data;
}
export async function ucStop() {
  const { data } = await api.post('/uc/stop/');
  return data;
}

// ── 스마트 수집/분석 ──
export interface SmartCollectResult {
  keyword: string;
  tab?: string;
  count?: number;
  total?: number;
  keyword_id?: number;
  has_terms?: boolean;
  error?: string;
}
export interface SmartCollectResponse {
  method_used: 'http' | 'api';
  terms_source?: string;
  products_source?: string;
  results: SmartCollectResult[];
  blocked: boolean;
  logs?: any[];
  api_results?: SmartCollectResult[];
}
export async function smartCollect(
  keywords: string[],
  method: 'auto' | 'http' | 'api' = 'auto',
  tabs?: string[],
): Promise<SmartCollectResponse> {
  const payload: any = { keywords, method };
  if (tabs) payload.tabs = tabs;
  const { data } = await api.post('/collect/', payload);
  return data;
}
export async function smartAnalysis(
  keywordId: number,
  method: 'auto' | 'api' = 'auto',
) {
  const { data } = await api.post(`/smart-analysis/${keywordId}/`, { method });
  return data;
}

// ── 연관키워드 ──
export async function getRelatedKeywords(keyword: string) {
  const { data } = await api.get('/related-keywords/', { params: { keyword } });
  return data;
}

// ── 카테고리키워드 (데이터랩) ──
export interface DatalabCategory {
  cid: string;
  pid: string;
  name: string;
}
export interface CategoryKeywordRank {
  rank: number;
  keyword: string;
  linkId: string;
}
export interface EnrichData {
  monthlyPcQcCnt?: number;
  monthlyMobileQcCnt?: number;
  compIdx?: string;
  productCount?: number;
  category?: string;
}
export async function getDatalabCategories(parentCid = '0'): Promise<DatalabCategory[]> {
  const { data } = await api.get('/datalab/categories/', { params: { cid: parentCid } });
  return data;
}
export async function getCategoryKeywordRank(params: {
  cid: string; startDate: string; endDate: string;
  age?: string; gender?: string; device?: string;
}): Promise<{ ranks: CategoryKeywordRank[]; cached?: boolean; cached_at?: string }> {
  const { data } = await api.get('/datalab/category-keywords/', { params });
  return data;
}
export async function enrichKeywords(keywords: string[]): Promise<{ data: Record<string, EnrichData> }> {
  const { data } = await api.post('/datalab/enrich-keywords/', { keywords });
  return data;
}

// ── 키워드 자동매칭 ──
export async function autoMatchKeywords(productName: string, keywords: string[]): Promise<{ matches: string[] }> {
  const { data } = await api.post('/datalab/auto-match/', { product_name: productName, keywords });
  return data;
}

// ── 카테고리 이름 조회 ──
export async function getCategoryNames(cids: string[]): Promise<Record<string, string>> {
  const { data } = await api.get('/datalab/category-names/', { params: { cids: cids.join(',') } });
  return data;
}

// ── 구매키워드 ──
export interface BuyKeywordItem {
  naver_product_name: string;
  keyword: string;
  channel_name: string;
  channel_group: string;
  order_count: number;
  order_amount: number;
  naver_shop_name: string;
  uploaded_at: string;
}
export async function getBuyKeywords(productCode: string): Promise<{ success: boolean; results: BuyKeywordItem[] }> {
  const { data } = await api.get(`/buy-keywords/${productCode}/`);
  return data;
}

// ── 보고서 ──
export interface Report {
  id: number;
  title: string;
  report_type: string;
  created_at: string;
  content?: string;
}
export async function getReports(): Promise<Report[]> {
  const { data } = await api.get('/reports/');
  return data;
}
export async function getReport(id: number): Promise<Report> {
  const { data } = await api.get(`/reports/${id}/`);
  return data;
}
export async function createReport(payload: { title: string; content: string; report_type?: string }): Promise<Report> {
  const { data } = await api.post('/reports/', payload);
  return data;
}
export async function deleteReport(id: number): Promise<void> {
  await api.delete(`/reports/${id}/`);
}
export function downloadReport(id: number) {
  window.open(`/api/naver/reports/${id}/download/`, '_blank');
}

// ── 순위컨닝 ──
export async function getRankCunningProducts() {
  const { data } = await api.get('/rank-cunning/');
  return data;
}
export async function addRankCunningProducts(products: any[]) {
  const { data } = await api.post('/rank-cunning/', { products });
  return data;
}
export async function deleteRankCunningProduct(id: number) {
  await api.delete(`/rank-cunning/${id}/`);
}

// ── 엑셀 다운로드 ──
export function downloadTermsExcel() {
  window.open('/api/naver/export/terms/', '_blank');
}
export function downloadRankExcel(days = 30) {
  window.open(`/api/naver/export/rank/?days=${days}`, '_blank');
}
