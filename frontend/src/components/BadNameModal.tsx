import { useEffect, useState } from 'react';
import { scanBadNames, purgeBadNames, type BadNameScan } from '../api/bulkRegisterApi';

interface Props { open: boolean; onClose: () => void; dark: boolean; }

export default function BadNameModal({ open, onClose, dark }: Props) {
  const [data, setData] = useState<BadNameScan | null>(null);
  const [tab, setTab] = useState<'pool' | 'live'>('pool');
  const [stages, setStages] = useState('queue,candidate');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const C = dark ? {
    ov: 'bg-black/60', panel: 'bg-[#15151f] border-[#2a2a40] text-white', sub: 'text-gray-400',
    head: 'bg-[#252540] text-gray-300', row: 'border-[#2a2a40]', hover: 'hover:bg-[#252540]', idle: 'border-[#2a2a40] hover:bg-[#252540]',
  } : {
    ov: 'bg-black/40', panel: 'bg-white border-gray-200 text-gray-900', sub: 'text-gray-500',
    head: 'bg-gray-100 text-gray-700', row: 'border-gray-200', hover: 'hover:bg-gray-50', idle: 'border-gray-200 hover:bg-gray-50',
  };

  async function doScan() {
    setLoading(true); setMsg('스캔 중…'); setChecked(new Set());
    try {
      const r = await scanBadNames('both', stages);
      setData(r);
      setMsg(`풀(등록대상) ${r.pool?.total ?? 0}건 · 라이브 ${r.live?.total ?? 0}건`);
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  useEffect(() => { if (open) doScan(); }, [open, stages]);

  const poolItems = data?.pool?.items ?? [];
  const liveItems = data?.live?.items ?? [];

  async function doPurge() {
    const ids = poolItems.filter(i => i.id && checked.has(i.id)).map(i => i.id!) ;
    if (!ids.length) { setMsg('선택 없음'); return; }
    if (!window.confirm(`${ids.length}건을 작업대기/후보에서 제외합니다(등록 안 됨). 진행?`)) return;
    setLoading(true);
    try { const r = await purgeBadNames(ids); setMsg(`✅ ${r.purged}건 제외(등록방지)`); await doScan(); }
    catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  function toggle(id: number) { setChecked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  if (!open) return null;

  const items = tab === 'pool' ? poolItems : liveItems;
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.ov}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1020px] max-w-[97vw] max-h-[92vh] flex flex-col shadow-2xl`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 py-3 border-b ${C.row}`}>
          <span className="text-lg">🧹</span><h2 className="font-bold text-sm">불량 상품명 탐지</h2>
          <span className={`text-[11px] ${C.sub}`}>AI 안내문 누출·형식오류 상품명 검출</span>
          <div className="flex-1" />
          {msg && <span className="text-xs">{msg}</span>}{loading && <span className={`text-xs ${C.sub} animate-pulse`}>…</span>}
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub}`}>닫기 ✕</button>
        </div>

        <div className={`flex items-center gap-2 px-4 py-2 border-b ${C.row}`}>
          <button onClick={() => setTab('pool')} className={`text-xs px-3 py-1 rounded border ${tab === 'pool' ? 'bg-rose-600 text-white border-rose-600' : C.idle}`}>📦 등록대상 {poolItems.length}</button>
          <button onClick={() => setTab('live')} className={`text-xs px-3 py-1 rounded border ${tab === 'live' ? 'bg-rose-600 text-white border-rose-600' : C.idle}`}>🌐 라이브 {liveItems.length}</button>
          <select value={stages} onChange={e => setStages(e.target.value)} className={`text-xs border rounded px-2 py-1 ${C.idle}`}>
            <option value="queue,candidate">작업대기+후보</option>
            <option value="queue">작업대기</option>
            <option value="all">전체 풀</option>
          </select>
          <button onClick={doScan} className={`text-xs px-2 py-1 rounded border ${C.idle}`}>🔄 재스캔</button>
          <div className="flex-1" />
          {tab === 'pool' && (
            <button onClick={doPurge} disabled={loading || !checked.size} className="text-xs px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-40">
              선택 {checked.size}건 작업대기 제외
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`${C.head} sticky top-0`}>
              <tr>
                {tab === 'pool' && <th className="px-2 py-1.5"></th>}
                {(tab === 'pool' ? ['단계', 'W코드', '상품명', '사유'] : ['스토어', 'W코드', '상품명', '사유']).map(h => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className={`border-t ${C.row} ${C.hover}`}>
                  {tab === 'pool' && <td className="px-2 py-1"><input type="checkbox" checked={!!it.id && checked.has(it.id)} onChange={() => it.id && toggle(it.id)} /></td>}
                  <td className="px-2 py-1 whitespace-nowrap">{tab === 'pool' ? (it.stage || '-') : it.store_name}</td>
                  <td className="px-2 py-1 font-mono">{it.product_code}</td>
                  <td className="px-2 py-1 max-w-[420px] truncate text-rose-500" title={it.name}>{it.name}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-amber-500">{it.reason}</td>
                </tr>
              ))}
              {items.length === 0 && !loading && <tr><td colSpan={5} className={`p-6 text-center text-xs ${C.sub}`}>불량 상품명 없음 ✓</td></tr>}
            </tbody>
          </table>
        </div>
        <div className={`px-4 py-2 border-t ${C.row} text-[10px] ${C.sub}`}>
          ※ 등록대상(작업대기/후보) 불량명은 체크 후 [작업대기 제외]로 등록을 막을 수 있습니다(상품명 재생성 권장). 라이브는 목록 확인용 — 🔤금지어점검/직접 수정 필요. · AI추천은 불량명을 자동 제외합니다.
        </div>
      </div>
    </div>
  );
}
