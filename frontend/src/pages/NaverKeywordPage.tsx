import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';

interface KeywordRow {
  relKeyword: string;
  monthlyPcQcCnt: number;
  monthlyMobileQcCnt: number;
  monthlyAvePcClkCnt: number;
  monthlyAveMobileClkCnt: number;
  monthlyAvePcCtr: number;
  monthlyAveMobileCtr: number;
  compIdx: string;
  plAvgDepth: number;
}

type SortKey = keyof KeywordRow | 'dupCount';
type SortDir = 'asc' | 'desc';
type MonitorMetric = 'none' | 'monthlyPcQcCnt' | 'monthlyMobileQcCnt' | 'monthlyAvePcClkCnt' | 'monthlyAveMobileClkCnt' | 'monthlyAvePcCtr' | 'monthlyAveMobileCtr' | 'compIdx' | 'plAvgDepth';

const MONITOR_OPTIONS: { key: MonitorMetric; label: string }[] = [
  { key: 'monthlyPcQcCnt', label: 'PC조회' },
  { key: 'monthlyMobileQcCnt', label: '모바일조회' },
  { key: 'monthlyAvePcClkCnt', label: 'PC클릭' },
  { key: 'monthlyAveMobileClkCnt', label: '모바일클릭' },
  { key: 'monthlyAvePcCtr', label: 'PC클릭률' },
  { key: 'monthlyAveMobileCtr', label: '모바일클릭률' },
  { key: 'compIdx', label: '경쟁도' },
  { key: 'plAvgDepth', label: '월광고수' },
];

const PAGE_SIZES = [100, 300, 500, 1000];
const COMP_MAP: Record<string, string> = { HIGH: '높음', MEDIUM: '중간', LOW: '낮음' };
const COMP_COLOR_D: Record<string, string> = { '높음': 'text-red-400', '중간': 'text-yellow-400', '낮음': 'text-green-400' };
const COMP_COLOR_L: Record<string, string> = { '높음': 'text-red-600', '중간': 'text-yellow-600', '낮음': 'text-green-600' };

function safe(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }
function fmt(v: number, dec = 0): string { return dec > 0 ? v.toFixed(dec) : v.toLocaleString(); }

function fmtMetric(r: KeywordRow, metric: MonitorMetric): string {
  if (metric === 'none') return '';
  if (metric === 'compIdx') return r.compIdx;
  if (metric === 'monthlyAvePcCtr' || metric === 'monthlyAveMobileCtr') return fmt(r[metric], 2);
  if (metric === 'monthlyAvePcClkCnt' || metric === 'monthlyAveMobileClkCnt') return fmt(r[metric], 1);
  return fmt(r[metric]);
}

