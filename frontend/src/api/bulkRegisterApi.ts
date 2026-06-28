import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface RegisterSet {
  id?: number;
  folder_id?: number;
  name: string;
  // 가격
  margin_rate: number;
  fee_rate: number;
  set_ship_fee: number;
  free_shipping: number;       // 0 | 1
  discount_rate: number;
  review_point_text: number;
  review_point_photo: number;
  // 배송
  delivery_company_code: string;
  delivery_fee_type: string;   // 무료 | 조건부 무료 | 유료 | 수량별 | 구간별
  base_ship_fee: number;
  free_cond_amount: number | null;
  return_fee: number;
  exchange_fee: number;
  // 기타
  default_stock: number;
  vat_type: string;
  product_state: string;
  origin_code: string;
  as_phone: string | null;
  as_guide: string | null;
}

export interface FolderSet {
  folder_id: number;
  store_id: number | null;
  name: string;
  product_count: number;
  has_set: boolean;
  set: RegisterSet | null;
}

export interface PriceCalc {
  cost: number;
  orig_ship_fee: number;
  margin_amount: number;
  fee_amount: number;
  ship_adjust: number;
  review_amount: number;
  target_price: number;   // 고객 실결제가
  list_price: number;     // 등록 판매가(정가)
  discount_amount: number;
  discount_rate: number;
  net_margin: number;
}

export interface PreviewItem {
  product_code: string;
  name: string;
  category_code: string | null;
  cost: number;
  orig_ship_fee: number;
  target_price: number;
  list_price: number;
  discount_amount: number;
  net_margin: number;
  image: string;
  img_upscaled: boolean;
  has_detail: boolean;
  category_ok: boolean;
}

export interface PreviewResult {
  total_confirmed: number;
  file_count: number;
  batch_size: number;
  items: PreviewItem[];
  warnings: string[];
}

export async function fetchRegisterSets(): Promise<{ folders: FolderSet[] }> {
  return (await api.get('/register/sets/')).data;
}

export async function fetchRegisterSet(folderId: number, storeName?: string): Promise<{ set: RegisterSet }> {
  return (await api.get(`/register/sets/${folderId}/`, { params: { store_name: storeName } })).data;
}

export async function saveRegisterSet(folderId: number, set: Partial<RegisterSet>): Promise<{ ok: boolean; set: RegisterSet }> {
  return (await api.put(`/register/sets/${folderId}/`, set)).data;
}

export async function calcPrice(set: Partial<RegisterSet>, cost = 10000, origShipFee = 0): Promise<PriceCalc> {
  return (await api.post('/register/calc/', { set, cost, orig_ship_fee: origShipFee })).data;
}

export async function previewBulk(folderId: number, set: Partial<RegisterSet>, n = 10): Promise<PreviewResult> {
  return (await api.post('/register/preview/', { folder_id: folderId, set, n })).data;
}

export async function generateBulk(folderId: number, storeName: string): Promise<{ blob: Blob; files: number; total: number; filename: string }> {
  const resp = await api.post('/register/generate/', { folder_id: folderId, store_name: storeName }, { responseType: 'blob' });
  const cd = resp.headers['content-disposition'] || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  const filename = m ? decodeURIComponent(m[1]) : `bulk_${folderId}.zip`;
  return {
    blob: resp.data,
    files: Number(resp.headers['x-meta-files'] || 0),
    total: Number(resp.headers['x-meta-total'] || 0),
    filename,
  };
}

// ── 등록 단계 (상태 기반: 등록후보/작업대기) ──────────────────────
export interface RegStore {
  id: number;
  store_id: number | null;
  name: string;
  color: string | null;
  total: number;
  candidate_count: number;
  queue_count: number;
  registered_count: number;
  staged_pending: number;  // 단계(후보/대기) + 미등록 = 새로 등록될 건수
  naver_count: number;     // 현재 네이버에 등록된 상품수 (smartstore_product)
}

export type Stage = 'candidate' | 'queue' | null;

export async function fetchStoreStages(): Promise<{ stores: RegStore[] }> {
  return (await api.get('/register/folder-tree/')).data;
}

