/**
 * ThumbnailEditor — 상품 썸네일 AI 편집 모달.
 *
 * 작업 (모두 backend FastAPI port 8902 호출):
 *  - 배경 제거 (rembg)
 *  - 글씨 자동 제거 (easyocr + LaMa)
 *  - 선명도 + 업스케일 (Real-ESRGAN or Lanczos)
 *  - 회전 (-10 ~ +10도)
 *
 * 흐름:
 *  1) 모달 열림 → 원본 URL 보존 (FastAPI 가 fetch)
 *  2) 작업 클릭 → API 호출 → image_b64 갱신 + history push
 *  3) 저장 → Django 로 image_b64 전송 → MEDIA 저장 + edited_image_url UPDATE
 *  4) 원본 리셋 → Django DELETE → edited_image_url=NULL
 *
 * 독립 컴포넌트 — 어디서든 재사용 가능.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aiBgRemove, aiTextRemove, aiUpscale, aiRotate, aiGeminiEdit, aiFlip,
  aiAdjust, aiFilter, aiBlur, aiPadSquare, aiFrame, aiOcr,
  fluxFill, fluxRedux, fluxKontext, fluxCanny, fluxDepth, fluxUpscale, fluxIPAdapter,
  addVariant, fetchVariants,
  type ImageOpResult, type FluxResult, type ImageRef, type OcrResult,
  type ThumbnailSourceType, type ThumbnailVariant,
} from '../api/naverProductApi';
import { AiIcon, type AiIconName } from './aiIcons';

type TabKey = 'basic' | 'flux' | 'gemini' | 'post';
type BasicTool = 'bg-remove' | 'text-remove' | 'upscale' | 'rotate' | 'flip' | null;
type PostTool = 'adjust' | 'filter' | 'pad-square' | 'frame' | 'ocr' | null;

// FLUX 기능 정의 — 각 카드별 메타
type FluxFeature = 'fill' | 'redux' | 'kontext' | 'canny' | 'depth' | 'upscale' | 'ipadapter' | 'family';

const FLUX_FEATURES: { key: FluxFeature; emoji: string; label: string; desc: string; needsPrompt: boolean; needsRef?: boolean }[] = [
  { key: 'fill',     emoji: '🎨', label: '배경 교체 (자동 마스크)', desc: 'bg-remove로 상품 자동 분리 → 배경만 prompt로 재생성', needsPrompt: true },
  { key: 'kontext',  emoji: '💬', label: '자연어 인컨텍스트 편집',  desc: 'Gemini와 동일 UX. 자연어 지시로 자유 편집', needsPrompt: true },
  { key: 'redux',    emoji: '🖼', label: '4장 시안 생성',            desc: 'Redux로 입력 컨디셔닝 기반 4가지 variation 동시 생성', needsPrompt: false },
  { key: 'family',   emoji: '👨‍👩‍👧', label: '가족모델 추가',         desc: 'Fill에 가족 prompt 자동 적용 — 상품 사용하는 가족 합성', needsPrompt: false },
  { key: 'upscale',  emoji: '🔍', label: 'AI 업스케일 (FLUX Tile)',  desc: 'Tile ControlNet — Real-ESRGAN 보다 자연스러운 4x', needsPrompt: false },
  { key: 'ipadapter',emoji: '🎯', label: '참조 이미지 스타일',        desc: 'IP-Adapter — 업로드한 사진의 분위기/스타일 적용', needsPrompt: true, needsRef: true },
  { key: 'canny',    emoji: '✏️', label: '윤곽 보존 재생성',          desc: 'Canny 엣지 유지 + 모든 텍스처 재생성', needsPrompt: true },
  { key: 'depth',    emoji: '🌐', label: '3D 깊이 보존 재생성',       desc: 'Depth map 보존 + 자연스러운 원근감', needsPrompt: true },
];

const FAMILY_PRESET = 'Add a happy Korean family (parents and a child) naturally using or holding this product in a warm sunlit home setting. Lifestyle photography. Keep the product 100% identical.';

// 생성형 AI 프리셋 — 클릭하면 prompt 입력창에 채움 (수정 후 실행 권장)
const GEN_PRESETS: { label: string; prompt: string; emoji: string }[] = [
  { emoji: '⬜', label: '깨끗한 흰 배경', prompt: 'Replace the background with a pure clean white studio backdrop. Soft shadow under the product. Keep the product 100% identical.' },
  { emoji: '🎨', label: '그라데이션', prompt: 'Replace the background with a subtle pastel gradient (light pink to white). Modern e-commerce style. Keep the product unchanged.' },
  { emoji: '🛋', label: '거실 인테리어', prompt: 'Place the product naturally in a cozy modern living room interior. Warm lighting. Keep the product 100% identical, only the surroundings change.' },
  { emoji: '🌳', label: '야외 자연', prompt: 'Place the product in a natural outdoor scene (grass, soft daylight). Keep the product unchanged.' },
  { emoji: '🏪', label: '매장 디스플레이', prompt: 'Show the product on a sleek modern retail store display shelf, clean professional lighting. Keep the product unchanged.' },
  { emoji: '👨‍👩‍👧', label: '가족 모델 추가', prompt: 'Add a happy Korean family (parents and one child) naturally using or holding this product in a warm home setting. Keep the product itself exactly the same.' },
  { emoji: '👩', label: '여성 모델', prompt: 'Add a Korean woman in her 30s naturally using/holding this product. Lifestyle photography style. Keep the product unchanged.' },
  { emoji: '✨', label: '럭셔리 스튜디오', prompt: 'Replace the background with a luxury dark studio backdrop with dramatic side lighting. Keep the product unchanged.' },
];

type Op = {
  type: 'bg_remove' | 'text_remove' | 'upscale' | 'rotate';
  label: string;
  elapsed_ms: number;
  meta?: Record<string, unknown>;
};

interface Props {
  productId: number;
  productCode: string;
  productName: string;
  originalUrl: string;
  existingEditedUrl?: string | null;
  initialB64?: string | null;
  dark: boolean;
  onClose: () => void;
  onSaved: (editedUrl: string | null) => void;
  /** 갤러리 열기 콜백 */
  onOpenGallery?: () => void;
}

const BG_MODELS = [
  { value: 'isnet-general-use', label: 'ISNet (범용·균형)' },
  { value: 'u2net', label: 'U²-Net (전통, 빠름)' },
  { value: 'u2net_human_seg', label: '👤 인물 분리 (가족모델용)' },
  { value: 'u2net_cloth_seg', label: '👕 의류 분리 (상의/하의)' },
  { value: 'silueta', label: 'Silueta (인물·실루엣)' },
  { value: 'birefnet-general', label: 'BiRefNet (디테일·느림)' },
];

