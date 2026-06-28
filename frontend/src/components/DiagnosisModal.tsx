import { useEffect, useState } from 'react';
import {
  fetchStoreStages, diagnosisSync, diagnosisStatus, diagnosisResults,
  type RegStore, type DiagResults, type DiagWorker,
} from '../api/bulkRegisterApi';

interface Props { open: boolean; onClose: () => void; dark: boolean; initialStoreId?: number | null; }

const PER = 50;

export default function DiagnosisModal({ open, onClose, dark, initialStoreId }: Props) {
  const [stores, setStores] = useState<RegStore[]>([]);
  const [storeId, setStoreId] = useState<number | null>(initialStoreId ?? null);
  const [data, setData] = useState<DiagResults | null>(null);
  const [workers, setWorkers] = useState<DiagWorker[]>([]);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'attr' | 'tag' | 'brand'>('all');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const C = dark ? {
    ov: 'bg-black/60', panel: 'bg-[#15151f] border-[#2a2a40] text-white', sub: 'text-gray-400',
    head: 'bg-[#252540] text-gray-300', row: 'border-[#2a2a40]', hover: 'hover:bg-[#252540]',
    input: 'bg-[#252540] border-[#2a2a40] text-white', idle: 'border-[#2a2a40] hover:bg-[#252540]', card: 'bg-[#1c1c2e] border-[#2a2a40]',
  } : {
    ov: 'bg-black/40', panel: 'bg-white border-gray-200 text-gray-900', sub: 'text-gray-500',
    head: 'bg-gray-100 text-gray-700', row: 'border-gray-200', hover: 'hover:bg-gray-50',
    input: 'bg-white border-gray-300 text-gray-900', idle: 'border-gray-200 hover:bg-gray-50', card: 'bg-gray-50 border-gray-200',
  };

  useEffect(() => {
    if (!open) return;
    fetchStoreStages().then(r => {
      const ss = r.stores.filter(s => s.store_id != null);
      setStores(ss);
      if (storeId == null && ss.length) setStoreId((ss.find(s => s.total > 0) || ss[0]).store_id!);
    });
    refreshStatus();
  }, [open]);

  useEffect(() => { if (open && storeId != null) loadResults(); }, [storeId, open]);

  async function loadResults() {
    if (storeId == null) return;
    setLoading(true);
    try { setData(await diagnosisResults(storeId)); setPage(1); }
    catch { setData(null); } finally { setLoading(false); }
  }
  async function refreshStatus() {
    try { const s = await diagnosisStatus(); setWorkers(s.workers || []); } catch {}
  }
  async function doSync() {
    setLoading(true); setMsg('전체 아이디 병렬 동기화 시작…');
    try {
      const r = await diagnosisSync(undefined, 5);
      setMsg(r.ok ? `✅ ${r.dispatched}개 아이디 워커 디스패치됨 (진행상황 갱신 버튼으로 확인)` : '❌ ' + r.error);
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }

  const store = stores.find(s => s.store_id === storeId);
  const items = (data?.items || []).filter(it =>
    filter === 'all' ? true : filter === 'attr' ? it.attr_missing : filter === 'tag' ? it.tag_missing : it.brand_missing);
  const totalPages = Math.max(1, Math.ceil(items.length / PER));
  const pageItems = items.slice((page - 1) * PER, page * PER);
  const cell = (missing: number, val: string | null) => missing
    ? <span className="text-rose-500 font-bold">미등록</span>
    : <span className={C.sub} title={val || ''}>{(val || '-').slice(0, 22)}</span>;

  const activeWorkers = workers.filter(w => w.status === 'ok').length;
  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.ov}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1180px] max-w-[98vw] h-[93vh] flex flex-col shadow-2xl`} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-3 px-4 py-2.5 border-b ${C.row}`}>
          <span className="text-lg">🩺</span><h2 className="font-bold text-sm">상품등록정보검토</h2>
          <select value={storeId ?? ''} onChange={e => setStoreId(Number(e.target.value))} className={`${C.input} border rounded px-2 py-1 text-xs min-w-[180px]`}>
            {stores.map(s => <option key={s.store_id} value={s.store_id!}>{s.name}</option>)}
          </select>
          <button onClick={doSync} disabled={loading} className="text-xs px-3 py-1.5 rounded bg-[#03c75a] hover:opacity-90 text-white font-bold disabled:opacity-40">🔄 전체 동기화(병렬)</button>
          <button onClick={() => { refreshStatus(); loadResults(); }} className={`text-xs px-2 py-1 rounded border ${C.idle}`}>↻ 갱신</button>
          {activeWorkers > 0 && <span className="text-[11px] text-amber-500 animate-pulse">워커 {activeWorkers}개 수집중</span>}
          <div className="flex-1" />
          {msg && <span className="text-xs">{msg}</span>}
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub}`}>닫기 ✕</button>
        </div>

        {/* 요약 칩 */}
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${C.row} flex-wrap`}>
          <span className="text-xs font-bold">{store?.name}</span>
          <span className={`text-xs ${C.sub}`}>검토필요 <b>{data?.total ?? 0}</b>개</span>
          <div className="flex gap-1.5">
            {([['all', '전체', data?.total], ['attr', '🏷 속성', data?.attr_missing], ['tag', '🔖 태그', data?.tag_missing], ['brand', '🅑 브랜드', data?.brand_missing]] as const).map(([k, lbl, n]) => (
              <button key={k} onClick={() => { setFilter(k as any); setPage(1); }}
                className={`text-xs px-2.5 py-1 rounded border ${filter === k ? 'bg-rose-600 text-white border-rose-600' : C.idle}`}>
                {lbl} {n ?? 0}
              </button>
            ))}
          </div>
          <span className={`text-[11px] ${C.sub}`}>제조사 미등록 {data?.mfr_missing ?? 0}</span>
        </div>

        {/* 상품 테이블 (진단페이지 미러) */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`${C.head} sticky top-0`}>
              <tr>{['이미지', '상품 / 카테고리', 'W코드', '브랜드', '제조사', '속성', '태그'].map(h => <th key={h} className="px-2 py-1.5 text-left whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {pageItems.map((it, i) => (
                <tr key={i} className={`border-t ${C.row} ${C.hover}`}>
                  <td className="px-2 py-1">{it.thumbnail ? <img src={it.thumbnail} className="w-9 h-9 object-cover rounded" loading="lazy" /> : '—'}</td>
                  <td className="px-2 py-1 max-w-[300px]">
                    <div className="truncate" title={it.product_name}>{it.product_name}</div>
                    <div className={`text-[10px] ${C.sub} truncate`}>{it.category_text}</div>
                  </td>
                  <td className="px-2 py-1 font-mono">{it.seller_management_code || '-'}</td>
                  <td className="px-2 py-1">{cell(it.brand_missing, it.brand_value)}</td>
                  <td className="px-2 py-1">{cell(it.mfr_missing, it.mfr_value)}</td>
                  <td className="px-2 py-1 max-w-[260px]">{cell(it.attr_missing, it.attr_value)}</td>
                  <td className="px-2 py-1">{it.tag_missing ? <span className="text-rose-500 font-bold">미등록</span> : <span className="text-[#03c75a]">등록</span>}</td>
                </tr>
              ))}
              {pageItems.length === 0 && !loading && <tr><td colSpan={7} className={`p-8 text-center text-xs ${C.sub}`}>수집 데이터 없음 — [전체 동기화] 후 [갱신]</td></tr>}
            </tbody>
          </table>
        </div>

        {/* 페이지 + 워커상태 */}
        <div className={`flex items-center gap-2 px-3 py-2 border-t ${C.row}`}>
          <button disabled={page <= 1} onClick={() => setPage(1)} className={`text-xs px-2 py-0.5 rounded border ${C.idle} disabled:opacity-30`}>«</button>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={`text-xs px-2 py-0.5 rounded border ${C.idle} disabled:opacity-30`}>◀</button>
          <span className="text-xs">{page} / {totalPages} ({items.length}개)</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className={`text-xs px-2 py-0.5 rounded border ${C.idle} disabled:opacity-30`}>▶</button>
          <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className={`text-xs px-2 py-0.5 rounded border ${C.idle} disabled:opacity-30`}>»</button>
          <div className="flex-1" />
          <span className={`text-[10px] ${C.sub}`}>{workers.length > 0 ? `워커 ${workers.length} (수집중 ${activeWorkers})` : ''}</span>
        </div>
      </div>
    </div>
  );
}
