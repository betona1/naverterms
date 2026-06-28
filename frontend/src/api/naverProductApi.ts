import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface ProductSalesInfo {
  total_amount: number;
  total_quantity: number;
  order_count: number;
}

export interface NaverProductItem {
  id: number;
  product_code: string;
  source_id: number | null;
  folder_id: number;
  product_name: string | null;
  ai_product_name: string | null;
  ai_recommended_name: string | null;
  edited_product_name: string | null;
  naver_product_name: string | null;
  category_name: string | null;
  brand: string | null;
  manufacturer: string | null;
  origin: string | null;
  ownerclan_price: number;
  market_price: number;
  shipping_fee: number;
  return_fee: number;
  image_small: string | null;
  image_large: string | null;
  edited_image_url: string | null;
  upscaled_image_url: string | null;
  additional_images?: string[] | null;
  sale_status: string | null;
  sync_status: string | null;
  copied_at: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
  sales?: ProductSalesInfo;
}

export interface NaverProductFolder {
  id: number;
  store_id: number | null;
  name: string;
  color: string | null;
  sort_order: number;
  is_system: number;
  queue_position: number | null;
  description: string | null;
  product_count: number;
}

export interface NaverProductListResponse {
  items: NaverProductItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ImportState {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  processed: number;
  inserted: number;
  updated: number;
  error: string | null;
  message: string;
}

export async function fetchNaverProducts(
  page = 1, perPage = 50,
  opts: { folder_id?: number | null; search?: string; sort?: string; include_sales?: boolean } = {},
): Promise<NaverProductListResponse> {
  const params: Record<string, string | number> = { page, per_page: perPage };
  if (opts.folder_id != null) params.folder_id = opts.folder_id;
  if (opts.search) params.search = opts.search;
  if (opts.sort) params.sort = opts.sort;
  if (opts.include_sales) params.include_sales = '1';
  const r = await api.get('/naver-products/', { params });
  return r.data;
}

export async function fetchNaverFolders(): Promise<{ items: NaverProductFolder[] }> {
  const r = await api.get('/naver-products/folders/');
  return r.data;
}

export async function syncNaverFolders(): Promise<{ ok: boolean; stores_total: number; folders_created: number; folders_updated: number }> {
  const r = await api.post('/naver-products/folders/sync/');
  return r.data;
}

export async function startImportFrom11st(batchSize = 1000): Promise<{ ok: boolean; error?: string; state: ImportState }> {
  const r = await api.post('/naver-products/import-from-11st/', { batch_size: batchSize });
  return r.data;
}

export async function fetchImportStatus(): Promise<ImportState> {
  const r = await api.get('/naver-products/import-status/');
  return r.data;
}

export interface GenerateNameResult {
  ok: boolean;
  naver_product_name?: string;
  model?: string;
  elapsed_ms?: number;
  byte_length?: number;
  raw_first_line?: string;
  error?: string;
}

export async function generateNaverName(
  productId: number, useVision = true,  // 모달의 단건 [🤖] 은 비전 ON
): Promise<GenerateNameResult> {
  const r = await api.post(`/naver-products/${productId}/generate-name/`,
    { use_vision: useVision },
    { validateStatus: () => true });
  return r.data;
}

export interface EnqueueResult {
  ok: boolean;
  queued: number;
  requested: number;
  already_queued?: number;
}

export interface QueueWorker {
  endpoint: string;
  running: number;
  done: number;
}

export interface QueueStatus {
  pending: number;
  running: number;
  done_recent: number;
  error: number;
  by_worker: QueueWorker[];
}

export async function enqueueGenerate(opts: {
  ids?: number[];
  folder_id?: number;
  top_sales?: number;
  only_missing?: boolean;
}): Promise<EnqueueResult> {
  const r = await api.post('/naver-products/enqueue/', opts);
  return r.data;
}

export async function fetchQueueStatus(): Promise<QueueStatus> {
  const r = await api.get('/naver-products/queue-status/');
  return r.data;
}

export async function moveNaverProducts(
  ids: number[], folderId: number,
): Promise<{ ok: boolean; moved?: number; folder_id?: number; error?: string }> {
  const r = await api.post('/naver-products/move/', { ids, folder_id: folderId });
  return r.data;
}

export interface VisionAnalysis {
  color?: string[] | null;
  material?: string | null;
  form?: string | null;
  package_qty?: string | null;
  key_features?: string[] | null;
  readable_text?: string | null;
}

export interface NaverProductDetail extends NaverProductItem {
  market_product_name: string | null;
  naver_keywords: string | null;
  keywords: string | null;
  comment: string | null;
  naver_product_name_before: string | null;
  category_code: string | null;
  model_name: string | null;
  consumer_price: number;
  option1_name: string | null;
  option1_values: string | null;
  option2_name: string | null;
  option2_values: string | null;
  combined_option: string | null;
  product_attribute: string | null;
  detail_html: string | null;
  is_modified: number;
  image_medium: string | null;
  image_analysis: VisionAnalysis | null;
  image_analyzed_at: string | null;
}

export async function fetchNaverProductDetail(id: number): Promise<NaverProductDetail> {
  const r = await api.get(`/naver-products/${id}/`);
  return r.data;
}

export async function patchNaverProduct(
  id: number, payload: Partial<NaverProductDetail>,
): Promise<{ ok: boolean; detail?: NaverProductDetail; error?: string }> {
  const r = await api.patch(`/naver-products/${id}/`, payload, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function clearVisionCache(id: number): Promise<{ ok: boolean; error?: string }> {
  const r = await api.post(`/naver-products/${id}/clear-vision/`);
  return r.data;
}

// ─── 썸네일 AI 편집 ─────────────────────────────
// FastAPI 이미지 서비스(port 8902)는 frontend 에서 직접 호출.
// 저장은 Django(8901) 로 image_b64 전송 → MEDIA 저장 + edited_image_url 업데이트.
const imageAi = axios.create({ baseURL: '/image-ai' });  // Vite proxy 로 8902 → /image-ai

export interface ImageOpResult {
  ok: boolean;
  image_b64: string;       // data URL 없이 순수 base64 (WEBP)
  op: string;
  elapsed_ms: number;
  meta: Record<string, unknown>;
}

// imageRef = base64(WEBP) 또는 { url } — 첫 호출은 url, 이후엔 b64
export type ImageRef = { b64?: string; url?: string };

function _refPayload(ref: ImageRef): Record<string, string> {
  if (ref.b64) return { image_b64: ref.b64 };
  if (ref.url) return { image_url: ref.url };
  throw new Error('image ref required');
}

export async function aiBgRemove(ref: ImageRef, model = 'isnet-general-use'): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/bg-remove', { ..._refPayload(ref), model });
  return r.data;
}

export async function aiTextRemove(ref: ImageRef, maskB64?: string): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/text-remove', {
    ..._refPayload(ref),
    params: maskB64 ? { mask_b64: maskB64 } : undefined,
  });
  return r.data;
}

