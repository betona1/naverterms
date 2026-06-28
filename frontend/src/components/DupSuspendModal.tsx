import { useEffect, useState } from 'react';
import { scanDupSuspend, applyDupSuspend, type DupGroup } from '../api/bulkRegisterApi';

interface Props { open: boolean; onClose: () => void; dark: boolean; }

export default function DupSuspendModal({ open, onClose, dark }: Props) {
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [excessTotal, setExcessTotal] = useState(0);
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
    setLoading(true); setMsg('스캔 중…');
    try {
      const r = await scanDupSuspend();
      setGroups(r.groups.filter(g => g.excess.length > 0));
      setExcessTotal(r.excess_total);
      setMsg(`중복그룹 ${r.group_count}개 · 품절대상(초과분) ${r.excess_total}건`);
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  useEffect(() => { if (open) doScan(); }, [open]);

  async function doApply() {
    if (excessTotal === 0) { setMsg('품절 대상 없음'); return; }
    if (!window.confirm(`중복 초과분 ${excessTotal}건을 품절처리(판매중지)합니다. 각 그룹의 판매중·매출 상품은 유지됩니다. 진행?`)) return;
    setLoading(true); setMsg(`품절처리 중… ${excessTotal}건 (건당 ~1초)`);
    try {
      const r = await applyDupSuspend();
      setMsg(`✅ 품절처리 ${r.suspended}건 / 실패 ${r.failed}건`);
      await doScan();
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.ov}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1000px] max-w-[97vw] max-h-[92vh] flex flex-col shadow-2xl`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 py-3 border-b ${C.row}`}>
          <span className="text-lg">🔁</span><h2 className="font-bold text-sm">중복 상품 초과분 품절처리</h2>
          <span className={`text-[11px] ${C.sub}`}>같은 W코드 중복 시 판매중·매출 1개 유지, 나머지 판매중지</span>
          <div className="flex-1" />
          {msg && <span className="text-xs">{msg}</span>}{loading && <span className={`text-xs ${C.sub} animate-pulse`}>…</span>}
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub}`}>닫기 ✕</button>
        </div>
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${C.row}`}>
          <button onClick={doScan} disabled={loading} className={`text-xs px-2 py-1 rounded border ${C.idle} disabled:opacity-40`}>🔄 재스캔</button>
          <div className="flex-1" />
          <button onClick={doApply} disabled={loading || excessTotal === 0} className="text-xs px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-40">
            ⚠ 초과분 {excessTotal}건 품절처리
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`${C.head} sticky top-0`}>
              <tr>{['스토어', 'W코드', '유지(opno/상태/매출)', '품절대상 opno'].map(h => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={i} className={`border-t ${C.row} ${C.hover}`}>
                  <td className="px-2 py-1 whitespace-nowrap">{g.store_name}</td>
                  <td className="px-2 py-1 font-mono">{g.product_code}</td>
                  <td className="px-2 py-1 text-emerald-500 whitespace-nowrap">{g.keep.origin_product_no} · {g.keep.status_type} · {g.keep.sales.toLocaleString()}원</td>
                  <td className="px-2 py-1 text-rose-500 font-mono">{g.excess.map(e => e.origin_product_no).join(', ')}</td>
                </tr>
              ))}
              {groups.length === 0 && !loading && <tr><td colSpan={4} className={`p-6 text-center text-xs ${C.sub}`}>품절처리할 중복 초과분 없음 ✓</td></tr>}
            </tbody>
          </table>
        </div>
        <div className={`px-4 py-2 border-t ${C.row} text-[10px] ${C.sub}`}>
          ※ 원본 삭제 금지 정책에 따라 <b>삭제 대신 판매중지(SUSPENSION)</b>. 각 그룹은 판매중·매출 높은 것을 유지하고 나머지만 품절처리합니다. (네이버 API, 건당 ~1초)
        </div>
      </div>
    </div>
  );
}