export async function setStage(ids: number[], stage: Stage): Promise<{ ok: boolean; updated: number }> {
  return (await api.post('/register/stage/', { ids, stage })).data;
}

export async function selectIds(params: {
  folder_id: number; stage?: string; registered?: string;
  category_code?: string; search?: string; recommend?: string; limit?: number;
}): Promise<{ ids: number[]; count: number; excluded_bad?: number; eligible?: number }> {
  return (await api.get('/register/select-ids/', { params })).data;
}

export async function markRegistered(ids: number[], registered: boolean): Promise<{ ok: boolean; updated: number }> {
  return (await api.post('/register/mark/', { ids, registered })).data;
}

export async function verifyRegistration(storeFolderId: number, sync = false): Promise<{ ok: boolean; queue_count: number; verified: number; missing: number; missing_codes: string[]; synced: boolean; error?: string }> {
  return (await api.post('/register/verify/', { store_folder_id: storeFolderId, sync })).data;
}

export interface SyncInspect {
  ok: boolean;
  synced: boolean;
  queue_count: number;
  counts: { found: number; missing: number; soldout: number; stopped: number; price_diff: number };
  anomalies: { code: string; type: string; detail: string; name: string }[];
  log: string[];
  log_file: string | null;
  error?: string;
}

export async function syncInspect(storeFolderId: number, sync = true): Promise<SyncInspect> {
  return (await api.post('/register/sync-inspect/', { store_folder_id: storeFolderId, sync })).data;
}

export async function generateAllQueueExcel(): Promise<{ blob: Blob; stores: number; files: number; total: number; filename: string }> {
  const resp = await api.post('/register/queue-excel-all/', {}, { responseType: 'blob' });
  const cd = resp.headers['content-disposition'] || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  return {
    blob: resp.data,
    stores: Number(resp.headers['x-meta-stores'] || 0),
    files: Number(resp.headers['x-meta-files'] || 0),
    total: Number(resp.headers['x-meta-total'] || 0),
    filename: m ? decodeURIComponent(m[1]) : 'all_queues.zip',
  };
}

export async function generateQueueExcel(storeFolderId: number, storeName: string): Promise<{ blob: Blob; files: number; total: number; filename: string }> {
  const resp = await api.post('/register/queue-excel/', { store_folder_id: storeFolderId }, { responseType: 'blob' });
  const cd = resp.headers['content-disposition'] || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  return {
    blob: resp.data,
    files: Number(resp.headers['x-meta-files'] || 0),
    total: Number(resp.headers['x-meta-total'] || 0),
    filename: m ? decodeURIComponent(m[1]) : `${storeName || 'queue'}_${storeFolderId}.zip`,
  };
}

export interface FailureAnalysis {
  ok: boolean;
  failed: { code: string; reasons: string[] }[];
  failed_codes: string[];
  failed_count: number;
  reason_summary: { reason: string; count: number }[];
  applied: { queue_pending: number; success_marked: number; failed_kept: number };
}

