/**
 * ThumbnailVariantGallery — 상품별 변형 풀 (최대 20개) 갤러리.
 *
 * 기능:
 *  - 카드 그리드 (반응형 5/4/3/2 columns)
 *  - source_type 별 색상 뱃지 + 시간/크기/라벨
 *  - 클릭 → 큰 미리보기 사이드패널
 *  - 📌 활성으로 설정 / ✏️ 라벨 수정 / 🗑 삭제
 *  - 상단: 카운트 + "원본 복귀" / "전체 삭제"
 *  - 외부에서 add 콜백 받음 (Editor 에서 새로 생성한 것 즉시 추가)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchVariants, deleteVariant, activateVariant, patchVariantLabel,
  type ThumbnailVariant, type ThumbnailSourceType,
} from '../api/naverProductApi';

interface Props {
  productId: number;
  productCode: string;
  productName: string;
  dark: boolean;
  onClose: () => void;
  /** 활성 변형 변경되거나 풀 변화 시 호출 — 부모가 상품 detail 새로고침 */
  onChanged: (activeUrl: string | null) => void;
  /** 외부에서 "AI 편집 열기" 같은 액션 트리거 */
  onOpenEditor?: () => void;
  onOpenExtract?: () => void;
}

const SOURCE_BADGE: Record<ThumbnailSourceType, { label: string; color: string; emoji: string }> = {
  manual:         { label: '수동',          color: 'bg-gray-500',     emoji: '✋' },
  ai_edit:        { label: 'AI편집',        color: 'bg-violet-600',   emoji: '🪄' },
  gemini:         { label: 'Gemini',        color: 'bg-pink-600',     emoji: '🎨' },
  flux:           { label: 'FLUX',          color: 'bg-rose-600',     emoji: '🎨' },
  detail_capture: { label: '상세캡쳐',      color: 'bg-sky-600',      emoji: '📐' },
  flip_h:         { label: '좌우반전',      color: 'bg-amber-600',    emoji: '🔄' },
  flip_v:         { label: '상하반전',      color: 'bg-amber-600',    emoji: '🔃' },
  bg_remove:      { label: '배경제거',      color: 'bg-emerald-600',  emoji: '🪄' },
  text_remove:    { label: '글씨제거',      color: 'bg-emerald-600',  emoji: '✏️' },
  upscale:        { label: '선명도+',       color: 'bg-amber-600',    emoji: '🔍' },
  rotate:         { label: '회전',          color: 'bg-violet-500',   emoji: '🔁' },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '방금';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}분 전`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}시간 전`;
  return `${Math.floor(ms / 86_400_000)}일 전`;
}

