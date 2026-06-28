import { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import {
  autoCheckPreview, autoCheckStart, autoCheckStatus,
  visionStart, visionStatus, listByStatus,
  type AutoCheckPreview, type AutoCheckStatus, type VisionStatus, type StatusSkuItem,
} from '../api/missingAttrsApi';
import { ProductAttrModal } from './ProductAttrModal';
import { ManualReviewModal } from './ManualReviewModal';

const SRC_COLOR: Record<string, string> = {
  '명시': 'bg-[#03c75a]/20 text-[#03c75a]',
  '사전': 'bg-indigo-500/20 text-indigo-400',
  '비전': 'bg-amber-500/20 text-amber-500',
};

export default function AttrAutoCheckModal({ onClose }: { onClose: () => void }) {
  const { dark } = useTheme();
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = dark ? 'bg-[#252540] border-[#2a2a40] text-white' : 'bg-white border-gray-300 text-gray-900';
  const head = dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-50 text-gray-600';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const [stores, setStores] = useState<SmartStore[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(undefined);
  const [limit, setLimit] = useState(60);
  const [preview, setPreview] = useState<AutoCheckPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [status, setStatus] = useState<AutoCheckStatus | null>(null);
  const [vision, setVision] = useState<VisionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [vStarting, setVStarting] = useState(false);
  const timer = useRef<number | null>(null);

  // 카운터 드릴다운(특정 status SKU 목록) + ProductAttrModal / 수동검토 모달
  const [drill, setDrill] = useState<{ status: string; label: string } | null>(null);
  const [drillItems, setDrillItems] = useState<StatusSkuItem[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillSearch, setDrillSearch] = useState('');
  const [attrModal, setAttrModal] = useState<{ code: string; store: number } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const openDrill = (status: string, label: string) => {
    setDrill({ status, label }); setDrillSearch('');
    setDrillLoading(true); setDrillItems([]);
    listByStatus(status, storeId, 200, '')
      .then(d => setDrillItems(d.items || []))
      .catch(() => setDrillItems([]))
      .finally(() => setDrillLoading(false));
  };
  const reloadDrill = () => {
    if (!drill) return;
    setDrillLoading(true);
    listByStatus(drill.status, storeId, 200, drillSearch)
      .then(d => setDrillItems(d.items || []))
      .catch(() => setDrillItems([]))
      .finally(() => setDrillLoading(false));
  };

  useEffect(() => { fetchStores(true).then(setStores).catch(() => {}); }, []);

  const refreshStatus = useCallback(() => {
    autoCheckStatus().then(setStatus).catch(() => {});
    visionStatus().then(setVision).catch(() => {});
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // 워커 실행 중이면 폴링
  const anyRunning = status?.running || vision?.running;
  useEffect(() => {
    if (anyRunning) {
      timer.current = window.setInterval(refreshStatus, 3000);
      return () => { if (timer.current) window.clearInterval(timer.current); };
    }
  }, [anyRunning, refreshStatus]);

  const doVision = () => {
    if (!confirm(`썸네일을 GPU(${(vision?.gpus || []).length}대)로 실시간 분석해 색상·재질·형태를 채웁니다.\n남은 대상 ${(vision?.pending_targets || 0).toLocaleString()} W코드 — 백그라운드로 진행됩니다.`)) return;
    setVStarting(true);
    visionStart({ store_id: storeId, limit: Math.max(limit, 500) })
      .then(r => { if (!r.ok) alert(r.error || '시작 실패'); setTimeout(refreshStatus, 1500); })
      .finally(() => setVStarting(false));
  };

  const doPreview = () => {
    setPreviewing(true); setPreview(null);
    autoCheckPreview({ store_id: storeId, limit })
      .then(setPreview)
      .catch(() => setPreview(null))
      .finally(() => setPreviewing(false));
  };

  const doStart = () => {
    if (!confirm(`정확히 판별된 속성을 ${storeId ? '선택 스토어' : '전체'} 대상으로 자동 등록합니다.\n(추측 없이 명시·사전·비전 유일매칭만)`)) return;
    setStarting(true);
    autoCheckStart({ store_id: storeId, limit: Math.max(limit, 500) })
      .then(r => { if (!r.ok) alert(r.error || '시작 실패'); setTimeout(refreshStatus, 1500); })
      .finally(() => setStarting(false));
  };

  const counts = status?.counts || {};
  const w = status?.worker;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className={`w-full max-w-4xl max-h-[88vh] rounded-xl border shadow-2xl flex flex-col ${card}`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center justify-between px-5 py-3.5 border-b ${border}`}>
          <div>
            <h2 className={`text-[15px] font-bold ${text}`}>🤖 속성 AI 자동체크</h2>
            <p className={`text-[11px] mt-0.5 ${sub}`}>상품명·상세·썸네일(비전) 분석 → <b>정확히 판별되는 속성만</b> 자동 등록 (추측 0)</p>
          </div>
          <button onClick={onClose} className={`text-[22px] leading-none ${sub} hover:${text}`}>×</button>
        </div>

        {/* 카운터 */}
        <div className={`grid grid-cols-4 gap-2 px-5 py-3 border-b ${border}`}>
          <Stat dark={dark} label="대기(pending)" v={counts['pending']} accent="#ef4444" onClick={() => openDrill('pending', '대기(pending)')} />
          <Stat dark={dark} label="등록완료" v={counts['registered']} accent="#03c75a" onClick={() => openDrill('registered', '등록완료')} />
          <Stat dark={dark} label="수동검토" v={counts['needs_manual']} accent="#f59e0b" onClick={() => openDrill('needs_manual', '수동검토')} />
          <Stat dark={dark} label="실패" v={counts['fail']} accent="#9ca3af" />
        </div>

        {/* 카운터 드릴다운 패널 */}
        {drill && (
          <div className={`px-5 py-3 border-b ${border}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[13px] font-semibold ${text}`}>📋 {drill.label} 상품</span>
              <span className={`text-[11px] ${sub}`}>{drillItems.length}건 · 행 클릭 시 속성현황</span>
              {drill.status === 'needs_manual' && (
                <button onClick={() => setManualOpen(true)}
                        className="px-2 py-0.5 rounded text-[11px] bg-amber-600 text-white hover:bg-amber-700">🖐 수동검토 화면</button>
              )}
              <input value={drillSearch} onChange={e => setDrillSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && reloadDrill()}
                     placeholder="W코드/상품명" className={`ml-auto px-2 py-1 rounded text-[12px] border w-40 ${inputCls} focus:outline-none`} />
              <button onClick={reloadDrill} className={`px-2 py-1 rounded text-[12px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-200' : 'border-gray-300 hover:bg-gray-100 text-gray-700'}`}>조회</button>
              <button onClick={() => setDrill(null)} className={`text-[16px] leading-none ${sub} hover:${text}`}>×</button>
            </div>
            <div className={`max-h-52 overflow-auto rounded border ${border}`}>
              {drillLoading && <div className={`px-3 py-5 text-center text-[12px] ${sub}`}>조회중…</div>}
              {!drillLoading && !drillItems.length && <div className={`px-3 py-5 text-center text-[12px] ${sub}`}>대상 없음</div>}
              {!drillLoading && drillItems.map(it => (
                <div key={`${it.seller_code}-${it.store_id}`} onClick={() => setAttrModal({ code: it.seller_code, store: it.store_id })}
                     className={`px-3 py-1.5 flex items-center gap-2 cursor-pointer border-b last:border-0 ${border} ${dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50'}`}>
                  <span className="font-mono text-[11px] text-indigo-500 dark:text-indigo-400">{it.seller_code}</span>
                  <span className={`text-[10px] ${sub}`}>{it.store_name}</span>
                  {!it.is_sale && <span className="text-[10px] px-1 rounded bg-red-500/20 text-red-400">비판매</span>}
                  <span className={`text-[12px] truncate ${text}`}>{it.name || '—'}</span>
                  <span className="ml-auto text-[11px]" style={{ color: '#03c75a' }}>{it.attr_count}개</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 컨트롤 */}
        <div className={`flex flex-wrap items-center gap-2 px-5 py-3 border-b ${border}`}>
          <select value={storeId ?? ''} onChange={e => setStoreId(e.target.value ? Number(e.target.value) : undefined)}
                  className={`px-3 py-1.5 rounded text-[13px] border ${inputCls} focus:outline-none`}>
            <option value="">전체 스토어</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}
          </select>
          <label className={`text-[12px] ${sub}`}>표본/목표</label>
          <input type="number" value={limit} min={10} max={5000}
                 onChange={e => setLimit(Math.max(10, Number(e.target.value) || 60))}
                 className={`px-2 py-1.5 rounded text-[13px] border w-24 ${inputCls} focus:outline-none`} />
          <button onClick={doPreview} disabled={previewing}
                  className={`px-3 py-1.5 rounded text-[13px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-200' : 'border-gray-300 hover:bg-gray-100 text-gray-700'} disabled:opacity-50`}>
            {previewing ? '분석 중…' : '🔍 미리보기 (등록 안함)'}
          </button>
          <button onClick={doStart} disabled={starting || status?.running}
                  className="px-3 py-1.5 rounded text-[13px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-50 ml-auto">
            {status?.running ? '실행 중…' : starting ? '시작 중…' : '⚡ 자동등록 실행'}
          </button>
        </div>

        {/* 워커 진행 상태 */}
        {w && (status?.running || w.status === 'running') && (
          <div className={`px-5 py-2 border-b ${border} text-[12px] flex items-center gap-2`}>
            <span className="inline-block w-2 h-2 rounded-full bg-[#03c75a] animate-pulse" />
            <span className={text}>{w.name}</span>
            <span className={sub}>{w.log}</span>
          </div>
        )}

        {/* 썸네일 라이브 비전 (GPU) */}
        <div className={`px-5 py-3 border-b ${border}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-amber-500 text-[13px] font-semibold">🖼 썸네일 라이브 비전</span>
            <span className={`text-[11px] ${sub}`}>
              상품 썸네일을 GPU로 분석해 <b>색상·재질·형태</b> 채움 · GPU {(vision?.gpus || []).length}대 분산
            </span>
            {vision && (
              <span className={`text-[11px] ${sub}`}>· 남은 대상 <b className="text-amber-500">{vision.pending_targets.toLocaleString()}</b> W코드</span>
            )}
            <button onClick={doVision} disabled={vStarting || vision?.running}
                    className="ml-auto px-3 py-1.5 rounded text-[13px] bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
              {vision?.running ? '비전 분석 중…' : vStarting ? '시작 중…' : '🖼 썸네일 비전 분석 실행'}
            </button>
          </div>
          {vision?.worker && (vision.running || vision.worker.status === 'running') && (
            <div className="mt-2 text-[12px] flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span className={text}>{vision.worker.name}</span>
              <span className={sub}>{vision.worker.log}</span>
            </div>
          )}
        </div>

        {/* 미리보기 결과 */}
        <div className="overflow-auto flex-1">
          {preview && (
            <>
              <div className={`px-5 py-2 text-[12px] ${sub} sticky top-0 ${dark ? 'bg-[#1c1c2e]' : 'bg-white'} border-b ${border}`}>
                스캔 <b className={text}>{preview.scanned}</b> · 판별 SKU <b className="text-[#03c75a]">{preview.matched_skus}</b> · 속성 <b className={text}>{preview.attr_total}</b>
                <span className="ml-3">출처:
                  <span className="ml-1 text-[#03c75a]">명시 {preview.sources['명시'] || 0}</span>
                  <span className="ml-1 text-indigo-400">사전 {preview.sources['사전'] || 0}</span>
                  <span className="ml-1 text-amber-500">비전 {preview.sources['비전'] || 0}</span>
                </span>
              </div>
              {preview.results.length === 0 ? (
                <div className={`px-5 py-10 text-center text-[13px] ${sub}`}>
                  정확히 판별 가능한 속성이 없습니다. (멀티컬러 등 명시 안 된 속성은 의도적으로 비움)
                </div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className={`${head} sticky top-8`}>
                    <tr className="text-left">
                      <th className="px-4 py-2 w-[110px]">W코드</th>
                      <th className="px-4 py-2">상품명</th>
                      <th className="px-4 py-2 w-[55%]">판별 속성</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.results.map((r, i) => (
                      <tr key={i} className={`border-t ${border}`}>
                        <td className={`px-4 py-2 font-mono text-[11px] ${sub}`}>{r.seller_code}</td>
                        <td className={`px-4 py-2 ${text}`}>{r.name.slice(0, 36)}</td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1.5">
                            {r.selections.map((s, j) => (
                              <span key={j} className={`px-1.5 py-0.5 rounded text-[11px] ${dark ? 'bg-[#252540]' : 'bg-gray-100'} ${text}`}>
                                <span className={sub}>{s.attr_name}:</span> {s.value}
                                <span className={`ml-1 px-1 rounded text-[9px] ${SRC_COLOR[s.source] || ''}`}>{s.source}</span>
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          {!preview && !previewing && (
            <div className={`px-5 py-10 text-center text-[13px] ${sub}`}>
              <b>미리보기</b>로 자동체크 결과를 먼저 확인하고, <b>자동등록 실행</b>으로 백그라운드 일괄 등록하세요.<br />
              <span className="text-[12px]">명시(상품명) · 사전(매핑사전) · 비전(썸네일) 모두 <b>유일매칭만</b> 채택합니다.</span>
            </div>
          )}
        </div>
      </div>

      {attrModal && <ProductAttrModal sellerCode={attrModal.code} storeId={attrModal.store} onClose={() => setAttrModal(null)} />}
      {manualOpen && <ManualReviewModal initialStoreId={storeId} onClose={() => { setManualOpen(false); reloadDrill(); refreshStatus(); }} />}
    </div>
  );
}

function Stat({ dark, label, v, accent, onClick }: { dark: boolean; label: string; v?: number; accent: string; onClick?: () => void }) {
  return (
    <div onClick={onClick}
         className={`rounded-lg px-3 py-2 ${dark ? 'bg-[#252540]' : 'bg-gray-50'} ${onClick ? 'cursor-pointer hover:ring-2 hover:ring-offset-0 transition' : ''}`}
         style={onClick ? { boxShadow: 'none' } : undefined}>
      <div className="text-[11px] flex items-center gap-1" style={{ color: accent }}>
        {label}{onClick && <span className="opacity-60">›</span>}
      </div>
      <div className={`text-[16px] font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>{(v ?? 0).toLocaleString()}</div>
    </div>
  );
}
