import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import {
  pipelineStatus, productAttrs, syncStart, syncStatusReq,
  pipelineCrawlStart, pipelineStageStart, pipelineWorkers, recentChanges,
  type PipelineStore, type ProductAttrItem, type PipelineWorkers, type RecentChange,
} from '../api/missingAttrsApi';
import { ProductAttrModal } from './ProductAttrModal';
import { ManualReviewModal } from './ManualReviewModal';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: '미처리', cls: 'bg-gray-400/20 text-gray-400' },
  classified: { label: '추론완료', cls: 'bg-indigo-500/20 text-indigo-400' },
  registered: { label: '적용완료', cls: 'bg-[#03c75a]/20 text-[#03c75a]' },
  needs_manual: { label: '수동', cls: 'bg-amber-500/20 text-amber-500' },
  fail: { label: '실패', cls: 'bg-red-500/20 text-red-400' },
};

/** 속성 파이프라인 현황(수집→추론→동기화) + 상품별 속성 저장상태 확인. */
export function ProductAttrViewer() {
  const [stores, setStores] = useState<SmartStore[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(undefined);
  const [pipe, setPipe] = useState<PipelineStore[]>([]);
  const [sync, setSync] = useState<{ running: boolean; worker: any } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [wk, setWk] = useState<PipelineWorkers | null>(null);
  const [busy, setBusy] = useState('');
  const [code, setCode] = useState('');
  const [attrs, setAttrs] = useState<ProductAttrItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState<RecentChange[]>([]);
  const [attrModal, setAttrModal] = useState<{ code: string; store: number } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { fetchStores(true).then(setStores).catch(() => {}); }, []);

  const refresh = useCallback(() => {
    pipelineStatus(storeId).then(d => setPipe(d.stores || [])).catch(() => {});
    syncStatusReq().then(setSync).catch(() => {});
    pipelineWorkers().then(setWk).catch(() => {});
    recentChanges(storeId, 100).then(d => setChanges(d.changes || [])).catch(() => {});
  }, [storeId]);
  useEffect(() => { refresh(); }, [refresh]);
  const anyRunning = sync?.running || wk?.crawl.running || wk?.stage.running || wk?.sync.running;
  useEffect(() => {
    if (anyRunning) {
      timer.current = window.setInterval(refresh, 3000);
      return () => { if (timer.current) window.clearInterval(timer.current); };
    }
  }, [anyRunning, refresh]);

  const runStage = (which: 'crawl' | 'stage') => {
    const label = which === 'crawl' ? '① 수집(크롤)+탐지' : '② GPU 추론(스테이징)';
    if (!confirm(`${storeId ? '선택 스토어' : '전체 스토어'} ${label}를 백그라운드로 실행합니다.${which === 'stage' ? '\n(GPU 분류, 네이버 PUT 없음 — 동기화는 별도 버튼)' : ''}`)) return;
    setBusy(which);
    const p = which === 'crawl' ? pipelineCrawlStart(storeId) : pipelineStageStart({ store_id: storeId, limit: 5000 });
    p.then(r => { if (!r.ok) alert(r.error || '실패'); setTimeout(refresh, 1500); }).finally(() => setBusy(''));
  };

  const loadProduct = () => {
    if (!code.trim() || !storeId) { alert('스토어 선택 + W코드 입력'); return; }
    setLoading(true); setAttrs(null);
    productAttrs(code.trim(), storeId).then(d => setAttrs(d.attributes || [])).catch(() => setAttrs([])).finally(() => setLoading(false));
  };
  const doSync = (sid?: number) => {
    if (!confirm(`${sid ? '선택 스토어' : '전체'}의 추론완료(classified) 속성을 네이버에 동기화(적용)합니다.`)) return;
    setSyncing(true);
    syncStart({ store_id: sid, limit: 5000 }).then(r => { if (!r.ok) alert(r.error || '실패'); setTimeout(refresh, 1500); }).finally(() => setSyncing(false));
  };

  const W = ({ k, color }: { k: 'crawl' | 'stage' | 'sync'; color: string }) => {
    const w = wk?.[k];
    if (!w?.running) return null;
    return <div className="text-[11px] flex items-center gap-1.5 mt-1" style={{ color }}>
      <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: color }} />{w.name}: <span className="text-gray-500 dark:text-gray-400">{w.log}</span>
    </div>;
  };

  return (
    <div className="space-y-3">
      {/* 3단계 파이프라인 컨트롤 */}
      <div className="rounded-lg border border-violet-300/40 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-900/10 p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-bold text-violet-700 dark:text-violet-300">⚙ 속성 파이프라인 실행</span>
          <select value={storeId ?? ''} onChange={e => setStoreId(e.target.value ? Number(e.target.value) : undefined)}
                  className="px-2 py-1 rounded text-[12px] border bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100">
            <option value="">전체 스토어</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}
          </select>
          <button onClick={() => runStage('crawl')} disabled={!!busy || wk?.crawl.running}
                  className="px-2.5 py-1.5 rounded text-[12px] bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
            {wk?.crawl.running ? '① 수집중…' : '① 수집+탐지'}
          </button>
          <button onClick={() => runStage('stage')} disabled={!!busy || wk?.stage.running}
                  className="px-2.5 py-1.5 rounded text-[12px] bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
            {wk?.stage.running ? '② 추론중…' : '② GPU 추론'}
          </button>
          <button onClick={() => doSync(storeId)} disabled={syncing || sync?.running}
                  className="px-2.5 py-1.5 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-50">
            {sync?.running ? '③ 동기화중…' : '③ 동기화(적용)'}
          </button>
          <button onClick={() => setManualOpen(true)}
                  className="px-2.5 py-1.5 rounded text-[12px] bg-amber-600 text-white hover:bg-amber-700">
            🖐 수동검토
          </button>
          <span className="text-[10px] text-gray-400 ml-auto">수집·추론은 PUT 없음 · 동기화만 네이버 적용</span>
        </div>
        <W k="crawl" color="#0284c7" /><W k="stage" color="#f59e0b" /><W k="sync" color="#03c75a" />
      </div>

      {/* 파이프라인 현황 */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 bg-gray-50 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-700">
          <span className="text-[13px] font-bold text-gray-800 dark:text-gray-100">📊 속성 파이프라인 현황</span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">수집 → GPU추론 → 동기화(적용)</span>
          {sync?.running && <span className="text-[11px] text-indigo-400 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />동기화중: {sync.worker?.log}</span>}
          <button onClick={() => doSync(storeId)} disabled={syncing || sync?.running}
                  className="ml-auto px-2.5 py-1 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-50">
            {sync?.running ? '동기화중…' : '⚡ 동기화(적용)'}
          </button>
        </div>
        <table className="w-full text-[12px]">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr className="text-left">
              <th className="px-3 py-1.5">스토어</th>
              <th className="px-3 py-1.5 text-right">판매상품</th>
              <th className="px-3 py-1.5 text-right">수집</th>
              <th className="px-3 py-1.5 text-right">추론대기</th>
              <th className="px-3 py-1.5 text-right text-indigo-400">추론완료</th>
              <th className="px-3 py-1.5 text-right text-[#03c75a]">적용완료</th>
            </tr>
          </thead>
          <tbody>
            {pipe.map(s => (
              <tr key={s.store_id} className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-100">
                <td className="px-3 py-1.5">{s.store_name}</td>
                <td className="px-3 py-1.5 text-right">{s.sale_skus?.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{s.crawled_skus?.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{s.pending?.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right text-indigo-400">{s.classified?.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right text-[#03c75a]">{s.registered?.toLocaleString()}</td>
              </tr>
            ))}
            {!pipe.length && <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">데이터 없음</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 상품별 속성 조회 */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 bg-gray-50 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-700">
          <span className="text-[13px] font-bold text-gray-800 dark:text-gray-100">🔎 상품별 속성 확인</span>
          <select value={storeId ?? ''} onChange={e => setStoreId(e.target.value ? Number(e.target.value) : undefined)}
                  className="px-2 py-1 rounded text-[12px] border bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100">
            <option value="">스토어</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}
          </select>
          <input value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadProduct()}
                 placeholder="W코드" className="px-2 py-1 rounded text-[12px] border w-36 bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100" />
          <button onClick={loadProduct} disabled={loading}
                  className="px-2.5 py-1 rounded text-[12px] bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">{loading ? '조회중…' : '조회'}</button>
        </div>
        {attrs && (
          <table className="w-full text-[12px]">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="text-left">
                <th className="px-3 py-1.5 w-[28%]">속성</th>
                <th className="px-3 py-1.5 w-[90px]">상태</th>
                <th className="px-3 py-1.5">추론값 / 적용값</th>
              </tr>
            </thead>
            <tbody>
              {attrs.map((a, i) => {
                const b = STATUS_BADGE[a.status] || { label: a.status, cls: 'bg-gray-400/20 text-gray-400' };
                const val = a.registered_value_text || a.recommended_value_text;
                return (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-100">
                    <td className="px-3 py-1.5">{a.attribute_name}<span className="ml-1 text-[10px] text-gray-400">{a.classification_type === 'MULTI_SELECT' ? '多' : ''}</span></td>
                    <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${b.cls}`}>{b.label}</span></td>
                    <td className="px-3 py-1.5">
                      {val ? <span className="font-semibold">{val}</span> : <span className="text-gray-400">—</span>}
                      {a.candidate_values.length > 0 && <span className="ml-2 text-[10px] text-gray-400">후보 {a.candidate_values.length}</span>}
                    </td>
                  </tr>
                );
              })}
              {!attrs.length && <tr><td colSpan={3} className="px-3 py-4 text-center text-gray-400">빈 속성 없음</td></tr>}
            </tbody>
          </table>
        )}
        {!attrs && !loading && <div className="px-3 py-4 text-[12px] text-gray-400">스토어 선택 + W코드 입력 후 조회 — 속성별 추론/적용 상태를 확인합니다.</div>}
      </div>

      {/* 최근 적용 내역 */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2 bg-gray-50 dark:bg-gray-800/40 border-b border-gray-200 dark:border-gray-700">
          <span className="text-[13px] font-bold text-gray-800 dark:text-gray-100">🕒 최근 적용 내역</span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">속성 PUT(적용) 이력 · 행 클릭 시 상품 속성 현황</span>
          <span className="ml-auto text-[11px] text-gray-400">{changes.length}건</span>
        </div>
        <table className="w-full text-[12px]">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr className="text-left">
              <th className="px-3 py-1.5 w-[150px]">시각</th>
              <th className="px-3 py-1.5">스토어</th>
              <th className="px-3 py-1.5">W코드</th>
              <th className="px-3 py-1.5 text-right w-[90px]">추가속성</th>
              <th className="px-3 py-1.5 w-[80px]">상태</th>
            </tr>
          </thead>
          <tbody>
            {changes.map(ch => {
              const b = ch.status === 'ok' ? { label: '성공', cls: 'bg-[#03c75a]/20 text-[#03c75a]' }
                : ch.status === 'failed' ? { label: '실패', cls: 'bg-red-500/20 text-red-400' }
                : { label: ch.status, cls: 'bg-gray-400/20 text-gray-400' };
              return (
                <tr key={ch.id} onClick={() => setAttrModal({ code: ch.seller_code, store: ch.store_id })}
                    className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-100 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 font-mono text-[11px]">{ch.changed_at || '—'}</td>
                  <td className="px-3 py-1.5">{ch.store_name}</td>
                  <td className="px-3 py-1.5 font-mono text-indigo-500 dark:text-indigo-400">{ch.seller_code}</td>
                  <td className="px-3 py-1.5 text-right">{ch.added_count}</td>
                  <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${b.cls}`}>{b.label}</span></td>
                </tr>
              );
            })}
            {!changes.length && <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">적용 내역 없음</td></tr>}
          </tbody>
        </table>
      </div>

      {attrModal && <ProductAttrModal sellerCode={attrModal.code} storeId={attrModal.store} onClose={() => setAttrModal(null)} />}
      {manualOpen && <ManualReviewModal initialStoreId={storeId} onClose={() => { setManualOpen(false); refresh(); }} />}
    </div>
  );
}
