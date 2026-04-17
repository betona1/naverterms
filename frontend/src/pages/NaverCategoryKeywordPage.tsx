import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import type { DatalabCategory, CategoryKeywordRank, EnrichData } from '../api/naverApi';

type SortKey = 'rank' | 'keyword' | 'pcQc' | 'moQc' | 'totalQc' | 'compIdx' | 'productCount' | 'category';
type SortDir = 'asc' | 'desc';

const PAGE_SIZES = [100, 300, 500];
const COMP_MAP: Record<string, string> = { HIGH: '높음', MEDIUM: '중간', LOW: '낮음' };
const COMP_COLOR_D: Record<string, string> = { '높음': 'text-red-400', '중간': 'text-yellow-400', '낮음': 'text-green-400' };
const COMP_COLOR_L: Record<string, string> = { '높음': 'text-red-600', '중간': 'text-yellow-600', '낮음': 'text-green-600' };

const AGE_OPTIONS = [
  { value: '', label: '전체' },
  { value: '10', label: '10대' }, { value: '20', label: '20대' },
  { value: '30', label: '30대' }, { value: '40', label: '40대' },
  { value: '50', label: '50대' }, { value: '60', label: '60대 이상' },
];
const GENDER_OPTIONS = [
  { value: '', label: '전체' }, { value: 'f', label: '여성' }, { value: 'm', label: '남성' },
];
const DEVICE_OPTIONS = [
  { value: '', label: '전체' }, { value: 'pc', label: 'PC' }, { value: 'mo', label: '모바일' },
];

function toDateStr(d: Date) { return d.toISOString().split('T')[0]; }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return toDateStr(d); }
function fmt(v: number) { return v.toLocaleString(); }

interface EnrichedRow extends CategoryKeywordRank {
  pcQc: number;
  moQc: number;
  totalQc: number;
  compIdx: string;
  productCount: number;
  category: string;
}

/* ───── Pagination ───── */
function Pagination({ page, totalPages, total, pageSize, onPageChange, onPageSizeChange, dark }: {
  page: number; totalPages: number; total: number; pageSize: number;
  onPageChange: (p: number) => void; onPageSizeChange: (s: number) => void; dark: boolean;
}) {
  if (total === 0) return null;
  const maxButtons = 10;
  let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
  const endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage + 1 < maxButtons) startPage = Math.max(1, endPage - maxButtons + 1);
  const pages: number[] = [];
  for (let i = startPage; i <= endPage; i++) pages.push(i);
  const btn = `px-2 py-1 text-[11px] rounded border transition-colors ${dark ? 'border-[#444] hover:bg-[#333] text-gray-300 disabled:opacity-30' : 'border-[#ddd] hover:bg-[#e7f5ff] disabled:opacity-30'}`;
  const activeBtn = 'px-2 py-1 text-[11px] rounded border border-[#228be6] bg-[#228be6] text-white font-bold';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-1">
        <button className={btn} disabled={page <= 1} onClick={() => onPageChange(1)}>&#171;</button>
        <button className={btn} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>&#8249;</button>
        {startPage > 1 && <span className="text-[10px] text-gray-500 px-0.5">...</span>}
        {pages.map(p => <button key={p} className={p === page ? activeBtn : btn} onClick={() => onPageChange(p)}>{p}</button>)}
        {endPage < totalPages && <span className="text-[10px] text-gray-500 px-0.5">...</span>}
        <button className={btn} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>&#8250;</button>
        <button className={btn} disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>&#187;</button>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[11px] ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{from.toLocaleString()}~{to.toLocaleString()} / {total.toLocaleString()}개</span>
        <select className={`border rounded px-1.5 py-0.5 text-[11px] ${dark ? 'bg-[#2d2d2d] border-[#444] text-gray-300' : 'border-[#ddd]'}`}
          value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))}>
          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}개씩</option>)}
        </select>
      </div>
    </div>
  );
}

