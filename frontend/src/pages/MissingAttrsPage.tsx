import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchSummary, fetchSkuList, registerForSku,
  type MissingSummary, type SkuRow,
} from '../api/missingAttrsApi';
import { fetchAttrProductDetail, type AttrGroup, type AttrGroupValue } from '../api/attrAnalyticsApi';
import AttrAutoCheckModal from '../components/AttrAutoCheckModal';

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString();
}

export default function MissingAttrsPage() {
  const { dark } = useTheme();
  const [summary, setSummary] = useState<MissingSummary | null>(null);
  const [items, setItems] = useState<SkuRow[]>([]);
  const [page, setPage] = useState(1);
  const perPage = 50;
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selectedSku, setSelectedSku] = useState<SkuRow | null>(null);
  const [autoCheckOpen, setAutoCheckOpen] = useState(false);

  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = dark ? 'bg-[#252540] border-[#2a2a40] text-white' : 'bg-white border-gray-300 text-gray-900';
  const tableHeader = dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-50 text-gray-600';
  const rowHover = dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const loadList = useCallback(() => {
    setLoading(true);
    fetchSkuList({
      page, per_page: perPage,
      search,
      category_id: categoryFilter || undefined,
      store_id: storeFilter,
    })
      .then(d => { setItems(d.items); setTotal(d.total); setTotalPages(d.total_pages); })
      .catch(() => { setItems([]); setTotal(0); setTotalPages(0); })
      .finally(() => setLoading(false));
  }, [page, search, categoryFilter, storeFilter]);

  useEffect(() => { fetchSummary().then(setSummary).catch(()=>{}); }, []);
  useEffect(() => { loadList(); }, [loadList]);

  return (
    <div className={`min-h-[calc(100vh-42px)] ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'} p-6`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className={`text-xl font-bold ${text}`}>빈 속성 검토 + 등록 (상품별)</h1>
          <p className={`text-[12px] mt-0.5 ${textSub}`}>
            상품 클릭 → 빈 속성 모달에서 일괄 등록
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setAutoCheckOpen(true)}
                  className="px-3 py-1.5 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] font-semibold">
            🤖 속성 자동체크
          </button>
          <button onClick={() => { fetchSummary().then(setSummary); loadList(); }}
                  className={`px-3 py-1.5 rounded text-[12px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}>
            새로고침
          </button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <StatCard dark={dark} label="빈속성 보유 SKU" value={fmt(summary.skus_with_missing)} sub={`총 ${fmt(summary.total_missing)} row`} accent="#ef4444" />
          <StatCard dark={dark} label="자동등록 후보" value={fmt(summary.auto_candidates)} sub="옵션 1개 — 검토 없이" accent="#03c75a" />
          <StatCard dark={dark} label="등록 완료" value={fmt(summary.registered)} sub={`pending ${fmt(summary.pending)}`} accent="#0078d7" />
          <StatCard dark={dark} label="속성 종류" value={fmt(summary.unique_attrs)} sub="고유 attribute_seq" accent="#f59e0b" />
        </div>
      )}

      <div className={`rounded-lg border ${card}`}>
        <div className={`flex flex-wrap items-center gap-2 px-4 py-3 border-b ${border}`}>
          <input value={searchInput}
                 onChange={e => setSearchInput(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && (setSearch(searchInput.trim()), setPage(1))}
                 placeholder="W코드 / 상품번호 검색"
                 className={`px-3 py-1.5 rounded text-[13px] border w-56 ${inputCls} focus:outline-none focus:border-[#03c75a]`} />
          <button onClick={() => { setSearch(searchInput.trim()); setPage(1); }}
                  className="px-3 py-1.5 rounded text-[13px] bg-[#03c75a] text-white hover:bg-[#02b150]">검색</button>

          <input value={categoryFilter}
                 onChange={e => { setCategoryFilter(e.target.value); setPage(1); }}
                 placeholder="카테고리 ID"
                 className={`px-3 py-1.5 rounded text-[13px] border w-40 ${inputCls} focus:outline-none focus:border-[#03c75a]`} />
          {(search || categoryFilter || storeFilter) && (
            <button onClick={() => { setSearchInput(''); setSearch(''); setCategoryFilter(''); setStoreFilter(undefined); setPage(1); }}
                    className={`px-2 py-1.5 rounded text-[12px] ${textSub} hover:${dark?'bg-[#252540]':'bg-gray-100'}`}>
              초기화
            </button>
          )}
          <div className={`ml-auto text-[12px] ${textSub}`}>총 <span className={text}>{fmt(total)}</span>개 SKU</div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className={tableHeader}>
              <tr className="text-left">
                <th className="px-4 py-2 w-[110px]">W코드</th>
                <th className="px-4 py-2">상품명</th>
                <th className="px-4 py-2 w-[110px]">스토어</th>
                <th className="px-4 py-2 w-[180px]">카테고리</th>
                <th className="px-4 py-2 w-[80px] text-right">가격</th>
                <th className="px-4 py-2 w-[70px] text-right">빈속성</th>
                <th className="px-4 py-2 w-[70px] text-right">자동</th>
                <th className="px-4 py-2 w-[70px] text-right">자유</th>
                <th className="px-4 py-2 w-[70px] text-right">등록완료</th>
              </tr>
            </thead>
            <tbody className={text}>
              {loading ? (
                <tr><td colSpan={9} className={`text-center py-10 ${textSub}`}>불러오는 중…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={9} className={`text-center py-10 ${textSub}`}>데이터 없음</td></tr>
              ) : items.map((r, i) => (
                <tr key={`${r.seller_management_code}-${r.store_id}-${i}`}
                    onClick={() => setSelectedSku(r)}
                    className={`border-t ${border} cursor-pointer ${rowHover}`}>
                  <td className="px-4 py-2 font-mono text-[11px]">{r.seller_management_code}</td>
                  <td className="px-4 py-2">
                    <div className="truncate max-w-[420px]" title={r.product_name || ''}>{r.product_name || '(이름 없음)'}</div>
                  </td>
                  <td className="px-4 py-2 truncate max-w-[110px]">{r.store_name || `#${r.store_id}`}</td>
                  <td className="px-4 py-2 truncate max-w-[180px]" title={r.category_text}>
                    <button onClick={e => { e.stopPropagation(); setCategoryFilter(r.category_id); setPage(1); }}
                            className="hover:underline text-left">
                      {r.category_text || r.category_id}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-right">{fmt(r.sale_price)}</td>
                  <td className="px-4 py-2 text-right font-bold text-red-400">{r.missing_count}</td>
                  <td className="px-4 py-2 text-right">
                    {r.auto_count > 0 ? <span className="text-[#03c75a] font-bold">{r.auto_count}</span> : <span className={textSub}>0</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.free_count > 0 ? <span className="text-orange-400">{r.free_count}</span> : <span className={textSub}>0</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.registered_count > 0 ? <span className="text-blue-400">{r.registered_count}</span> : <span className={textSub}>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={`flex items-center justify-between px-4 py-3 border-t ${border}`}>
          <div className={`text-[12px] ${textSub}`}>{page} / {totalPages || 1} 페이지</div>
          <div className="flex gap-1">
            <button disabled={page<=1} onClick={() => setPage(1)}
                    className={`px-2 py-1 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>◀◀</button>
            <button disabled={page<=1} onClick={() => setPage(p => Math.max(1, p-1))}
                    className={`px-2 py-1 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>◀</button>
            <button disabled={page>=totalPages} onClick={() => setPage(p => p+1)}
                    className={`px-2 py-1 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>▶</button>
            <button disabled={page>=totalPages} onClick={() => setPage(totalPages)}
                    className={`px-2 py-1 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>▶▶</button>
          </div>
        </div>
      </div>

      {selectedSku && (
        <SkuMissingModal
          dark={dark}
          sku={selectedSku}
          onClose={() => { setSelectedSku(null); loadList(); fetchSummary().then(setSummary); }}
        />
      )}
      {autoCheckOpen && (
        <AttrAutoCheckModal onClose={() => { setAutoCheckOpen(false); loadList(); fetchSummary().then(setSummary); }} />
      )}
    </div>
  );
}

function StatCard({ dark, label, value, sub, accent }:
  { dark: boolean; label: string; value: string; sub: string; accent: string }) {
  return (
    <div className={`rounded-lg border p-4 ${dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200'}`}>
      <div className={`text-[12px] mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
      <div className="text-[22px] font-bold" style={{ color: accent }}>{value}</div>
      <div className={`text-[11px] mt-1 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</div>
    </div>
  );
}

function SkuMissingModal({ dark, sku, onClose }:
  { dark: boolean; sku: SkuRow; onClose: () => void }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const headBg = dark ? 'bg-[#0f0f1a]' : 'bg-gray-100';

  // attribute_groups: 카테고리의 모든 속성 + 각 옵션의 selected (현재 등록 상태)
  const [groups, setGroups] = useState<AttrGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // 사용자가 등록할 값 큐 (attribute_seq → AttrGroupValue)
  const [queue, setQueue] = useState<Map<number, AttrGroupValue>>(new Map());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    fetchAttrProductDetail(sku.seller_management_code, sku.store_id)
      .then(d => setGroups(d.attribute_groups || []))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [sku.seller_management_code, sku.store_id]);

  useEffect(() => { reload(); }, [reload]);

  // 자동 후보: 옵션 1개이며 미선택인 attribute
  const autoCandidates = groups.filter(g =>
    g.values.length === 1 && !g.values.some(v => v.selected)
  );
  const missingGroups = groups.filter(g => !g.values.some(v => v.selected));
  const setGroups_ = groups.filter(g => g.values.some(v => v.selected));

  const setVal = (aseq: number, v: AttrGroupValue | null) => {
    const next = new Map(queue);
    if (v === null) next.delete(aseq); else next.set(aseq, v);
    setQueue(next);
  };

  const queueAuto = () => {
    const m = new Map<number, AttrGroupValue>();
    autoCandidates.forEach(g => { m.set(g.attribute_seq, g.values[0]); });
    setQueue(m);
  };

  const doRegister = async (dryRun: boolean) => {
    if (queue.size === 0) { alert('등록할 속성을 선택하세요'); return; }
    if (!dryRun && !confirm(`${queue.size}개 속성을 등록하시겠습니까?`)) return;
    setBusy(true);
    setFeedback(`${dryRun ? '[DRY-RUN]' : '[등록]'} 진행 중...`);
    try {
      const r = await registerForSku({
        seller_management_code: sku.seller_management_code,
        store_id: sku.store_id,
        dry_run: dryRun,
        selections: Array.from(queue.entries()).map(([aseq, v]) => ({
          attribute_seq: aseq, value_seq: v.seq, value_text: v.text || '',
        })),
      });
      if (r.ok) {
        setFeedback(`${dryRun?'DRY-RUN':'등록'} 성공: ${r.attrs_set}개 속성 ${dryRun?'시뮬레이션':'적용'}됨`);
        if (!dryRun) {
          setQueue(new Map());
          reload();
        }
      } else {
        setFeedback(`실패: ${r.error}`);
      }
    } catch (e) {
      setFeedback(`오류: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className={`w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-lg ${dark?'bg-[#1a1a2e]':'bg-white'} shadow-2xl`}>
        <div className={`sticky top-0 flex items-center justify-between px-5 py-3 border-b ${border} ${dark?'bg-[#1a1a2e]':'bg-white'} z-10`}>
          <div>
            <h3 className={`text-[15px] font-bold ${text}`}>{sku.product_name || '(이름 없음)'}</h3>
            <div className={`text-[11px] mt-0.5 ${textSub}`}>
              <span className="font-mono">{sku.seller_management_code}</span>
              <span className="mx-2">·</span>{sku.store_name}
              <span className="mx-2">·</span>{sku.category_text || sku.category_id}
              <span className="mx-2">·</span>전체 <b className={text}>{groups.length}</b>개 속성
              <span className="mx-2">·</span>설정됨 <span className="text-[#03c75a] font-bold">{setGroups_.length}</span>
              <span className="mx-2">·</span>빈값 <span className="text-red-400 font-bold">{missingGroups.length}</span>
            </div>
          </div>
          <button onClick={onClose} className={`text-[20px] ${textSub} hover:${text}`}>×</button>
        </div>

        <div className={`sticky top-[60px] flex flex-wrap items-center gap-2 px-5 py-3 border-b ${border} ${dark?'bg-[#1a1a2e]':'bg-white'} z-10`}>
          <span className={`text-[12px] ${textSub}`}>
            등록 큐 <b className={text}>{queue.size}</b> / 빈값 {missingGroups.length}
            <span className="ml-3">(자동후보 {autoCandidates.length})</span>
          </span>
          <button onClick={queueAuto}
                  disabled={autoCandidates.length===0}
                  className={`px-3 py-1 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300 hover:bg-[#2a2a40]':'border-gray-300 text-gray-600 hover:bg-gray-100'} disabled:opacity-40`}>
            자동후보 모두 큐에
          </button>
          <button onClick={() => setQueue(new Map())}
                  className={`px-3 py-1 rounded text-[12px] ${textSub} hover:${dark?'bg-[#252540]':'bg-gray-100'}`}>
            큐 비우기
          </button>
          <div className="ml-auto flex gap-2">
            <button disabled={busy||queue.size===0} onClick={() => doRegister(true)}
                    className={`px-3 py-1.5 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300 hover:bg-[#2a2a40]':'border-gray-300 text-gray-700 hover:bg-gray-100'} disabled:opacity-40`}>
              DRY-RUN
            </button>
            <button disabled={busy||queue.size===0} onClick={() => doRegister(false)}
                    className="px-4 py-1.5 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-40">
              {busy ? '진행 중...' : `${queue.size}개 등록`}
            </button>
          </div>
        </div>

        {feedback && (
          <div className={`px-5 py-2 text-[12px] whitespace-pre-wrap ${dark?'bg-[#0f0f1a] text-gray-300':'bg-yellow-50 text-yellow-800'} border-b ${border}`}>
            {feedback}
          </div>
        )}

        <div className="p-5">
          {loading ? (
            <div className={`text-center py-10 ${textSub}`}>불러오는 중...</div>
          ) : groups.length === 0 ? (
            <div className={`text-center py-10 ${textSub}`}>이 카테고리에는 속성 정보 없음</div>
          ) : (
            <table className={`w-full text-[12px] border ${border} rounded`}>
              <colgroup><col style={{width:200}}/><col/></colgroup>
              <tbody>
                {groups.map(g => {
                  const queued = queue.get(g.attribute_seq);
                  const hasSelected = g.values.some(v => v.selected);
                  const isAuto = g.values.length === 1 && !hasSelected;
                  const isPrimary = g.attribute_type === 'PRIMARY';
                  const isMultiSelect = g.classification_type === 'MULTI_SELECT';
                  const isFree = g.values.length === 0;
                  return (
                    <tr key={g.attribute_seq}
                        className={`border-b ${border} ${hasSelected ? (dark?'bg-[#03c75a]/5':'bg-green-50') : ''}`}>
                      <th scope="row" className={`text-left align-top px-3 py-2 font-medium ${headBg} border-r ${border}`}>
                        <div className={`${g.attribute_name.startsWith('attr#')?'font-mono text-[11px]':''} ${text}`}>
                          {g.attribute_name}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {isPrimary && <span className="text-[10px] px-1 rounded bg-[#03c75a]/20 text-[#03c75a]">주요</span>}
                          {isMultiSelect && <span className="text-[10px] px-1 rounded bg-blue-500/20 text-blue-400">복수</span>}
                          {!isMultiSelect && g.classification_type === 'SINGLE_SELECT' && <span className={`text-[10px] ${textSub}`}>단일</span>}
                          {isFree && <span className="text-[10px] px-1 rounded bg-orange-500/20 text-orange-400">자유입력</span>}
                          {hasSelected && <span className="text-[10px] px-1 rounded bg-[#03c75a]/20 text-[#03c75a]">설정됨</span>}
                          {!hasSelected && !isFree && isAuto && <span className="text-[10px] px-1 rounded bg-yellow-500/20 text-yellow-400">자동후보</span>}
                          {!hasSelected && !isFree && !isAuto && <span className="text-[10px] px-1 rounded bg-red-500/20 text-red-400">빈값</span>}
                        </div>
                        {queued && (
                          <div className="text-[10px] text-yellow-400 mt-1 font-bold">→ {queued.text} 큐에</div>
                        )}
                      </th>
                      <td className={`align-top px-3 py-2 ${dark?'bg-[#1c1c2e]':'bg-white'}`}>
                        {isFree ? (
                          <div className={`${textSub} italic text-[11px]`}>옵션 정보 없음 (자유입력 — 인증번호 등 직접 입력 필요)</div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {g.values.map(v => {
                              const isSel = v.selected;       // 이미 등록된 값
                              const isQueued = queued?.seq === v.seq && !isSel;
                              return (
                                <button key={v.seq}
                                        onClick={() => isSel ? null : setVal(g.attribute_seq, isQueued ? null : v)}
                                        disabled={isSel}
                                        className={`px-2.5 py-1 rounded-full text-[12px] border transition-colors flex items-center gap-1.5
                                          ${isSel
                                            ? 'bg-[#03c75a] text-white border-[#03c75a] font-medium cursor-default'
                                            : isQueued
                                              ? 'bg-yellow-500 text-white border-yellow-500 font-medium'
                                              : `${dark?'bg-[#252540] text-gray-400 border-[#2a2a40] hover:bg-[#2a2a40] hover:text-gray-200':'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100 hover:text-gray-900'}`}`}>
                                  {v.color && <span className="w-3 h-3 rounded-full border border-white/30 inline-block" style={{background: v.color}} />}
                                  {isSel && <span className="text-[10px]">✓</span>}
                                  {isQueued && <span className="text-[10px]">+</span>}
                                  {v.text || `#${v.seq}`}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
