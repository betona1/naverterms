import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchBrandPolicy, fetchBrandAutoDiscover, upsertBrandPolicy, deleteBrandPolicy,
  type BrandPolicyItem,
} from '../api/naverProductApi';

interface Props {
  onClose: () => void;
  dark: boolean;
}

export default function BrandPolicyModal({ onClose, dark }: Props) {
  const [tab, setTab] = useState<'white' | 'black' | 'discover'>('discover');
  const [items, setItems] = useState<BrandPolicyItem[]>([]);
  const [discovery, setDiscovery] = useState<Array<{ name: string; count: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newPolicy, setNewPolicy] = useState<'white' | 'black'>('white');
  const [msg, setMsg] = useState('');

  const C = dark ? {
    bg: 'bg-[#1c1c2e]', border: 'border-[#2a2a40]', text: 'text-white',
    sub: 'text-gray-400', muted: 'text-gray-500',
    panel: 'bg-[#252540]', input: 'bg-[#252540] border-[#2a2a40] text-white placeholder-gray-500',
  } : {
    bg: 'bg-white', border: 'border-gray-200', text: 'text-gray-900',
    sub: 'text-gray-600', muted: 'text-gray-500',
    panel: 'bg-gray-50', input: 'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
  };

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(prev => prev === m ? '' : prev), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'discover') {
        const r = await fetchBrandAutoDiscover(100);
        setDiscovery(r.items);
      } else {
        const r = await fetchBrandPolicy({ policy: tab, search: search || undefined, limit: 500 });
        setItems(r.items);
      }
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => { load(); }, [load]);

  const onAdd = async () => {
    const n = newName.trim();
    if (!n) return;
    const r = await upsertBrandPolicy(n, newPolicy);
    if (r.ok) {
      flash(`✅ ${newPolicy === 'white' ? '화이트' : '블랙'}: ${n}`);
      setNewName('');
      load();
    } else {
      flash(`실패: ${r.error}`);
    }
  };

  const onQuickClassify = async (name: string, policy: 'white' | 'black') => {
    const r = await upsertBrandPolicy(name, policy);
    if (r.ok) {
      flash(`${policy === 'white' ? '⚪ 화이트' : '⚫ 블랙'} 등록: ${name}`);
      setDiscovery(prev => prev.filter(x => x.name !== name));
    }
  };

  const onDelete = async (name: string) => {
    if (!confirm(`${name} 정책 삭제?`)) return;
    await deleteBrandPolicy(name);
    flash(`🗑 ${name}`);
    load();
  };

  const filteredDiscovery = useMemo(() => {
    if (!search) return discovery;
    return discovery.filter(d => d.name.toLowerCase().includes(search.toLowerCase()));
  }, [discovery, search]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 py-4" onClick={onClose}>
      <div className={`${C.bg} ${C.border} border rounded-xl shadow-2xl w-[96vw] max-w-4xl max-h-[92vh] flex flex-col`} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-3 border-b ${C.border} bg-gradient-to-r from-slate-700 to-zinc-700 text-white rounded-t-xl`}>
          <div className="flex items-center gap-3">
            <span>🏷</span>
            <h2 className="text-sm font-bold">브랜드 / 제조사 정책</h2>
            <span className="text-[11px] text-white/80">화이트 = 영원히 사용 · 블랙 = 영원히 차단</span>
          </div>
          <button onClick={onClose} className="text-xl text-white/80 hover:text-white">×</button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b ${C.border} ${C.panel}`}>
          {(['discover', 'black', 'white'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-5 py-2 text-xs font-bold border-b-2 transition ${
                      tab === t
                        ? t === 'white' ? 'border-emerald-500 text-emerald-600 dark:text-emerald-300'
                          : t === 'black' ? 'border-rose-500 text-rose-600 dark:text-rose-300'
                          : 'border-sky-500 text-sky-600 dark:text-sky-300'
                        : 'border-transparent ' + C.muted
                    }`}>
              {t === 'discover' ? '🔍 미등록 후보' : t === 'white' ? '⚪ 화이트' : '⚫ 블랙'}
            </button>
          ))}
        </div>

        {msg && (
          <div className="px-5 py-1 text-xs bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-b border-emerald-200 dark:border-emerald-800">{msg}</div>
        )}

        {/* Toolbar */}
        <div className={`flex items-center gap-2 px-5 py-2 border-b ${C.border}`}>
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="🔍 이름 검색"
                 className={`${C.input} border rounded px-2 py-1 text-xs flex-1`} />
          {tab !== 'discover' && (
            <>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
                     placeholder="새 항목 이름"
                     className={`${C.input} border rounded px-2 py-1 text-xs w-48`} />
              <select value={newPolicy} onChange={e => setNewPolicy(e.target.value as 'white' | 'black')}
                      className={`${C.input} border rounded px-1.5 py-1 text-xs`}>
                <option value="white">⚪ 화이트</option>
                <option value="black">⚫ 블랙</option>
              </select>
              <button onClick={onAdd}
                      className="px-3 py-1 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white">
                + 추가
              </button>
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className={`text-center py-10 ${C.muted}`}>로딩 중...</div>
          ) : tab === 'discover' ? (
            <div>
              <div className={`text-[11px] ${C.muted} mb-2`}>
                DB 의 brand / manufacturer 필드 중 정책 미등록 — 빈도 desc. 좌측 ⚪ 또는 ⚫ 클릭으로 즉시 분류
              </div>
              {filteredDiscovery.length === 0 ? (
                <div className={`text-center py-10 ${C.muted}`}>미등록 항목 없음 (또는 검색 결과 없음)</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className={`${C.panel} sticky top-0`}>
                    <tr>
                      <th className="text-left px-2 py-1.5">이름</th>
                      <th className="text-right px-2 py-1.5 w-20">건수</th>
                      <th className="text-center px-2 py-1.5 w-32">분류</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDiscovery.map(d => (
                      <tr key={d.name} className={`border-t ${C.border} hover:${C.panel}`}>
                        <td className={`px-2 py-1.5 ${C.text}`}>{d.name}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${C.sub}`}>{d.count.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-center">
                          <button onClick={() => onQuickClassify(d.name, 'white')}
                                  className="px-2 py-0.5 text-[10px] rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold mr-1">
                            ⚪
                          </button>
                          <button onClick={() => onQuickClassify(d.name, 'black')}
                                  className="px-2 py-0.5 text-[10px] rounded bg-rose-600 hover:bg-rose-700 text-white font-bold">
                            ⚫
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className={`${C.panel} sticky top-0`}>
                <tr>
                  <th className="text-left px-2 py-1.5">이름</th>
                  <th className="text-left px-2 py-1.5 w-24">출처</th>
                  <th className="text-left px-2 py-1.5">메모</th>
                  <th className="text-right px-2 py-1.5 w-20">매칭</th>
                  <th className="text-center px-2 py-1.5 w-16">삭제</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.name} className={`border-t ${C.border} hover:${C.panel}`}>
                    <td className={`px-2 py-1.5 font-bold ${C.text}`}>{it.name}</td>
                    <td className={`px-2 py-1.5 text-[10px] ${C.muted}`}>{it.source}</td>
                    <td className={`px-2 py-1.5 ${C.sub}`}>{it.note}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${C.sub}`}>{it.hit_count.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-center">
                      <button onClick={() => onDelete(it.name)}
                              className="px-2 py-0.5 text-[10px] rounded bg-gray-500 hover:bg-rose-600 text-white">
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={5} className={`text-center py-6 ${C.muted}`}>없음</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}