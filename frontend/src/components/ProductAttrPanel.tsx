import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import { ProductAttrViewer } from './ProductAttrViewer';
import {
  autoCheckPreview, autoCheckStart, autoCheckStatus,
  visionStart, visionStatus,
  type AutoCheckPreview, type AutoCheckStatus, type VisionStatus,
} from '../api/missingAttrsApi';

const SRC_COLOR: Record<string, string> = {
  '명시': 'bg-[#03c75a]/20 text-[#03c75a]',
  '사전': 'bg-indigo-500/20 text-indigo-400',
  '비전': 'bg-amber-500/20 text-amber-500',
};

/** GPU 모니터 모달의 '상품속성' 탭 본문 — 속성 AI 자동체크 + 썸네일 라이브 비전(GPU). */
export function ProductAttrPanel() {
  const [stores, setStores] = useState<SmartStore[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(undefined);
  const [limit, setLimit] = useState(500);
  const [preview, setPreview] = useState<AutoCheckPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [status, setStatus] = useState<AutoCheckStatus | null>(null);
  const [vision, setVision] = useState<VisionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [vStarting, setVStarting] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { fetchStores(true).then(setStores).catch(() => {}); }, []);

  const refreshStatus = useCallback(() => {
    autoCheckStatus().then(setStatus).catch(() => {});
    visionStatus().then(setVision).catch(() => {});
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const anyRunning = status?.running || vision?.running;
  useEffect(() => {
    if (anyRunning) {
      timer.current = window.setInterval(refreshStatus, 3000);
      return () => { if (timer.current) window.clearInterval(timer.current); };
    }
  }, [anyRunning, refreshStatus]);

  const doPreview = () => {
    setPreviewing(true); setPreview(null);
    autoCheckPreview({ store_id: storeId, limit: 60 })
      .then(setPreview).catch(() => setPreview(null)).finally(() => setPreviewing(false));
  };
  const doStart = () => {
    if (!confirm(`정확히 판별된 속성을 ${storeId ? '선택 스토어' : '전체'} 대상으로 자동 등록합니다. (추측 없이 명시·사전·비전 유일매칭만)`)) return;
    setStarting(true);
    autoCheckStart({ store_id: storeId, limit: Math.max(limit, 500) })
      .then(r => { if (!r.ok) alert(r.error || '시작 실패'); setTimeout(refreshStatus, 1500); })
      .finally(() => setStarting(false));
  };
  const doVision = () => {
    if (!confirm(`썸네일을 GPU(${(vision?.gpus || []).length}대)로 실시간 분석해 색상·재질·형태를 채웁니다.\n남은 대상 ${(vision?.pending_targets || 0).toLocaleString()} W코드 — 백그라운드로 진행됩니다. (1천건 약 1시간)`)) return;
    setVStarting(true);
    visionStart({ store_id: storeId, limit: Math.max(limit, 500) })
      .then(r => { if (!r.ok) alert(r.error || '시작 실패'); setTimeout(refreshStatus, 1500); })
      .finally(() => setVStarting(false));
  };

  const counts = status?.counts || {};
  const w = status?.worker;
  const vw = vision?.worker;

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      {/* 파이프라인 현황 + 상품별 속성 확인 */}
      <ProductAttrViewer />

      {/* 카운터 */}
      <div className="grid grid-cols-4 gap-2">
        <Stat label="대기(pending)" v={counts['pending']} accent="#ef4444" />
        <Stat label="등록완료" v={counts['registered']} accent="#03c75a" />
        <Stat label="수동검토" v={counts['needs_manual']} accent="#f59e0b" />
        <Stat label="실패" v={counts['fail']} accent="#9ca3af" />
      </div>

      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
        <select value={storeId ?? ''} onChange={e => setStoreId(e.target.value ? Number(e.target.value) : undefined)}
                className="px-2 py-1.5 rounded text-[12px] border bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100">
          <option value="">전체 스토어</option>
          {stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}
        </select>
        <label className="text-[11px] text-gray-500 dark:text-gray-400">목표</label>
        <input type="number" value={limit} min={10} max={5000}
               onChange={e => setLimit(Math.max(10, Number(e.target.value) || 500))}
               className="px-2 py-1.5 rounded text-[12px] border w-20 bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100" />
        <button onClick={doPreview} disabled={previewing}
                className="px-2.5 py-1.5 rounded text-[12px] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50">
          {previewing ? '분석 중…' : '🔍 미리보기'}
        </button>
        <button onClick={doStart} disabled={starting || status?.running}
                className="px-2.5 py-1.5 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-50 ml-auto">
          {status?.running ? '실행 중…' : starting ? '시작 중…' : '⚡ 자동등록(정밀)'}
        </button>
      </div>
      {w && (status?.running || w.status === 'running') && (
        <div className="text-[12px] flex items-center gap-2 px-1">
          <span className="inline-block w-2 h-2 rounded-full bg-[#03c75a] animate-pulse" />
          <span className="text-gray-800 dark:text-gray-100">{w.name}</span>
          <span className="text-gray-500 dark:text-gray-400">{w.log}</span>
        </div>
      )}

      {/* 썸네일 라이브 비전 (GPU) */}
      <div className="p-3 rounded-lg border border-amber-300/40 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-900/10">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-amber-600 dark:text-amber-400 text-[13px] font-bold">🖼 썸네일 라이브 비전</span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            썸네일 GPU 분석 → <b>색상·재질·형태</b> 채움 · GPU {(vision?.gpus || []).length}대 분산
          </span>
          {vision && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">· 남은 <b className="text-amber-600 dark:text-amber-400">{vision.pending_targets.toLocaleString()}</b> W코드</span>
          )}
          <button onClick={doVision} disabled={vStarting || vision?.running}
                  className="ml-auto px-2.5 py-1.5 rounded text-[12px] bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
            {vision?.running ? '비전 분석 중…' : vStarting ? '시작 중…' : '🖼 비전 분석 실행'}
          </button>
        </div>
        {vw && (vision?.running || vw.status === 'running') && (
          <div className="mt-2 text-[12px] flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-gray-800 dark:text-gray-100">{vw.name}</span>
            <span className="text-gray-500 dark:text-gray-400">{vw.log}</span>
          </div>
        )}
        <div className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
          ※ qwen2.5vl 1건 ~30~44초 · 1천건 약 1시간 · 멀티컬러는 정확히 비움(추측 0)
        </div>
      </div>

      {/* 미리보기 결과 */}
      {preview && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-3 py-2 text-[12px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-700">
            스캔 <b className="text-gray-800 dark:text-gray-100">{preview.scanned}</b> · 판별 SKU <b className="text-[#03c75a]">{preview.matched_skus}</b> · 속성 <b className="text-gray-800 dark:text-gray-100">{preview.attr_total}</b>
            <span className="ml-3">출처:
              <span className="ml-1 text-[#03c75a]">명시 {preview.sources['명시'] || 0}</span>
              <span className="ml-1 text-indigo-400">사전 {preview.sources['사전'] || 0}</span>
              <span className="ml-1 text-amber-500">비전 {preview.sources['비전'] || 0}</span>
            </span>
          </div>
          {preview.results.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gray-500 dark:text-gray-400">
              정확히 판별 가능한 속성이 없습니다. (멀티컬러 등 명시 안 된 속성은 의도적으로 비움)
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 dark:bg-gray-800/40 text-gray-500 dark:text-gray-400">
                <tr className="text-left">
                  <th className="px-3 py-1.5 w-[110px]">W코드</th>
                  <th className="px-3 py-1.5">상품명</th>
                  <th className="px-3 py-1.5 w-[52%]">판별 속성</th>
                </tr>
              </thead>
              <tbody>
                {preview.results.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-1.5 font-mono text-[11px] text-gray-500 dark:text-gray-400">{r.seller_code}</td>
                    <td className="px-3 py-1.5 text-gray-800 dark:text-gray-100">{r.name.slice(0, 32)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {r.selections.map((s, j) => (
                          <span key={j} className="px-1.5 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100">
                            <span className="text-gray-500 dark:text-gray-400">{s.attr_name}:</span> {s.value}
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
        </div>
      )}
      {!preview && !previewing && (
        <div className="px-4 py-6 text-center text-[12px] text-gray-500 dark:text-gray-400">
          <b>미리보기</b>로 결과 확인 → <b>자동등록(정밀)</b> 또는 <b>비전 분석</b>으로 백그라운드 일괄 처리.<br />
          명시(상품명) · 사전(매핑사전) · 비전(썸네일) 모두 <b>유일매칭만</b> 채택합니다.
        </div>
      )}
    </div>
  );
}

function Stat({ label, v, accent }: { label: string; v?: number; accent: string }) {
  return (
    <div className="rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700">
      <div className="text-[11px]" style={{ color: accent }}>{label}</div>
      <div className="text-[16px] font-bold text-gray-900 dark:text-white">{(v ?? 0).toLocaleString()}</div>
    </div>
  );
}
