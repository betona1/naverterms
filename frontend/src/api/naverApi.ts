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

// ── 결과보기 (최근업데이트순 + 탭별 수집상태 + 즐겨찾기) ──
export interface ResultKeyword {
  id: number;
  keyword: string;
  is_favorite: boolean;
  last_searched_at: string | null;
  created_at: string;
  total_count: number;
  term_count: number;
  terms: string[];
  collected: Record<string, { count: number; total: number; collected_at: string }>;
  has_data: boolean;
}
export async function getResultsKeywords(): Promise<{ keywords: ResultKeyword[] }> {
  const { data } = await api.get('/results/keywords/');
  return data;
}
export async function toggleFavorite(id: number, value?: boolean) {
  const body = value == null ? {} : { is_favorite: value };
  const { data } = await api.patch(`/keywords/${id}/favorite/`, body);
  return data as { id: number; is_favorite: boolean };
}

// ── 수집 로그 ──
export interface CrawlLogEntry {
  id: number;
  timestamp: string;
  type: string;
  message: string;
  keyword: string;
  session_id: string;
}
export async function getCrawlLogs(params: { limit?: number; since_id?: number } = {}): Promise<{ logs: CrawlLogEntry[] }> {
  const { data } = await api.get('/crawl-logs/', { params });
  return data;
}
export async function postCrawlLog(entry: { type?: string; message: string; keyword?: string; session_id?: string }) {
  const { data } = await api.post('/crawl-logs/', entry);
  return data;
}
export async function clearCrawlLogs() {
  await api.delete('/crawl-logs/');
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
export async function ucStart(keywords: string[], headless = true, tabOrder?: string[]) {
  const { data } = await api.post('/uc/start/', { keywords, headless, tab_order: tabOrder });
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
export interface CategorySearchHit {
  cid: string;
  name: string;
  path: string;          // '대 > 중 > 소 > 세'
  depth: number;
  chain: { cid: string; name: string }[];
}

/** 카테고리 전 단계에서 키워드로 검색. chain 으로 대>중>소>세를 한 번에 채울 수 있다. */
export async function searchDatalabCategories(q: string, limit = 200): Promise<CategorySearchHit[]> {
  const { data } = await api.get('/datalab/category-search/', { params: { q, limit } });
  return Array.isArray(data) ? data : [];
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

// ── 동의어 (키워드별) ──
export interface NaverSynonym {
  id: number;
  keyword: number;
  keyword_text: string;
  word: string;
  source: 'naver_dict' | 'autocomplete' | 'manual';
  is_confirmed: boolean | null;
  verification_score: number | null;
  verification_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface SynonymVerification {
  verdict: 'likely_synonym' | 'maybe_synonym' | 'unlikely_synonym' | 'no_data' | 'same_word';
  score: number;
  cat_score?: number;
  product_overlap?: number;
  top_cat_match?: boolean;
  big_cat_match?: boolean;
  top_cat_keyword?: string;
  top_cat_candidate?: string;
  top_categories_keyword?: [string, number][];
  top_categories_candidate?: [string, number][];
  total1?: number;
  total2?: number;
  sample_count?: number;
  details?: string;
  error?: string;
}
export async function getSynonyms(keywordId: number): Promise<NaverSynonym[]> {
  const { data } = await api.get(`/synonyms/${keywordId}/`);
  return data;
}
export async function addSynonym(keywordId: number, payload: { word: string; is_confirmed?: boolean | null; source?: string }): Promise<NaverSynonym> {
  const { data } = await api.post(`/synonyms/${keywordId}/`, payload);
  return data;
}
export async function lookupSynonyms(keywordId: number, includeAutocomplete = true): Promise<{ added: number; candidates_count: number; autocomplete_count: number; synonyms: NaverSynonym[] }> {
  const { data } = await api.post(`/synonyms/${keywordId}/lookup/`, { include_autocomplete: includeAutocomplete });
  return data;
}
export async function verifySynonym(keywordId: number, payload: { word?: string; synonym_id?: number }): Promise<NaverSynonym & { verification: SynonymVerification }> {
  const { data } = await api.post(`/synonyms/${keywordId}/verify/`, payload);
  return data;
}
export async function patchSynonym(synonymId: number, body: { is_confirmed: boolean | null }): Promise<NaverSynonym> {
  const { data } = await api.patch(`/synonyms/item/${synonymId}/`, body);
  return data;
}
export async function deleteSynonym(synonymId: number): Promise<void> {
  await api.delete(`/synonyms/item/${synonymId}/`);
}

// ── 자동완성 (마켓별) ──
export type AutocompleteMarket = 'naver' | 'coupang';
export interface AutocompleteResult {
  query: string;
  results: Record<string, { keywords: string[]; error: string | null }>;
}
export async function fetchAutocomplete(query: string, markets: AutocompleteMarket[]): Promise<AutocompleteResult> {
  const { data } = await api.post('/autocomplete/', { query, markets });
  return data;
}

// ── 엑셀 다운로드 ──
export function downloadTermsExcel() {
  window.open('/api/naver/export/terms/', '_blank');
}
export function downloadRankExcel(days = 30) {
  window.open(`/api/naver/export/rank/?days=${days}`, '_blank');
}

// ── 구매수추적 ──
export async function getPurchaseTargets() {
  const { data } = await api.get('/purchase/targets/');
  return data;
}
export async function addPurchaseTarget(payload: {
  nv_mid: string; product_name: string; store_name?: string;
  image_url?: string; category?: string;
  source_keyword?: string; source_rank?: number;
}) {
  const { data } = await api.post('/purchase/targets/', payload);
  return data;
}
export async function deletePurchaseTarget(id: number) {
  await api.delete(`/purchase/targets/${id}/`);
}
export async function updatePurchaseTarget(id: number, payload: Record<string, unknown>) {
  const { data } = await api.put(`/purchase/targets/${id}/`, payload);
  return data;
}
export async function runPurchaseTracking(targetIds?: number[]) {
  const { data } = await api.post('/purchase/track/', { target_ids: targetIds || null, headless: true });
  return data;
}
export async function getPurchaseTrackStatus(logSince = 0) {
  const { data } = await api.get('/purchase/status/', { params: { logSince } });
  return data;
}
export async function stopPurchaseTracking() {
  const { data } = await api.post('/purchase/stop/');
  return data;
}
export async function getPurchaseSummary() {
  const { data } = await api.get('/purchase/summary/');
  return data;
}
export async function getPurchaseHistory(targetId?: number, days = 30) {
  const { data } = await api.get('/purchase/history/', { params: { target_id: targetId, days } });
  return data;
}
export async function togglePurchaseAutoTrack(targetId: number, enabled: boolean, time?: string) {
  const { data } = await api.post('/purchase/toggle-auto/', { target_id: targetId, enabled, time });
  return data;
}
