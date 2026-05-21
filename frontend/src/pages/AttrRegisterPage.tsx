import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchAttrList, fetchAttrSkus, registerBulk, registerFiltered,
  refreshSummary, markBulk,
  type MissingAttrItem, type CandidateValue, type MissingSkuItem,
} from '../api/missingAttrsApi';

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString();
}

type KindFilter = 'all' | 'opt' | 'auto' | 'free';

export default function AttrRegisterPage() {
  const { dark } = useTheme();
  const [items, setItems] = useState<MissingAttrItem[]>([]);
  const [page, setPage] = useState(1);
  const perPage = 50;
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [kind, setKind] = useState<KindFilter>('opt');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MissingAttrItem | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = dark ? 'bg-[#252540] border-[#2a2a40] text-white' : 'bg-white border-gray-300 text-gray-900';
  const tableHeader = dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-50 text-gray-600';
  const rowHover = dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const load = useCallback(() => {
    setLoading(true);
    fetchAttrList({ page, per_page: perPage, search, kind, status: 'pending', sort: 'count' })
      .then(d => { setItems(d.items); setTotal(d.total); setTotalPages(d.total_pages); })
      .catch(() => { setItems([]); setTotal(0); setTotalPages(0); })
      .finally(() => setLoading(false));
  }, [page, search, kind]);

  useEffect(() => { load(); }, [load]);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshSummary();
      alert(`재계산 완료\n속성 ${r.attr_summary_rows.toLocaleString()}개\nSKU ${r.sku_summary_rows.toLocaleString()}개`);
      load();
    } catch (e) {
      alert(`실패: ${e}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={`min-h-[calc(100vh-42px)] ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'} p-6`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className={`text-xl font-bold ${text}`}>속성별 등록 (비슷한 상품 일괄 적용)</h1>
          <p className={`text-[12px] mt-0.5 ${textSub}`}>속성 클릭 → 카테고리 선택 → 값 선택 → 일괄 등록</p>
        </div>
        <div className="flex gap-2">
          <button onClick={doRefresh} disabled={refreshing}
                  className={`px-3 py-1.5 rounded text-[12px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'} disabled:opacity-50`}>
            {refreshing ? '재계산 중...' : '요약 재계산'}
          </button>
          <button onClick={load}
                  className={`px-3 py-1.5 rounded text-[12px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}>
            새로고침
          </button>
        </div>
      </div>

      <div className={`rounded-lg border ${card}`}>
        <div className={`flex flex-wrap items-center gap-2 px-4 py-3 border-b ${border}`}>
          <input value={searchInput}
                 onChange={e => setSearchInput(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && (setSearch(searchInput.trim()), setPage(1))}
                 placeholder="속성명 검색"
                 className={`px-3 py-1.5 rounded text-[13px] border w-56 ${inputCls} focus:outline-none focus:border-[#03c75a]`} />
          <button onClick={() => { setSearch(searchInput.trim()); setPage(1); }}
                  className="px-3 py-1.5 rounded text-[13px] bg-[#03c75a] text-white hover:bg-[#02b150]">검색</button>

          <div className="flex gap-1 ml-2">
            {(['all', 'opt', 'auto', 'free'] as KindFilter[]).map(k => (
              <button key={k} onClick={() => { setKind(k); setPage(1); }}
                      className={`px-2.5 py-1 rounded text-[12px] border ${
                        kind === k
                          ? 'bg-[#03c75a] text-white border-[#03c75a]'
                          : `${dark ? 'border-[#2a2a40] text-gray-300 hover:bg-[#252540]' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`
                      }`}>
                {k === 'all' ? '전체' : k === 'opt' ? '옵션 1+' : k === 'auto' ? '자동(1개)' : '자유입력'}
              </button>
            ))}
          </div>
          {(search || kind !== 'opt') && (
            <button onClick={() => { setSearchInput(''); setSearch(''); setKind('opt'); setPage(1); }}
                    className={`px-2 py-1.5 rounded text-[12px] ${textSub} hover:${dark?'bg-[#252540]':'bg-gray-100'}`}>
              초기화
            </button>
          )}
          <div className={`ml-auto text-[12px] ${textSub}`}>총 <span className={text}>{fmt(total)}</span>개 속성</div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className={tableHeader}>
              <tr className="text-left">
                <th className="px-4 py-2 w-[60px]">SEQ</th>
                <th className="px-4 py-2">속성명</th>
                <th className="px-4 py-2 w-[140px]">옵션값 (예시)</th>
                <th className="px-4 py-2 w-[80px] text-right">옵션 수</th>
                <th className="px-4 py-2 w-[90px] text-right">전체 SKU</th>
                <th className="px-4 py-2 w-[90px] text-right">미등록</th>
                <th className="px-4 py-2 w-[80px] text-right">완료</th>
                <th className="px-4 py-2 w-[80px] text-right">기타</th>
              </tr>
            </thead>
            <tbody className={text}>
              {loading ? (
                <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>불러오는 중…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>데이터 없음</td></tr>
              ) : items.map(r => (
                <tr key={r.attribute_seq}
                    onClick={() => setSelected(r)}
                    className={`border-t ${border} cursor-pointer ${rowHover}`}>
                  <td className="px-4 py-2 font-mono text-[11px]">{r.attribute_seq}</td>
                  <td className="px-4 py-2 font-medium">{r.attribute_name}</td>
                  <td className="px-4 py-2 truncate max-w-[140px] text-[11px]" title={r.candidate_values.map(v=>v.text).join(', ')}>
                    {r.candidate_count === 0
                      ? <span className="text-orange-400">자유입력</span>
                      : r.candidate_values.slice(0, 2).map(v => v.text).join(', ') +
                        (r.candidate_count > 2 ? ` 외 ${r.candidate_count - 2}` : '')}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {r.candidate_count === 0
                      ? <span className="text-orange-400">FREE</span>
                      : r.candidate_count === 1
                        ? <span className="text-yellow-400 font-bold">1</span>
                        : r.candidate_count}
                  </td>
                  <td className="px-4 py-2 text-right">{fmt(r.missing_skus)}</td>
                  <td className="px-4 py-2 text-right font-bold text-red-400">{fmt(r.pending_skus)}</td>
                  <td className="px-4 py-2 text-right text-blue-400">{fmt(r.registered_skus)}</td>
                  <td className="px-4 py-2 text-right text-[11px]">
                    {r.needs_manual_skus ? <span className="text-orange-400" title="needs_manual">{fmt(r.needs_manual_skus)}</span> : '-'}
                    {' / '}
                    {r.failed_skus ? <span className="text-red-500" title="fail">{fmt(r.failed_skus)}</span> : '-'}
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

      {selected && (
        <AttrBulkRegisterModal
          dark={dark}
          attr={selected}
          onClose={() => { setSelected(null); load(); }}
        />
      )}
    </div>
  );
}

interface AttrBulkRegisterModalProps {
  dark: boolean;
  attr: MissingAttrItem;
  onClose: () => void;
}

function AttrBulkRegisterModal({ dark, attr, onClose }: AttrBulkRegisterModalProps) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const headBg = dark ? 'bg-[#0f0f1a]' : 'bg-gray-100';
  const inputCls = dark ? 'bg-[#252540] border-[#2a2a40] text-white' : 'bg-white border-gray-300 text-gray-900';
  const rowHover = dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50';

  const [skus, setSkus] = useState<MissingSkuItem[]>([]);
  const [byCategory, setByCategory] = useState<{category_id:string;cnt:number}[]>([]);
  const [page, setPage] = useState(1);
  const perPage = 100;
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedValue, setSelectedValue] = useState<CandidateValue | null>(null);
  const [freeText, setFreeText] = useState('');  // 자유입력 모드 텍스트
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());  // key: seller|store
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  const isFreeInput = attr.candidate_count === 0;

  const skuKey = (s: MissingSkuItem) => `${s.seller_management_code}|${s.store_id}`;

  const load = useCallback(() => {
    setLoading(true);
    fetchAttrSkus(attr.attribute_seq, {
      page, per_page: perPage,
      category_id: categoryFilter || undefined,
      search: search || undefined,
      status: 'pending',
    })
      .then(d => {
        setSkus(d.items); setTotal(d.total); setTotalPages(d.total_pages);
        setByCategory(d.by_category || []);
      })
      .catch(() => { setSkus([]); setTotal(0); setTotalPages(0); setByCategory([]); })
      .finally(() => setLoading(false));
  }, [attr.attribute_seq, page, categoryFilter, search]);

  useEffect(() => { load(); }, [load]);

  const toggleSku = (s: MissingSkuItem) => {
    const k = skuKey(s);
    const next = new Set(selectedSkus);
    if (next.has(k)) next.delete(k); else next.add(k);
    setSelectedSkus(next);
  };

  const toggleAllVisible = () => {
    const allVisibleKeys = skus.map(skuKey);
    const allSelected = allVisibleKeys.every(k => selectedSkus.has(k));
    const next = new Set(selectedSkus);
    if (allSelected) {
      allVisibleKeys.forEach(k => next.delete(k));
    } else {
      allVisibleKeys.forEach(k => next.add(k));
    }
    setSelectedSkus(next);
  };

  const selectAllInCategory = (catId: string) => {
    // 카테고리 변경 + 100개 모두 선택 시도 (1페이지만)
    setCategoryFilter(catId);
    setPage(1);
  };

  const clearSelection = () => setSelectedSkus(new Set());

  const doBulkRegister = async (dryRun: boolean) => {
    if (isFreeInput) {
      if (!freeText.trim()) { alert('값을 입력하세요'); return; }
    } else {
      if (!selectedValue) { alert('값을 선택하세요'); return; }
    }
    if (selectedSkus.size === 0) { alert('SKU 를 선택하세요'); return; }
    const valueLabel = isFreeInput ? freeText.trim() : selectedValue!.text;
    if (!dryRun && !confirm(`${selectedSkus.size}개 SKU 에 [${valueLabel}] 등록하시겠습니까?`)) return;

    setBusy(true);
    setFeedback(`${dryRun ? '[DRY-RUN]' : '[등록]'} ${selectedSkus.size}개 진행 중...`);
    try {
      const skuObjs = skus
        .filter(s => selectedSkus.has(skuKey(s)))
        .filter(s => s.origin_product_no)
        .map(s => ({
          seller_management_code: s.seller_management_code,
          store_id: s.store_id,
          origin_product_no: s.origin_product_no,
        }));
      if (skuObjs.length === 0) {
        setFeedback('선택된 SKU 중 origin_product_no 있는 항목이 없음 (현재 페이지에 없는 SKU 일수 있음)');
        return;
      }
      const r = await registerBulk({
        attribute_seq: attr.attribute_seq,
        value_seq: isFreeInput ? 0 : selectedValue!.seq,
        value_text: valueLabel,
        dry_run: dryRun,
        skus: skuObjs,
      });
      setFeedback(`${dryRun ? 'DRY-RUN' : '등록'} 결과: OK ${r.ok} / FAIL ${r.fail}${r.errors.length ? `\n에러 샘플:\n${r.errors.slice(0,5).join('\n')}` : ''}`);
      if (!dryRun) {
        clearSelection();
        load();
      }
    } catch (e) {
      setFeedback(`오류: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doRegisterAllMatching = async (dryRun: boolean) => {
    if (isFreeInput) {
      if (!freeText.trim()) { alert('값을 입력하세요'); return; }
    } else {
      if (!selectedValue) { alert('값을 선택하세요'); return; }
    }
    const valueLabel = isFreeInput ? freeText.trim() : selectedValue!.text;
    const filterDesc = categoryFilter ? `카테고리=${categoryFilter}` : '전체';
    if (!dryRun && !confirm(`${filterDesc} (총 ${total.toLocaleString()}개) 매칭되는 모든 SKU 에 [${valueLabel}] 등록하시겠습니까?\n\n— 페이지네이션 없이 매칭 전부 처리 (max 2000)`)) return;

    setBusy(true);
    setFeedback(`${dryRun ? '[DRY-RUN]' : '[전체 등록]'} 진행 중... (${total}개 매칭)`);
    try {
      const r = await registerFiltered({
        attribute_seq: attr.attribute_seq,
        value_seq: isFreeInput ? 0 : selectedValue!.seq,
        value_text: valueLabel,
        category_id: categoryFilter || undefined,
        search: search || undefined,
        max_skus: 2000,
        dry_run: dryRun,
      });
      if (r.aborted) {
        setFeedback(`중단: ${r.errors.join(', ')}\n매칭 ${r.total_matched.toLocaleString()}개 — 한도 초과. 카테고리 필터로 줄이세요.`);
      } else {
        setFeedback(`${dryRun ? 'DRY-RUN' : '전체 등록'} 결과: 매칭 ${r.total_matched} / OK ${r.ok} / FAIL ${r.fail}${r.errors.length ? `\n에러 샘플:\n${r.errors.slice(0,5).join('\n')}` : ''}`);
        if (!dryRun) {
          clearSelection();
          load();
        }
      }
    } catch (e) {
      setFeedback(`오류: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doMarkSkipped = async () => {
    if (selectedSkus.size === 0) { alert('SKU 를 선택하세요'); return; }
    if (!confirm(`${selectedSkus.size}개 SKU 의 [${attr.attribute_name}] 항목을 스킵 처리(skipped) 합니까?`)) return;
    setBusy(true);
    try {
      const skuObjs = skus
        .filter(s => selectedSkus.has(skuKey(s)))
        .map(s => ({ seller_management_code: s.seller_management_code, store_id: s.store_id }));
      const r = await markBulk({ attribute_seq: attr.attribute_seq, status: 'skipped', skus: skuObjs });
      setFeedback(`스킵 처리: ${r.updated}개`);
      clearSelection();
      load();
    } catch (e) {
      setFeedback(`오류: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const candidates = useMemo(() => attr.candidate_values || [], [attr]);
  const allVisibleSelected = skus.length > 0 && skus.every(s => selectedSkus.has(skuKey(s)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className={`w-full max-w-7xl max-h-[94vh] overflow-y-auto rounded-lg ${dark?'bg-[#1a1a2e]':'bg-white'} shadow-2xl`}>

        <div className={`sticky top-0 flex items-center justify-between px-5 py-3 border-b ${border} ${dark?'bg-[#1a1a2e]':'bg-white'} z-10`}>
          <div>
            <h3 className={`text-[15px] font-bold ${text}`}>{attr.attribute_name}
              <span className={`ml-2 text-[11px] font-normal ${textSub}`}>seq={attr.attribute_seq}</span>
            </h3>
            <div className={`text-[11px] mt-0.5 ${textSub}`}>
              옵션 <b className={text}>{attr.candidate_count}</b>개 ·
              미등록 SKU <b className="text-red-400">{fmt(attr.pending_skus)}</b> ·
              완료 <b className="text-blue-400">{fmt(attr.registered_skus)}</b>
            </div>
          </div>
          <button onClick={onClose} className={`text-[20px] ${textSub} hover:${text}`}>×</button>
        </div>

        {/* 후보값 chip — 클릭해서 선택 / 자유입력은 텍스트 박스 */}
        <div className={`px-5 py-3 border-b ${border}`}>
          <div className={`text-[11px] mb-2 ${textSub}`}>
            {isFreeInput ? '등록할 값 직접 입력 (자유입력 속성)' : '등록할 값 선택 (필수)'}
          </div>
          {isFreeInput ? (
            <div className="flex flex-wrap gap-2 items-center">
              <input value={freeText}
                     onChange={e => setFreeText(e.target.value)}
                     placeholder="예: 자가검사번호, 인증번호, 모델명 등"
                     className={`flex-1 max-w-md px-3 py-1.5 rounded text-[13px] border ${inputCls} focus:outline-none focus:border-[#03c75a]`} />
              {freeText.trim() && (
                <span className={`text-[11px] px-2 py-1 rounded ${dark?'bg-[#03c75a]/15 text-[#03c75a]':'bg-green-100 text-green-800'}`}>
                  → "{freeText.trim()}"
                </span>
              )}
              {/* 자주 쓰는 값 */}
              <div className="flex gap-1 ml-2">
                {['해외구매대행', '자가인증', 'KC 인증'].map(s => (
                  <button key={s} onClick={() => setFreeText(s)}
                          className={`text-[11px] px-2 py-1 rounded border ${dark?'border-[#2a2a40] text-gray-400 hover:bg-[#252540]':'border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <div className={`${textSub} italic text-[12px]`}>옵션 정보 없음.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {candidates.map(v => {
                const isSel = selectedValue?.seq === v.seq;
                return (
                  <button key={v.seq}
                          onClick={() => setSelectedValue(isSel ? null : v)}
                          className={`px-2.5 py-1 rounded-full text-[12px] border transition-colors flex items-center gap-1.5
                            ${isSel
                              ? 'bg-[#03c75a] text-white border-[#03c75a] font-medium'
                              : `${dark?'bg-[#252540] text-gray-400 border-[#2a2a40] hover:bg-[#2a2a40] hover:text-gray-200':'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100 hover:text-gray-900'}`}`}>
                    {v.color && <span className="w-3 h-3 rounded-full border border-white/30 inline-block" style={{background: v.color}} />}
                    {v.text || `#${v.seq}`}
                    {isSel && <span className="text-[10px]">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 카테고리별 분포 — 클릭해서 필터 */}
        {byCategory.length > 0 && (
          <div className={`px-5 py-3 border-b ${border}`}>
            <div className={`text-[11px] mb-2 ${textSub}`}>카테고리 필터 (현재 표시: {fmt(total)} SKU)</div>
            <div className="flex flex-wrap gap-1">
              <button onClick={() => { setCategoryFilter(''); setPage(1); }}
                      className={`px-2 py-1 rounded text-[11px] border ${
                        !categoryFilter
                          ? 'bg-[#03c75a]/20 border-[#03c75a] text-[#03c75a] font-medium'
                          : `${dark?'border-[#2a2a40] text-gray-400 hover:bg-[#252540]':'border-gray-300 text-gray-600 hover:bg-gray-100'}`}`}>
                전체
              </button>
              {byCategory.map(c => (
                <button key={c.category_id}
                        onClick={() => selectAllInCategory(c.category_id)}
                        className={`px-2 py-1 rounded text-[11px] border ${
                          categoryFilter === c.category_id
                            ? 'bg-[#03c75a]/20 border-[#03c75a] text-[#03c75a] font-medium'
                            : `${dark?'border-[#2a2a40] text-gray-400 hover:bg-[#252540]':'border-gray-300 text-gray-600 hover:bg-gray-100'}`}`}>
                  {c.category_id} ({c.cnt})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 검색 + 액션 바 */}
        <div className={`sticky top-[60px] flex flex-wrap items-center gap-2 px-5 py-3 border-b ${border} ${dark?'bg-[#1a1a2e]':'bg-white'} z-10`}>
          <input value={searchInput}
                 onChange={e => setSearchInput(e.target.value)}
                 onKeyDown={e => e.key === 'Enter' && (setSearch(searchInput.trim()), setPage(1))}
                 placeholder="W코드 검색"
                 className={`px-3 py-1.5 rounded text-[12px] border w-48 ${inputCls}`} />
          <button onClick={() => { setSearch(searchInput.trim()); setPage(1); }}
                  className="px-3 py-1.5 rounded text-[12px] bg-[#03c75a] text-white">검색</button>

          <span className={`ml-3 text-[12px] ${textSub}`}>
            선택 <b className={text}>{selectedSkus.size}</b> / 표시 {skus.length} / 총 {fmt(total)}
          </span>
          {(selectedValue || (isFreeInput && freeText.trim())) && (
            <span className={`text-[11px] ${dark?'bg-[#03c75a]/15 text-[#03c75a]':'bg-green-100 text-green-800'} px-2 py-1 rounded`}>
              값: <b>{isFreeInput ? freeText.trim() : selectedValue!.text}</b>
            </span>
          )}
          {selectedSkus.size > 0 && (
            <button onClick={clearSelection}
                    className={`px-2 py-1 rounded text-[11px] ${textSub} hover:${dark?'bg-[#252540]':'bg-gray-100'}`}>
              선택 해제
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={doMarkSkipped}
                    disabled={busy || selectedSkus.size === 0}
                    className={`px-3 py-1.5 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300 hover:bg-[#2a2a40]':'border-gray-300 text-gray-700 hover:bg-gray-100'} disabled:opacity-40`}>
              스킵 처리
            </button>
            <button onClick={() => doBulkRegister(true)}
                    disabled={busy || (isFreeInput ? !freeText.trim() : !selectedValue) || selectedSkus.size === 0}
                    className={`px-3 py-1.5 rounded text-[12px] border ${dark?'border-[#2a2a40] text-gray-300 hover:bg-[#2a2a40]':'border-gray-300 text-gray-700 hover:bg-gray-100'} disabled:opacity-40`}>
              DRY-RUN
            </button>
            <button onClick={() => doBulkRegister(false)}
                    disabled={busy || (isFreeInput ? !freeText.trim() : !selectedValue) || selectedSkus.size === 0}
                    className="px-3 py-1.5 rounded text-[12px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-40">
              {busy ? '진행 중...' : `선택 ${selectedSkus.size}개 등록`}
            </button>
            <button onClick={() => doRegisterAllMatching(false)}
                    disabled={busy || (isFreeInput ? !freeText.trim() : !selectedValue) || total === 0 || total > 2000}
                    title={total > 2000 ? `매칭 ${total.toLocaleString()}개 — 2000 한도 초과. 카테고리로 좁히세요` : `매칭 ${total.toLocaleString()}개 전부 등록`}
                    className="px-4 py-1.5 rounded text-[12px] bg-[#dc2626] text-white hover:bg-[#b91c1c] disabled:opacity-40">
              {busy ? '진행 중...' : `매칭 ${fmt(total)}개 전체 등록`}
            </button>
          </div>
        </div>

        {feedback && (
          <div className={`px-5 py-2 text-[12px] whitespace-pre-wrap ${dark?'bg-[#0f0f1a] text-gray-300':'bg-yellow-50 text-yellow-800'} border-b ${border}`}>
            {feedback}
          </div>
        )}

        {/* SKU 리스트 */}
        <div className="px-5 py-3">
          <table className={`w-full text-[12px] border ${border} rounded`}>
            <thead className={headBg}>
              <tr>
                <th className="px-2 py-2 w-8">
                  <input type="checkbox"
                         checked={allVisibleSelected}
                         onChange={toggleAllVisible} />
                </th>
                <th className="px-3 py-2 text-left w-[120px]">W코드</th>
                <th className="px-3 py-2 text-left">상품명</th>
                <th className="px-3 py-2 text-left w-[120px]">스토어</th>
                <th className="px-3 py-2 text-left w-[100px]">카테고리</th>
                <th className="px-3 py-2 text-right w-[80px]">가격</th>
              </tr>
            </thead>
            <tbody className={text}>
              {loading ? (
                <tr><td colSpan={6} className={`text-center py-10 ${textSub}`}>불러오는 중...</td></tr>
              ) : skus.length === 0 ? (
                <tr><td colSpan={6} className={`text-center py-10 ${textSub}`}>SKU 없음</td></tr>
              ) : skus.map(s => {
                const isSel = selectedSkus.has(skuKey(s));
                return (
                  <tr key={skuKey(s)}
                      onClick={() => toggleSku(s)}
                      className={`border-t ${border} cursor-pointer ${isSel ? (dark?'bg-[#03c75a]/10':'bg-green-50') : rowHover}`}>
                    <td className="px-2 py-2">
                      <input type="checkbox"
                             checked={isSel}
                             onChange={() => toggleSku(s)}
                             onClick={e => e.stopPropagation()} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{s.seller_management_code}</td>
                    <td className="px-3 py-2 truncate max-w-[400px]" title={s.product_name}>{s.product_name || '(이름 없음)'}</td>
                    <td className="px-3 py-2 truncate max-w-[120px]">{s.store_name || `#${s.store_id}`}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{s.category_id}</td>
                    <td className="px-3 py-2 text-right">{fmt(s.sale_price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={`flex items-center justify-between mt-3`}>
            <div className={`text-[12px] ${textSub}`}>{page} / {totalPages || 1} 페이지</div>
            <div className="flex gap-1">
              <button disabled={page<=1} onClick={() => setPage(1)}
                      className={`px-2 py-1 rounded text-[11px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>◀◀</button>
              <button disabled={page<=1} onClick={() => setPage(p => Math.max(1, p-1))}
                      className={`px-2 py-1 rounded text-[11px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>◀</button>
              <button disabled={page>=totalPages} onClick={() => setPage(p => p+1)}
                      className={`px-2 py-1 rounded text-[11px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>▶</button>
              <button disabled={page>=totalPages} onClick={() => setPage(totalPages)}
                      className={`px-2 py-1 rounded text-[11px] border ${dark?'border-[#2a2a40] text-gray-300':'border-gray-300 text-gray-600'} disabled:opacity-40`}>▶▶</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