/* ─��─── Main ───── */
export default function NaverCategoryKeywordPage() {
  const { dark } = useTheme();

  // Category cascading
  const [cat1List, setCat1List] = useState<DatalabCategory[]>([]);
  const [cat2List, setCat2List] = useState<DatalabCategory[]>([]);
  const [cat3List, setCat3List] = useState<DatalabCategory[]>([]);
  const [cat4List, setCat4List] = useState<DatalabCategory[]>([]);
  const [sel1, setSel1] = useState('');
  const [sel2, setSel2] = useState('');
  const [sel3, setSel3] = useState('');
  const [sel4, setSel4] = useState('');
  const [catLoading, setCatLoading] = useState(false);

  // Filters
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(toDateStr(new Date()));
  const [age, setAge] = useState('');
  const [gender, setGender] = useState('');
  const [device, setDevice] = useState('');

  // Results
  const [rows, setRows] = useState<CategoryKeywordRank[]>([]);
  const [enrichData, setEnrichData] = useState<Record<string, EnrichData>>({});
  const [loading, setLoading] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const enrichAbort = useRef(false);

  // Table
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filterKw, setFilterKw] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(500);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // Category breadcrumb
  const catPath = useMemo(() => {
    const parts: string[] = [];
    const find = (list: DatalabCategory[], cid: string) => list.find(c => c.cid === cid);
    if (sel1) { const c = find(cat1List, sel1); if (c) parts.push(c.name); }
    if (sel2) { const c = find(cat2List, sel2); if (c) parts.push(c.name); }
    if (sel3) { const c = find(cat3List, sel3); if (c) parts.push(c.name); }
    if (sel4) { const c = find(cat4List, sel4); if (c) parts.push(c.name); }
    return parts;
  }, [sel1, sel2, sel3, sel4, cat1List, cat2List, cat3List, cat4List]);

  const deepestCid = sel4 || sel3 || sel2 || sel1;

  // Load top-level categories on mount
  useEffect(() => { naverApi.getDatalabCategories('0').then(setCat1List).catch(() => {}); }, []);

  // Cascade effects
  useEffect(() => {
    setCat2List([]); setSel2(''); setCat3List([]); setSel3(''); setCat4List([]); setSel4('');
    if (!sel1) return;
    setCatLoading(true);
    naverApi.getDatalabCategories(sel1).then(setCat2List).catch(() => setCat2List([])).finally(() => setCatLoading(false));
  }, [sel1]);
  useEffect(() => {
    setCat3List([]); setSel3(''); setCat4List([]); setSel4('');
    if (!sel2) return;
    setCatLoading(true);
    naverApi.getDatalabCategories(sel2).then(setCat3List).catch(() => setCat3List([])).finally(() => setCatLoading(false));
  }, [sel2]);
  useEffect(() => {
    setCat4List([]); setSel4('');
    if (!sel3) return;
    setCatLoading(true);
    naverApi.getDatalabCategories(sel3).then(setCat4List).catch(() => setCat4List([])).finally(() => setCatLoading(false));
  }, [sel3]);

  // Enrich keywords in batches
  const doEnrich = useCallback(async (keywords: string[]) => {
    enrichAbort.current = false;
    setEnriching(true);
    setEnrichProgress({ done: 0, total: keywords.length });
    const batchSize = 50;
    let done = 0;

    for (let i = 0; i < keywords.length; i += batchSize) {
      if (enrichAbort.current) break;
      const batch = keywords.slice(i, i + batchSize);
      try {
        const res = await naverApi.enrichKeywords(batch);
        const batchData = res.data || {};
        setEnrichData(prev => ({ ...prev, ...batchData }));
        done += batch.length;
        setEnrichProgress({ done, total: keywords.length });
      } catch {
        done += batch.length;
        setEnrichProgress({ done, total: keywords.length });
      }
    }
    setEnriching(false);
    setEnrichProgress(null);
  }, []);

  const search = useCallback(async () => {
    if (!deepestCid) { setError('카테고리를 선택하세요'); return; }
    enrichAbort.current = true;
    setLoading(true); setError(''); setStatusMsg(''); setPage(1); setChecked(new Set());
    setEnrichData({}); setEnrichProgress(null);

    try {
      const data = await naverApi.getCategoryKeywordRank({ cid: deepestCid, startDate, endDate, age, gender, device });
      const list = data.ranks || [];
      setRows(list);
      const cacheNote = data.cached ? ` (캐시 ${new Date(data.cached_at).toLocaleString('ko-KR')})` : '';
      setStatusMsg(`${catPath.join(' > ')} — ${list.length}개 키워드${cacheNote}`);
      setLoading(false);

      // Auto-enrich
      if (list.length > 0) {
        const kws = list.map(r => r.keyword);
        doEnrich(kws);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'API 오류');
      setRows([]);
      setLoading(false);
    }
  }, [deepestCid, startDate, endDate, age, gender, device, catPath, doEnrich]);

  // Build enriched rows
  const enrichedRows: EnrichedRow[] = useMemo(() => rows.map(r => {
    const e = enrichData[r.keyword];
    const pcQc = e?.monthlyPcQcCnt ?? -1;
    const moQc = e?.monthlyMobileQcCnt ?? -1;
    return {
      ...r,
      pcQc,
      moQc,
      totalQc: pcQc >= 0 && moQc >= 0 ? pcQc + moQc : -1,
      compIdx: e?.compIdx ? (COMP_MAP[e.compIdx] || e.compIdx) : '',
      productCount: e?.productCount ?? -1,
      category: e?.category || '',
    };
  }), [rows, enrichData]);

  // Filter & sort
  const filtered = useMemo(() => {
    if (!filterKw) return enrichedRows;
    return enrichedRows.filter(r => r.keyword.includes(filterKw));
  }, [enrichedRows, filterKw]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    let av: number | string, bv: number | string;
    switch (sortKey) {
      case 'rank': av = a.rank; bv = b.rank; break;
      case 'keyword': av = a.keyword; bv = b.keyword; break;
      case 'pcQc': av = a.pcQc; bv = b.pcQc; break;
      case 'moQc': av = a.moQc; bv = b.moQc; break;
      case 'totalQc': av = a.totalQc; bv = b.totalQc; break;
      case 'productCount': av = a.productCount; bv = b.productCount; break;
      case 'category': av = a.category; bv = b.category; break;
      case 'compIdx': {
        const order: Record<string, number> = { '높음': 3, '중간': 2, '낮음': 1 };
        av = order[a.compIdx] || 0; bv = order[b.compIdx] || 0; break;
      }
      default: av = a.rank; bv = b.rank;
    }
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  }), [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  const globalOffset = (safePage - 1) * pageSize;

  const handleSort = (key: SortKey) => {
    const dir = sortKey === key && sortDir === 'desc' ? 'asc' : 'desc';
    setSortKey(key); setSortDir(dir); setPage(1);
  };
  const handlePageChange = (p: number) => setPage(Math.max(1, Math.min(p, totalPages)));
  const handlePageSizeChange = (s: number) => { setPageSize(s); setPage(1); };

  // Checkbox logic
  const toggleCheck = (kw: string) => setChecked(prev => { const n = new Set(prev); if (n.has(kw)) n.delete(kw); else n.add(kw); return n; });
  const pageAllChecked = pageRows.length > 0 && pageRows.every(r => checked.has(r.keyword));
  const togglePageAll = () => {
    if (pageAllChecked) setChecked(prev => { const n = new Set(prev); for (const r of pageRows) n.delete(r.keyword); return n; });
    else setChecked(prev => { const n = new Set(prev); for (const r of pageRows) n.add(r.keyword); return n; });
  };
  const allChecked = sorted.length > 0 && sorted.every(r => checked.has(r.keyword));
  const toggleAll = () => { if (allChecked) setChecked(new Set()); else setChecked(new Set(sorted.map(r => r.keyword))); };
  const checkedCount = sorted.filter(r => checked.has(r.keyword)).length;

  const handleCopy = () => {
    const text = sorted.filter(r => checked.has(r.keyword)).map(r => r.keyword).join('\n');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };

  const handleExcel = async () => {
    const XLSX = await import('xlsx');
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const defaultName = `카테고리키워드_${catPath.join('_') || 'all'}_${dateStr}`;
    const fileName = prompt('파일명을 입력하세요', defaultName);
    if (!fileName) return;
    const header = ['순위', '키워드', '대표카테고리', 'PC검색량', '모바일검색량', '총검색수', '경쟁도', '상품수'];
    const data = sorted.map(r => [
      r.rank, r.keyword, r.category,
      r.pcQc >= 0 ? r.pcQc : '', r.moQc >= 0 ? r.moQc : '',
      r.totalQc >= 0 ? r.totalQc : '', r.compIdx,
      r.productCount >= 0 ? r.productCount : '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '카테고리키워드');
    XLSX.writeFile(wb, `${fileName}.xlsx`);
  };

  const arrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
  const compColor = dark ? COMP_COLOR_D : COMP_COLOR_L;

  // Style helpers
  const cardBg = dark ? 'bg-[#1e1e2e] border-[#333]' : 'bg-white border-[#e0e0e0]';
  const selectCls = `border rounded px-2 py-1.5 text-[12px] min-w-[140px] ${dark ? 'bg-[#2d2d2d] border-[#444] text-gray-200' : 'border-[#ddd]'}`;
  const inputCls = `border rounded px-2 py-1 text-[11px] ${dark ? 'bg-[#2d2d2d] border-[#444] text-gray-200 placeholder-gray-500' : 'border-[#ddd] placeholder-gray-400'}`;
  const thBg = dark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-[#f7f7f7] text-[#555]';
  const labelCls = `text-[11px] font-medium ${dark ? 'text-gray-400' : 'text-gray-500'}`;
  const loadingCell = dark ? 'text-gray-600' : 'text-gray-300';

  const COL_HEADERS: [SortKey, string, string][] = [
    ['rank', '순위', 'text-center w-[50px]'],
    ['keyword', '키워드', 'text-left'],
    ['category', '대표카테고리', 'text-left'],
    ['pcQc', 'PC검색량', 'text-right'],
    ['moQc', '모바일검색량', 'text-right'],
    ['totalQc', '총검색수', 'text-right'],
    ['compIdx', '경쟁도', 'text-center'],
    ['productCount', '상품수', 'text-right'],
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-4 space-y-3">
      {/* Category Selector */}
      <div className={`border rounded-lg p-4 space-y-3 ${cardBg}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[13px] font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>카테고리</span>
          {catLoading && <span className="text-[11px] text-[#228be6] animate-pulse">로딩...</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>대카테고리</span>
            <select className={selectCls} value={sel1} onChange={e => setSel1(e.target.value)}>
              <option value="">선택</option>
              {cat1List.map(c => <option key={c.cid} value={c.cid}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>중카테고리</span>
            <select className={selectCls} value={sel2} onChange={e => setSel2(e.target.value)} disabled={!sel1 || cat2List.length === 0}>
              <option value="">{cat2List.length === 0 && sel1 ? '없음' : '선택'}</option>
              {cat2List.map(c => <option key={c.cid} value={c.cid}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>소카테고리</span>
            <select className={selectCls} value={sel3} onChange={e => setSel3(e.target.value)} disabled={!sel2 || cat3List.length === 0}>
              <option value="">{cat3List.length === 0 && sel2 ? '없음' : '선택'}</option>
              {cat3List.map(c => <option key={c.cid} value={c.cid}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>세부카테고리</span>
            <select className={selectCls} value={sel4} onChange={e => setSel4(e.target.value)} disabled={!sel3 || cat4List.length === 0}>
              <option value="">{cat4List.length === 0 && sel3 ? '없음' : '선택'}</option>
              {cat4List.map(c => <option key={c.cid} value={c.cid}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {/* Date & Filters */}
        <div className={`flex flex-wrap items-end gap-3 pt-2 border-t ${dark ? 'border-[#444]' : 'border-gray-200'}`}>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>기간</span>
            <div className="flex items-center gap-1">
              <input type="date" className={`${inputCls} w-[130px]`} value={startDate} onChange={e => setStartDate(e.target.value)} />
              <span className={`text-[11px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>~</span>
              <input type="date" className={`${inputCls} w-[130px]`} value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>연령</span>
            <select className={`${inputCls} w-[90px]`} value={age} onChange={e => setAge(e.target.value)}>
              {AGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>성별</span>
            <select className={`${inputCls} w-[80px]`} value={gender} onChange={e => setGender(e.target.value)}>
              {GENDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className={labelCls}>기기</span>
            <select className={`${inputCls} w-[90px]`} value={device} onChange={e => setDevice(e.target.value)}>
              {DEVICE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button onClick={search} disabled={loading || !deepestCid}
            className="px-5 py-1.5 bg-[#03c75a] text-white rounded text-[13px] font-bold hover:bg-[#02b050] disabled:opacity-50 whitespace-nowrap">
            {loading ? '검색중...' : '검색'}
          </button>
          {sorted.length > 0 && (
            <button onClick={handleExcel}
              className="px-4 py-1.5 bg-[#20744a] text-white rounded text-[13px] font-bold hover:bg-[#1a5c3a] flex items-center gap-1 whitespace-nowrap">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Excel
            </button>
          )}
        </div>
      </div>

      {/* Enrich progress */}
      {enrichProgress && (
        <div className={`border rounded p-2 ${cardBg}`}>
          <div className="flex items-center gap-3">
            <span className={`text-[11px] whitespace-nowrap font-medium ${dark ? 'text-gray-300' : 'text-gray-600'}`}>검색량/상품수 조회중</span>
            <div className={`flex-1 rounded-full h-[6px] overflow-hidden ${dark ? 'bg-[#333]' : 'bg-[#eee]'}`}>
              <div className="h-full bg-[#e879f9] transition-all duration-300" style={{ width: `${(enrichProgress.done / enrichProgress.total) * 100}%` }} />
            </div>
            <span className={`text-[11px] whitespace-nowrap tabular-nums ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{enrichProgress.done}/{enrichProgress.total}</span>
          </div>
        </div>
      )}

      {error && <p className="text-[12px] text-red-500">{error}</p>}
      {statusMsg && <p className="text-[12px] text-[#228be6] font-medium">{statusMsg}</p>}

      {/* Landing Hero */}
      {rows.length === 0 && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-6 select-none">
          <div className={`rounded-2xl shadow-lg border px-10 py-12 max-w-[700px] w-full ${dark ? 'bg-[#1e1e2e] border-[#333]' : 'bg-white border-[#e5e8eb]'}`}>
            <div className="text-center space-y-5">
              <h2 className={`text-[28px] font-extrabold tracking-[-0.5px] leading-[1.4] ${dark ? 'text-white' : 'text-gray-900'}`}>
                카테고리별<br /><span className="text-[#e879f9]">TOP 500 인기 키워드</span>를 확인합니다
              </h2>
              <p className={`text-[16px] leading-[2] ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                네이버 데이터랩 기반으로<br />
                카테고리를 선택하면 <span className="text-[#e879f9] font-semibold">최근 30일</span> 인기 키워드를<br />
                <span className="text-[#228be6] font-semibold">검색량, 상품수</span>와 함께 확인할 수 있습니다
              </p>
              <div className={`flex justify-center items-center gap-4 mt-3 pt-5 border-t ${dark ? 'border-[#333]' : 'border-gray-200'}`}>
                {[
                  { n: '1', label: '카테고리 선택', color: '#e879f9' },
                  { n: '2', label: '검색', color: '#03c75a' },
                  { n: '3', label: 'TOP 500 + 검색량', color: '#228be6' },
                ].map((s, i) => (
                  <div key={s.n} className="flex items-center gap-2">
                    {i > 0 && <svg width="20" height="12" viewBox="0 0 16 10" className="mr-1"><path d="M2 5h10M10 2l3 3-3 3" stroke={dark ? '#555' : '#ccc'} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    <span className="w-[26px] h-[26px] rounded-full text-white text-[12px] font-bold flex items-center justify-center" style={{ background: s.color }}>{s.n}</span>
                    <span className={`text-[13px] font-semibold ${dark ? 'text-gray-300' : 'text-gray-700'}`}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filter & Breadcrumb */}
      {rows.length > 0 && (
        <div className={`border rounded p-3 ${cardBg}`}>
          <div className="flex flex-wrap items-center gap-3">
            {catPath.length > 0 && <span className={`text-[12px] font-medium ${dark ? 'text-gray-300' : 'text-gray-700'}`}>{catPath.join(' > ')}</span>}
            <div className={`h-4 w-px ${dark ? 'bg-[#444]' : 'bg-gray-200'}`} />
            <input className={`${inputCls} w-[150px]`} placeholder="키워드 필터" value={filterKw}
              onChange={e => { setFilterKw(e.target.value); setPage(1); }} />
            <span className={`text-[11px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>전체 {rows.length} / 필터 {filtered.length}</span>
            {checkedCount > 0 && (
              <>
                <span className="text-[11px] text-[#228be6] font-bold">{checkedCount}개 선택</span>
                <button onClick={handleCopy}
                  className={`text-[11px] font-bold px-3 py-1 rounded transition-colors ${copied ? 'bg-[#00a651] text-white' : 'bg-[#228be6] text-white hover:bg-[#1c7ed6]'}`}>
                  {copied ? '복사됨!' : '선택 복사'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <>
          <Pagination page={safePage} totalPages={totalPages} total={sorted.length} pageSize={pageSize}
            onPageChange={handlePageChange} onPageSizeChange={handlePageSizeChange} dark={dark} />
          <div className={`border rounded overflow-x-auto ${cardBg}`}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className={`${thBg} text-[11px]`}>
                  <th className="px-1 py-2 text-center" style={{ minWidth: 64 }}>
                    <div className="flex items-center justify-center gap-1">
                      <label className="flex items-center gap-0.5 cursor-pointer" title="전체선택">
                        <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-orange-500 w-[13px] h-[13px]" />
                        <span className="text-[8px] text-orange-500 font-bold">전체</span>
                      </label>
                      <label className="flex items-center gap-0.5 cursor-pointer" title="페이지선택">
                        <input type="checkbox" checked={pageAllChecked} onChange={togglePageAll} className="accent-[#228be6] w-[13px] h-[13px]" />
                        <span className="text-[8px] text-[#228be6] font-bold">페이지</span>
                      </label>
                    </div>
                  </th>
                  {COL_HEADERS.map(([key, label, align]) => (
                    <th key={key} className={`px-2 py-2 ${align} font-semibold cursor-pointer hover:text-[#228be6] select-none whitespace-nowrap`}
                      onClick={() => handleSort(key)}>
                      {label}{arrow(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const gi = globalOffset + i;
                  const isChecked = checked.has(r.keyword);
                  const hasEnrich = r.keyword in enrichData;
                  return (
                    <tr key={`${r.keyword}-${gi}`}
                      className={`border-b transition-colors
                        ${dark
                          ? `border-[#333] hover:bg-[#2a2a3e] ${isChecked ? 'bg-[#1a2a4a]' : gi % 2 ? 'bg-[#1a1a28]' : ''}`
                          : `border-[#f0f0f0] hover:bg-[#f5faff] ${isChecked ? 'bg-[#e7f5ff]' : gi % 2 ? 'bg-[#fafafa]' : ''}`
                        }`}>
                      <td className="px-1 py-1.5 text-center">
                        <input type="checkbox" checked={isChecked} onChange={() => toggleCheck(r.keyword)} className="accent-[#228be6]" />
                      </td>
                      <td className={`px-2 py-1.5 text-center tabular-nums font-medium ${
                        r.rank <= 10 ? (dark ? 'text-[#e879f9]' : 'text-[#c026d3]') :
                        r.rank <= 50 ? (dark ? 'text-[#228be6]' : 'text-[#2563eb]') :
                        dark ? 'text-gray-400' : 'text-gray-600'
                      }`}>{r.rank}</td>
                      <td className={`px-2 py-1.5 font-medium ${dark ? 'text-gray-200' : 'text-gray-800'}`}>{r.keyword}</td>
                      <td className={`px-2 py-1.5 text-left text-[11px] ${hasEnrich ? (dark ? 'text-gray-400' : 'text-gray-500') : loadingCell}`}>
                        {hasEnrich ? r.category : (enriching ? '...' : '')}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${hasEnrich ? '' : loadingCell}`}>
                        {hasEnrich ? (r.pcQc >= 0 ? fmt(r.pcQc) : '-') : (enriching ? '...' : '')}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${hasEnrich ? '' : loadingCell}`}>
                        {hasEnrich ? (r.moQc >= 0 ? fmt(r.moQc) : '-') : (enriching ? '...' : '')}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${hasEnrich ? '' : loadingCell}`}>
                        {hasEnrich ? (r.totalQc >= 0 ? fmt(r.totalQc) : '-') : (enriching ? '...' : '')}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-bold text-[11px] ${hasEnrich ? (compColor[r.compIdx] || '') : loadingCell}`}>
                        {hasEnrich ? (r.compIdx || '-') : (enriching ? '...' : '')}
                      </td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${hasEnrich ? '' : loadingCell}`}>
                        {hasEnrich ? (r.productCount >= 0 ? fmt(r.productCount) : '-') : (enriching ? '...' : '')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={safePage} totalPages={totalPages} total={sorted.length} pageSize={pageSize}
            onPageChange={handlePageChange} onPageSizeChange={handlePageSizeChange} dark={dark} />
        </>
      )}

      {rows.length > 0 && sorted.length === 0 && (
        <p className={`text-[12px] text-center py-4 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>필터 조건에 맞는 결과가 없습니다.</p>
      )}
    </div>
  );
}
