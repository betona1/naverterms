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

// ── 엑셀 다운로드 ──
export function downloadTermsExcel() {
  window.open('/api/naver/export/terms/', '_blank');
}
export function downloadRankExcel(days = 30) {
  window.open(`/api/naver/export/rank/?days=${days}`, '_blank');
}
