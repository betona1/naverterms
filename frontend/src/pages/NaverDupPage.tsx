import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import {
  fetchDup,
  markOrDelete,
  fetchGroup,
  type DupResponse,
  type DupItem,
  type Criterion,
  type StrengthFilter,
} from '../api/naverDupApi';
import { useTheme } from '../hooks/useTheme';

interface Folder {
  id: number;
  name: string;
  product_count: number;
  is_system: 0 | 1;
}

const CRITERIA: { key: Criterion; label: string; tip: string; color: string }[] = [
  { key: 'name',   label: '상품명',     tip: '정규화 EXACT + 토큰 Jaccard ≥85% TOKEN — 옵션 시그니처(사이즈/수량/색상) 다르면 제외', color: '#06b6d4' },
  { key: 'image',  label: '동일이미지', tip: 'image_large URL 일치 + 옵션 시그니처 동일', color: '#10b981' },
  { key: 'detail', label: '상세페이지', tip: 'detail_html MD5 일치 + 옵션 시그니처 동일', color: '#8b5cf6' },
];

function HoverImage({ src }: { src: string | null }) {
  const [show, setShow] = useState(false);
  if (!src) return <div className="w-10 h-10 rounded bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-[10px] text-gray-400 mx-auto">N/A</div>;
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <img src={src} alt="" className="w-10 h-10 object-cover rounded mx-auto" />
      {show && (
        <div className="fixed z-[100] pointer-events-none" style={{ left: '120px', top: '50%', transform: 'translateY(-50%)' }}>
          <div className="bg-white dark:bg-gray-800 shadow-2xl rounded-lg p-2 border border-gray-200 dark:border-gray-700">
            <img src={src} alt="" className="w-80 h-80 object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}

function ownerclanItemUrl(wcode: string) {
  return `https://ownerclan.com/V2/product/view.php?selfcode=${encodeURIComponent(wcode)}`;
}

export default function NaverDupPage() {
  const { dark } = useTheme();
  const [criterion, setCriterion] = useState<Criterion>('name');
  const [folderId, setFolderId] = useState<number | null>(null);
  const [excludeUnsorted, setExcludeUnsorted] = useState<boolean>(true);
  const [strengthFilter, setStrengthFilter] = useState<StrengthFilter>('all');

  const [folders, setFolders] = useState<Folder[]>([]);
  const [data, setData] = useState<DupResponse>({ items: [], total: 0, page: 1, per_page: 50, total_pages: 0 });
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<DupItem[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);

  const critInfo = useMemo(() => CRITERIA.find(c => c.key === criterion)!, [criterion]);

  useEffect(() => {
    axios.get('/api/smartstore/naver-products/folders/').then(r => {
      const items: Folder[] = Array.isArray(r.data) ? r.data : (r.data.items || []);
      setFolders(items.filter(f => f.product_count > 0));
    }).catch(() => setFolders([]));
  }, []);

  const load = useCallback(async (opts: { refresh?: boolean } = {}) => {
    setLoading(true); setError(null);
    try {
      const res = await fetchDup(criterion, page, perPage, {
        refresh: opts.refresh,
        strength: strengthFilter,
        folderId,
        excludeFolderId: !folderId && excludeUnsorted ? 1 : null,
      });
      setData(res);
      if (opts.refresh) setActionMsg(`재진단 완료 — ${res.total.toLocaleString()}건`);
    } catch (e: unknown) {
      const m = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(m || (e as Error).message || '진단 실패');
    } finally {
      setLoading(false);
      setTimeout(() => setActionMsg(null), 3500);
    }
  }, [criterion, page, perPage, strengthFilter, folderId, excludeUnsorted]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); setPage(1); }, [criterion, folderId, strengthFilter, excludeUnsorted]);
  useEffect(() => { setSelected(new Set()); }, [page]);

  const allChecked = data.items.length > 0 && data.items.every(it => selected.has(it.id));
  const someChecked = !allChecked && data.items.some(it => selected.has(it.id));
  const togglePageAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allChecked) data.items.forEach(it => next.delete(it.id));
      else data.items.forEach(it => next.add(it.id));
      return next;
    });
  };
  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onAction = async (action: 'mark' | 'delete' | 'dismiss') => {
    if (selected.size === 0) return;
    const labels: Record<typeof action, string> = {
      mark: '중복 마킹 (sync_status=dup_marked)',
      delete: '⚠ DB 영구 삭제',
      dismiss: `중복 해제 (${criterion} 모드에서 영구 제외)`,
    };
    if (!confirm(`선택된 ${selected.size}건을 ${labels[action]} 처리합니다.\n계속할까요?`)) return;
    setBusy(true);
    try {
      const r = await markOrDelete(Array.from(selected), action, action === 'dismiss' ? criterion : undefined);
      const n = (r as { marked?: number; deleted?: number; dismissed?: number }).marked
        ?? (r as { deleted?: number }).deleted
        ?? (r as { dismissed?: number }).dismissed ?? 0;
      const verb = action === 'mark' ? '마킹' : action === 'delete' ? '삭제' : '해제';
      setActionMsg(`${n}건 ${verb} 완료`);
      setSelected(new Set());
      setExpandedGroup(null);
      await load({ refresh: true });
    } catch (e: unknown) {
      setActionMsg('실패: ' + ((e as Error).message || ''));
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 4000);
    }
  };

  // 페이지 내 그룹별로 최저가가 아닌 항목 자동 체크
  const onCheckHigherPriced = () => {
    const byGroup: Map<string, DupItem[]> = new Map();
    for (const it of data.items) {
      const k = it.group_key || `${it.folder_id}#${it.match_count}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(it);
    }
    const checks = new Set<number>();
    for (const grp of byGroup.values()) {
      if (grp.length < 2) continue;
      const minPrice = Math.min(...grp.map(g => g.market_price || 0));
      for (const g of grp) {
        if ((g.market_price || 0) > minPrice) checks.add(g.id);
      }
    }
    setSelected(checks);
    setActionMsg(`그룹별 최저가 제외하고 ${checks.size}건 자동 체크`);
    setTimeout(() => setActionMsg(null), 3500);
  };

  const onExpandGroup = async (it: DupItem) => {
    if (expandedGroup === it.group_key) {
      setExpandedGroup(null);
      setGroupMembers([]);
      return;
    }
    if (!it.group_key) return;
    setExpandedGroup(it.group_key);
    setGroupLoading(true);
    try {
      const r = await fetchGroup(it.group_key, criterion, folderId);
      setGroupMembers(r.items || []);
    } catch (e) {
      setGroupMembers([]);
      console.error(e);
    } finally {
      setGroupLoading(false);
    }
  };

  const onRefresh = async () => { setPage(1); await load({ refresh: true }); };

  const folderBadge = (id: number, name: string) => (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" title={`folder_id=${id}`}>
      {name}
    </span>
  );

  return (
    <div className={`min-h-screen ${dark ? 'bg-[#0f0f1a] text-gray-200' : 'bg-gray-50 text-gray-800'}`}>
      <div className={`sticky top-[78px] z-20 ${dark ? 'bg-[#1c1c2e] border-b border-[#2a2a40]' : 'bg-white border-b border-gray-200'}`}>
        <div className="max-w-[100rem] mx-auto px-4 pt-3 pb-2">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-sm font-bold">네이버 My상품 중복진단</h1>
              <span className="text-[11px] text-gray-400">
                옵션 시그니처(사이즈/수량/색상) 다르면 별개 SKU 로 처리
              </span>
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <span className="text-[11px] text-rose-500 font-bold">선택 {selected.size.toLocaleString()}</span>
              )}
              <button
                className={`px-2.5 py-1.5 text-xs rounded font-medium ${dark ? 'bg-[#252540] hover:bg-[#2f2f50]' : 'bg-gray-200 hover:bg-gray-300'} disabled:opacity-50`}
                onClick={onRefresh}
                disabled={loading}>
                {loading ? '진단중…' : '재진단'}
              </button>
              <button
                className="px-2.5 py-1.5 text-xs rounded font-bold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                onClick={onCheckHigherPriced}
                disabled={loading || data.items.length === 0}
                title="현재 페이지의 각 그룹에서 최저가가 아닌 항목 자동 체크">
                💰 가격높음 체크
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                onClick={() => onAction('dismiss')}
                disabled={selected.size === 0 || busy}
                title={`선택 항목을 '중복 아님'으로 처리 — ${criterion} 모드에서 영구 제외 (다음 진단에서도 안나옴)`}>
                {busy ? '처리중…' : `중복해제 ${selected.size > 0 ? `(${selected.size})` : ''}`}
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded font-bold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                onClick={() => onAction('mark')}
                disabled={selected.size === 0 || busy}
                title="sync_status='dup_marked' 으로 마킹 (안전 — 삭제 안함)">
                {busy ? '처리중…' : `중복마킹 ${selected.size > 0 ? `(${selected.size})` : ''}`}
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                onClick={() => onAction('delete')}
                disabled={selected.size === 0 || busy}
                title="naver_my_product 에서 영구 삭제 (스마트스토어 원본은 건드리지 않음)">
                {busy ? '처리중…' : `DB 삭제 ${selected.size > 0 ? `(${selected.size})` : ''}`}
              </button>
            </div>
          </div>

          {/* 폴더 선택 */}
          <div className="flex items-center gap-2 mt-3">
            <span className="text-[11px] text-gray-500 shrink-0">스토어:</span>
            <select
              className={`text-xs border rounded px-2 py-1 max-w-md ${dark ? 'bg-[#13131f] border-[#2a2a40] text-gray-200' : 'bg-white border-gray-300 text-gray-700'}`}
              value={folderId === null ? '' : String(folderId)}
              onChange={e => setFolderId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">전체 폴더</option>
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.name} ({f.product_count.toLocaleString()})</option>
              ))}
            </select>
            {!folderId && (
              <label className="flex items-center gap-1.5 text-[11px] cursor-pointer ml-2">
                <input type="checkbox" checked={excludeUnsorted} onChange={e => setExcludeUnsorted(e.target.checked)} />
                <span className={dark ? 'text-gray-300' : 'text-gray-600'}>미분류(169k) 제외</span>
              </label>
            )}
          </div>

          {/* 검사 기준 서브탭 */}
          <div className="mt-2 flex gap-1">
            {CRITERIA.map(c => {
              const active = criterion === c.key;
              return (
                <button
                  key={c.key}
                  onClick={() => setCriterion(c.key)}
                  className={`px-3 py-1.5 text-[11px] rounded font-medium transition-colors ${
                    active
                      ? 'text-white'
                      : dark
                        ? 'bg-[#252540] text-gray-300 hover:bg-[#2f2f50]'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                  style={active ? { background: c.color } : undefined}
                  title={c.tip}>
                  {c.label}으로 검사
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">{critInfo.tip}</div>

          {/* strength 필터 */}
          {criterion === 'name' && (
            <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
              <span className="text-gray-400">강도:</span>
              {(['all', 'exact', 'token'] as StrengthFilter[]).map(o => (
                <button
                  key={o}
                  onClick={() => setStrengthFilter(o)}
                  className={`px-2 py-0.5 rounded-full font-medium ${
                    strengthFilter === o
                      ? 'bg-rose-600 text-white'
                      : dark
                        ? 'bg-[#252540] text-gray-300 hover:bg-[#2f2f50]'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  {o === 'all' ? '전체' : o.toUpperCase()}
                </button>
              ))}
            </div>
          )}

          {actionMsg && (
            <div className="mt-2 text-[11px] text-blue-500 dark:text-blue-400">{actionMsg}</div>
          )}
        </div>
      </div>

      <div className="max-w-[100rem] mx-auto px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">
            중복 의심 <b className="text-rose-600 dark:text-rose-400">{data.total.toLocaleString()}</b>건
          </span>
          {data.total_pages > 1 && (
            <div className="flex items-center gap-0.5 ml-3">
              <button className={`px-1.5 py-1 text-xs rounded border ${dark ? 'border-[#2a2a40]' : 'border-gray-300'} disabled:opacity-30`}
                disabled={page <= 1} onClick={() => setPage(page - 1)}>&lt;</button>
              {Array.from({ length: Math.min(data.total_pages, 7) }, (_, i) => {
                let p: number;
                if (data.total_pages <= 7) p = i + 1;
                else if (page <= 4) p = i + 1;
                else if (page >= data.total_pages - 3) p = data.total_pages - 6 + i;
                else p = page - 3 + i;
                return (
                  <button key={p} className={`px-1.5 py-1 text-xs rounded border ${p === page ? 'bg-rose-600 text-white border-rose-600' : dark ? 'border-[#2a2a40] hover:bg-[#252540]' : 'border-gray-300 hover:bg-gray-100'}`}
                    onClick={() => setPage(p)}>{p}</button>
                );
              })}
              <button className={`px-1.5 py-1 text-xs rounded border ${dark ? 'border-[#2a2a40]' : 'border-gray-300'} disabled:opacity-30`}
                disabled={page >= data.total_pages} onClick={() => setPage(page + 1)}>&gt;</button>
              <span className="text-[11px] text-gray-400 ml-2">{page} / {data.total_pages}</span>
            </div>
          )}
        </div>

        <div className={`rounded border overflow-x-auto ${dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200'}`}>
          <table className="w-full text-sm">
            <thead className={dark ? 'bg-[#13131f]' : 'bg-gray-50'}>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                <th className="px-2 py-2 w-10 text-center">
                  <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = someChecked; }} onChange={togglePageAll} />
                </th>
                <th className="px-2 py-2 w-14">이미지</th>
                {criterion === 'name' && <th className="px-2 py-2 w-20">강도</th>}
                <th className="px-2 py-2 w-32">스토어</th>
                <th className="px-2 py-2">상품명</th>
                <th className="px-2 py-2 w-28">W코드</th>
                <th className="px-2 py-2 w-24 text-right">마켓가</th>
                <th className="px-2 py-2">중복 그룹</th>
              </tr>
            </thead>
            <tbody className={dark ? 'divide-y divide-[#2a2a40]' : 'divide-y divide-gray-100'}>
              {loading ? (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">진단중… 폴더 단위 인덱싱이 필요해 시간이 걸릴 수 있습니다.</td></tr>
              ) : error ? (
                <tr><td colSpan={8} className="text-center py-8 text-red-500">{error}</td></tr>
              ) : data.items.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">중복 의심 상품이 없습니다.</td></tr>
              ) : data.items.map(it => {
                const isExpanded = expandedGroup === it.group_key && expandedGroup !== null;
                const minPriceInGroup = isExpanded && groupMembers.length > 0
                  ? Math.min(...groupMembers.map(g => g.market_price || 0)) : 0;
                return (
                <>
                <tr key={it.id} className={`${dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50'} ${selected.has(it.id) ? (dark ? 'bg-rose-900/20' : 'bg-rose-50') : ''}`}>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleOne(it.id)} />
                  </td>
                  <td className="px-2 py-1.5">
                    <HoverImage src={it.image_large} />
                  </td>
                  {criterion === 'name' && (
                    <td className="px-2 py-1.5">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          it.strength === 'exact'
                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                        }`}>
                        {it.strength === 'exact' ? 'EXACT' : `TOKEN ${(it.score * 100).toFixed(0)}%`}
                      </span>
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-xs">
                    {folderBadge(it.folder_id, it.folder_name || `#${it.folder_id}`)}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="line-clamp-1 text-xs">{it.product_name}</div>
                    {it.naver_product_name && it.naver_product_name !== it.product_name && (
                      <div className="line-clamp-1 text-[10px] text-emerald-500 mt-0.5">▸ {it.naver_product_name}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {it.product_code && (
                      <a href={ownerclanItemUrl(it.product_code)} target="_blank" rel="noreferrer"
                        className="text-blue-500 hover:underline font-mono">
                        {it.product_code}
                      </a>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs">{(it.market_price || 0).toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-xs">
                    <button onClick={() => onExpandGroup(it)} className="text-left hover:bg-gray-100 dark:hover:bg-gray-700 px-1 py-0.5 rounded w-full">
                      <div className="text-[11px] text-rose-600 dark:text-rose-400 font-bold">
                        {isExpanded ? '▼' : '▶'} {it.match_count}건 그룹
                      </div>
                      <div className="text-[10px] text-gray-400 font-mono line-clamp-2">
                        {(it.twin_codes || []).slice(0, 5).join(', ')}
                        {(it.twin_codes || []).length > 5 && ` +${(it.twin_codes || []).length - 5}`}
                      </div>
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={criterion === 'name' ? 8 : 7} className={dark ? 'bg-[#13131f] px-2 py-2' : 'bg-gray-50 px-2 py-2'}>
                      {groupLoading ? (
                        <div className="text-center text-xs text-gray-400 py-2">그룹 멤버 조회중…</div>
                      ) : (
                        <div className={`rounded border ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
                          <table className="w-full text-xs">
                            <thead className={dark ? 'bg-[#1c1c2e]' : 'bg-white'}>
                              <tr className="text-left text-[10px] text-gray-400">
                                <th className="px-2 py-1 w-10"></th>
                                <th className="px-2 py-1 w-12">이미지</th>
                                <th className="px-2 py-1">상품명</th>
                                <th className="px-2 py-1 w-24">W코드</th>
                                <th className="px-2 py-1 w-24 text-right">마켓가</th>
                                <th className="px-2 py-1 w-16"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {groupMembers.map(gm => {
                                const isMin = (gm.market_price || 0) === minPriceInGroup;
                                return (
                                <tr key={gm.id} className={`${isMin ? (dark ? 'bg-emerald-900/20' : 'bg-emerald-50') : ''}`}>
                                  <td className="px-2 py-1 text-center">
                                    <input type="checkbox" checked={selected.has(gm.id)} onChange={() => toggleOne(gm.id)} />
                                  </td>
                                  <td className="px-2 py-1"><HoverImage src={gm.image_large} /></td>
                                  <td className="px-2 py-1">{gm.product_name}</td>
                                  <td className="px-2 py-1">
                                    <a href={ownerclanItemUrl(gm.product_code)} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline font-mono">
                                      {gm.product_code}
                                    </a>
                                  </td>
                                  <td className="px-2 py-1 text-right">
                                    {(gm.market_price || 0).toLocaleString()}
                                    {isMin && <span className="ml-1 text-[9px] text-emerald-600 font-bold">최저</span>}
                                  </td>
                                  <td className="px-2 py-1 text-center">
                                    <button
                                      onClick={async () => {
                                        if (!confirm(`W${gm.product_code} 영구 삭제?`)) return;
                                        try {
                                          await markOrDelete([gm.id], 'delete');
                                          setActionMsg(`W${gm.product_code} 삭제 완료`);
                                          setGroupMembers(prev => prev.filter(m => m.id !== gm.id));
                                          await load({ refresh: true });
                                        } catch { setActionMsg('삭제 실패'); }
                                      }}
                                      className="px-1.5 py-0.5 text-[10px] rounded bg-rose-600 text-white hover:bg-rose-700">
                                      삭제
                                    </button>
                                  </td>
                                </tr>);
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </>);
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