export async function aiUpscale(ref: ImageRef, scale = 2.0, sharpness = 1.5): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/upscale', {
    ..._refPayload(ref), params: { scale, sharpness },
  });
  return r.data;
}

export async function aiRotate(ref: ImageRef, angle: number, expand = false): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/rotate', {
    ..._refPayload(ref), params: { angle, expand },
  });
  return r.data;
}

// 생성형 AI — 자연어 프롬프트로 배경 교체 / 모델 추가 등 (상품 자체는 보존)
export async function aiGeminiEdit(
  ref: ImageRef, prompt: string, model = 'gemini-2.5-flash-image',
): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/gemini-edit', {
    ..._refPayload(ref), prompt, model,
  }, { timeout: 120000 });
  return r.data;
}

export async function aiFlip(ref: ImageRef, direction: 'h' | 'v'): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/flip', {
    ..._refPayload(ref), params: { direction },
  });
  return r.data;
}

// ─── 로컬 보너스 (Pillow + LaMa) ─────────────────
export async function aiAdjust(ref: ImageRef, opts: {
  brightness?: number; contrast?: number; saturation?: number; sharpness?: number;
}): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/adjust', { ..._refPayload(ref), params: opts });
  return r.data;
}

export async function aiFilter(ref: ImageRef, preset: 'grayscale' | 'sepia' | 'cool' | 'warm' | 'vintage' | 'invert' | 'posterize' | 'solarize'): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/filter', { ..._refPayload(ref), params: { preset } });
  return r.data;
}