export async function analyzeFailures(storeFolderId: number, file: File, markSuccess = true): Promise<FailureAnalysis> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('store_folder_id', String(storeFolderId));
  fd.append('mark_success', markSuccess ? '1' : '0');
  return (await api.post('/register/analyze-failures/', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
}

// 상품 목록 (정렬/카테고리/등록완료 필터)
export interface RegProduct {
  id: number;
  product_code: string;
  naver_product_name: string | null;
  category_code: string | null;
  category_name: string | null;
  ownerclan_price: number;
  image_small: string | null;
  image_large: string | null;
  upscaled_image_url: string | null;
  registered: number;
  register_verified: number;
  register_stage: string | null;
}

export async function fetchRegProducts(params: {
  folder_id: number; page?: number; per_page?: number; sort?: string;
  category_code?: string; registered?: string; search?: string; register_stage?: string;
}): Promise<{ items: RegProduct[]; total: number; page: number; total_pages: number }> {
  return (await api.get('/naver-products/', { params })).data;
}

// ── 라이브 상품명 금지어 점검/수정 ──────────────────────────────
export interface LiveNameMatch {
  store_id: number;
  store_name: string;
  origin_product_no: number;
  product_code: string;
  name: string;
  clean_name: string;
  status_type: string;
  banned_hit: string[];
}

export async function scanLiveNames(storeId?: number): Promise<{ matches: LiveNameMatch[]; words: string[]; total: number }> {
  return (await api.get('/live-name/scan/', { params: storeId ? { store_id: storeId } : {} })).data;
}

export async function fixLiveNames(items: { store_id: number; origin_product_no: number; new_name: string }[]): Promise<{ ok: boolean; updated: number; failed: number; results: any[] }> {
  return (await api.post('/live-name/fix/', { items })).data;
}

// ── 불량 상품명 탐지 ──────────────────────────────────────────
export interface BadNameItem {
  id?: number; product_code: string; folder_id?: number; name: string;
  stage?: string | null; reason: string;
  store_id?: number; store_name?: string; origin_product_no?: number;
}
export interface BadNameScan {
  pool?: { total: number; items: BadNameItem[] };
  live?: { total: number; items: BadNameItem[] };
}
export async function scanBadNames(scope: 'pool'|'live'|'both' = 'both', stages = 'queue,candidate'): Promise<BadNameScan> {
  return (await api.get('/bad-name/scan/', { params: { scope, stages } })).data;
}
export async function purgeBadNames(ids: number[]): Promise<{ ok: boolean; purged: number }> {
  return (await api.post('/bad-name/purge/', { ids })).data;
}

// ── 중복 초과분 품절처리 ──────────────────────────────────────
export interface DupGroup {
  store_id: number; store_name: string; product_code: string;
  keep: { origin_product_no: number; name: string; status_type: string; sales: number };
  excess: { origin_product_no: number; name: string; status_type: string; sales: number }[];
}
export async function scanDupSuspend(storeId?: number): Promise<{ groups: DupGroup[]; group_count: number; excess_total: number }> {
  return (await api.get('/dup-suspend/scan/', { params: storeId ? { store_id: storeId } : {} })).data;
}
export async function applyDupSuspend(items?: { store_id: number; origin_product_no: number }[], storeId?: number): Promise<{ ok: boolean; suspended: number; failed: number }> {
  return (await api.post('/dup-suspend/apply/', items ? { items } : (storeId ? { store_id: storeId } : {}))).data;
}

// ── 상품등록정보검토 (진단) ──────────────────────────────────
export interface DiagItem {
  product_name: string; category_text: string; thumbnail: string;
  seller_management_code: string | null;
  brand_value: string | null; brand_missing: number;
  mfr_value: string | null; mfr_missing: number;
  attr_value: string | null; attr_missing: number;
  tag_missing: number;
}
export interface DiagResults {
  items: DiagItem[]; total: number;
  brand_missing: number; mfr_missing: number; attr_missing: number; tag_missing: number;
}
export interface DiagWorker { worker_name: string; status: string; last_log_line: string; }

export async function diagnosisSync(loginIds?: string[], concurrency = 5): Promise<{ ok: boolean; dispatched?: number; error?: string }> {
  return (await api.post('/diagnosis/sync/', { login_ids: loginIds, concurrency })).data;
}
export async function diagnosisStatus(): Promise<{ workers: DiagWorker[]; stores_collected: number; items_total: number }> {
  return (await api.get('/diagnosis/status/')).data;
}
export async function diagnosisResults(storeId: number): Promise<DiagResults> {
  return (await api.get('/diagnosis/results/', { params: { store_id: storeId } })).data;
}

// ── 상품 태그/속성 메타 (My상품·스마트스토어상품 표기용) ──
export interface ProductMeta { tags: string[]; tag_count: number; attr_count: number; tag_registered?: number; }
export async function fetchProductMeta(codes: string[], storeId?: number): Promise<Record<string, ProductMeta>> {
  if (!codes.length) return {};
  const r = await api.get('/product-tag-attr-meta/', { params: { codes: codes.join(','), store_id: storeId } });
  return r.data.meta || {};
}
