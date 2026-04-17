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

// ── 엑셀 다운로드 ──
export function downloadTermsExcel() {
  window.open('/api/naver/export/terms/', '_blank');
}
export function downloadRankExcel(days = 30) {
  window.open(`/api/naver/export/rank/?days=${days}`, '_blank');
}