function normalizeRow(r: KeywordRow): KeywordRow {
  return {
    ...r,
    monthlyPcQcCnt: safe(r.monthlyPcQcCnt),
    monthlyMobileQcCnt: safe(r.monthlyMobileQcCnt),
    monthlyAvePcClkCnt: safe(r.monthlyAvePcClkCnt),
    monthlyAveMobileClkCnt: safe(r.monthlyAveMobileClkCnt),
    monthlyAvePcCtr: safe(r.monthlyAvePcCtr),
    monthlyAveMobileCtr: safe(r.monthlyAveMobileCtr),
    plAvgDepth: safe(r.plAvgDepth),
    compIdx: COMP_MAP[r.compIdx] || r.compIdx || 'N/A',
  };
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  return Promise.resolve();
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
        {pages.map(p => (
          <button key={p} className={p === page ? activeBtn : btn} onClick={() => onPageChange(p)}>{p}</button>
        ))}
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

/* ───── Monitor Panel ───── */
function MonitorPanel({ sorted, checked, metric, onMetricChange, dark }: {
  sorted: KeywordRow[]; checked: Set<string>; metric: MonitorMetric;
  onMetricChange: (m: MonitorMetric) => void; dark: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const checkedRows = useMemo(() => sorted.filter(r => checked.has(r.relKeyword)), [sorted, checked]);

  const handleCopy = () => {
    const lines = checkedRows.map(r => {
      const val = metric !== 'none' ? ` (${fmtMetric(r, metric)})` : '';
      return `${r.relKeyword}${val}`;
    });
    copyToClipboard(lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  return (
    <div className="hidden xl:block fixed right-3 top-[54px] z-40" style={{ width: 260 }}>
      <div className={`flex flex-col rounded-2xl shadow-2xl overflow-hidden border ${dark ? 'border-[#444] bg-[#2a2a3e]' : 'border-[#d0d0d0] bg-[#e8e8e8]'}`}
           style={{ height: 'calc(100vh - 66px)' }}>
        <div className={`px-3 pt-2 pb-1 flex items-center gap-2 ${dark ? 'bg-[#2a2a3e]' : 'bg-[#e8e8e8]'}`}>
          <div className="flex gap-1.5">
            <div className="w-[10px] h-[10px] rounded-full bg-[#ff5f57]" />
            <div className="w-[10px] h-[10px] rounded-full bg-[#febc2e]" />
            <div className="w-[10px] h-[10px] rounded-full bg-[#28c840]" />
          </div>
          <span className={`flex-1 text-center text-[11px] font-bold ${dark ? 'text-gray-300' : 'text-[#555]'}`}>선택 키워드</span>
          <span className={`text-[10px] font-bold ${dark ? 'text-gray-500' : 'text-[#888]'}`}>{checkedRows.length}개</span>
        </div>

        <div className={`flex-1 flex flex-col mx-1.5 mb-1.5 rounded-lg overflow-hidden border ${dark ? 'bg-[#1e1e2e] border-[#444]' : 'bg-white border-[#ccc]'}`}>
          <div className={`border-b px-2 py-1.5 ${dark ? 'bg-[#252540] border-[#444]' : 'bg-[#fafafa] border-[#eee]'}`}>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {MONITOR_OPTIONS.map(opt => (
                <label key={opt.key} className="flex items-center gap-0.5 cursor-pointer">
                  <input type="radio" name="monitor-metric" checked={metric === opt.key}
                    onChange={() => onMetricChange(metric === opt.key ? 'none' : opt.key)}
                    className="accent-[#228be6] w-[12px] h-[12px]" />
                  <span className={`text-[9px] ${metric === opt.key ? 'text-[#228be6] font-bold' : dark ? 'text-gray-500' : 'text-[#888]'}`}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2.5 py-2 scrollbar-thin">
            {checkedRows.length === 0 ? (
              <p className={`text-[11px] text-center mt-10 ${dark ? 'text-gray-600' : 'text-[#bbb]'}`}>체크된 키워드가 여기에 표시됩니다</p>
            ) : (
              <div className="space-y-0">
                {checkedRows.map(r => (
                  <div key={r.relKeyword} className={`text-[12px] leading-[1.8] ${dark ? 'text-gray-300' : 'text-[#333]'}`}>
                    <span className="font-medium">{r.relKeyword}</span>
                    {metric !== 'none' && <span className="text-[#228be6] ml-1">({fmtMetric(r, metric)})</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {checkedRows.length > 0 && (
            <div className={`border-t px-2 py-1.5 flex justify-center ${dark ? 'border-[#444] bg-[#252540]' : 'border-[#eee] bg-[#fafafa]'}`}>
              <button onClick={handleCopy}
                className={`text-[11px] font-bold px-3 py-1 rounded transition-colors ${copied ? 'bg-[#00a651] text-white' : 'bg-[#228be6] text-white hover:bg-[#1c7ed6]'}`}>
                {copied ? '복사됨!' : '전체복사'}
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-center pb-1">
          <div className={`w-[60px] h-[4px] rounded-full ${dark ? 'bg-[#444]' : 'bg-[#ccc]'}`} />
        </div>
      </div>
    </div>
  );
}

/* ───── Main ───── */
export default function NaverKeywordPage() {
  const { dark } = useTheme();
  const [keyword, setKeyword] = useState('');
  const [rows, setRows] = useState<KeywordRow[]>([]);
  const [filtered, setFiltered] = useState<KeywordRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('monthlyMobileQcCnt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dupCounts, setDupCounts] = useState<Map<string, number>>(new Map());
  const [monitorMetric, setMonitorMetric] = useState<MonitorMetric>('monthlyPcQcCnt');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(500);

  const [fKeyword, setFKeyword] = useState('');
  const [fPcView, setFPcView] = useState('');
  const [fMoView, setFMoView] = useState('');
  const [fPcClick, setFPcClick] = useState('');
  const [fMoClick, setFMoClick] = useState('');
  const [fComp, setFComp] = useState('전체');
  const [includeWord, setIncludeWord] = useState('');
  const [excludeWord, setExcludeWord] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tableTopRef = useRef<HTMLDivElement>(null);
  const scrollToTable = () => tableTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doFilter = useCallback((data: KeywordRow[], kw?: string, pv?: string, mv?: string, pc?: string, mc?: string, comp?: string) => {
    const _kw = kw ?? fKeyword, _pv = pv ?? fPcView, _mv = mv ?? fMoView;
    const _pc = pc ?? fPcClick, _mc = mc ?? fMoClick, _comp = comp ?? fComp;
    let result = data;
    if (_kw) result = result.filter(r => r.relKeyword.includes(_kw));
    if (_pv) result = result.filter(r => r.monthlyPcQcCnt >= Number(_pv));
    if (_mv) result = result.filter(r => r.monthlyMobileQcCnt >= Number(_mv));
    if (_pc) result = result.filter(r => r.monthlyAvePcClkCnt >= Number(_pc));
    if (_mc) result = result.filter(r => r.monthlyAveMobileClkCnt >= Number(_mc));
    if (_comp === '높음만') result = result.filter(r => r.compIdx === '높음');
    if (_comp === '중간,낮음만') result = result.filter(r => r.compIdx !== '높음');
    setFiltered(result);
    setPage(1);
    return result;
  }, [fKeyword, fPcView, fMoView, fPcClick, fMoClick, fComp]);

  const search = useCallback(async (kw?: string) => {
    const raw = kw ?? keyword;
    const keywords = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (keywords.length === 0) return;

    setLoading(true); setError(''); setStatusMsg(''); setChecked(new Set()); setPage(1);

    if (keywords.length === 1) {
      setDupCounts(new Map());
      try {
        const data = await naverApi.getRelatedKeywords(keywords[0]);
        const list = (data.keywordList || []).map(normalizeRow);
        setRows(list); doFilter(list);
        setStatusMsg(`${list.length}개 키워드 검색됨`);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'API 오류');
        setRows([]); setFiltered([]);
      } finally { setLoading(false); }
      return;
    }

    setStatusMsg(`${keywords.length}개 키워드 검색 중...`);
    const countMap = new Map<string, number>();
    const allResults: KeywordRow[] = [];
    const seenData = new Map<string, KeywordRow>();
    let done = 0;
    setProgress({ done: 0, total: keywords.length });

    for (const q of keywords) {
      try {
        const data = await naverApi.getRelatedKeywords(q);
        for (const r of (data.keywordList || []).map(normalizeRow)) {
          countMap.set(r.relKeyword, (countMap.get(r.relKeyword) || 0) + 1);
          if (!seenData.has(r.relKeyword)) { seenData.set(r.relKeyword, r); allResults.push(r); }
        }
      } catch { /* skip */ }
      done++;
      setProgress({ done, total: keywords.length });
      await new Promise(res => setTimeout(res, 200));
    }

    setDupCounts(countMap); setRows(allResults); doFilter(allResults);
    setStatusMsg(`${keywords.length}개 키워드 검색 → 중복제거 ${allResults.length}개`);
    setProgress(null); setLoading(false);
  }, [keyword, doFilter]);

  const searchAll = useCallback(async () => {
    const keywords = filtered.filter(r => checked.has(r.relKeyword)).map(r => r.relKeyword);
    if (keywords.length === 0) { setError('체크된 키워드가 없습니다.'); return; }
    setLoading(true); setError(''); setStatusMsg('모두 검색 중...'); setChecked(new Set()); setPage(1);

    const countMap = new Map<string, number>();
    const allResults: KeywordRow[] = [];
    const seenData = new Map<string, KeywordRow>();
    let done = 0;
    setProgress({ done: 0, total: keywords.length });

    for (const kw of keywords) {
      try {
        const data = await naverApi.getRelatedKeywords(kw);
        for (const raw of (data.keywordList || [])) {
          const r = normalizeRow(raw);
          countMap.set(r.relKeyword, (countMap.get(r.relKeyword) || 0) + 1);
          if (!seenData.has(r.relKeyword)) { seenData.set(r.relKeyword, r); allResults.push(r); }
        }
      } catch { /* skip */ }
      done++;
      setProgress({ done, total: keywords.length });
      await new Promise(res => setTimeout(res, 200));
    }

    setDupCounts(countMap); setRows(allResults); doFilter(allResults);
    setStatusMsg(`${keywords.length}개 키워드 모두검색 → 중복제거 ${allResults.length}개`);
    setProgress(null); setLoading(false);
  }, [filtered, checked, doFilter]);

  const handleFilter = () => doFilter(rows);
  const resetFilters = () => {
    setFKeyword(''); setFPcView(''); setFMoView(''); setFPcClick(''); setFMoClick(''); setFComp('전체');
    doFilter(rows, '', '', '', '', '', '전체');
  };

  const handleSort = (key: SortKey) => {
    const dir = sortKey === key && sortDir === 'desc' ? 'asc' : 'desc';
    setSortKey(key); setSortDir(dir); setPage(1);
  };

  const hasDup = dupCounts.size > 0;

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    if (sortKey === 'dupCount') {
      const av = dupCounts.get(a.relKeyword) || 0, bv = dupCounts.get(b.relKeyword) || 0;
      return sortDir === 'asc' ? av - bv : bv - av;
    }
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  }), [filtered, sortKey, sortDir, dupCounts]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  const globalOffset = (safePage - 1) * pageSize;

  const handlePageChange = (p: number) => { setPage(Math.max(1, Math.min(p, totalPages))); scrollToTable(); };
  const handlePageSizeChange = (s: number) => { setPageSize(s); setPage(1); scrollToTable(); };

  const handleRowDblClick = (kw: string) => { setKeyword(kw); search(kw); };

  const toggleCheck = (kw: string) => {
    setChecked(prev => { const next = new Set(prev); if (next.has(kw)) next.delete(kw); else next.add(kw); return next; });
  };
  const pageAllChecked = pageRows.length > 0 && pageRows.every(r => checked.has(r.relKeyword));
  const togglePageAll = () => {
    if (pageAllChecked) {
      setChecked(prev => { const next = new Set(prev); for (const r of pageRows) next.delete(r.relKeyword); return next; });
    } else {
      setChecked(prev => { const next = new Set(prev); for (const r of pageRows) next.add(r.relKeyword); return next; });
    }
  };
  const allChecked = sorted.length > 0 && sorted.every(r => checked.has(r.relKeyword));
  const toggleAll = () => {
    if (allChecked) setChecked(new Set());
    else setChecked(new Set(sorted.map(r => r.relKeyword)));
  };

  const handleInclude = () => {
    if (!includeWord.trim()) return;
    const words = includeWord.trim().split(/[\s,]+/).filter(Boolean);
    setChecked(prev => {
      const next = new Set(prev);
      for (const r of sorted) { if (words.some(w => r.relKeyword.includes(w))) next.add(r.relKeyword); }
      return next;
    });
  };
  const handleExclude = () => {
    if (!excludeWord.trim()) return;
    const words = excludeWord.trim().split(/[\s,]+/).filter(Boolean);
    setChecked(prev => {
      const next = new Set(prev);
      for (const r of sorted) { if (words.some(w => r.relKeyword.includes(w))) next.delete(r.relKeyword); }
      return next;
    });
  };

  const handleExcelDownload = async () => {
    const XLSX = await import('xlsx');
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const defaultName = `${keyword || '키워드'}_${dateStr}`;
    const fileName = prompt('파일명을 입력하세요', defaultName);
    if (!fileName) return;

    const header = hasDup
      ? ['#','키워드','PC조회수','모바일조회수','PC클릭수','모바일클릭수','PC클릭률%','모바일클릭률%','경쟁도','월광고수','중복횟수']
      : ['#','키워드','PC조회수','모바일조회수','PC클릭수','모바일클릭수','PC클릭률%','모바일클릭률%','경쟁도','월광고수'];

    const data = sorted.map((r, i) => {
      const base = [i+1, r.relKeyword, r.monthlyPcQcCnt, r.monthlyMobileQcCnt,
        r.monthlyAvePcClkCnt, r.monthlyAveMobileClkCnt,
        r.monthlyAvePcCtr, r.monthlyAveMobileCtr, r.compIdx, r.plAvgDepth];
      if (hasDup) base.push(dupCounts.get(r.relKeyword) || 0);
      return base;
    });

    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '키워드');
    XLSX.writeFile(wb, `${fileName}.xlsx`);
  };

  const checkedCount = sorted.filter(r => checked.has(r.relKeyword)).length;
  const arrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
  const compColor = dark ? COMP_COLOR_D : COMP_COLOR_L;

  const paginationProps = {
    page: safePage, totalPages, total: sorted.length, pageSize,
    onPageChange: handlePageChange, onPageSizeChange: handlePageSizeChange, dark,
  };

  // style helpers
  const cardBg = dark ? 'bg-[#1e1e2e] border-[#333]' : 'bg-white border-[#e0e0e0]';
  const inputCls = `border rounded px-2 py-1 text-[11px] ${dark ? 'bg-[#2d2d2d] border-[#444] text-gray-200 placeholder-gray-500' : 'border-[#ddd] placeholder-gray-400'}`;
  const thBg = dark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-[#f7f7f7] text-[#555]';

  return (
    <>
      <MonitorPanel sorted={sorted} checked={checked} metric={monitorMetric} onMetricChange={setMonitorMetric} dark={dark} />

      <div className={`xl:pr-[272px] ${dark ? '' : ''}`}>
        <div className="max-w-[1200px] mx-auto px-4 py-4 space-y-3">
          {/* Search */}
          <div className="flex gap-2 items-start">
            <div className="flex-1 relative">
              <textarea ref={inputRef}
                className={`w-full border rounded px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none leading-[1.6]
                  ${dark ? 'bg-[#2d2d2d] border-[#444] text-white placeholder-gray-500' : 'border-[#ccc] placeholder-gray-400'}`}
                placeholder="키워드를 입력하세요 (여러 개는 줄바꿈으로 구분)"
                rows={keyword.includes('\n') ? Math.min(keyword.split('\n').length + 1, 8) : 2}
                value={keyword} onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); search(); } }}
              />
              {keyword.includes('\n') && (
                <span className="absolute right-2 bottom-1.5 text-[9px] text-gray-500">
                  {keyword.split('\n').filter(s => s.trim()).length}개 키워드
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <button onClick={() => search()} disabled={loading}
                className="px-5 py-2 bg-[#03c75a] text-white rounded text-[13px] font-bold hover:bg-[#02b050] disabled:opacity-50 whitespace-nowrap">
                검색
              </button>
              <button onClick={searchAll} disabled={loading || filtered.length === 0}
                className="px-4 py-2 bg-[#228be6] text-white rounded text-[13px] font-bold hover:bg-[#1c7ed6] disabled:opacity-50 whitespace-nowrap">
                모두검색
              </button>
              {sorted.length > 0 && (
                <button onClick={handleExcelDownload}
                  className="px-4 py-2 bg-[#20744a] text-white rounded text-[13px] font-bold hover:bg-[#1a5c3a] flex items-center justify-center gap-1 whitespace-nowrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Excel
                </button>
              )}
              <span className={`text-[9px] text-center ${dark ? 'text-gray-600' : 'text-gray-400'}`}>Ctrl+Enter 검색</span>
            </div>
          </div>

          {/* Progress */}
          {progress && (
            <div className={`border rounded p-2 ${cardBg}`}>
              <div className="flex items-center gap-3">
                <div className={`flex-1 rounded-full h-[6px] overflow-hidden ${dark ? 'bg-[#333]' : 'bg-[#eee]'}`}>
                  <div className="h-full bg-[#228be6] transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
                <span className={`text-[11px] whitespace-nowrap ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{progress.done}/{progress.total}</span>
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
                    연관키워드를 찾고, 또 찾아서<br />
                    <span className="text-[#03c75a]">최적의 키워드</span>를 발굴합니다
                  </h2>
                  <p className={`text-[16px] leading-[2] ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                    하나의 키워드에서 출발해 연관키워드를 수집하고<br />
                    다시 그 키워드들로 <span className="text-[#03c75a] font-semibold">반복 검색</span>하여<br />
                    숨겨진 <span className="text-[#228be6] font-semibold">롱테일 키워드</span>까지 모두 찾아냅니다
                  </p>
                  <div className={`flex justify-center items-center gap-4 mt-3 pt-5 border-t ${dark ? 'border-[#333]' : 'border-gray-200'}`}>
                    {[
                      { n: '1', label: '검색', color: '#03c75a' },
                      { n: '2', label: '선택 & 모두검색', color: '#1f6b3f' },
                      { n: '3', label: '최적 키워드 완성', color: '#228be6' },
                    ].map((s, i) => (
                      <div key={s.n} className="flex items-center gap-2">
                        {i > 0 && (
                          <svg width="20" height="12" viewBox="0 0 16 10" className="mr-1">
                            <path d="M2 5h10M10 2l3 3-3 3" stroke={dark ? '#555' : '#ccc'} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                        <span className="w-[26px] h-[26px] rounded-full text-white text-[12px] font-bold flex items-center justify-center" style={{ background: s.color }}>{s.n}</span>
                        <span className={`text-[13px] font-semibold ${dark ? 'text-gray-300' : 'text-gray-700'}`}>{s.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <p className={`text-[13px] mt-3 ${dark ? 'text-gray-600' : 'text-gray-400'}`}>
                키워드를 입력하고 <span className="font-semibold text-[#03c75a]">검색</span> 버튼을 누르세요
              </p>
            </div>
          )}

          {sorted.length > pageSize && (
            <p className="text-[12px] text-yellow-500 font-medium">
              {sorted.length.toLocaleString()}개 키워드가 검색되어 {pageSize}개씩 보여집니다.
            </p>
          )}

          {/* Filters */}
          {rows.length > 0 && (
            <div className={`border rounded p-3 space-y-2 ${cardBg}`}>
              <div className="flex flex-wrap gap-2 items-center">
                <input className={`${inputCls} w-[120px]`} placeholder="키워드 포함" value={fKeyword} onChange={e => setFKeyword(e.target.value)} />
                <input className={`${inputCls} w-[100px]`} placeholder="PC조회수 ≥" value={fPcView} onChange={e => setFPcView(e.target.value)} />
                <input className={`${inputCls} w-[100px]`} placeholder="모바일조회 ≥" value={fMoView} onChange={e => setFMoView(e.target.value)} />
                <input className={`${inputCls} w-[100px]`} placeholder="PC클릭수 ≥" value={fPcClick} onChange={e => setFPcClick(e.target.value)} />
                <input className={`${inputCls} w-[100px]`} placeholder="모바일클릭 ≥" value={fMoClick} onChange={e => setFMoClick(e.target.value)} />
                <select className={`${inputCls}`} value={fComp} onChange={e => setFComp(e.target.value)}>
                  <option>전체</option><option>높음만</option><option>중간,낮음만</option>
                </select>
                <button onClick={handleFilter} className="px-3 py-1 bg-[#228be6] text-white rounded text-[11px] font-bold">필터적용</button>
                <button onClick={resetFilters} className="px-3 py-1 bg-gray-500 text-white rounded text-[11px]">초기화</button>
                <span className={`text-[11px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>전체 {rows.length} / 필터 {filtered.length}</span>
              </div>
              <div className={`flex flex-wrap gap-2 items-center border-t pt-2 ${dark ? 'border-[#444]' : 'border-gray-200'}`}>
                <input className={`${inputCls} w-[120px]`} placeholder="포함문자" value={includeWord}
                  onChange={e => setIncludeWord(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleInclude()} />
                <button onClick={handleInclude} className="px-3 py-1 bg-[#03c75a] text-white rounded text-[11px] font-bold">포함하기</button>
                <input className={`${inputCls} w-[120px]`} placeholder="제거문자" value={excludeWord}
                  onChange={e => setExcludeWord(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleExclude()} />
                <button onClick={handleExclude} className="px-3 py-1 bg-red-500 text-white rounded text-[11px] font-bold">제거하기</button>
                {checkedCount > 0 && <span className="text-[11px] text-[#228be6] font-bold">{checkedCount}개 선택</span>}
              </div>
            </div>
          )}

          {/* Table */}
          <div ref={tableTopRef} />
          {sorted.length > 0 && (
            <>
              <Pagination {...paginationProps} />
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
                      <th className="px-2 py-2 text-center w-[36px]">#</th>
                      {([
                        ['relKeyword', '키워드', 'text-left'],
                        ['monthlyPcQcCnt', 'PC조회수', 'text-right'],
                        ['monthlyMobileQcCnt', '모바일조회수', 'text-right'],
                        ['monthlyAvePcClkCnt', 'PC클릭수', 'text-right'],
                        ['monthlyAveMobileClkCnt', '모바일클릭수', 'text-right'],
                        ['monthlyAvePcCtr', 'PC클릭률%', 'text-right'],
                        ['monthlyAveMobileCtr', '모바일클릭률%', 'text-right'],
                        ['compIdx', '경쟁도', 'text-center'],
                        ['plAvgDepth', '월광고수', 'text-right'],
                        ...(hasDup ? [['dupCount', '중복', 'text-center'] as [string, string, string]] : []),
                      ] as [SortKey, string, string][]).map(([key, label, align]) => (
                        <th key={key}
                          className={`px-2 py-2 ${align} font-semibold cursor-pointer hover:text-[#228be6] select-none whitespace-nowrap`}
                          onClick={() => handleSort(key)}>
                          {label}{arrow(key)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r, i) => {
                      const gi = globalOffset + i;
                      const isChecked = checked.has(r.relKeyword);
                      const dup = dupCounts.get(r.relKeyword) || 0;
                      return (
                        <tr key={`${r.relKeyword}-${gi}`}
                          className={`border-b cursor-pointer transition-colors
                            ${dark
                              ? `border-[#333] hover:bg-[#2a2a3e] ${isChecked ? 'bg-[#1a2a4a]' : gi % 2 ? 'bg-[#1a1a28]' : ''}`
                              : `border-[#f0f0f0] hover:bg-[#f5faff] ${isChecked ? 'bg-[#e7f5ff]' : gi % 2 ? 'bg-[#fafafa]' : ''}`
                            }`}
                          onDoubleClick={() => handleRowDblClick(r.relKeyword)}>
                          <td className="px-1 py-1.5 text-center">
                            <input type="checkbox" checked={isChecked} onChange={() => toggleCheck(r.relKeyword)} className="accent-[#228be6]" />
                          </td>
                          <td className={`px-2 py-1.5 text-center ${dark ? 'text-gray-500' : 'text-gray-400'}`}>{gi + 1}</td>
                          <td className={`px-2 py-1.5 font-medium ${dark ? 'text-gray-200' : 'text-gray-800'}`}>{r.relKeyword}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyPcQcCnt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyMobileQcCnt)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyAvePcClkCnt, 1)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyAveMobileClkCnt, 1)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyAvePcCtr, 2)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.monthlyAveMobileCtr, 2)}</td>
                          <td className={`px-2 py-1.5 text-center font-bold text-[11px] ${compColor[r.compIdx] || ''}`}>{r.compIdx}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.plAvgDepth)}</td>
                          {hasDup && (
                            <td className={`px-2 py-1.5 text-center font-bold tabular-nums ${dup >= 3 ? 'text-red-500' : dup >= 2 ? 'text-yellow-500' : dark ? 'text-gray-500' : 'text-gray-400'}`}>
                              {dup}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination {...paginationProps} />
            </>
          )}

          {rows.length > 0 && sorted.length === 0 && (
            <p className={`text-[12px] text-center py-4 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>필터 조건에 맞는 결과가 없습니다.</p>
          )}
        </div>
      </div>
    </>
  );
}