function formatBytes(b: number | null): string {
  if (!b) return '—';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

export function ThumbnailVariantGallery({
  productId, productCode, productName, dark,
  onClose, onChanged, onOpenEditor, onOpenExtract,
}: Props) {
  const [items, setItems] = useState<ThumbnailVariant[]>([]);
  const [count, setCount] = useState(0);
  const [max, setMax] = useState(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [selected, setSelected] = useState<ThumbnailVariant | null>(null);
  const [editLabelId, setEditLabelId] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState('');

  const C = useMemo(() => ({
    panel: dark ? 'bg-[#1c1c2e]' : 'bg-white',
    bg: dark ? 'bg-[#0a0a16]' : 'bg-gray-50',
    border: dark ? 'border-[#2a2a40]' : 'border-gray-200',
    text: dark ? 'text-white' : 'text-gray-900',
    muted: dark ? 'text-gray-400' : 'text-gray-500',
    sub: dark ? 'text-gray-300' : 'text-gray-700',
    card: dark ? 'bg-[#252540] hover:bg-[#2a2a50]' : 'bg-white hover:bg-gray-50',
    btn: dark
      ? 'bg-[#252540] hover:bg-[#2a2a50] border-[#3a3a55] text-gray-100'
      : 'bg-white hover:bg-gray-50 border-gray-300 text-gray-800',
    btnGreen: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    btnRose: 'bg-rose-600 hover:bg-rose-700 text-white',
    btnSky: 'bg-sky-600 hover:bg-sky-700 text-white',
    btnPurple: 'bg-violet-600 hover:bg-violet-700 text-white',
    btnAmber: 'bg-amber-600 hover:bg-amber-700 text-white',
    input: dark
      ? 'bg-[#0f0f1a] border-[#2a2a40] text-white'
      : 'bg-white border-gray-300 text-gray-900',
  }), [dark]);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await fetchVariants(productId);
      setItems(r.items);
      setCount(r.count);
      setMax(r.max);
      // 활성 변형 또는 선택 변형 유지
      const active = r.items.find((v) => v.is_active) || null;
      setSelected((cur) => cur ? (r.items.find((v) => v.id === cur.id) || active) : active);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  async function onActivate(v: ThumbnailVariant) {
    setBusy(`activate-${v.id}`); setError('');
    try {
      const r = await activateVariant(productId, v.id);
      if (!r.ok) throw new Error(r.error || 'activate failed');
      await reload();
      onChanged(v.image_url);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  async function onDelete(v: ThumbnailVariant) {
    if (!confirm(`이 변형을 삭제할까요?\n[${SOURCE_BADGE[v.source_type]?.label}] ${v.label || ''}`)) return;
    setBusy(`del-${v.id}`); setError('');
    try {
      const r = await deleteVariant(productId, v.id);
      if (!r.ok) throw new Error(r.error || 'delete failed');
      // 활성 변형 삭제 시 edited_image_url 도 비워짐 → 원본 복귀
      if (v.is_active) onChanged(null);
      if (selected?.id === v.id) setSelected(null);
      await reload();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  async function onSaveLabel(v: ThumbnailVariant) {
    setBusy(`label-${v.id}`); setError('');
    try {
      const r = await patchVariantLabel(productId, v.id, labelDraft);
      if (!r.ok) throw new Error(r.error || 'label failed');
      setEditLabelId(null);
      await reload();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  const isBusy = busy !== '';
  const remaining = max - count;
  const remainingColor = remaining <= 3
    ? 'text-rose-500' : remaining <= 7 ? 'text-amber-500' : 'text-emerald-500';

  return (
    <div className="fixed inset-0 z-[220] bg-black/75 flex items-center justify-center p-3"
         onClick={onClose}>
      <div className={`${C.panel} ${C.border} border rounded-xl shadow-2xl w-full max-w-[1500px] h-[94vh] flex flex-col`}
           onClick={(e) => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${C.border}`}>
          <div className="min-w-0 flex items-center gap-3">
            <div className={`text-sm font-bold ${C.text} flex items-center gap-2`}>
              🖼 썸네일 변형 갤러리
              <span className={`text-[10px] font-mono ${C.muted}`}>{productCode}</span>
            </div>
            <div className={`text-xs ${C.muted} truncate max-w-[700px]`}>{productName}</div>
            <span className={`text-xs font-mono font-bold ${remainingColor}`}>
              {count}/{max}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {onOpenEditor && (
              <button onClick={() => { onOpenEditor(); onClose(); }}
                      className={`${C.btnPurple} px-3 py-1 rounded text-xs font-bold`}>
                🪄 AI 편집 열기
              </button>
            )}
            {onOpenExtract && (
              <button onClick={() => { onOpenExtract(); onClose(); }}
                      className={`${C.btnSky} px-3 py-1 rounded text-xs font-bold`}>
                📐 상세 캡쳐 열기
              </button>
            )}
            <button onClick={onClose} className={`${C.btn} border rounded px-3 py-1 text-xs`}>
              ✕ 닫기 (Esc)
            </button>
          </div>
        </div>

        {/* 본문 */}
        <div className="flex-1 flex min-h-0 overflow-hidden">

          {/* ── 좌측: 카드 그리드 ── */}
          <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${C.bg}`}>
            {loading ? (
              <div className={`text-center text-xs ${C.muted} py-12 animate-pulse`}>로딩중...</div>
            ) : items.length === 0 ? (
              <div className={`flex flex-col items-center justify-center h-full text-center ${C.muted}`}>
                <div className="text-6xl mb-3">📭</div>
                <div className="text-sm">아직 저장된 변형이 없습니다</div>
                <div className="text-[11px] mt-1">AI 편집 / 상세 캡쳐 / Gemini 생성 후 자동 저장됩니다</div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {items.map((v) => {
                  const badge = SOURCE_BADGE[v.source_type] || SOURCE_BADGE.manual;
                  const isSel = selected?.id === v.id;
                  return (
                    <div key={v.id}
                         onClick={() => setSelected(v)}
                         className={`${C.card} ${C.border} border rounded-lg p-2 cursor-pointer transition-all relative group ${
                           isSel ? 'ring-2 ring-violet-500' : ''
                         } ${v.is_active ? 'ring-2 ring-emerald-500' : ''}`}>
                      {/* 활성 뱃지 */}
                      {v.is_active && (
                        <div className="absolute -top-2 -right-2 bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg z-10">
                          ✓ 활성
                        </div>
                      )}
                      {/* 이미지 */}
                      <div className="aspect-square rounded overflow-hidden bg-[repeating-conic-gradient(#80808022_0_25%,transparent_0_50%)] bg-[length:16px_16px] mb-1.5">
                        <img src={v.image_url} alt=""
                             loading="lazy"
                             className="w-full h-full object-contain" />
                      </div>
                      {/* 메타 */}
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded text-white font-bold ${badge.color}`}>
                          {badge.emoji} {badge.label}
                        </span>
                        <span className={`text-[9px] font-mono ${C.muted}`}>
                          {timeAgo(v.created_at)}
                        </span>
                      </div>
                      <div className={`text-[9px] ${C.muted} font-mono flex items-center justify-between`}>
                        <span>{v.width}×{v.height}</span>
                        <span>{formatBytes(v.bytes)}</span>
                      </div>
                      {v.label && (
                        <div className={`text-[10px] ${C.text} truncate mt-0.5`} title={v.label}>
                          {v.label}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* 빈 슬롯 안내 */}
                {remaining > 0 && remaining <= 10 && (
                  <div className={`${C.border} border-2 border-dashed rounded-lg aspect-square flex items-center justify-center text-center ${C.muted}`}>
                    <div className="text-[11px]">
                      <div className="text-3xl mb-1">+</div>
                      <div>{remaining}개 더 저장 가능</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── 우측: 큰 미리보기 + 액션 ── */}
          <div className={`w-[380px] flex-shrink-0 ${C.panel} border-l ${C.border} flex flex-col overflow-y-auto`}>
            {selected ? (
              <>
                <div className={`p-3 border-b ${C.border}`}>
                  <div className={`text-xs font-bold ${C.text} mb-2 flex items-center justify-between`}>
                    <span>🔍 변형 #{selected.id}</span>
                    {selected.is_active && (
                      <span className="text-[10px] bg-emerald-500 text-white px-2 py-0.5 rounded-full font-bold">
                        ✓ 현재 활성
                      </span>
                    )}
                  </div>
                  <div className={`relative bg-[repeating-conic-gradient(#80808022_0_25%,transparent_0_50%)] bg-[length:20px_20px] rounded border ${C.border} flex items-center justify-center min-h-[260px] max-h-[360px] overflow-hidden`}>
                    <img src={selected.image_url} alt=""
                         className="max-w-full max-h-[360px] object-contain" />
                  </div>
                </div>

                {/* 메타 */}
                <div className={`p-3 border-b ${C.border} text-[11px] space-y-1`}>
                  {(() => {
                    const badge = SOURCE_BADGE[selected.source_type] || SOURCE_BADGE.manual;
                    return (
                      <div className="flex items-center gap-1.5">
                        <span className={`${badge.color} text-white px-1.5 py-0.5 rounded text-[10px] font-bold`}>
                          {badge.emoji} {badge.label}
                        </span>
                        <span className={C.muted}>{timeAgo(selected.created_at)}</span>
                      </div>
                    );
                  })()}
                  <div className={C.sub}>
                    <span className={C.muted}>크기:</span> {selected.width}×{selected.height} · {formatBytes(selected.bytes)}
                  </div>
                  {selected.source_meta && Object.keys(selected.source_meta).length > 0 && (
                    <div className={`${C.muted} text-[10px] font-mono break-all bg-black/10 rounded p-1 max-h-20 overflow-y-auto`}>
                      {JSON.stringify(selected.source_meta, null, 1)}
                    </div>
                  )}

                  {/* 라벨 */}
                  {editLabelId === selected.id ? (
                    <div className="flex gap-1 mt-2">
                      <input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)}
                             autoFocus
                             className={`${C.input} border rounded px-2 py-1 text-xs flex-1`}
                             placeholder="라벨/메모" />
                      <button onClick={() => onSaveLabel(selected)}
                              disabled={isBusy}
                              className={`${C.btnGreen} text-xs px-2 rounded`}>OK</button>
                      <button onClick={() => setEditLabelId(null)}
                              className={`${C.btn} border text-xs px-2 rounded`}>취소</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`text-[10px] ${C.muted}`}>라벨:</span>
                      <span className={`text-[11px] ${C.text} flex-1 truncate`}>
                        {selected.label || <i className={C.muted}>(없음)</i>}
                      </span>
                      <button onClick={() => { setEditLabelId(selected.id); setLabelDraft(selected.label || ''); }}
                              className={`text-[10px] ${C.muted} hover:underline`}>
                        ✏️ 수정
                      </button>
                    </div>
                  )}
                </div>

                {/* 액션 */}
                <div className={`p-3 space-y-2`}>
                  {!selected.is_active ? (
                    <button onClick={() => onActivate(selected)}
                            disabled={isBusy}
                            className={`${C.btnGreen} w-full rounded py-2 text-sm font-bold disabled:opacity-40`}>
                      {busy === `activate-${selected.id}` ? '⏳ 활성화중...' : '📌 이 변형을 활성으로 설정'}
                    </button>
                  ) : (
                    <div className={`text-center text-xs ${C.muted} py-2 italic`}>
                      이 변형이 현재 사용중입니다
                    </div>
                  )}
                  <button onClick={() => onDelete(selected)}
                          disabled={isBusy}
                          className={`${C.btnRose} w-full rounded py-1.5 text-xs font-bold disabled:opacity-40`}>
                    {busy === `del-${selected.id}` ? '⏳ 삭제중...' : '🗑 이 변형 삭제'}
                  </button>
                  <a href={selected.image_url} target="_blank" rel="noreferrer"
                     className={`${C.btn} border block text-center rounded py-1 text-[11px]`}>
                    🔗 새 탭에서 원본 보기
                  </a>
                </div>
              </>
            ) : (
              <div className={`flex items-center justify-center h-full text-center ${C.muted} text-xs italic p-6`}>
                좌측에서 변형을 클릭하면<br/>상세 정보 + 활성화/삭제 가능
              </div>
            )}

            {error && (
              <div className={`p-3 text-[11px] text-rose-500 leading-snug break-words border-t ${C.border}`}>
                ⚠ {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
