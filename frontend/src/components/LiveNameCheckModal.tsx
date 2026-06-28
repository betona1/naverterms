import { useEffect, useState } from 'react';
import { scanLiveNames, fixLiveNames, type LiveNameMatch } from '../api/bulkRegisterApi';

interface Props {
  open: boolean;
  onClose: () => void;
  dark: boolean;
}

export default function LiveNameCheckModal({ open, onClose, dark }: Props) {
  const [words, setWords] = useState<string[]>([]);
  const [matches, setMatches] = useState<LiveNameMatch[]>([]);
  const [edited, setEdited] = useState<Record<number, string>>({});   // opno → new_name
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const C = dark ? {
    ov: 'bg-black/60', panel: 'bg-[#15151f] border-[#2a2a40] text-white',
    sub: 'text-gray-400', input: 'bg-[#252540] border-[#2a2a40] text-white',
    head: 'bg-[#252540] text-gray-300', row: 'border-[#2a2a40]', hover: 'hover:bg-[#252540]',
    idle: 'border-[#2a2a40] hover:bg-[#252540]',
  } : {
    ov: 'bg-black/40', panel: 'bg-white border-gray-200 text-gray-900',
    sub: 'text-gray-500', input: 'bg-white border-gray-300 text-gray-900',
    head: 'bg-gray-100 text-gray-700', row: 'border-gray-200', hover: 'hover:bg-gray-50',
    idle: 'border-gray-200 hover:bg-gray-50',
  };

  async function doScan() {
    setLoading(true); setMsg('라이브 상품명 스캔 중…');
    try {
      const r = await scanLiveNames();
      setWords(r.words); setMatches(r.matches);
      setEdited(Object.fromEntries(r.matches.map(m => [m.origin_product_no, m.clean_name])));
      setChecked(new Set(r.matches.map(m => m.origin_product_no)));
      setMsg(`🔍 금지어 ${r.words.length}종 · 라이브 매칭 ${r.total}건`);
    } catch (e: any) { setMsg('❌ 스캔 실패: ' + (e?.message || e)); } finally { setLoading(false); }
  }

  useEffect(() => { if (open) doScan(); }, [open]);

  async function doFix() {
    const items = matches
      .filter(m => checked.has(m.origin_product_no))
      .map(m => ({ store_id: m.store_id, origin_product_no: m.origin_product_no, new_name: (edited[m.origin_product_no] || m.clean_name).trim() }))
      .filter(it => it.new_name && it.new_name !== matches.find(m => m.origin_product_no === it.origin_product_no)?.name);
    if (!items.length) { setMsg('수정할 항목 없음'); return; }
    if (!window.confirm(`네이버 라이브 상품명 ${items.length}건을 수정합니다. 진행할까요?`)) return;
    setLoading(true); setMsg(`네이버 수정 중… ${items.length}건 (건당 ~1초)`);
    try {
      const r = await fixLiveNames(items);
      setMsg(`✅ 수정 ${r.updated}건 / 실패 ${r.failed}건`);
      await doScan();
    } catch (e: any) { setMsg('❌ 수정 실패: ' + (e?.message || e)); } finally { setLoading(false); }
  }

  function toggle(opno: number) {
    setChecked(s => { const n = new Set(s); n.has(opno) ? n.delete(opno) : n.add(opno); return n; });
  }
  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.ov}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1040px] max-w-[97vw] max-h-[92vh] flex flex-col shadow-2xl`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 py-3 border-b ${C.row}`}>
          <span className="text-lg">🔤</span>
          <h2 className="font-bold text-sm">라이브 상품명 금지어 점검</h2>
          <span className={`text-[11px] ${C.sub}`}>네이버에 등록된 상품명에서 브랜드 금지어(크록스 등) 검출·수정</span>
          <div className="flex-1" />
          {msg && <span className="text-xs">{msg}</span>}
          {loading && <span className={`text-xs ${C.sub} animate-pulse`}>처리중…</span>}
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub}`}>닫기 ✕</button>
        </div>

        <div className={`px-4 py-2 border-b ${C.row} flex items-center gap-2 flex-wrap`}>
          <button onClick={doScan} disabled={loading} className={`text-xs px-2.5 py-1 rounded border ${C.idle} disabled:opacity-40`}>🔄 재스캔</button>
          <button onClick={() => setChecked(new Set(matches.map(m => m.origin_product_no)))} className={`text-xs px-2 py-1 rounded border ${C.idle}`}>전체선택</button>
          <button onClick={() => setChecked(new Set())} className={`text-xs px-2 py-1 rounded border ${C.idle}`}>해제</button>
          <span className={`text-xs ${C.sub}`}>선택 <b className="text-rose-500">{checked.size}</b> / {matches.length}</span>
          <div className="flex-1" />
          <button onClick={doFix} disabled={loading || checked.size === 0}
            className="text-xs px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-40">
            ⚠ 선택 {checked.size}건 네이버 수정
          </button>
        </div>

        {words.length > 0 && (
          <div className={`px-4 py-1.5 border-b ${C.row} text-[11px] ${C.sub}`}>
            금지어: {words.map((w, i) => <span key={i} className="inline-block px-1.5 py-0.5 mr-1 rounded bg-rose-500/15 text-rose-500">{w}</span>)}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`${C.head} sticky top-0`}>
              <tr>
                <th className="px-2 py-1.5"></th>
                {['스토어', 'W코드', '현재 상품명', '→ 수정명 (편집가능)', '상태'].map(h => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {matches.map(m => (
                <tr key={`${m.store_id}-${m.origin_product_no}`} className={`border-t ${C.row} ${C.hover}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={checked.has(m.origin_product_no)} onChange={() => toggle(m.origin_product_no)} /></td>
                  <td className="px-2 py-1 whitespace-nowrap">{m.store_name}</td>
                  <td className="px-2 py-1 font-mono">{m.product_code}</td>
                  <td className="px-2 py-1 max-w-[300px]">
                    <span className="text-rose-500">{m.name}</span>
                  </td>
                  <td className="px-2 py-1">
                    <input value={edited[m.origin_product_no] ?? m.clean_name}
                      onChange={e => setEdited(s => ({ ...s, [m.origin_product_no]: e.target.value }))}
                      className={`${C.input} border rounded px-2 py-0.5 text-[11px] w-full min-w-[260px]`} />
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">{m.status_type}</td>
                </tr>
              ))}
              {matches.length === 0 && !loading && (
                <tr><td colSpan={6} className={`p-6 text-center text-xs ${C.sub}`}>금지어 포함 라이브 상품 없음 ✓</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={`px-4 py-2 border-t ${C.row} text-[10px] ${C.sub}`}>
          ※ 금지어는 브랜드정책(black)에서 가져옵니다. 추가하려면 브랜드정책에 등록 → 재스캔. 수정은 네이버 커머스 API로 즉시 반영됩니다(건당 ~1초).
        </div>
      </div>
    </div>
  );
}