export async function aiBlur(ref: ImageRef, radius = 0, vignetteStrength = 0): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/blur', { ..._refPayload(ref), params: { radius, vignette: vignetteStrength } });
  return r.data;
}

export async function aiPadSquare(ref: ImageRef, color = '#ffffff', size = 0): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/pad-square', { ..._refPayload(ref), params: { color, size } });
  return r.data;
}

export async function aiFrame(ref: ImageRef, opts: {
  border_px?: number; border_color?: string;
  shadow?: boolean; shadow_blur?: number; shadow_offset?: number;
  rounded?: number;
}): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/frame', { ..._refPayload(ref), params: opts });
  return r.data;
}

export interface OcrResult {
  ok: boolean;
  texts: { box: number[][]; text: string; confidence: number }[];
  all_text: string;
  count: number;
  elapsed_ms: number;
}
export async function aiOcr(ref: ImageRef): Promise<OcrResult> {
  const r = await imageAi.post('/api/v1/ocr', _refPayload(ref));
  return r.data;
}

export async function aiInpaintMask(ref: ImageRef, maskB64: string, dilate = 4): Promise<ImageOpResult> {
  const r = await imageAi.post('/api/v1/inpaint', { ..._refPayload(ref), params: { mask_b64: maskB64, dilate } });
  return r.data;
}

// ─── FLUX (자체호스팅 ComfyUI, 워커 88) ─────────────────
export interface FluxReqBody {
  image_b64?: string;
  image_url?: string;
  prompt?: string;
  mask_b64?: string;
  ref_b64?: string;
  strength?: number;
  guidance?: number;
  steps?: number;
  scale?: number;
  n?: number;
}

export interface FluxResult {
  ok: boolean;
  images_b64: string[];    // 1개 또는 N개
  op: string;
  elapsed_ms: number;
  meta: Record<string, unknown>;
}

function _refToBody(ref: ImageRef): Pick<FluxReqBody, 'image_b64' | 'image_url'> {
  if (ref.b64) return { image_b64: ref.b64 };
  if (ref.url) return { image_url: ref.url };
  throw new Error('image ref required');
}

const FLUX_TIMEOUT = 600000; // 10분 (첫 호출 모델 로드 포함)