const COLOR_FILTERS: { key: 'grayscale' | 'sepia' | 'cool' | 'warm' | 'vintage' | 'invert' | 'posterize' | 'solarize'; emoji: string; label: string }[] = [
  { key: 'grayscale', emoji: '⬜', label: '흑백' },
  { key: 'sepia',     emoji: '🟤', label: '세피아' },
  { key: 'warm',      emoji: '🔥', label: '웜톤' },
  { key: 'cool',      emoji: '❄️', label: '쿨톤' },
  { key: 'vintage',   emoji: '📷', label: '빈티지' },
  { key: 'invert',    emoji: '🔁', label: '반전' },
  { key: 'posterize', emoji: '🎨', label: '포스터' },
  { key: 'solarize',  emoji: '☀️', label: '솔라' },
];

export function ThumbnailEditor({
  productId, productCode, productName, originalUrl, existingEditedUrl, initialB64,
  dark, onClose, onSaved, onOpenGallery,
}: Props) {
  // current = 화면에 보이는 편집본. null = 아직 원본 그대로
  const [currentB64, setCurrentB64] = useState<string | null>(initialB64 ?? null);
  const [history, setHistory] = useState<Op[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [bgModel, setBgModel] = useState('isnet-general-use');
  const [rotateAngle, setRotateAngle] = useState(0);
  const [rotateExpand, setRotateExpand] = useState(false);
  const [upScale, setUpScale] = useState(2.0);
  const [upSharp, setUpSharp] = useState(1.5);
  // 색감 조정 (로컬 보너스)
  const [adjBrightness, setAdjBrightness] = useState(1.0);
  const [adjContrast, setAdjContrast] = useState(1.0);
  const [adjSaturation, setAdjSaturation] = useState(1.0);
  // 블러/비네팅
  const [blurRadius, setBlurRadius] = useState(0);
  const [vignetteStr, setVignetteStr] = useState(0);
  // 후처리
  const [padColor, setPadColor] = useState('#ffffff');
  const [frameBorder, setFrameBorder] = useState(0);
  const [frameBorderColor, setFrameBorderColor] = useState('#ffffff');
  const [frameShadow, setFrameShadow] = useState(false);
  const [frameRounded, setFrameRounded] = useState(0);
  // OCR 결과
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  // 생성형 AI
  const [provider, setProvider] = useState<'flux' | 'gemini'>('flux');  // FLUX 기본
  const [fluxFeature, setFluxFeature] = useState<FluxFeature>('fill');
  const [genPrompt, setGenPrompt] = useState('');
  const [refImageB64, setRefImageB64] = useState<string | null>(null);
  const [refImageName, setRefImageName] = useState<string>('');
  const [fluxStrength, setFluxStrength] = useState(0.7);
  const [fluxScale, setFluxScale] = useState(2.0);
  // 변형 풀 mini-strip
  const [variants, setVariants] = useState<ThumbnailVariant[]>([]);
  const [variantCount, setVariantCount] = useState(0);
  const variantMax = 20;
  // 마지막 작업 타입 (저장 시 source_type 결정)
  const lastOpRef = useRef<ThumbnailSourceType>('manual');
  // 결과 패널 flash (변경 직후 깜빡임)
  const [flashKey, setFlashKey] = useState(0);
  // 탭 + 선택된 도구
  const [tab, setTab] = useState<TabKey>('basic');
  const [basicTool, setBasicTool] = useState<BasicTool>('bg-remove');
  const [postTool, setPostTool] = useState<PostTool>('adjust');
  const stackRef = useRef<string[]>([]);  // undo 스택 (이전 currentB64 들)

  // 복원영역 — 글씨제거가 상품도 같이 지웠을 때 원본을 드래그한 사각형 영역만큼 합성.
  const [originalImageB64, setOriginalImageB64] = useState<string | null>(initialB64 ?? null);
  const [restoreMode, setRestoreMode] = useState(false);
  const [restoreRect, setRestoreRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const restoreDragStart = useRef<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const C = useMemo(() => ({
    bg: dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]',
    panel: dark ? 'bg-[#1c1c2e]' : 'bg-white',
    border: dark ? 'border-[#2a2a40]' : 'border-gray-200',
    text: dark ? 'text-white' : 'text-gray-900',
    muted: dark ? 'text-gray-400' : 'text-gray-500',
    sub: dark ? 'text-gray-300' : 'text-gray-700',
    label: dark ? 'text-gray-300' : 'text-gray-700',
    input: dark
      ? 'bg-[#0f0f1a] border-[#2a2a40] text-white'
      : 'bg-white border-gray-300 text-gray-900',
    btn: dark
      ? 'bg-[#252540] hover:bg-[#2a2a50] border-[#3a3a55] text-gray-100'
      : 'bg-white hover:bg-gray-50 border-gray-300 text-gray-800',
    btnGreen: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    btnRose: 'bg-rose-600 hover:bg-rose-700 text-white',
    btnSky: 'bg-sky-600 hover:bg-sky-700 text-white',
    btnAmber: 'bg-amber-600 hover:bg-amber-700 text-white',
    btnPurple: 'bg-violet-600 hover:bg-violet-700 text-white',
  }), [dark]);

  // ── 현재 편집 대상의 ImageRef (b64 우선, 없으면 URL) ──
  const currentRef: ImageRef = useMemo(() => {
    if (currentB64) return { b64: currentB64 };
    return { url: originalUrl };
  }, [currentB64, originalUrl]);

  const previewSrc = currentB64
    ? `data:image/webp;base64,${currentB64}`
    : originalUrl;
  // 렌더 추적 (디버깅)
  console.log('[ThumbnailEditor] render — currentB64?',
    currentB64 ? `${currentB64.length}chars` : 'null',
    'previewSrc?', previewSrc.slice(0, 60));

  // ── 작업 실행 공통 래퍼 ──
  // 원본을 image-proxy 거쳐 가져옴 (네이버 외부 이미지 CORS 회피).
  // 절대 currentB64 의 변경에 끌려가면 안 됨 (글씨제거 결과가 "원본" 으로 잡히는 버그 방지)
  const proxyUrl = (u: string) =>
    u.startsWith('/') || u.startsWith(window.location.origin)
      ? u
      : `/api/smartstore/image-proxy/?url=${encodeURIComponent(u)}`;

  useEffect(() => {
    if (originalImageB64) return;
    if (!originalUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const cx = c.getContext('2d');
        if (!cx) return;
        cx.drawImage(img, 0, 0);
        const url = c.toDataURL('image/webp', 0.95);
        setOriginalImageB64(url.split(',')[1]);
      } catch (e) {
        console.warn('[ThumbnailEditor] 원본 b64 변환 실패 (CORS 가능성), applyRestore 에서 직접 url 사용', e);
      }
    };
    img.onerror = (e) => console.warn('[ThumbnailEditor] 원본 로드 실패', e);
    img.src = proxyUrl(originalUrl);
  }, [originalUrl, originalImageB64]);

  // 복원영역: 마우스 드래그 → rect 그리기
  function onRestoreMouseDown(e: React.MouseEvent) {
    if (!restoreMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    restoreDragStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setRestoreRect({ x: restoreDragStart.current.x, y: restoreDragStart.current.y, w: 0, h: 0 });
  }
  function onRestoreMouseMove(e: React.MouseEvent) {
    if (!restoreMode || !restoreDragStart.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x2 = e.clientX - rect.left;
    const y2 = e.clientY - rect.top;
    setRestoreRect({
      x: Math.min(restoreDragStart.current.x, x2),
      y: Math.min(restoreDragStart.current.y, y2),
      w: Math.abs(x2 - restoreDragStart.current.x),
      h: Math.abs(y2 - restoreDragStart.current.y),
    });
  }
  function onRestoreMouseUp() { restoreDragStart.current = null; }

  // 복원 적용: 원본의 사각형 영역을 현재 이미지에 합성. 원본 = originalImageB64 또는 originalUrl 폴백.
  async function applyRestore() {
    if (!restoreRect || !currentB64) return;
    if (!originalImageB64 && !originalUrl) { setError('원본 이미지를 못 찾음'); return; }
    const imgEl = imgRef.current;
    if (!imgEl) return;
    setBusy('복원중');
    try {
      const dispW = imgEl.clientWidth;
      const dispH = imgEl.clientHeight;
      // <img object-contain> 의 letterbox offset 계산
      const container = imgEl.parentElement;
      const cW = container?.clientWidth ?? dispW;
      const cH = container?.clientHeight ?? dispH;
      const offsetLeft = Math.max(0, (cW - dispW) / 2);
      const offsetTop = Math.max(0, (cH - dispH) / 2);

      const realW = imgEl.naturalWidth;
      const realH = imgEl.naturalHeight;
      const sx = realW / dispW;
      const sy = realH / dispH;
      const rx = Math.max(0, (restoreRect.x - offsetLeft) * sx);
      const ry = Math.max(0, (restoreRect.y - offsetTop) * sy);
      const rw = Math.min(realW - rx, restoreRect.w * sx);
      const rh = Math.min(realH - ry, restoreRect.h * sy);
      if (rw < 4 || rh < 4) { setError('복원영역이 너무 작음'); return; }

      const canvas = document.createElement('canvas');
      canvas.width = realW;
      canvas.height = realH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas ctx 없음');

      const loadFromB64OrUrl = (b64: string | null, url: string | null) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => res(im);
          im.onerror = (e) => { console.error('[restore] img load fail', e, b64 ? 'b64' : url); rej(e); };
          im.src = b64 ? `data:image/webp;base64,${b64}` : (url ? proxyUrl(url) : '');
        });

      const curImg = await loadFromB64OrUrl(currentB64, null);
      const origImg = await loadFromB64OrUrl(originalImageB64, originalUrl);
      ctx.drawImage(curImg, 0, 0, realW, realH);
      ctx.drawImage(origImg, rx, ry, rw, rh, rx, ry, rw, rh);

      stackRef.current.push(currentB64);
      const dataUrl = canvas.toDataURL('image/webp', 0.92);
      setCurrentB64(dataUrl.split(',')[1]);
      setHistory(h => [...h, { type: 'restore', label: '원본복원', elapsed_ms: 0, meta: { rect: { rx, ry, rw, rh } } }]);
      setRestoreMode(false);
      setRestoreRect(null);
    } catch (e) {
      setError('복원 실패 (CORS 가능성): ' + String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  async function runOp(
    label: string,
    fn: () => Promise<ImageOpResult>,
    sourceType: ThumbnailSourceType = 'manual',
  ) {
    setError('');
    setBusy(label);
    console.log('[ThumbnailEditor] runOp START', label);
    try {
      const r = await fn();
      console.log('[ThumbnailEditor] runOp RESPONSE', {
        ok: r.ok, op: r.op, elapsed_ms: r.elapsed_ms,
        image_b64_len: r.image_b64?.length, image_b64_first: r.image_b64?.slice(0, 60),
      });
      if (!r.ok || !r.image_b64) {
        throw new Error('서버 응답 실패');
      }
      stackRef.current.push(currentB64 ?? '');
      setCurrentB64(r.image_b64);
      console.log('[ThumbnailEditor] runOp setCurrentB64 CALLED — new length:', r.image_b64.length);
      lastOpRef.current = sourceType;
      setFlashKey((k) => k + 1);
      setHistory((h) => [...h, {
        type: r.op as Op['type'], label,
        elapsed_ms: r.elapsed_ms, meta: r.meta,
      }]);
    } catch (e) {
      const msg = (e as { response?: { data?: { detail?: string } }; message?: string });
      setError(msg.response?.data?.detail || msg.message || String(e));
    } finally {
      setBusy('');
    }
  }

  // 변형 풀 로드 (마운트 + 저장 후)
  const reloadVariants = useCallback(async () => {
    try {
      const r = await fetchVariants(productId);
      setVariants(r.items);
      setVariantCount(r.count);
    } catch { /* noop */ }
  }, [productId]);

  useEffect(() => { reloadVariants(); }, [reloadVariants]);

  // FLUX 실행 — multi-image 결과(redux=4장) 자동으로 풀에 추가 + 첫번째를 current 로
  async function runFlux(label: string, sourceType: ThumbnailSourceType, fn: () => Promise<FluxResult>) {
    setError(''); setBusy(label);
    try {
      const t0 = Date.now();
      const r = await fn();
      if (!r.ok || !r.images_b64?.length) throw new Error('FLUX 응답 비어있음');
      const elapsed = Date.now() - t0;

      if (r.images_b64.length === 1) {
        // 단일 결과 — 일반 작업처럼 current 갱신
        stackRef.current.push(currentB64 ?? '');
        setCurrentB64(r.images_b64[0]);
        lastOpRef.current = sourceType;
        setHistory((h) => [...h, {
          type: 'bg_remove' /* type 호환용 */, label,
          elapsed_ms: elapsed, meta: r.meta,
        }]);
      } else {
        // 다중 결과 (redux 4장) — 모두 풀에 자동 추가, 첫번째 current
        let added = 0;
        for (const b64 of r.images_b64) {
          if (variantCount + added >= 20) break;
          const res = await addVariant(productId, b64, sourceType,
            { ...r.meta, batch_index: added + 1 },
            `${label} #${added + 1}`, false);
          if (res.ok) added += 1;
        }
        stackRef.current.push(currentB64 ?? '');
        setCurrentB64(r.images_b64[0]);
        lastOpRef.current = sourceType;
        setHistory((h) => [...h, {
          type: 'bg_remove', label: `${label} (${added}장 풀 추가)`,
          elapsed_ms: elapsed, meta: r.meta,
        }]);
        await reloadVariants();
      }
    } catch (e) {
      const m = e as { response?: { data?: { detail?: string } }; message?: string };
      setError(m.response?.data?.detail || m.message || String(e));
    } finally {
      setBusy('');
    }
  }

  // 참조 이미지 업로드 (IP-Adapter 용)
  function onRefImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:image/png;base64,xxx → 그대로 저장 (data URL)
      setRefImageB64(result.split(',')[1] || null);
      setRefImageName(f.name);
    };
    reader.readAsDataURL(f);
  }

  // 현재 선택된 FLUX 기능 실행
  async function executeFlux() {
    const feat = FLUX_FEATURES.find((f) => f.key === fluxFeature)!;
    const prompt = fluxFeature === 'family' ? FAMILY_PRESET : genPrompt.trim();
    if (feat.needsPrompt && !prompt) { setError('프롬프트를 입력하세요'); return; }
    if (feat.needsRef && !refImageB64) { setError('참조 이미지를 업로드하세요'); return; }
    const label = `FLUX: ${feat.label}`;
    const sourceType: ThumbnailSourceType = 'flux';
    switch (fluxFeature) {
      case 'fill':
      case 'family':
        return runFlux(label, sourceType, () => fluxFill(currentRef, prompt));
      case 'kontext':
        return runFlux(label, sourceType, () => fluxKontext(currentRef, prompt));
      case 'redux':
        return runFlux(label, sourceType, () => fluxRedux(currentRef, { prompt: prompt || undefined, n: 4 }));
      case 'canny':
        return runFlux(label, sourceType, () => fluxCanny(currentRef, prompt, { strength: fluxStrength }));
      case 'depth':
        return runFlux(label, sourceType, () => fluxDepth(currentRef, prompt, { strength: fluxStrength }));
      case 'upscale':
        return runFlux(label, sourceType, () => fluxUpscale(currentRef, fluxScale));
      case 'ipadapter':
        return runFlux(label, sourceType, () => fluxIPAdapter(currentRef, refImageB64!, prompt, { strength: fluxStrength }));
    }
  }

  function undo() {
    if (stackRef.current.length === 0) return;
    const prev = stackRef.current.pop()!;
    setCurrentB64(prev || null);
    setHistory((h) => h.slice(0, -1));
  }

  function resetLocal() {
    stackRef.current = [];
    setCurrentB64(null);
    setHistory([]);
    setError('');
  }

  async function onSave(activate: boolean) {
    if (!currentB64) { setError('변경사항이 없습니다'); return; }
    if (variantCount >= variantMax && activate === false) {
      setError(`풀 가득참 (${variantCount}/${variantMax}). 갤러리에서 변형 삭제 후 재시도.`);
      return;
    }
    setBusy(activate ? 'save-activate' : 'save-pool');
    try {
      const sourceMeta = { ops: history.map((h) => h.label) };
      const r = await addVariant(
        productId, currentB64,
        lastOpRef.current,
        sourceMeta,
        undefined,
        activate,
      );
      if (!r.ok) throw new Error(r.error || 'save failed');
      await reloadVariants();
      if (activate) {
        onSaved(r.image_url || null);
        onClose();
      } else {
        // 풀에만 추가 — 모달 유지, 알림
        setError('');
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  // ESC 닫기
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const isBusy = busy !== '';

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-3"
         onClick={onClose}>
      <div className={`${C.panel} ${C.border} border rounded-xl shadow-2xl w-full max-w-[1400px] h-[92vh] flex flex-col`}
           onClick={(e) => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${C.border}`}>
          <div className="min-w-0">
            <div className={`text-sm font-bold ${C.text} flex items-center gap-2`}>
              <span>🪄 썸네일 AI 편집</span>
              <span className={`text-[10px] font-mono ${C.muted}`}>{productCode}</span>
            </div>
            <div className={`text-xs ${C.muted} truncate max-w-[900px]`}>{productName}</div>
          </div>
          <button onClick={onClose}
                  className={`${C.btn} border rounded px-3 py-1 text-xs`}>
            ✕ 닫기 (Esc)
          </button>
        </div>

        {/* 본문: 좌 비교영역 / 우 컨트롤 */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* ── 좌측: 원본 vs 편집본 비교 ── */}
          <div className={`flex-1 flex flex-col p-3 gap-3 ${dark ? 'bg-[#0a0a16]' : 'bg-gray-50'} min-w-0 overflow-auto`}>
            <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
              {/* 원본 */}
              <div className={`${C.panel} ${C.border} border rounded-lg p-2 flex flex-col`}>
                <div className={`text-[11px] font-bold ${C.muted} mb-1.5 flex items-center justify-between`}>
                  <span>📷 원본 (image_large)</span>
                  {existingEditedUrl && <span className="text-[10px] text-amber-500">기존 편집본 있음</span>}
                </div>
                <div className="flex-1 flex items-center justify-center bg-[repeating-conic-gradient(#80808022_0_25%,transparent_0_50%)] bg-[length:20px_20px] rounded overflow-hidden">
                  <img src={originalUrl} alt="원본"
                       className="max-w-full max-h-full object-contain" />
                </div>
              </div>
              {/* 편집본 — 결과 표시. 변경 시 emerald 링 flash */}
              <div className={`${C.panel} ${C.border} border rounded-lg p-2 flex flex-col transition-all ${
                flashKey > 0 && !isBusy ? 'ring-4 ring-emerald-500 ring-opacity-100' : ''
              }`}
                   key={`flash-${flashKey}`}>
                <div className={`text-[11px] font-bold mb-1.5 flex items-center justify-between ${
                  currentB64 ? 'text-emerald-500' : C.muted
                }`}>
                  <span>✨ 편집본 결과 {currentB64 && '✓'}</span>
                  <span className="text-[10px]">{currentB64 ? `${Math.round(currentB64.length * 0.75 / 1024)}KB` : '아직 변경 없음 — 우측 버튼 클릭'}</span>
                </div>
                <div className="flex-1 flex items-center justify-center bg-[repeating-conic-gradient(#80808022_0_25%,transparent_0_50%)] bg-[length:20px_20px] rounded overflow-hidden">
                  {isBusy ? (
                    <div className={`text-sm ${C.muted} animate-pulse text-center px-3`}>
                      ⏳ {busy} 처리중...<br/>
                      <span className="text-[10px]">(첫 호출은 모델 로드로 느릴 수 있음)</span>
                    </div>
                  ) : (
                    <div className={`relative w-full h-full flex items-center justify-center ${restoreMode ? 'cursor-crosshair' : ''}`}
                         onMouseDown={onRestoreMouseDown}
                         onMouseMove={onRestoreMouseMove}
                         onMouseUp={onRestoreMouseUp}
                         onMouseLeave={onRestoreMouseUp}>
                      <img ref={imgRef} src={previewSrc} alt="편집본"
                           className="max-w-full max-h-full object-contain"
                           draggable={false} />
                      {restoreMode && restoreRect && (
                        <div className="absolute border-2 border-emerald-500 bg-emerald-500/20 pointer-events-none"
                             style={{ left: restoreRect.x, top: restoreRect.y, width: restoreRect.w, height: restoreRect.h }} />
                      )}
                      {restoreMode && (
                        <div className="absolute top-2 left-2 right-2 flex items-center gap-2 bg-emerald-900/80 text-white text-xs px-3 py-1.5 rounded">
                          <span className="font-bold">📐 복원영역</span>
                          <span className="opacity-80">— 원본을 가져올 영역을 드래그</span>
                          <div className="flex-1" />
                          {restoreRect && restoreRect.w > 4 && (
                            <button onClick={applyRestore} disabled={isBusy}
                                    className="bg-emerald-500 hover:bg-emerald-600 px-3 py-0.5 rounded font-bold disabled:opacity-40">
                              {busy === '복원중' ? '⏳' : '✓ 적용'}
                            </button>
                          )}
                          <button onClick={() => { setRestoreMode(false); setRestoreRect(null); }}
                                  className="bg-rose-600 hover:bg-rose-700 px-3 py-0.5 rounded font-bold">
                            취소
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 작업 이력 */}
            <div className={`${C.panel} ${C.border} border rounded-lg p-2`}>
              <div className={`text-[11px] font-bold ${C.muted} mb-1`}>📋 작업 이력 ({history.length})</div>
              {history.length === 0 ? (
                <div className={`text-[11px] ${C.muted} italic`}>아직 작업 없음</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {history.map((op, i) => (
                    <span key={i}
                          className={`text-[10px] px-2 py-0.5 rounded border ${C.border} ${C.sub}`}>
                      <b>{i + 1}.</b> {op.label}
                      <span className={`ml-1 font-mono ${C.muted}`}>{op.elapsed_ms}ms</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── 우측: 탭 + 아이콘 그리드 + 옵션 + 푸터 액션 ── */}
          <aside className={`w-[380px] flex-shrink-0 ${C.panel} border-l ${C.border} flex flex-col`}>

            {/* 탭 헤더 */}
            <div className={`p-2 border-b ${C.border} ${C.panel}`}>
              <div className={`grid grid-cols-4 gap-1 rounded-lg p-1 ${dark ? 'bg-black/30' : 'bg-gray-100'}`}>
                {([
                  ['basic',  'bg-gradient-to-br from-emerald-600 to-teal-500',     '⚙️', '기본 도구'],
                  ['flux',   'bg-gradient-to-br from-indigo-600 to-cyan-500',      '🔷', 'FLUX 생성'],
                  ['post',   'bg-gradient-to-br from-amber-500 to-orange-500',     '🎨', '후처리'],
                  ['gemini', 'bg-gradient-to-br from-pink-500 to-violet-600',      '⚡', 'Gemini'],
                ] as [TabKey, string, string, string][]).map(([k, grad, emoji, label]) => (
                  <button key={k} onClick={() => setTab(k)}
                          disabled={isBusy}
                          className={`py-1.5 px-1 text-[10px] font-bold rounded transition-all ${
                            tab === k ? `${grad} text-white shadow-md`
                                      : `${C.muted} hover:bg-black/10`
                          }`}>
                    <div className="text-base leading-none mb-0.5">{emoji}</div>
                    <div className="leading-tight">{label}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* 본문 — 탭별 컨텐츠 (스크롤) */}
            <div className="flex-1 overflow-y-auto">

              {/* ─────────── 기본 편집 도구 ─────────── */}
              {tab === 'basic' && (
              <div className="p-3 space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['bg-remove',   '배경 제거'],
                    ['text-remove', '글씨 제거'],
                    ['upscale',     '선명도+'],
                    ['rotate',      '회전'],
                    ['flip',        '반전'],
                  ] as [AiIconName, string][]).map(([icon, label]) => {
                    const sel = basicTool === icon;
                    return (
                      <button key={icon}
                              onClick={() => setBasicTool(icon as BasicTool)}
                              disabled={isBusy}
                              className={`p-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1 ${
                                sel ? 'bg-gradient-to-br from-emerald-600 to-teal-500 text-white border-emerald-400 shadow-lg scale-105'
                                    : `${C.btn} hover:border-emerald-400 hover:scale-105`
                              }`}>
                        <AiIcon name={icon} size={28} />
                        <span className="text-[10px] font-bold leading-tight">{label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* 선택된 도구 옵션 패널 */}
                {basicTool && (
                <div className={`rounded-lg border ${C.border} p-3 ${dark ? 'bg-black/20' : 'bg-emerald-50/40'}`}>
                  {basicTool === 'bg-remove' && (
                    <>
                      <label className={`text-[10px] font-bold ${C.label} block mb-1.5`}>모델 선택</label>
                      <select value={bgModel} onChange={(e) => setBgModel(e.target.value)} disabled={isBusy}
                              className={`${C.input} border rounded w-full px-2 py-1.5 text-xs mb-2`}>
                        {BG_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                      <button onClick={() => runOp('배경제거', () => aiBgRemove(currentRef, bgModel), 'bg_remove')}
                              disabled={isBusy}
                              className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '배경제거' ? '⏳ 처리중...' : '▶ 배경 제거 실행'}
                      </button>
                    </>
                  )}
                  {basicTool === 'text-remove' && (
                    <>
                      <div className={`text-[10px] ${C.muted} mb-2 leading-snug`}>
                        EasyOCR 한/영 검출 → LaMa 자연 채움
                      </div>
                      <button onClick={() => runOp('글씨제거', () => aiTextRemove(currentRef), 'text_remove')}
                              disabled={isBusy}
                              className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '글씨제거' ? '⏳ 처리중...' : '▶ 자동 검출 + 제거'}
                      </button>
                      <button onClick={() => { setRestoreMode(true); setRestoreRect(null); }}
                              disabled={isBusy || (!originalImageB64 && !originalUrl) || restoreMode}
                              title="글씨제거 결과에서 상품이 같이 지워진 영역을 원본 이미지로 복원"
                              className={`mt-1.5 ${restoreMode ? 'bg-emerald-700 text-white' : `${C.btn} border`} w-full rounded py-1.5 text-[11px] font-bold disabled:opacity-40`}>
                        📐 복원영역 선택 (마우스 드래그)
                      </button>
                      <div className={`text-[9px] ${C.muted} mt-1 leading-snug`}>
                        ↳ 상품이 같이 지워진 사각형 영역을 원본으로 되살림
                      </div>
                    </>
                  )}
                  {basicTool === 'upscale' && (
                    <>
                      <label className={`text-[10px] ${C.label} block`}>배율: <b>{upScale.toFixed(1)}x</b></label>
                      <input type="range" min={1.0} max={4.0} step={0.5} value={upScale}
                             onChange={(e) => setUpScale(Number(e.target.value))} disabled={isBusy}
                             className="w-full mb-1.5" />
                      <label className={`text-[10px] ${C.label} block`}>선명도: <b>{upSharp.toFixed(1)}</b></label>
                      <input type="range" min={0.5} max={3.0} step={0.1} value={upSharp}
                             onChange={(e) => setUpSharp(Number(e.target.value))} disabled={isBusy}
                             className="w-full mb-2" />
                      <button onClick={() => runOp('선명도+', () => aiUpscale(currentRef, upScale, upSharp), 'upscale')}
                              disabled={isBusy}
                              className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '선명도+' ? '⏳ 처리중...' : '▶ 선명도 + 업스케일'}
                      </button>
                    </>
                  )}
                  {basicTool === 'rotate' && (
                    <>
                      <div className={`flex items-center justify-between text-[10px] ${C.label} mb-1`}>
                        <span>각도</span><b className="font-mono">{rotateAngle.toFixed(1)}°</b>
                      </div>
                      <input type="range" min={-180} max={180} step={0.5} value={rotateAngle}
                             onChange={(e) => setRotateAngle(Number(e.target.value))} disabled={isBusy}
                             className="w-full mb-1.5" />
                      <div className="flex gap-1 mb-2">
                        {[-90, -5, -1, 0, 1, 5, 90].map((a) => (
                          <button key={a} onClick={() => setRotateAngle(a)} disabled={isBusy}
                                  className={`flex-1 text-[9px] py-0.5 rounded border ${C.btn} ${rotateAngle === a ? 'ring-1 ring-violet-500' : ''}`}>
                            {a > 0 ? '+' : ''}{a}°
                          </button>
                        ))}
                      </div>
                      <label className={`flex items-center gap-1.5 text-[10px] ${C.label} cursor-pointer mb-2`}>
                        <input type="checkbox" checked={rotateExpand}
                               onChange={(e) => setRotateExpand(e.target.checked)} />
                        expand (잘림 방지)
                      </label>
                      <button onClick={() => runOp(`회전 ${rotateAngle.toFixed(1)}°`,
                                                    () => aiRotate(currentRef, rotateAngle, rotateExpand), 'rotate')}
                              disabled={isBusy || rotateAngle === 0}
                              className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy.startsWith('회전') ? '⏳ 처리중...' : '▶ 회전 적용'}
                      </button>
                    </>
                  )}
                  {basicTool === 'flip' && (
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => runOp('좌우반전', () => aiFlip(currentRef, 'h'), 'flip_h')}
                              disabled={isBusy}
                              className="bg-gradient-to-br from-emerald-600 to-teal-500 text-white rounded py-3 text-xs font-bold disabled:opacity-40 shadow flex flex-col items-center gap-1">
                        <AiIcon name="flip" size={22} />
                        {busy === '좌우반전' ? '⏳' : '좌우반전'}
                      </button>
                      <button onClick={() => runOp('상하반전', () => aiFlip(currentRef, 'v'), 'flip_v')}
                              disabled={isBusy}
                              className="bg-gradient-to-br from-emerald-600 to-teal-500 text-white rounded py-3 text-xs font-bold disabled:opacity-40 shadow flex flex-col items-center gap-1">
                        <AiIcon name="flip" size={22} style={{ transform: 'rotate(90deg)' }} />
                        {busy === '상하반전' ? '⏳' : '상하반전'}
                      </button>
                    </div>
                  )}
                </div>
                )}
              </div>
              )}

              {/* ─────────── FLUX 생성 기능 ─────────── */}
              {tab === 'flux' && (
              <div className="p-3 space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['fill',     'flux-bg-replace',    '배경 교체'],
                    ['kontext',  'flux-prompt',        '자연어 편집'],
                    ['redux',    'flux-variations',    '4장 시안'],
                    ['family',   'flux-bg-replace',    '가족모델'],
                    ['upscale',  'flux-tile-upscale',  'AI 업스케일'],
                    ['ipadapter','flux-style-ref',     '참조 스타일'],
                    ['canny',    'flux-edge',          '윤곽 보존'],
                    ['depth',    'flux-depth',         '3D 깊이'],
                  ] as ['fill'|'kontext'|'redux'|'family'|'upscale'|'ipadapter'|'canny'|'depth', AiIconName, string][]).map(([key, icon, label]) => {
                    const sel = fluxFeature === key;
                    return (
                      <button key={key}
                              onClick={() => setFluxFeature(key)}
                              disabled={isBusy}
                              className={`relative p-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1 ${
                                sel ? 'bg-gradient-to-br from-indigo-600 to-cyan-500 text-white border-cyan-400 shadow-lg scale-105'
                                    : `${C.btn} hover:border-cyan-400 hover:scale-105`
                              }`}>
                        <AiIcon name={icon} size={28} />
                        <span className="text-[10px] font-bold leading-tight">{label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* FLUX 옵션 패널 */}
                <div className={`rounded-lg border ${C.border} p-3 ${dark ? 'bg-cyan-900/10' : 'bg-cyan-50/40'}`}>
                  <div className={`text-[10px] ${C.muted} italic mb-2`}>
                    {FLUX_FEATURES.find((f) => f.key === fluxFeature)?.desc}
                  </div>

                  {fluxFeature !== 'family' && fluxFeature !== 'upscale' && fluxFeature !== 'redux' && (
                    <>
                      <div className="grid grid-cols-2 gap-1 mb-2">
                        {GEN_PRESETS.slice(0, 6).map((p) => (
                          <button key={p.label} onClick={() => setGenPrompt(p.prompt)} disabled={isBusy}
                                  title={p.prompt}
                                  className={`${C.btn} border rounded px-1.5 py-0.5 text-[9px] text-left truncate`}>
                            {p.emoji} {p.label}
                          </button>
                        ))}
                      </div>
                      <textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} disabled={isBusy}
                                placeholder="자연어 prompt (영어 권장)" rows={2}
                                className={`${C.input} border rounded w-full px-2 py-1.5 text-[11px] mb-2 leading-snug resize-y`} />
                    </>
                  )}

                  {fluxFeature === 'redux' && (
                    <textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} disabled={isBusy}
                              placeholder="(선택) 추가 prompt — 비워두면 4가지 자유 variation"
                              rows={2}
                              className={`${C.input} border rounded w-full px-2 py-1.5 text-[11px] mb-2 leading-snug resize-y`} />
                  )}

                  {fluxFeature === 'family' && (
                    <div className={`text-[10px] ${C.sub} italic mb-2 p-2 rounded ${dark ? 'bg-indigo-900/20' : 'bg-indigo-50'}`}>
                      자동: "Korean family naturally using this product" — 상품 100% 보존
                    </div>
                  )}

                  {fluxFeature === 'ipadapter' && (
                    <div className="mb-2">
                      <label className={`text-[10px] ${C.label} block mb-1`}>참조 이미지</label>
                      <input type="file" accept="image/*" onChange={onRefImageChange} disabled={isBusy}
                             className={`text-[10px] ${C.text} w-full`} />
                      {refImageB64 && (
                        <div className={`mt-1 text-[10px] ${C.muted} flex items-center gap-2`}>
                          <img src={`data:image/png;base64,${refImageB64}`} className="w-10 h-10 object-cover rounded" alt="ref" />
                          <span className="truncate flex-1">{refImageName}</span>
                          <button onClick={() => { setRefImageB64(null); setRefImageName(''); }} className="text-rose-500">✕</button>
                        </div>
                      )}
                    </div>
                  )}

                  {fluxFeature === 'upscale' && (
                    <>
                      <label className={`text-[10px] ${C.label} block`}>배율: <b>{fluxScale.toFixed(1)}x</b></label>
                      <input type="range" min={1.5} max={4.0} step={0.5} value={fluxScale}
                             onChange={(e) => setFluxScale(Number(e.target.value))} disabled={isBusy}
                             className="w-full mb-2" />
                    </>
                  )}

                  {(fluxFeature === 'canny' || fluxFeature === 'depth' || fluxFeature === 'ipadapter') && (
                    <>
                      <label className={`text-[10px] ${C.label} block`}>강도: <b>{fluxStrength.toFixed(2)}</b></label>
                      <input type="range" min={0.3} max={1.0} step={0.05} value={fluxStrength}
                             onChange={(e) => setFluxStrength(Number(e.target.value))} disabled={isBusy}
                             className="w-full mb-2" />
                    </>
                  )}

                  <button onClick={executeFlux} disabled={isBusy}
                          className="bg-gradient-to-r from-indigo-600 to-cyan-500 hover:from-indigo-700 hover:to-cyan-600 text-white w-full rounded py-2.5 text-xs font-bold disabled:opacity-40 shadow-md">
                    {busy.startsWith('FLUX') ? '⏳ FLUX 처리중 (10~60초)...' : '▶ FLUX 실행'}
                  </button>
                </div>
              </div>
              )}

              {/* ─────────── 후처리 ─────────── */}
              {tab === 'post' && (
              <div className="p-3 space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['adjust',     'adjust',     '색감 조정'],
                    ['filter',     'filter',     '컬러 필터'],
                    ['pad-square', 'pad-square', '정사각 패딩'],
                    ['frame',      'frame',      '프레임/그림자'],
                    ['ocr',        'ocr',        '글자 인식'],
                  ] as [PostTool, AiIconName, string][]).map(([key, icon, label]) => {
                    const sel = postTool === key;
                    return (
                      <button key={key}
                              onClick={() => setPostTool(key)}
                              disabled={isBusy}
                              className={`p-2.5 rounded-lg border-2 transition-all flex flex-col items-center gap-1 ${
                                sel ? 'bg-gradient-to-br from-amber-500 to-orange-500 text-white border-amber-400 shadow-lg scale-105'
                                    : `${C.btn} hover:border-amber-400 hover:scale-105`
                              }`}>
                        <AiIcon name={icon!} size={28} />
                        <span className="text-[10px] font-bold leading-tight">{label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className={`rounded-lg border ${C.border} p-3 ${dark ? 'bg-amber-900/10' : 'bg-amber-50/40'}`}>
                  {postTool === 'adjust' && (
                    <>
                      <label className={`text-[10px] ${C.label} block`}>밝기: <b>{adjBrightness.toFixed(2)}</b></label>
                      <input type="range" min={0.3} max={2.0} step={0.05} value={adjBrightness}
                             onChange={(e) => setAdjBrightness(Number(e.target.value))} disabled={isBusy} className="w-full mb-1.5" />
                      <label className={`text-[10px] ${C.label} block`}>대비: <b>{adjContrast.toFixed(2)}</b></label>
                      <input type="range" min={0.3} max={2.0} step={0.05} value={adjContrast}
                             onChange={(e) => setAdjContrast(Number(e.target.value))} disabled={isBusy} className="w-full mb-1.5" />
                      <label className={`text-[10px] ${C.label} block`}>채도: <b>{adjSaturation.toFixed(2)}</b></label>
                      <input type="range" min={0} max={2.0} step={0.05} value={adjSaturation}
                             onChange={(e) => setAdjSaturation(Number(e.target.value))} disabled={isBusy} className="w-full mb-2" />
                      <button onClick={() => runOp('색감조정',
                              () => aiAdjust(currentRef, { brightness: adjBrightness, contrast: adjContrast, saturation: adjSaturation }), 'manual')}
                              disabled={isBusy}
                              className="bg-gradient-to-r from-amber-500 to-orange-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '색감조정' ? '⏳ 처리중...' : '▶ 조정 적용'}
                      </button>
                    </>
                  )}
                  {postTool === 'filter' && (
                    <>
                      <div className={`text-[10px] ${C.muted} mb-2`}>클릭 즉시 적용</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {COLOR_FILTERS.map((f) => (
                          <button key={f.key} onClick={() => runOp(f.label, () => aiFilter(currentRef, f.key), 'manual')}
                                  disabled={isBusy}
                                  className={`${C.btn} border rounded px-2 py-1.5 text-[10px] font-bold flex items-center gap-1.5`}>
                            <span>{f.emoji}</span><span>{f.label}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {postTool === 'pad-square' && (
                    <>
                      <label className={`text-[10px] ${C.label} block mb-1`}>배경 색상</label>
                      <div className="flex items-center gap-2 mb-2">
                        <input type="color" value={padColor} onChange={(e) => setPadColor(e.target.value)} disabled={isBusy}
                               className="w-12 h-8 rounded border cursor-pointer" />
                        <input type="text" value={padColor} onChange={(e) => setPadColor(e.target.value)} disabled={isBusy}
                               className={`${C.input} border rounded px-2 py-1 text-xs flex-1 font-mono`} />
                      </div>
                      <button onClick={() => runOp('정사각패딩', () => aiPadSquare(currentRef, padColor), 'manual')}
                              disabled={isBusy}
                              className="bg-gradient-to-r from-amber-500 to-orange-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '정사각패딩' ? '⏳ 처리중...' : '▶ 1:1 패딩 적용 (네이버 권장)'}
                      </button>
                    </>
                  )}
                  {postTool === 'frame' && (
                    <>
                      <label className={`text-[10px] ${C.label} block`}>테두리: <b>{frameBorder}px</b></label>
                      <input type="range" min={0} max={50} step={1} value={frameBorder}
                             onChange={(e) => setFrameBorder(Number(e.target.value))} disabled={isBusy} className="w-full mb-1" />
                      {frameBorder > 0 && (
                        <div className="flex items-center gap-2 mb-2">
                          <label className={`text-[10px] ${C.label}`}>색상</label>
                          <input type="color" value={frameBorderColor} onChange={(e) => setFrameBorderColor(e.target.value)} disabled={isBusy}
                                 className="w-8 h-6 rounded border cursor-pointer" />
                        </div>
                      )}
                      <label className={`text-[10px] ${C.label} block`}>둥근 모서리: <b>{frameRounded}px</b></label>
                      <input type="range" min={0} max={80} step={1} value={frameRounded}
                             onChange={(e) => setFrameRounded(Number(e.target.value))} disabled={isBusy} className="w-full mb-1.5" />
                      <label className={`flex items-center gap-1.5 text-[10px] ${C.label} cursor-pointer mb-2`}>
                        <input type="checkbox" checked={frameShadow} onChange={(e) => setFrameShadow(e.target.checked)} />
                        그림자 추가
                      </label>
                      <button onClick={() => runOp('프레임', () => aiFrame(currentRef, {
                                border_px: frameBorder, border_color: frameBorderColor,
                                shadow: frameShadow, rounded: frameRounded,
                              }), 'manual')}
                              disabled={isBusy || (frameBorder === 0 && !frameShadow && frameRounded === 0)}
                              className="bg-gradient-to-r from-amber-500 to-orange-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow">
                        {busy === '프레임' ? '⏳ 처리중...' : '▶ 프레임 적용'}
                      </button>
                    </>
                  )}
                  {postTool === 'ocr' && (
                    <>
                      <div className={`text-[10px] ${C.muted} mb-2`}>이미지에서 한/영 글자 추출 (이미지 변경 X)</div>
                      <button onClick={async () => {
                        setBusy('OCR'); setError(''); setOcrResult(null);
                        try { setOcrResult(await aiOcr(currentRef)); }
                        catch (e) { setError(String((e as Error).message || e)); }
                        finally { setBusy(''); }
                      }} disabled={isBusy}
                              className="bg-gradient-to-r from-amber-500 to-orange-500 text-white w-full rounded py-2 text-xs font-bold disabled:opacity-40 shadow mb-2">
                        {busy === 'OCR' ? '⏳ 인식중...' : '▶ 글자 인식 실행'}
                      </button>
                      {ocrResult && (
                        <div className={`text-[11px] ${C.text} mt-2 p-2 rounded ${dark ? 'bg-black/30' : 'bg-white'} max-h-40 overflow-y-auto`}>
                          <div className={`text-[10px] ${C.muted} mb-1`}>{ocrResult.count}개 검출</div>
                          <pre className="whitespace-pre-wrap break-words font-sans">{ocrResult.all_text || '(글자 없음)'}</pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              )}

              {/* ─────────── Gemini (추후 구현) ─────────── */}
              {tab === 'gemini' && (
              <div className="p-3 space-y-3">
                <div className={`rounded-xl p-5 bg-gradient-to-br from-pink-500/15 to-violet-600/15 border-2 ${dark ? 'border-pink-700/40' : 'border-pink-300'}`}>
                  <div className="text-5xl text-center mb-2">⚡</div>
                  <div className={`text-base font-bold text-center mb-1 ${dark ? 'text-pink-300' : 'text-pink-700'}`}>
                    Gemini 2.5 Flash Image
                  </div>
                  <div className={`text-[10px] text-center ${C.muted} mb-3`}>
                    Google API · 자연어 편집 · 건당 ~$0.04
                  </div>
                  <div className={`inline-block px-3 py-1 rounded-full text-[10px] font-bold mx-auto block text-center w-fit ${
                    dark ? 'bg-amber-900/50 text-amber-300' : 'bg-amber-100 text-amber-700'
                  }`}>
                    🚧 추후 구현
                  </div>
                </div>

                <div className={`rounded-lg border ${C.border} p-3 text-[10px] ${C.sub} leading-relaxed`}>
                  <div className={`font-bold ${C.text} mb-1`}>📋 활성화 방법</div>
                  <ol className="list-decimal list-inside space-y-1">
                    <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-violet-500 underline">aistudio.google.com</a> 에서 API key 발급 (무료, 5분)</li>
                    <li><code className={`px-1 rounded ${dark ? 'bg-black/40' : 'bg-gray-200'}`}>.env</code> 에 <code className={`px-1 rounded ${dark ? 'bg-black/40' : 'bg-gray-200'}`}>GEMINI_API_KEY=...</code> 추가</li>
                    <li><code className={`px-1 rounded ${dark ? 'bg-black/40' : 'bg-gray-200'}`}>pm2 restart naverterms-image-ai</code></li>
                  </ol>
                  <div className={`mt-2 pt-2 border-t ${C.border} text-[9px] ${C.muted}`}>
                    이미 백엔드는 준비됨. API key 만 등록하면 즉시 활성화.
                  </div>
                </div>

                {/* 비활성 프리뷰 버튼들 */}
                <div className="opacity-40 pointer-events-none">
                  <div className="grid grid-cols-2 gap-2">
                    {GEN_PRESETS.slice(0, 4).map((p) => (
                      <div key={p.label} className={`${C.btn} border rounded px-2 py-1.5 text-[10px] flex items-center gap-1`}>
                        {p.emoji} {p.label}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 bg-gradient-to-r from-pink-500 to-violet-600 text-white rounded py-2 text-xs font-bold text-center">
                    ⚡ Gemini 실행 (비활성)
                  </div>
                </div>
              </div>
              )}

            </div> {/* /본문 */}

            {/* 에러 */}
            {error && (
              <div className={`p-2 mx-2 mb-1 rounded text-[10px] text-rose-500 leading-snug break-words border border-rose-500/30 font-mono shrink-0 ${dark ? 'bg-rose-900/20' : 'bg-rose-50'}`}>
                ⚠ {error}
              </div>
            )}

            {/* 푸터: 갤러리 + Undo + Reset + 저장 */}
            <div className={`p-3 border-t ${C.border} space-y-2 ${C.panel} shrink-0`}>
              <div className="grid grid-cols-3 gap-1.5">
                <button onClick={onOpenGallery} disabled={!onOpenGallery}
                        className={`${C.btn} border rounded py-1.5 flex flex-col items-center gap-0.5 disabled:opacity-30 text-[10px]`}>
                  <AiIcon name="gallery" size={20} />
                  <span>갤러리 <span className={`font-mono ${variantCount >= 18 ? 'text-rose-500' : variantCount >= 12 ? 'text-amber-500' : ''}`}>{variantCount}/{variantMax}</span></span>
                </button>
                <button onClick={undo} disabled={isBusy || history.length === 0}
                        className={`${C.btn} border rounded py-1.5 flex flex-col items-center gap-0.5 disabled:opacity-30 text-[10px]`}>
                  <AiIcon name="undo" size={20} />
                  <span>한단계 취소</span>
                </button>
                <button onClick={resetLocal} disabled={isBusy || history.length === 0}
                        className={`${C.btn} border rounded py-1.5 flex flex-col items-center gap-0.5 disabled:opacity-30 text-[10px]`}>
                  <AiIcon name="reset" size={20} />
                  <span>처음으로</span>
                </button>
              </div>

              <button onClick={() => onSave(true)}
                      disabled={isBusy || !currentB64 || variantCount >= variantMax}
                      className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white w-full rounded-lg py-2.5 font-bold flex items-center justify-center gap-2 disabled:opacity-40 shadow-md hover:shadow-lg transition-shadow">
                <AiIcon name="save-activate" size={22} />
                <span className="text-sm">{busy === 'save-activate' ? '⏳ 저장중...' : '풀에 추가 + 활성화 → 닫기'}</span>
              </button>

              <button onClick={() => onSave(false)}
                      disabled={isBusy || !currentB64 || variantCount >= variantMax}
                      className="bg-gradient-to-r from-violet-600 to-purple-600 text-white w-full rounded-lg py-2 font-bold flex items-center justify-center gap-2 disabled:opacity-40 shadow hover:shadow-md transition-shadow">
                <AiIcon name="save-pool" size={20} />
                <span className="text-xs">{busy === 'save-pool' ? '⏳ 저장중...' : '풀에만 추가 (편집 계속)'}</span>
              </button>

              {variantCount >= variantMax && (
                <div className="text-[10px] text-rose-500 text-center font-bold">
                  ⚠ 풀 가득참 — 갤러리에서 삭제 필요
                </div>
              )}
              <div className={`text-[9px] ${C.muted} text-center`}>
                원본 image_large 는 항상 보존됩니다
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
