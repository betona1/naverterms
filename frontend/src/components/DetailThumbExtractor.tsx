/**
 * DetailThumbExtractor — 상세 HTML 페이지에서 영역을 선택해 썸네일 추출.
 *
 * UX (윈도우 캡쳐 도구 패턴):
 *  - 빈 영역 클릭+드래그   → 새 사각형 즉시 그리기
 *  - 사각형 가운데 드래그   → 이동
 *  - 핸들(8개) 드래그       → 리사이즈
 *  - "🎯 화면 중앙으로"     → 현재 viewport 중앙에 selection 재배치
 *  - 비율 잠금 (free/1:1 등)
 *
 * 캡쳐: html2canvas-pro (Tailwind v4 oklch 지원) → 사각형 영역 crop → WEBP base64.
 * 이미지 CORS: detail_html 의 img src 를 /api/smartstore/image-proxy/ 로 재작성.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import html2canvas from 'html2canvas-pro';
import { addVariant, fetchVariants } from '../api/naverProductApi';

type AspectMode = 'free' | '1:1' | '4:3' | '3:4' | '16:9';
type DragMode = 'draw' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface Sel { x: number; y: number; w: number; h: number }
const MIN_SIZE = 30;
const DEFAULT_SEL: Sel = { x: 40, y: 40, w: 300, h: 300 };

interface Props {
  productId: number;
  productCode: string;
  productName: string;
  detailHtml: string;
  dark: boolean;
  onClose: () => void;
  onSaved: (editedUrl: string | null) => void;
  onSendToEditor?: (imageB64: string) => void;
  onOpenGallery?: () => void;
}

const ASPECTS: Record<AspectMode, number | null> = {
  free: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
};

function rewriteImgSrc(html: string): string {
  return html.replace(
    /<img\b([^>]*?)\s(?:src|data-src|data-original)\s*=\s*("|')([^"']+)\2([^>]*?)>/gi,
    (_m, before, q, url, after) => {
      if (!url.startsWith('http')) return _m;
      const proxied = `/api/smartstore/image-proxy/?url=${encodeURIComponent(url)}`;
      const hasCross = /crossorigin\s*=/i.test(before + after);
      const crossAttr = hasCross ? '' : ' crossorigin="anonymous"';
      return `<img${before} src=${q}${proxied}${q}${after}${crossAttr}>`;
    },
  );
}

export function DetailThumbExtractor({
  productId, productCode, productName, detailHtml,
  dark, onClose, onSaved, onSendToEditor, onOpenGallery,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [sel, setSel] = useState<Sel>(DEFAULT_SEL);
  const [aspect, setAspect] = useState<AspectMode>('1:1');
  const [capturedB64, setCapturedB64] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [contentReady, setContentReady] = useState(false);
  const [contentSize, setContentSize] = useState({ w: 800, h: 600 });

  const processedHtml = useMemo(() => rewriteImgSrc(detailHtml || ''), [detailHtml]);

  const C = useMemo(() => ({
    panel: dark ? 'bg-[#1c1c2e]' : 'bg-white',
    bg: dark ? 'bg-[#0a0a16]' : 'bg-gray-100',
    border: dark ? 'border-[#2a2a40]' : 'border-gray-200',
    text: dark ? 'text-white' : 'text-gray-900',
    muted: dark ? 'text-gray-400' : 'text-gray-500',
    sub: dark ? 'text-gray-300' : 'text-gray-700',
    btn: dark
      ? 'bg-[#252540] hover:bg-[#2a2a50] border-[#3a3a55] text-gray-100'
      : 'bg-white hover:bg-gray-50 border-gray-300 text-gray-800',
    btnGreen: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    btnSky: 'bg-sky-600 hover:bg-sky-700 text-white',
    btnPurple: 'bg-violet-600 hover:bg-violet-700 text-white',
    btnAmber: 'bg-amber-600 hover:bg-amber-700 text-white',
  }), [dark]);

  // 컨텐츠 이미지 로딩 완료 감지 + 사이즈 측정
  useEffect(() => {
    if (!contentRef.current) return;
    const imgs = Array.from(contentRef.current.querySelectorAll('img'));
    const measure = () => {
      if (contentRef.current) {
        setContentSize({
          w: contentRef.current.scrollWidth,
          h: contentRef.current.scrollHeight,
        });
      }
    };
    if (imgs.length === 0) { setContentReady(true); measure(); return; }
    let remaining = imgs.length;
    const done = () => {
      remaining -= 1;
      measure();
      if (remaining <= 0) { setContentReady(true); measure(); }
    };
    imgs.forEach((img) => {
      if (img.complete) done();
      else {
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      }
    });
    // 추가로 ResizeObserver
    const ro = new ResizeObserver(measure);
    ro.observe(contentRef.current);
    return () => {
      imgs.forEach((img) => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
      });
      ro.disconnect();
    };
  }, [processedHtml]);

  // ── 통합 드래그 핸들러 ─────────────────────────────────
  const dragRef = useRef<{
    mode: DragMode;
    startMx: number; startMy: number;
    startSel: Sel;
    pointerId: number;
    captureEl: HTMLElement;
  } | null>(null);

  function _wrapperCoords(e: { clientX: number; clientY: number }): { x: number; y: number } {
    if (!wrapperRef.current) return { x: 0, y: 0 };
    const r = wrapperRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function _clampSel(s: Sel, mode: DragMode): Sel {
    let { x, y, w, h } = s;
    const maxW = contentSize.w;
    const maxH = contentSize.h;
    if (w < MIN_SIZE) { if (mode.includes('w')) x -= (MIN_SIZE - w); w = MIN_SIZE; }
    if (h < MIN_SIZE) { if (mode.includes('n')) y -= (MIN_SIZE - h); h = MIN_SIZE; }
    if (x < 0) { if (mode === 'move' || mode === 'draw') x = 0; else { w += x; x = 0; } }
    if (y < 0) { if (mode === 'move' || mode === 'draw') y = 0; else { h += y; y = 0; } }
    if (x + w > maxW) { if (mode === 'move') x = maxW - w; else w = maxW - x; }
    if (y + h > maxH) { if (mode === 'move') y = maxH - h; else h = maxH - y; }
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  const startDrag = useCallback((mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { x: mx, y: my } = _wrapperCoords(e);
    const startSel: Sel = mode === 'draw'
      ? { x: mx, y: my, w: 0, h: 0 }
      : { ...sel };
    if (mode === 'draw') setSel(startSel);
    const captureEl = e.currentTarget as HTMLElement;
    captureEl.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode, startMx: mx, startMy: my, startSel,
      pointerId: e.pointerId, captureEl,
    };
  }, [sel]);

  const onWrapperMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const { x: mx, y: my } = _wrapperCoords(e);
    const dx = mx - d.startMx;
    const dy = my - d.startMy;
    const ratio = ASPECTS[aspect];
    let { x, y, w, h } = d.startSel;

    if (d.mode === 'draw') {
      // 시작점 vs 현재점으로 사각형 정의
      const sx = d.startSel.x;
      const sy = d.startSel.y;
      x = Math.min(sx, mx);
      y = Math.min(sy, my);
      w = Math.abs(mx - sx);
      h = Math.abs(my - sy);
      if (ratio) {
        // 작은 변에 맞춤 (사용자가 의도한 영역을 넘지 않도록)
        if (w / ratio > h) h = w / ratio;
        else w = h * ratio;
      }
    } else if (d.mode === 'move') {
      x += dx; y += dy;
    } else {
      if (d.mode.includes('e')) w += dx;
      if (d.mode.includes('w')) { x += dx; w -= dx; }
      if (d.mode.includes('s')) h += dy;
      if (d.mode.includes('n')) { y += dy; h -= dy; }
      if (ratio) {
        if (d.mode.length === 2) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            const newH = w / ratio;
            if (d.mode.includes('n')) y += (h - newH);
            h = newH;
          } else {
            const newW = h * ratio;
            if (d.mode.includes('w')) x += (w - newW);
            w = newW;
          }
        } else if (d.mode === 'e' || d.mode === 'w') {
          h = w / ratio;
        } else {
          w = h * ratio;
        }
      }
    }

    setSel(_clampSel({ x, y, w, h }, d.mode));
  }, [aspect, contentSize]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* noop */ }
    // draw 모드에서 너무 작게 끝났으면 최소 크기 보장
    if (d.mode === 'draw') {
      setSel((s) => _clampSel(s, 'draw'));
    }
    dragRef.current = null;
    void e;
  }, [contentSize]);

  // aspect 변경 시 비율 재조정
  useEffect(() => {
    const ratio = ASPECTS[aspect];
    if (!ratio) return;
    setSel((s) => _clampSel({ ...s, h: s.w / ratio }, 'move'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  // viewport 중앙으로 selection 이동
  function centerInViewport() {
    if (!scrollRef.current || !wrapperRef.current) return;
    const sc = scrollRef.current;
    const cx = sc.scrollLeft + sc.clientWidth / 2;
    const cy = sc.scrollTop + sc.clientHeight / 2;
    setSel((s) => _clampSel({
      x: cx - s.w / 2,
      y: cy - s.h / 2,
      w: s.w,
      h: s.h,
    }, 'move'));
  }

  // selection 을 viewport 안으로 스크롤
  function scrollSelIntoView() {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      left: Math.max(0, sel.x + sel.w / 2 - scrollRef.current.clientWidth / 2),
      top: Math.max(0, sel.y + sel.h / 2 - scrollRef.current.clientHeight / 2),
      behavior: 'smooth',
    });
  }

  // ── 캡쳐 ─────────────────────────────────────────────────
  async function capture() {
    if (!contentRef.current) { setError('content 요소 없음'); return; }
    if (sel.w < MIN_SIZE || sel.h < MIN_SIZE) { setError('선택 영역이 너무 작습니다'); return; }
    setBusy('capture');
    setError('');
    try {
      const canvas = await html2canvas(contentRef.current, {
        useCORS: true,
        backgroundColor: '#ffffff',
        scale: 1,
        logging: false,
        // 컨텐츠 전체 크기 기준으로 렌더
        width: contentSize.w,
        height: contentSize.h,
        windowWidth: contentSize.w,
        windowHeight: contentSize.h,
      });
      const out = document.createElement('canvas');
      out.width = Math.round(sel.w);
      out.height = Math.round(sel.h);
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      const scaleX = canvas.width / contentSize.w;
      const scaleY = canvas.height / contentSize.h;
      ctx.drawImage(
        canvas,
        sel.x * scaleX, sel.y * scaleY,
        sel.w * scaleX, sel.h * scaleY,
        0, 0, sel.w, sel.h,
      );
      const dataUrl = out.toDataURL('image/webp', 0.92);
      const b64 = dataUrl.split(',')[1] || null;
      if (!b64) throw new Error('toDataURL 빈 결과');
      setCapturedB64(b64);
    } catch (e) {
      const err = e as Error;
      setError(`캡쳐 실패: ${err.name || ''} ${err.message || String(e)}`);
      console.error('[DetailThumbExtractor] capture failed:', e);
    } finally {
      setBusy('');
    }
  }

  async function save(activate: boolean) {
    if (!capturedB64) return;
    setBusy(activate ? 'save-activate' : 'save-pool'); setError('');
    try {
      // 풀 카운트 사전 체크
      const cur = await fetchVariants(productId);
      if (cur.count >= cur.max) {
        throw new Error(`풀 가득참 (${cur.count}/${cur.max}). 갤러리에서 삭제 후 재시도.`);
      }
      const r = await addVariant(
        productId, capturedB64, 'detail_capture',
        { region: sel, aspect },
        `상세캡쳐 ${sel.w}×${sel.h}`,
        activate,
      );
      if (!r.ok) throw new Error(r.error || 'save failed');
      if (activate) {
        onSaved(r.image_url || null);
        onClose();
      } else {
        // 풀에만 저장 — 캡쳐창 유지, 다른 영역 시도 가능
        setCapturedB64(null);
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  function sendToEditor() {
    if (!capturedB64 || !onSendToEditor) return;
    onSendToEditor(capturedB64);
    onClose();
  }

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const isBusy = busy !== '';
  const previewSrc = capturedB64 ? `data:image/webp;base64,${capturedB64}` : null;

  return (
    <div className="fixed inset-0 z-[210] bg-black/75 flex items-center justify-center p-3"
         onClick={onClose}>
      <div className={`${C.panel} ${C.border} border rounded-xl shadow-2xl w-full max-w-[1500px] h-[94vh] flex flex-col`}
           onClick={(e) => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${C.border}`}>
          <div className="min-w-0">
            <div className={`text-sm font-bold ${C.text} flex items-center gap-2`}>
              📐 상세페이지 → 썸네일 추출
              <span className={`text-[10px] font-mono ${C.muted}`}>{productCode}</span>
            </div>
            <div className={`text-xs ${C.muted} truncate max-w-[1100px]`}>{productName}</div>
          </div>
          <button onClick={onClose} className={`${C.btn} border rounded px-3 py-1 text-xs`}>
            ✕ 닫기 (Esc)
          </button>
        </div>

        <div className="flex-1 flex min-h-0 overflow-hidden">

          {/* ── 좌측: 상세 HTML + 선택영역 ── */}
          <div className={`flex-1 min-w-0 flex flex-col ${C.bg}`}>
            {/* 컨트롤 바 */}
            <div className={`flex items-center gap-2 px-3 py-2 border-b ${C.border} ${C.panel} text-xs flex-wrap`}>
              <span className={`font-bold ${C.text}`}>비율:</span>
              {(['free', '1:1', '4:3', '3:4', '16:9'] as AspectMode[]).map((a) => (
                <button key={a} onClick={() => setAspect(a)}
                        className={`px-2 py-0.5 rounded border ${
                          aspect === a
                            ? 'bg-violet-600 border-violet-600 text-white'
                            : C.btn}`}>
                  {a}
                </button>
              ))}
              <span className={`mx-2 ${C.muted}`}>|</span>
              <button onClick={centerInViewport}
                      className={`${C.btnAmber} px-2 py-0.5 rounded text-[11px]`}>
                🎯 화면 중앙으로
              </button>
              <button onClick={scrollSelIntoView}
                      className={`${C.btn} border px-2 py-0.5 rounded text-[11px]`}>
                ↗ 선택영역으로 스크롤
              </button>
              <span className={`mx-2 ${C.muted}`}>|</span>
              <span className={C.sub}>영역:</span>
              <span className={`font-mono ${C.text}`}>{sel.x},{sel.y}</span>
              <span className={C.muted}>·</span>
              <span className={`font-mono font-bold ${C.text}`}>{sel.w}×{sel.h}px</span>
              {!contentReady && (
                <span className={`ml-auto text-amber-500 animate-pulse text-[11px]`}>⏳ 이미지 로드 중...</span>
              )}
              {contentReady && (
                <span className={`ml-auto ${C.muted} text-[10px]`}>
                  컨텐츠 {contentSize.w}×{contentSize.h}px
                </span>
              )}
            </div>

            {/* 빈 영역 클릭+드래그 안내 */}
            <div className={`px-3 py-1.5 border-b ${C.border} ${dark ? 'bg-violet-900/20' : 'bg-violet-50'} text-[11px] ${dark ? 'text-violet-200' : 'text-violet-800'}`}>
              💡 <b>빈 영역을 클릭+드래그</b>해서 새로 그리거나, 가운데 잡고 이동, 모서리로 크기 조절
            </div>

            {/* 스크롤 컨테이너 */}
            <div ref={scrollRef}
                 className="flex-1 overflow-auto relative"
                 style={{ minWidth: 0 }}>

              {/* wrapper — contentRef 크기로 자연스레 늘어남 (inline-block) */}
              <div ref={wrapperRef}
                   className="relative inline-block min-w-full">

                {/* 실제 상세 HTML — 자연 플로우로 wrapper 크기 결정 */}
                <div ref={contentRef}
                     className="bg-white block [&_*]:pointer-events-none"
                     dangerouslySetInnerHTML={{ __html: processedHtml }} />

                {/* 클릭 캐처 — 절대 위치 transparent overlay, 빈 영역 클릭 감지 */}
                <div className="absolute inset-0 cursor-crosshair"
                     onPointerDown={(e) => {
                       if (e.target === e.currentTarget) startDrag('draw', e);
                     }}
                     onPointerMove={onWrapperMove}
                     onPointerUp={endDrag} />

                {/* 어두운 마스킹 (선택 외부) — pointer-events-none 으로 클릭 통과 */}
                {contentReady && sel.w > 0 && (
                  <>
                    <div className="absolute bg-black/55 pointer-events-none"
                         style={{ left: 0, top: 0, right: 0, height: sel.y }} />
                    <div className="absolute bg-black/55 pointer-events-none"
                         style={{ left: 0, right: 0, top: sel.y + sel.h, bottom: 0 }} />
                    <div className="absolute bg-black/55 pointer-events-none"
                         style={{ left: 0, top: sel.y, width: sel.x, height: sel.h }} />
                    <div className="absolute bg-black/55 pointer-events-none"
                         style={{ left: sel.x + sel.w, top: sel.y, right: 0, height: sel.h }} />
                  </>
                )}

                {/* 선택 사각형 */}
                {contentReady && sel.w > 0 && sel.h > 0 && (
                  <div className="absolute border-2 border-violet-400 shadow-[0_0_0_1px_rgba(255,255,255,0.7),0_8px_25px_rgba(0,0,0,0.5)]"
                       style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}>
                    {/* 중앙: 이동 */}
                    <div className="absolute inset-2 cursor-move"
                         onPointerDown={(e) => startDrag('move', e)}
                         onPointerMove={onWrapperMove}
                         onPointerUp={endDrag} />

                    {/* 핸들 8개 — 16x16 으로 키움, 잡기 쉽게 */}
                    {([
                      ['nw', 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize'],
                      ['ne', 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize'],
                      ['sw', 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize'],
                      ['se', 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize'],
                      ['n', 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize'],
                      ['s', 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize'],
                      ['w', 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize'],
                      ['e', 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-ew-resize'],
                    ] as [DragMode, string][]).map(([handle, cls]) => (
                      <div key={handle}
                           onPointerDown={(e) => startDrag(handle, e)}
                           onPointerMove={onWrapperMove}
                           onPointerUp={endDrag}
                           className={`absolute w-4 h-4 bg-violet-500 border-2 border-white rounded-sm shadow-md ${cls}`} />
                    ))}

                    {/* 크기 라벨 */}
                    <div className="absolute -top-7 left-1/2 -translate-x-1/2 text-[11px] bg-violet-600 text-white font-mono font-bold px-2 py-0.5 rounded whitespace-nowrap shadow-lg">
                      {sel.w}×{sel.h}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── 우측: 캡쳐 미리보기 + 액션 ── */}
          <div className={`w-[380px] flex-shrink-0 ${C.panel} border-l ${C.border} flex flex-col overflow-y-auto`}>

            <div className={`p-3 border-b ${C.border}`}>
              <div className={`text-xs font-bold ${C.text} mb-2 flex items-center justify-between`}>
                <span>✨ 캡쳐 미리보기</span>
                {capturedB64 && (
                  <span className={`text-[10px] ${C.muted} font-mono`}>
                    {Math.round(capturedB64.length * 0.75 / 1024)}KB
                  </span>
                )}
              </div>
              <div className={`relative bg-[repeating-conic-gradient(#80808022_0_25%,transparent_0_50%)] bg-[length:20px_20px] rounded border ${C.border} flex items-center justify-center`}
                   style={{ minHeight: 240, maxHeight: 320 }}>
                {previewSrc ? (
                  <img src={previewSrc} alt="captured"
                       className="max-w-full max-h-[320px] object-contain" />
                ) : (
                  <div className={`text-xs ${C.muted} italic p-6 text-center leading-relaxed`}>
                    좌측에서 영역 지정 후<br/>
                    아래 <b>📷 캡쳐</b> 클릭
                  </div>
                )}
              </div>
            </div>

            <div className={`p-3 border-b ${C.border}`}>
              <button onClick={capture}
                      disabled={isBusy || !contentReady || sel.w < MIN_SIZE}
                      className={`${C.btnSky} w-full rounded py-2.5 text-sm font-bold disabled:opacity-40 flex items-center justify-center gap-2`}>
                {busy === 'capture' ? '⏳ 캡쳐 중...' : '📷 선택 영역 캡쳐'}
              </button>
              {!contentReady && (
                <div className={`text-[10px] ${C.muted} text-center mt-1.5`}>
                  이미지 로드 완료 대기중...
                </div>
              )}
            </div>

            <div className={`p-3 border-b ${C.border} space-y-2`}>
              <div className={`text-[10px] font-bold ${C.muted}`}>캡쳐 후</div>
              <button onClick={() => save(true)}
                      disabled={isBusy || !capturedB64}
                      className={`${C.btnGreen} w-full rounded py-2 text-sm font-bold disabled:opacity-40`}>
                {busy === 'save-activate' ? '⏳ 저장중...' : '💾 풀에 추가 + 활성화 → 닫기'}
              </button>
              <button onClick={() => save(false)}
                      disabled={isBusy || !capturedB64}
                      className={`${C.btnPurple} w-full rounded py-1.5 text-xs font-bold disabled:opacity-40`}>
                {busy === 'save-pool' ? '⏳ 저장중...' : '📥 풀에만 추가 (다음 영역 캡쳐 계속)'}
              </button>
              {onSendToEditor && (
                <button onClick={sendToEditor}
                        disabled={isBusy || !capturedB64}
                        className={`${C.btn} border w-full rounded py-1.5 text-xs font-bold disabled:opacity-40`}>
                  🪄 AI 편집기로 보내기 (저장 안함)
                </button>
              )}
              {onOpenGallery && (
                <button onClick={() => { onOpenGallery(); onClose(); }}
                        className={`${C.btn} border w-full rounded py-1 text-[11px]`}>
                  🗂 갤러리 열기 ({sel.w}×{sel.h} 픽셀)
                </button>
              )}
            </div>

            {error && (
              <div className={`p-3 text-[11px] text-rose-500 leading-snug break-words border-b ${C.border} font-mono`}>
                ⚠ {error}
              </div>
            )}

            <div className="mt-auto p-3">
              <div className={`text-[10px] ${C.muted} leading-relaxed`}>
                <b>💡 단축키 / 팁</b>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>빈 영역 클릭+드래그 → 새 영역</li>
                  <li>가운데 드래그 → 이동</li>
                  <li>모서리 8개 → 크기 조절</li>
                  <li>비율 1:1 추천 (썸네일 표준)</li>
                  <li>Esc → 닫기</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