export async function fluxFill(ref: ImageRef, prompt: string, opts: { maskB64?: string; guidance?: number; steps?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-fill', {
    ..._refToBody(ref), prompt,
    mask_b64: opts.maskB64, guidance: opts.guidance, steps: opts.steps,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxRedux(ref: ImageRef, opts: { prompt?: string; n?: number; strength?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-redux', {
    ..._refToBody(ref),
    prompt: opts.prompt, n: opts.n || 4, strength: opts.strength,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxKontext(ref: ImageRef, prompt: string, opts: { guidance?: number; steps?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-kontext', {
    ..._refToBody(ref), prompt,
    guidance: opts.guidance, steps: opts.steps,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxCanny(ref: ImageRef, prompt: string, opts: { strength?: number; guidance?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-canny', {
    ..._refToBody(ref), prompt,
    strength: opts.strength, guidance: opts.guidance,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxDepth(ref: ImageRef, prompt: string, opts: { strength?: number; guidance?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-depth', {
    ..._refToBody(ref), prompt,
    strength: opts.strength, guidance: opts.guidance,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxUpscale(ref: ImageRef, scale = 2.0): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-upscale', {
    ..._refToBody(ref), scale,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

export async function fluxIPAdapter(ref: ImageRef, refB64: string, prompt: string, opts: { strength?: number } = {}): Promise<FluxResult> {
  const r = await imageAi.post('/api/v1/flux-ipadapter', {
    ..._refToBody(ref), prompt, ref_b64: refB64,
    strength: opts.strength,
  }, { timeout: FLUX_TIMEOUT });
  return r.data;
}

// ─── 썸네일 변형 풀 (최대 20개) ─────────────────────────
export type ThumbnailSourceType =
  | 'ai_edit' | 'gemini' | 'flux' | 'detail_capture'
  | 'flip_h' | 'flip_v' | 'manual'
  | 'bg_remove' | 'text_remove' | 'upscale' | 'rotate';

export interface ThumbnailVariant {
  id: number;
  product_id: number;
  image_url: string;
  source_type: ThumbnailSourceType;
  source_meta: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  is_active: boolean;
  label: string | null;
  created_at: string;
}

export interface VariantListResponse {
  ok: boolean;
  items: ThumbnailVariant[];
  count: number;
  max: number;
  remaining: number;
}

export async function fetchVariants(productId: number): Promise<VariantListResponse> {
  const r = await api.get(`/naver-products/${productId}/variants/`);
  return r.data;
}

export async function addVariant(
  productId: number,
  imageB64: string,
  source_type: ThumbnailSourceType,
  source_meta?: Record<string, unknown>,
  label?: string,
  activate = true,
): Promise<{ ok: boolean; variant_id?: number; image_url?: string; error?: string; count?: number; max?: number }> {
  const r = await api.post(`/naver-products/${productId}/variants/`, {
    image_b64: imageB64, source_type, source_meta, label, activate,
  }, { validateStatus: () => true });
  return r.data;
}

export async function deleteVariant(productId: number, variantId: number) {
  const r = await api.delete(`/naver-products/${productId}/variants/${variantId}/`, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function activateVariant(productId: number, variantId: number) {
  const r = await api.post(`/naver-products/${productId}/variants/${variantId}/activate/`, undefined, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function patchVariantLabel(productId: number, variantId: number, label: string) {
  const r = await api.patch(`/naver-products/${productId}/variants/${variantId}/`, { label }, {
    validateStatus: () => true,
  });
  return r.data;
}

// ─── 일괄 업스케일 작업 ─────────────────────────────
export interface UpscaleWorker {
  endpoint: string; name: string; gpu_free_mb: number;
  alive: boolean; busy_count: number; concurrency: number;
}

export interface UpscaleStorage {
  host: string; path: string; url_prefix: string;
}

export interface UpscaleJob {
  id: number; folder_id: number | null; scale: number; model_family: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'error';
  total_targets: number; done_count: number; error_count: number;
  bytes_total: number;
  started_at: string | null; finished_at: string | null;
  last_error: string | null; created_at: string;
  storage_host: string; filename_format: string;
}

export interface UpscaleProgress {
  ok: boolean;
  job_id: number; status: string;
  total: number; done: number; error: number;
  pct: number; remaining: number;
  bytes_total: number; bytes_mb: number;
  by_state: Record<string, number>;
  workers: { endpoint: string; done: number; errors: number; avg_ms: number | null; bytes: number; busy: boolean }[];
  rate_per_min: number;
  eta_min: number | null;
  started_at: string | null;
}

export interface UpscaleStorageStats {
  ok: boolean;
  count: number;
  rate_per_min: number;
  window_s: number;
  host: string;
}

export async function fetchUpscaleStorageStats(): Promise<UpscaleStorageStats> {
  const r = await api.get('/upscale/storage-stats/');
  return r.data;
}

export async function fetchUpscaleWorkers(): Promise<{ ok: boolean; workers: UpscaleWorker[]; storage: UpscaleStorage }> {
  const r = await api.get('/upscale/workers/');
  return r.data;
}

export async function fetchUpscaleJobs(limit = 20): Promise<{ ok: boolean; items: UpscaleJob[] }> {
  const r = await api.get('/upscale/jobs/', { params: { limit } });
  return r.data;
}

export async function startUpscaleJob(opts: { folder_id?: number | null; scale?: number; model_family?: string; workers?: string[] }) {
  const r = await api.post('/upscale/jobs/', opts, { validateStatus: () => true });
  return r.data;
}

export async function fetchUpscaleProgress(jobId: number): Promise<UpscaleProgress> {
  const r = await api.get(`/upscale/jobs/${jobId}/progress/`);
  return r.data;
}

export async function controlUpscaleJob(jobId: number, action: 'pause' | 'resume' | 'cancel') {
  const r = await api.post(`/upscale/jobs/${jobId}/${action}/`, undefined, { validateStatus: () => true });
  return r.data;
}

export interface ImageAiHealth {
  ok: boolean;
  device: string;
  loaded: Record<string, unknown>;
  upscale_engine: string;
}

export async function aiHealth(): Promise<ImageAiHealth> {
  const r = await imageAi.get('/api/v1/health');
  return r.data;
}

export async function saveEditedThumbnail(
  productId: number, imageB64: string,
): Promise<{ ok: boolean; edited_image_url?: string; error?: string }> {
  const r = await api.post(`/naver-products/${productId}/edit-thumb/`, { image_b64: imageB64 }, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function resetEditedThumbnail(
  productId: number,
): Promise<{ ok: boolean; deleted_files?: number; error?: string }> {
  const r = await api.delete(`/naver-products/${productId}/edit-thumb/`, {
    validateStatus: () => true,
  });
  return r.data;
}

export interface KeywordVolume {
  pc: number;
  mobile: number;
  total: number;
  comp: string;          // 높음/중간/낮음
  product_count?: number;
  category?: string;
  fetched_at?: string;
  fresh: boolean;
}

export interface KeywordPool {
  ok: boolean;
  product_name: string;
  naver_product_name: string | null;
  vision_features: string[];
  vision_meta: {
    color?: string[] | string | null;
    material?: string | null;
    form?: string | null;
    package_qty?: string | null;
    readable_text?: string | null;
  };
  best_picks: string[];
  good_picks: string[];
  ad_keywords: string[];
  functional_keywords: string[];
  preset_keywords: string[];
  naver_keywords: string[];
  detail_keywords?: string[];
  detail_html_length?: number;
  banned_keywords?: string[];
  must_have_keywords?: string[];
  inferred_gender?: 'female' | 'male' | null;
  inferred_season?: 'summer' | 'winter' | 'spring_fall' | null;
  season_banned_keywords?: string[];
  image_ocr_text?: string;
  option_color?: string | null;
  color_mismatch?: { option_color: string; vision_colors: string[] } | null;
  keyword_volumes?: Record<string, KeywordVolume>;
  error?: string;
}

export interface RelatedKeyword {
  keyword: string;
  pc: number;
  mobile: number;
  total: number;
  comp: string;
}

export async function fetchRelatedKeywords(seed: string, limit = 30): Promise<{ ok: boolean; seed: string; items: RelatedKeyword[] }> {
  const r = await api.get('/naver-keyword-related/', { params: { seed, limit } });
  return r.data;
}

export async function fetchRelatedKeywordsMulti(seeds: string[], limit = 1500): Promise<{ ok: boolean; seeds: string[]; items: RelatedKeyword[] }> {
  const r = await api.get('/naver-keyword-related/', { params: { seeds: seeds.join(','), limit } });
  return r.data;
}

export async function fetchHotKeywords(category: string, limit = 20): Promise<{ ok: boolean; items: Array<{ keyword: string; total: number; comp: string }> }> {
  const r = await api.get('/naver-keyword-hot/', { params: { category, limit } });
  return r.data;
}

export interface BrandPolicyItem {
  name: string;
  policy: 'white' | 'black';
  source: string | null;
  note: string | null;
  hit_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export async function fetchBrandPolicy(opts: { policy?: 'white' | 'black'; search?: string; limit?: number; offset?: number } = {}): Promise<{ items: BrandPolicyItem[]; total: number }> {
  const r = await api.get('/brand-policy/', { params: opts });
  return r.data;
}

export async function fetchBrandAutoDiscover(limit = 50): Promise<{ items: Array<{ name: string; count: number }>; mode: string }> {
  const r = await api.get('/brand-policy/', { params: { auto_discover: 1, limit } });
  return r.data;
}

export async function upsertBrandPolicy(name: string, policy: 'white' | 'black', note?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await api.post('/brand-policy/', { name, policy, note });
  return r.data;
}

export async function deleteBrandPolicy(name: string): Promise<{ ok: boolean; deleted: number }> {
  const r = await api.delete(`/brand-policy/${encodeURIComponent(name)}/`);
  return r.data;
}

export interface KeywordRelevance {
  ok: boolean;
  relevant: string[];
  irrelevant: string[];
  cached: boolean;
  model?: string;
  elapsed_ms?: number;
  error?: string;
}

export async function fetchKeywordRelevance(productId: number, keywords: string[], force = false): Promise<KeywordRelevance> {
  const r = await api.post(`/naver-products/${productId}/keyword-relevance/`, { keywords, force });
  return r.data;
}

export async function fetchKeywordPool(id: number): Promise<KeywordPool> {
  const r = await api.get(`/naver-products/${id}/keyword-pool/`);
  return r.data;
}

// ── AI 상품명 컨펌 학습 ─────────────────────────────────────────
export type NameCommentType = 'wrong' | 'missing' | 'overall';

export interface ConfirmNameResult {
  ok: boolean;
  product_code?: string;
  category_type?: string;
  bad_keywords?: string[];
  white_keywords?: string[];
  comment_type?: NameCommentType;
  error?: string;
}

export async function confirmNaverName(
  productId: number,
  payload: {
    before_name: string | null;
    after_name: string | null;
    comment?: string | null;
    comment_type: NameCommentType;
  },
): Promise<ConfirmNameResult> {
  const r = await api.post(`/naver-products/${productId}/confirm-name/`, payload, {
    validateStatus: () => true,
  });
  return r.data;
}

export interface NameConfirmationItem {
  id: number;
  product_code: string;
  product_id: number | null;
  category_type: string | null;
  category_name: string | null;
  before_name: string | null;
  after_name: string | null;
  bad_keywords: string[];
  white_keywords: string[];
  ai_comment: string | null;
  comment_type: NameCommentType;
  created_at: string | null;
}

export async function fetchNaverNameConfirmations(
  productId: number, limit = 20, offset = 0,
): Promise<{ ok: boolean; items: NameConfirmationItem[]; total: number }> {
  const r = await api.get(`/naver-products/${productId}/confirmations/`, {
    params: { limit, offset },
  });
  return r.data;
}

export interface NamePolicyItem {
  category_type: string;
  keyword: string;
  policy: 'white' | 'black';
  hit_count: number;
  source: string | null;
  last_product_code: string | null;
  updated_at: string | null;
}

export async function fetchNamePolicy(opts: {
  category_type?: string;
  policy?: 'white' | 'black';
  limit?: number;
} = {}): Promise<{ ok: boolean; items: NamePolicyItem[]; total: number }> {
  const r = await api.get('/name-policy/', { params: opts });
  return r.data;
}

export async function deleteNamePolicy(
  category_type: string, keyword: string, policy: 'white' | 'black',
): Promise<{ ok: boolean; deleted: number }> {
  const r = await api.delete(
    `/name-policy/${encodeURIComponent(category_type)}/${encodeURIComponent(keyword)}/${policy}/`,
  );
  return r.data;
}

// ── 상품명 버전 스냅샷 / 롤백 ─────────────────────────────────
export interface NameVersionSnapshot {
  id: number;
  version_tag: string;
  naver_product_name: string | null;
  source: string | null;
  note: string | null;
  created_at: string | null;
}

export interface NamePatchNote {
  version: string;
  date: string;
  summary: string;
  issues: string[];
  fixes: string[];
}

export interface NameVersionsResponse {
  ok: boolean;
  code_version: string;        // 현재 generator 코드 버전 (예: 'v1.02')
  current_version: string | null; // 이 상품에 적용된 버전
  current_name: string | null;
  items: NameVersionSnapshot[];
  patch_notes?: NamePatchNote[];
}

export async function fetchNaverNameVersions(productId: number, limit = 20): Promise<NameVersionsResponse> {
  const r = await api.get(`/naver-products/${productId}/name-versions/`, { params: { limit } });
  return r.data;
}

export async function rollbackNaverName(
  productId: number, snapshotId: number,
): Promise<{ ok: boolean; restored_name?: string; restored_version?: string; snapshot_id?: number; error?: string }> {
  const r = await api.post(`/naver-products/${productId}/rollback-name/`, { snapshot_id: snapshotId }, {
    validateStatus: () => true,
  });
  return r.data;
}
