import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, BarChart, Cell,
} from 'recharts';
import { useTheme } from '../hooks/useTheme';
import {
  fetchOverview, fetchStoreDetail, fetchBusinessDetail, fetchRegistrationLimits,
  startPolicyCollect, fetchPolicyStatus,
  type OverviewData, type BusinessDetailData, type StoreDetailData,
  type TrendRow, type CategoryNode, type TopProductRow,
  type BusinessSummary, type MiniCategory,
  type RegistrationLimitData, type RegistrationLimitStore, type PolicyCollectStatus,
} from '../api/smartstoreAnalyticsApi';
import { formatKRW, formatKoreanWon, formatKoreanShort } from '../utils/format';
import ProductOrdersModal from '../components/smartstore/ProductOrdersModal';

type ViewMode = 'overview' | 'business' | 'store';
type OverviewTab = 'business' | 'store';

const PERIOD_PRESETS = [
  { key: 'thisMonth', label: '이번 달' },
  { key: 'thisYear', label: '올해' },
  { key: 'all', label: '전체' },
  { key: 'custom', label: '직접선택' },
] as const;

const PERIOD_UNITS = [
  { key: 'month', label: '월별' },
  { key: 'year', label: '년도별' },
] as const;

const CAT_COLORS = ['#03c75a', '#0078d7', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#d946ef'];

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  'SALE': { bg: 'bg-green-500/20', text: 'text-green-400' },
  'OUTOFSTOCK': { bg: 'bg-red-500/20', text: 'text-red-400' },
  'SUSPENSION': { bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  'CLOSE': { bg: 'bg-gray-500/20', text: 'text-gray-400' },
  'PROHIBITION': { bg: 'bg-red-700/20', text: 'text-red-500' },
  'UNADMISSION': { bg: 'bg-gray-500/20', text: 'text-gray-500' },
};
const STATUS_BADGE_LIGHT: Record<string, { bg: string; text: string }> = {
  'SALE': { bg: 'bg-green-100', text: 'text-green-700' },
  'OUTOFSTOCK': { bg: 'bg-red-100', text: 'text-red-700' },
  'SUSPENSION': { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  'CLOSE': { bg: 'bg-gray-100', text: 'text-gray-600' },
  'PROHIBITION': { bg: 'bg-red-200', text: 'text-red-800' },
  'UNADMISSION': { bg: 'bg-gray-100', text: 'text-gray-500' },
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function yearStartStr() {
  return `${new Date().getFullYear()}-01-01`;
}

export default function SmartStoreAnalyticsPage() {
  const { dark } = useTheme();

  // navigation
  const [view, setView] = useState<ViewMode>('overview');
  const [overviewTab, setOverviewTab] = useState<OverviewTab>('business');
  const [selectedBusinessCode, setSelectedBusinessCode] = useState('');
  const [, setSelectedBusinessName] = useState('');
  const [selectedStoreId, setSelectedStoreId] = useState(0);
  const [, setSelectedStoreName] = useState('');

  // filters
  const [periodPreset, setPeriodPreset] = useState('thisYear');
  const [periodUnit, setPeriodUnit] = useState('month');
  const [startDate, setStartDate] = useState(yearStartStr);
  const [endDate, setEndDate] = useState(todayStr);

  // data
  const [overviewData, setOverviewData] = useState<OverviewData | null>(null);
  const [businessData, setBusinessData] = useState<BusinessDetailData | null>(null);
  const [storeData, setStoreData] = useState<StoreDetailData | null>(null);
  const [regLimitData, setRegLimitData] = useState<RegistrationLimitData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const dashboardRef = useRef<HTMLDivElement>(null);

  // always load overview for nav dropdowns
  useEffect(() => {
    const sd = startDate || undefined;
    const ed = endDate || undefined;
    fetchOverview(sd, ed).then(setOverviewData).catch(() => {});
  }, [startDate, endDate]);

  // load registration limits once
  const reloadRegLimits = useCallback(() => {
    fetchRegistrationLimits().then(setRegLimitData).catch(() => {});
  }, []);
  useEffect(() => { reloadRegLimits(); }, [reloadRegLimits]);

  // period preset handler
  const handlePreset = useCallback((key: string) => {
    setPeriodPreset(key);
    if (key === 'thisMonth') { setStartDate(monthStartStr()); setEndDate(todayStr()); }
    else if (key === 'thisYear') { setStartDate(yearStartStr()); setEndDate(todayStr()); }
    else if (key === 'all') { setStartDate(''); setEndDate(''); }
  }, []);

  // period arrow navigation
  const periodLabel = (() => {
    if (!startDate) return '';
    if (periodUnit === 'year') return startDate.slice(0, 4);
    return startDate.slice(0, 7);
  })();

  const shiftPeriod = useCallback((dir: -1 | 1) => {
    setPeriodPreset('custom');
    const now = new Date();
    if (periodUnit === 'year') {
      const y = startDate ? parseInt(startDate.slice(0, 4)) : now.getFullYear();
      const ny = (isNaN(y) ? now.getFullYear() : y) + dir;
      setStartDate(`${ny}-01-01`);
      setEndDate(`${ny}-12-31`);
    } else {
      // startDate is YYYY-MM-DD; parse year/month from it
      let year = now.getFullYear();
      let month = now.getMonth(); // 0-based
      if (startDate && startDate.length >= 7) {
        year = parseInt(startDate.slice(0, 4));
        month = parseInt(startDate.slice(5, 7)) - 1;
        if (isNaN(year) || isNaN(month)) { year = now.getFullYear(); month = now.getMonth(); }
      }
      const d = new Date(year, month + dir, 1);
      const ys = d.getFullYear();
      const ms = String(d.getMonth() + 1).padStart(2, '0');
      setStartDate(`${ys}-${ms}-01`);
      const last = new Date(ys, d.getMonth() + 1, 0);
      setEndDate(`${ys}-${ms}-${String(last.getDate()).padStart(2, '0')}`);
    }
  }, [startDate, periodUnit]);

  // load detail data
  const loadData = useCallback(async () => {
    if (view === 'overview') return;
    setLoading(true);
    try {
      const sd = startDate || undefined;
      const ed = endDate || undefined;
      if (view === 'business') {
        const data = await fetchBusinessDetail(selectedBusinessCode, sd, ed, periodUnit);
        setBusinessData(data);
      } else {
        const data = await fetchStoreDetail(selectedStoreId, sd, ed, periodUnit);
        setStoreData(data);
      }
    } catch (e) {
      console.error('Analytics load error:', e);
    } finally {
      setLoading(false);
    }
  }, [view, selectedBusinessCode, selectedStoreId, startDate, endDate, periodUnit]);

  useEffect(() => { loadData(); }, [loadData]);

  // navigation helpers
  const goOverview = () => { setView('overview'); setSelectedBusinessCode(''); setSelectedStoreId(0); };
  const goBusiness = (b: BusinessSummary) => {
    setView('business');
    setSelectedBusinessCode(b.code);
    setSelectedBusinessName(b.name);
    setSelectedStoreId(0);
  };
  const goStore = (storeId: number, storeName: string) => {
    setView('store');
    setSelectedStoreId(storeId);
    setSelectedStoreName(storeName);
  };

  // dropdown nav handlers
  const handleBusinessSelect = (code: string) => {
    if (!code) { goOverview(); return; }
    const biz = overviewData?.businesses.find(b => b.code === code);
    if (biz) goBusiness(biz);
  };
  const handleStoreSelect = (sid: string) => {
    if (!sid) {
      if (selectedBusinessCode) {
        const biz = overviewData?.businesses.find(b => b.code === selectedBusinessCode);
        if (biz) goBusiness(biz);
      } else {
        goOverview();
      }
      return;
    }
    const id = Number(sid);
    let name = '';
    for (const b of overviewData?.businesses || []) {
      const idx = b.store_ids.indexOf(id);
      if (idx >= 0) {
        name = b.store_names[idx];
        if (selectedBusinessCode !== b.code) {
          setSelectedBusinessCode(b.code);
          setSelectedBusinessName(b.name);
        }
        break;
      }
    }
    goStore(id, name || `Store ${id}`);
  };

  // PDF export
  const handleExportPdf = async () => {
    if (!dashboardRef.current || exporting) return;
    setExporting(true);
    try {
      const { exportToPdf } = await import('../utils/exportPdf');
      await exportToPdf(dashboardRef.current, `스마트스토어_분석_${todayStr()}.pdf`);
    } catch (e) {
      console.error('PDF export failed:', e);
    } finally {
      setExporting(false);
    }
  };

  // stores available for dropdown
  const currentBizStores: { id: number; name: string }[] = [];
  if (selectedBusinessCode && overviewData) {
    const biz = overviewData.businesses.find(b => b.code === selectedBusinessCode);
    if (biz) {
      biz.store_ids.forEach((id, i) => currentBizStores.push({ id, name: biz.store_names[i] }));
    }
  } else if (overviewData) {
    for (const b of overviewData.businesses) {
      b.store_ids.forEach((id, i) => currentBizStores.push({ id, name: b.store_names[i] }));
    }
  }

  // styles
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'hover:bg-[#2a2a3e]' : 'hover:bg-gray-50';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = `px-2 py-1.5 rounded border text-[12px] ${dark ? 'bg-[#2d2d2d] border-[#444] text-white' : 'bg-white border-gray-300 text-gray-900'}`;
  const chartGrid = dark ? '#2a2a40' : '#e5e7eb';
  const chartTick = dark ? '#888' : '#6b7280';
  const tooltipBg = dark ? '#1c1c2e' : '#ffffff';
  const tooltipBorder = dark ? '#2a2a40' : '#e5e7eb';

  return (
    <div className={`${bg} min-h-screen`}>
      {/* Header */}
      <div className={`sticky top-[42px] z-10 border-b px-4 py-2.5 ${dark ? 'bg-[#1e1e2e] border-[#333]' : 'bg-white border-gray-200'}`}>
        <div className="max-w-7xl mx-auto flex flex-col gap-2">
          {/* Row 1: Navigation dropdowns */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={goOverview}
              className={`text-[13px] font-bold px-2.5 py-1 rounded transition-colors ${
                view === 'overview'
                  ? 'bg-[#03c75a] text-white'
                  : dark ? 'text-gray-300 hover:bg-[#2a2a40]' : 'text-gray-600 hover:bg-gray-100'
              }`}>
              스마트스토어 분석
            </button>
            <span className={txtSub}>/</span>
            <select
              value={selectedBusinessCode}
              onChange={e => handleBusinessSelect(e.target.value)}
              className={`text-[12px] font-medium px-2 py-1 rounded border-2 transition-colors cursor-pointer ${
                view === 'business'
                  ? 'border-[#03c75a] text-[#03c75a] font-bold ' + (dark ? 'bg-[#2d2d2d]' : 'bg-white')
                  : dark ? 'bg-[#2d2d2d] border-[#444] text-gray-200' : 'bg-white border-gray-300 text-gray-700'
              }`}>
              <option value="">사업자 선택</option>
              {(overviewData?.businesses || []).map(b => (
                <option key={b.code} value={b.code}>{b.name} ({b.store_names.length})</option>
              ))}
            </select>
            <span className={txtSub}>/</span>
            <select
              value={selectedStoreId || ''}
              onChange={e => handleStoreSelect(e.target.value)}
              className={`text-[12px] font-medium px-2 py-1 rounded border-2 transition-colors cursor-pointer ${
                view === 'store'
                  ? 'border-[#03c75a] text-[#03c75a] font-bold ' + (dark ? 'bg-[#2d2d2d]' : 'bg-white')
                  : dark ? 'bg-[#2d2d2d] border-[#444] text-gray-200' : 'bg-white border-gray-300 text-gray-700'
              }`}>
              <option value="">스토어 선택</option>
              {currentBizStores.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {loading && <span className="text-[11px] text-gray-400 animate-pulse ml-2">로딩중...</span>}
            <button onClick={handleExportPdf} disabled={exporting}
              className={`ml-auto px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                exporting ? 'opacity-50 cursor-wait' : 'hover:opacity-80'
              } ${dark ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white'}`}>
              {exporting ? '내보내기...' : 'PDF 저장'}
            </button>
          </div>
          {/* Row 2: Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded overflow-hidden border border-gray-300 dark:border-[#444]">
              {PERIOD_PRESETS.map(p => (
                <button key={p.key} onClick={() => handlePreset(p.key)}
                  className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    periodPreset === p.key
                      ? 'bg-[#03c75a] text-white'
                      : dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
                  }`}
                >{p.label}</button>
              ))}
            </div>
            {/* Period arrow navigation */}
            <div className={`flex items-center rounded border ${dark ? 'border-[#444]' : 'border-gray-300'}`}>
              <button onClick={() => shiftPeriod(-1)}
                className={`px-1.5 py-1 text-[12px] font-bold transition-colors ${dark ? 'text-gray-300 hover:bg-[#3d3d3d]' : 'text-gray-600 hover:bg-gray-100'}`}>
                ◀
              </button>
              <span className={`px-2 py-1 text-[11px] font-bold min-w-[60px] text-center ${dark ? 'text-white' : 'text-gray-900'}`}>
                {periodLabel || (periodUnit === 'year' ? String(new Date().getFullYear()) : todayStr().slice(0, 7))}
              </span>
              <button onClick={() => shiftPeriod(1)}
                className={`px-1.5 py-1 text-[12px] font-bold transition-colors ${dark ? 'text-gray-300 hover:bg-[#3d3d3d]' : 'text-gray-600 hover:bg-gray-100'}`}>
                ▶
              </button>
            </div>
            {periodPreset === 'custom' && (
              <>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={inputCls} />
                <span className={txtSub}>~</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={inputCls} />
              </>
            )}
            {view !== 'overview' && (
              <div className="flex rounded overflow-hidden border border-gray-300 dark:border-[#444]">
                {PERIOD_UNITS.map(p => (
                  <button key={p.key} onClick={() => setPeriodUnit(p.key)}
                    className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      periodUnit === p.key
                        ? 'bg-[#0078d7] text-white'
                        : dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
                    }`}
                  >{p.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div ref={dashboardRef} className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {view === 'overview' && overviewData && <OverviewView data={overviewData} regLimitData={regLimitData} onReloadRegLimits={reloadRegLimits} dark={dark}
          overviewTab={overviewTab} setOverviewTab={setOverviewTab}
          onBusinessClick={goBusiness} onStoreClick={goStore}
          card={card} tHead={tHead} tRow={tRow} txt={txt} txtSub={txtSub} chartGrid={chartGrid} chartTick={chartTick} tooltipBg={tooltipBg} tooltipBorder={tooltipBorder} />}
        {view === 'business' && businessData && <BusinessView data={businessData} dark={dark} onStoreClick={goStore}
          card={card} tHead={tHead} tRow={tRow} txt={txt} txtSub={txtSub} chartGrid={chartGrid} chartTick={chartTick} tooltipBg={tooltipBg} tooltipBorder={tooltipBorder} />}
        {view === 'store' && storeData && <StoreView data={storeData} dark={dark}
          card={card} tHead={tHead} tRow={tRow} txt={txt} txtSub={txtSub} chartGrid={chartGrid} chartTick={chartTick} tooltipBg={tooltipBg} tooltipBorder={tooltipBorder} />}
        {!loading && view === 'overview' && !overviewData && (
          <div className={`text-center py-20 ${txtSub}`}>데이터를 불러오는 중 오류가 발생했습니다.</div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   Level 0: Overview
   ════════════════════════════════════════════ */
interface StyleProps {
  dark: boolean; card: string; tHead: string; tRow: string;
  txt: string; txtSub: string; chartGrid: string; chartTick: string;
  tooltipBg: string; tooltipBorder: string;
}

function OverviewView({ data, regLimitData, onReloadRegLimits, dark, overviewTab, setOverviewTab, onBusinessClick, onStoreClick, ...s }: StyleProps & {
  data: OverviewData;
  regLimitData: RegistrationLimitData | null;
  onReloadRegLimits: () => void;
  overviewTab: OverviewTab;
  setOverviewTab: (t: OverviewTab) => void;
  onBusinessClick: (b: BusinessSummary) => void;
  onStoreClick: (id: number, name: string) => void;
}) {
  const t = data.totals;
  return (
    <>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard dark={dark} label="전체 상품수" value={t.total_products.toLocaleString()} icon={<IconBox />} />
        <SummaryCard dark={dark} label="판매된 상품수" value={t.sold_products.toLocaleString()}
          sub={`${t.total_products ? ((t.sold_products / t.total_products) * 100).toFixed(1) : 0}%`} icon={<IconCheck />} />
        <SummaryCard dark={dark} label="총 매출액" value={formatKoreanWon(t.total_revenue)} icon={<IconWon />} />
        <SummaryCard dark={dark} label="총 주문수" value={t.total_orders.toLocaleString()} icon={<IconCart />} />
        <SummaryCard dark={dark} label="총 수익" value={formatKoreanWon(t.total_profit)}
          color={t.total_profit >= 0 ? 'text-green-400' : 'text-red-400'} icon={<IconTrend />} />
      </div>

      {/* Toggle: 사업자별 / 스토어별 */}
      <div className="flex items-center gap-2">
        <div className={`flex rounded-lg overflow-hidden border ${dark ? 'border-[#444]' : 'border-gray-300'}`}>
          <button onClick={() => setOverviewTab('business')}
            className={`px-3 py-1.5 text-[12px] font-bold transition-colors ${
              overviewTab === 'business'
                ? 'bg-[#03c75a] text-white'
                : dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            사업자별 ({data.businesses.length})
          </button>
          <button onClick={() => setOverviewTab('store')}
            className={`px-3 py-1.5 text-[12px] font-bold transition-colors ${
              overviewTab === 'store'
                ? 'bg-[#03c75a] text-white'
                : dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            스토어별 ({data.all_stores?.length || 0})
          </button>
        </div>
      </div>

      {/* Cards Grid */}
      {overviewTab === 'business' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {data.businesses.map(b => (
            <button key={b.code} onClick={() => onBusinessClick(b)}
              className={`rounded-xl border p-4 text-left transition-all hover:scale-[1.02] ${s.card} hover:border-[#03c75a]/50`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[13px] font-bold ${s.txt}`}>{b.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${dark ? 'bg-[#2a2a40] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
                  {b.store_names.length}스토어
                </span>
              </div>
              <div className={`text-[11px] ${s.txtSub} mb-2 truncate`}>{b.store_names.join(', ')}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div><span className={s.txtSub}>매출</span> <span className={`font-bold ${s.txt}`}>{formatKoreanWon(b.total_revenue)}</span></div>
                <div><span className={s.txtSub}>주문</span> <span className={`font-bold ${s.txt}`}>{b.total_orders.toLocaleString()}</span></div>
                <div><span className={s.txtSub}>수익</span> <span className={`font-bold ${b.total_profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatKoreanWon(b.total_profit)}</span></div>
                <div><span className={s.txtSub}>상품</span> <span className={`font-bold ${s.txt}`}>{b.sold_products}/{b.total_products}</span></div>
                <div><span className={s.txtSub}>13개월</span> <span className={`font-bold text-orange-400`}>{(b.recent_sold_products || 0).toLocaleString()}</span></div>
              </div>
              {b.top_categories && b.top_categories.length > 0 && (
                <MiniCategoryChart categories={b.top_categories} dark={dark} />
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {(data.all_stores || []).map(st => (
            <button key={st.id} onClick={() => onStoreClick(st.id, st.store_name)}
              className={`rounded-xl border p-4 text-left transition-all hover:scale-[1.02] ${s.card} hover:border-[#03c75a]/50`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[13px] font-bold ${s.txt}`}>{st.store_name}</span>
              </div>
              {st.memo && <div className={`text-[10px] ${s.txtSub} mb-2`}>{st.memo}</div>}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                <div><span className={s.txtSub}>매출</span> <span className={`font-bold ${s.txt}`}>{formatKoreanWon(st.revenue)}</span></div>
                <div><span className={s.txtSub}>주문</span> <span className={`font-bold ${s.txt}`}>{st.orders.toLocaleString()}</span></div>
                <div><span className={s.txtSub}>수익</span> <span className={`font-bold ${st.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatKoreanWon(st.profit)}</span></div>
                <div><span className={s.txtSub}>상품</span> <span className={`font-bold ${s.txt}`}>{st.sold_products}/{st.total_products}</span></div>
                <div><span className={s.txtSub}>13개월</span> <span className={`font-bold text-orange-400`}>{(st.recent_sold_products || 0).toLocaleString()}</span></div>
              </div>
              {st.top_categories && st.top_categories.length > 0 && (
                <MiniCategoryChart categories={st.top_categories} dark={dark} />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Top 판매상품 */}
      {data.top_products && data.top_products.length > 0 && (
        <OverviewTopProducts products={data.top_products} dark={dark} {...s} />
      )}

      {/* 상품등록한도 */}
      {regLimitData && regLimitData.stores.length > 0 && (
        <RegistrationLimitPanel data={regLimitData} onReload={onReloadRegLimits} dark={dark} {...s} />
      )}
    </>
  );
}

/* ════════════════════════════════════════════
   Level 1: Business Detail
   ════════════════════════════════════════════ */
function BusinessView({ data, dark, onStoreClick, ...s }: StyleProps & {
  data: BusinessDetailData; onStoreClick: (id: number, name: string) => void;
}) {
  return (
    <>
      {/* Store Cards */}
      <div>
        <h3 className={`text-sm font-bold mb-3 ${s.txt}`}>소속 스토어 <span className={`font-normal ${s.txtSub}`}>({data.stores.length}개)</span></h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.stores.map(st => (
            <button key={st.id} onClick={() => onStoreClick(st.id, st.store_name)}
              className={`rounded-xl border p-4 text-left transition-all hover:scale-[1.02] ${s.card} hover:border-[#03c75a]/50`}>
              <div className={`text-[13px] font-bold mb-1 ${s.txt}`}>{st.store_name}</div>
              {st.memo && <div className={`text-[10px] ${s.txtSub} mb-2`}>{st.memo}</div>}
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <div><span className={s.txtSub}>매출</span><br /><span className={`font-bold ${s.txt}`}>{formatKoreanWon(st.revenue)}</span></div>
                <div><span className={s.txtSub}>주문</span><br /><span className={`font-bold ${s.txt}`}>{st.orders.toLocaleString()}</span></div>
                <div><span className={s.txtSub}>수익</span><br /><span className={`font-bold ${st.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatKoreanWon(st.profit)}</span></div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <TrendChart trend={data.trend} dark={dark} {...s} />
      <CategorySection categories={data.categories} dark={dark} {...s} />
      <TopProductsTable products={data.top_products} dark={dark} {...s} />
    </>
  );
}

/* ════════════════════════════════════════════
   Level 2: Store Detail
   ════════════════════════════════════════════ */
function StoreView({ data, dark, ...s }: StyleProps & { data: StoreDetailData }) {
  const sm = data.summary;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard dark={dark} label="전체 상품수" value={sm.products.toLocaleString()} icon={<IconBox />} />
        <SummaryCard dark={dark} label="판매된 상품수" value={sm.sold_products.toLocaleString()}
          sub={`${sm.products ? ((sm.sold_products / sm.products) * 100).toFixed(1) : 0}%`} icon={<IconCheck />} />
        <SummaryCard dark={dark} label="매출액" value={formatKoreanWon(sm.revenue)} icon={<IconWon />} />
        <SummaryCard dark={dark} label="주문수" value={sm.orders.toLocaleString()} icon={<IconCart />} />
        <SummaryCard dark={dark} label="수익" value={formatKoreanWon(sm.profit)}
          color={sm.profit >= 0 ? 'text-green-400' : 'text-red-400'} icon={<IconTrend />} />
      </div>

      <TrendChart trend={data.trend} dark={dark} {...s} />
      <CategorySection categories={data.categories} dark={dark} {...s} />
      <TopProductsTable products={data.top_products} dark={dark} {...s} />
    </>
  );
}

/* ════════════════════════════════════════════
   Shared Components
   ════════════════════════════════════════════ */

type ProductSortKey = 'revenue' | 'qty' | 'profit' | 'order_count' | 'cost';
type ProductSortDir = 'desc' | 'asc';

function OverviewTopProducts({ products, ...s }: StyleProps & { products: TopProductRow[] }) {
  const [tab, setTab] = useState<'all' | 'byStore'>('all');
  const [sortKey, setSortKey] = useState<ProductSortKey>('revenue');
  const [sortDir, setSortDir] = useState<ProductSortDir>('desc');
  const [orderModal, setOrderModal] = useState<{ code: string; name: string } | null>(null);

  const toggleSort = (key: ProductSortKey) => {
    if (sortKey === key) {
      setSortDir(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIcon = (key: ProductSortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'desc' ? ' ▼' : ' ▲';
  };

  const sorted = [...products].sort((a, b) => {
    const av = a[sortKey] ?? 0;
    const bv = b[sortKey] ?? 0;
    return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number);
  });

  // Group by store
  const storeGroups: Record<string, TopProductRow[]> = {};
  if (tab === 'byStore') {
    for (const p of sorted) {
      const sn = p.store_name || '미지정';
      if (!storeGroups[sn]) storeGroups[sn] = [];
      storeGroups[sn].push(p);
    }
  }
  const storeNames = Object.keys(storeGroups).sort((a, b) => {
    const aRev = storeGroups[a].reduce((s, p) => s + p.revenue, 0);
    const bRev = storeGroups[b].reduce((s, p) => s + p.revenue, 0);
    return bRev - aRev;
  });

  const badges = s.dark ? STATUS_BADGE : STATUS_BADGE_LIGHT;

  const headerCls = (key: ProductSortKey, label: string, w: string) => (
    <th className={`text-right px-2 py-2 font-medium ${s.txtSub} cursor-pointer select-none hover:text-[#03c75a] transition-colors ${w}`}
      onClick={() => toggleSort(key)}>
      {label}{sortIcon(key)}
    </th>
  );

  const renderRow = (p: TopProductRow, idx: number, showStore: boolean) => {
    const margin = p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0;
    const badge = p.status_type ? badges[p.status_type] : null;
    return (
      <tr key={`${p.seller_code}-${idx}`} className={`border-t ${s.dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${s.tRow}`}>
        <td className={`text-center px-2 py-2 ${s.txtSub}`}>{idx + 1}</td>
        <td className={`px-2 py-2 ${s.txt} max-w-[260px]`}>
          {p.product_url ? (
            <a href={p.product_url} target="_blank" rel="noopener noreferrer"
              className="hover:text-[#03c75a] hover:underline truncate block" title={p.product_name}>
              {p.product_name}
            </a>
          ) : (
            <span className="truncate block" title={p.product_name}>{p.product_name}</span>
          )}
        </td>
        {showStore && <td className={`px-2 py-2 text-[11px] ${s.txtSub} whitespace-nowrap`}>{p.store_name || '-'}</td>}
        <td className={`px-2 py-2 text-[11px] font-mono ${s.txtSub}`}>
          {p.channel_product_no ? (
            p.product_url ? (
              <a href={p.product_url} target="_blank" rel="noopener noreferrer"
                className="hover:text-[#03c75a] hover:underline">{p.channel_product_no}</a>
            ) : <span>{p.channel_product_no}</span>
          ) : '-'}
        </td>
        <td className="text-center px-2 py-2">
          {p.status && badge ? (
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${badge.bg} ${badge.text}`}>
              {p.status}
            </span>
          ) : p.status ? (
            <span className={`text-[10px] ${s.txtSub}`}>{p.status}</span>
          ) : null}
        </td>
        <td className={`text-right px-2 py-2 ${s.txt}`}>{p.qty.toLocaleString()}</td>
        <td className={`text-right px-2 py-2 font-medium ${s.txt} cursor-pointer hover:text-[#03c75a] transition-colors`}
          onClick={() => p.seller_code && setOrderModal({ code: p.seller_code, name: p.product_name })}
          title="주문이력 보기">
          {formatKoreanWon(p.revenue)}
        </td>
        <td className={`text-right px-2 py-2 ${s.txtSub}`}>{formatKoreanWon(p.cost)}</td>
        <td className={`text-right px-2 py-2 font-medium ${p.profit >= 0 ? 'text-green-500' : 'text-red-400'}`}>{formatKoreanWon(p.profit)}</td>
        <td className={`text-right px-2 py-2 ${margin >= 0 ? 'text-green-500' : 'text-red-400'}`}>{margin.toFixed(1)}%</td>
        <td className={`text-right px-2 py-2 ${s.txt}`}>{p.order_count.toLocaleString()}</td>
      </tr>
    );
  };

  const showStore = tab === 'all';

  return (
    <>
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <div className="flex items-center gap-3 mb-3">
        <h3 className={`text-sm font-bold ${s.txt}`}>Top 판매상품</h3>
        <div className={`flex rounded-lg overflow-hidden border ${s.dark ? 'border-[#444]' : 'border-gray-300'}`}>
          <button onClick={() => setTab('all')}
            className={`px-2.5 py-1 text-[11px] font-bold transition-colors ${
              tab === 'all'
                ? 'bg-[#03c75a] text-white'
                : s.dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            전체
          </button>
          <button onClick={() => setTab('byStore')}
            className={`px-2.5 py-1 text-[11px] font-bold transition-colors ${
              tab === 'byStore'
                ? 'bg-[#03c75a] text-white'
                : s.dark ? 'bg-[#2d2d2d] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}>
            사이트별
          </button>
        </div>
        <span className={`text-[11px] ${s.txtSub}`}>({products.length}개)</span>
      </div>

      <div className="overflow-auto max-h-[600px]">
        <table className="w-full text-[12px]">
          <thead className={`sticky top-0 z-[1] ${s.tHead}`}>
            <tr>
              <th className={`text-center px-2 py-2 font-medium ${s.txtSub} w-8`}>#</th>
              <th className={`text-left px-2 py-2 font-medium ${s.txtSub}`}>상품명</th>
              {showStore && <th className={`text-left px-2 py-2 font-medium ${s.txtSub} w-24`}>스토어</th>}
              <th className={`text-left px-2 py-2 font-medium ${s.txtSub} w-28`}>상품번호</th>
              <th className={`text-center px-2 py-2 font-medium ${s.txtSub} w-16`}>상태</th>
              {headerCls('qty', '수량', 'w-16')}
              {headerCls('revenue', '매출액', 'w-24')}
              {headerCls('cost', '원가', 'w-20')}
              {headerCls('profit', '수익', 'w-24')}
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-16`}>수익률</th>
              {headerCls('order_count', '주문수', 'w-16')}
            </tr>
          </thead>
          <tbody>
            {tab === 'all' ? (
              sorted.map((p, i) => renderRow(p, i, showStore))
            ) : (
              storeNames.map(storeName => {
                const items = storeGroups[storeName];
                const storeRev = items.reduce((sum, p) => sum + p.revenue, 0);
                const storeProfit = items.reduce((sum, p) => sum + p.profit, 0);
                return (
                  <Fragment key={storeName}>
                    <tr className={s.dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]'}>
                      <td colSpan={10} className="px-2 py-2">
                        <div className="flex items-center gap-3">
                          <span className={`text-[12px] font-bold ${s.txt}`}>{storeName}</span>
                          <span className={`text-[11px] ${s.txtSub}`}>{items.length}개</span>
                          <span className={`text-[11px] font-medium ${s.txt}`}>매출 {formatKoreanWon(storeRev)}</span>
                          <span className={`text-[11px] font-medium ${storeProfit >= 0 ? 'text-green-500' : 'text-red-400'}`}>수익 {formatKoreanWon(storeProfit)}</span>
                        </div>
                      </td>
                    </tr>
                    {items.map((p, i) => renderRow(p, i, false))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
    {orderModal && (
      <ProductOrdersModal
        code={orderModal.code}
        productName={orderModal.name}
        onClose={() => setOrderModal(null)}
      />
    )}
    </>
  );
}

function MiniCategoryChart({ categories, dark }: { categories: MiniCategory[]; dark: boolean }) {
  if (!categories.length) return null;
  const max = Math.max(...categories.map(c => c.amount));
  return (
    <div className={`mt-3 pt-2 border-t space-y-1 ${dark ? 'border-[#2a2a40]' : 'border-gray-100'}`}>
      {categories.slice(0, 4).map((c, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[10px]">
          <span className={`w-[60px] truncate ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{c.name}</span>
          <div className={`flex-1 h-[10px] rounded-full overflow-hidden ${dark ? 'bg-[#2a2a40]' : 'bg-gray-100'}`}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: max > 0 ? `${Math.max((c.amount / max) * 100, 4)}%` : '0%',
                backgroundColor: CAT_COLORS[i % CAT_COLORS.length],
              }}
            />
          </div>
          <span className={`w-[42px] text-right font-medium ${dark ? 'text-gray-300' : 'text-gray-600'}`}>
            {formatKoreanShort(c.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ trend, ...s }: StyleProps & { trend: TrendRow[] }) {
  if (!trend.length) return null;
  return (
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <h3 className={`text-sm font-bold mb-3 ${s.txt}`}>매출 추이</h3>
      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={trend}>
          <CartesianGrid strokeDasharray="3 3" stroke={s.chartGrid} />
          <XAxis dataKey="period" tick={{ fill: s.chartTick, fontSize: 11 }} />
          <YAxis yAxisId="left" tick={{ fill: s.chartTick, fontSize: 11 }}
            tickFormatter={(v: number) => formatKoreanShort(v)} />
          <YAxis yAxisId="right" orientation="right" tick={{ fill: s.chartTick, fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              background: s.tooltipBg, border: `1px solid ${s.tooltipBorder}`,
              fontSize: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
            labelStyle={{ color: s.dark ? '#fff' : '#111', fontWeight: 700 }}
            formatter={(value, name) => {
              const num = Number(value);
              if (name === '주문수' || name === '수량') return [num.toLocaleString(), name];
              return [formatKRW(num) + '원', name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="left" dataKey="revenue" name="매출액" fill="#03c75a" radius={[4, 4, 0, 0]} />
          <Bar yAxisId="left" dataKey="profit" name="수익" fill="#0078d7" radius={[4, 4, 0, 0]} />
          <Line yAxisId="right" dataKey="order_count" name="주문수" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type SortField = 'product_count' | 'sold_count' | 'total_qty' | 'total_amount';
type SortDir = 'desc' | 'asc' | null;

function sortNodes(nodes: CategoryNode[], field: SortField | null, dir: SortDir): CategoryNode[] {
  if (!field || !dir) return nodes;
  return [...nodes].sort((a, b) => dir === 'desc' ? b[field] - a[field] : a[field] - b[field]);
}

function CategorySection({ categories, ...s }: StyleProps & { categories: CategoryNode[] }) {
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  if (!categories.length) return null;

  const handleSort = (field: SortField) => {
    if (sortField !== field) { setSortField(field); setSortDir('desc'); }
    else if (sortDir === 'desc') { setSortDir('asc'); }
    else { setSortField(null); setSortDir(null); }
  };

  const handleCatClick = (catId: string) => {
    setSelectedCatId(prev => prev === catId ? null : catId);
  };

  // Chart data: selected category's children or top-level
  const selectedCat = selectedCatId ? categories.find(c => c.id === selectedCatId) : null;
  const chartNodes = selectedCat?.children || categories;
  const chartTitle = selectedCat ? `${selectedCat.name} 세부 카테고리` : '카테고리별 매출';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <CategoryBarChart categories={chartNodes} title={chartTitle} selectedCatName={selectedCat?.name || null}
        onBack={selectedCatId ? () => setSelectedCatId(null) : undefined} {...s} />
      <CategoryTreeTable categories={categories} selectedCatId={selectedCatId}
        onCategorySelect={handleCatClick}
        sortField={sortField} sortDir={sortDir} onSort={handleSort} {...s} />
    </div>
  );
}

function CategoryBarChart({ categories, title, selectedCatName, onBack, ...s }: StyleProps & {
  categories: CategoryNode[]; title: string; selectedCatName: string | null;
  onBack?: () => void;
}) {
  if (!categories.length) return null;
  const chartData = categories.slice(0, 12).map(c => ({
    name: c.name,
    total_amount: c.total_amount,
  }));
  return (
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <div className="flex items-center gap-2 mb-3">
        {onBack && (
          <button onClick={onBack}
            className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${s.dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#3d3d3d]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            ← 전체
          </button>
        )}
        <h3 className={`text-sm font-bold ${s.txt}`}>{title}</h3>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 36)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={s.chartGrid} />
          <XAxis type="number" tick={{ fill: s.chartTick, fontSize: 10 }}
            tickFormatter={(v: number) => formatKoreanShort(v)} />
          <YAxis type="category" dataKey="name" tick={{ fill: s.chartTick, fontSize: 11 }} width={75} />
          <Tooltip
            contentStyle={{
              background: s.tooltipBg, border: `1px solid ${s.tooltipBorder}`,
              fontSize: 12, borderRadius: 8,
            }}
            formatter={(value) => [formatKRW(Number(value)) + '원', '매출액']}
          />
          <Bar dataKey="total_amount" radius={[0, 4, 4, 0]}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CategoryTreeTable({ categories, selectedCatId, onCategorySelect, sortField, sortDir, onSort, ...s }: StyleProps & {
  categories: CategoryNode[];
  selectedCatId: string | null;
  onCategorySelect: (id: string) => void;
  sortField: SortField | null;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!categories.length) return null;

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const sortIcon = (field: SortField) => {
    if (sortField !== field) return '';
    return sortDir === 'desc' ? ' ▼' : ' ▲';
  };
  const headerBtn = (field: SortField, label: string) => (
    <th className={`text-right px-2 py-1.5 font-medium ${s.txtSub} cursor-pointer select-none hover:text-[#03c75a] transition-colors`}
      onClick={() => onSort(field)}>
      {label}{sortIcon(field)}
    </th>
  );

  const renderRows = (nodes: CategoryNode[], level: number, parentKey: string): React.ReactNode[] => {
    const sorted = level === 0 ? sortNodes(nodes, sortField, sortDir) : sortNodes(nodes, sortField, sortDir);
    const rows: React.ReactNode[] = [];
    for (const node of sorted) {
      const key = `${parentKey}/${node.id}`;
      const hasChildren = node.children && node.children.length > 0;
      const isOpen = expanded[key] ?? (level === 0);
      const isSelected = level === 0 && node.id === selectedCatId;

      rows.push(
        <tr key={key} className={`border-t ${s.dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${s.tRow} ${
          isSelected ? (s.dark ? 'bg-[#03c75a]/10' : 'bg-[#03c75a]/5') : ''
        }`}>
          <td className={`px-2 py-1.5 ${s.txt}`} style={{ paddingLeft: 8 + level * 20 }}>
            <span className="inline-flex items-center gap-1">
              {hasChildren ? (
                <button onClick={(e) => { e.stopPropagation(); toggle(key); }}
                  className="w-4 h-4 flex items-center justify-center text-[10px] opacity-60 hover:opacity-100">
                  {isOpen ? '▼' : '▶'}
                </button>
              ) : (
                <span className="w-4" />
              )}
              {level === 0 && hasChildren ? (
                <button onClick={() => onCategorySelect(node.id)}
                  className={`text-left transition-colors ${isSelected ? 'text-[#03c75a] font-bold' : 'font-bold hover:text-[#03c75a]'}`}>
                  {node.name}
                </button>
              ) : (
                <span className={level === 0 ? 'font-bold' : level === 1 ? 'font-medium' : ''}>{node.name}</span>
              )}
            </span>
          </td>
          <td className={`text-right px-2 py-1.5 ${s.txt}`}>{node.product_count.toLocaleString()}</td>
          <td className={`text-right px-2 py-1.5 ${s.txt}`}>{node.sold_count.toLocaleString()}</td>
          <td className={`text-right px-2 py-1.5 ${s.txt}`}>{node.total_qty.toLocaleString()}</td>
          <td className={`text-right px-2 py-1.5 font-medium ${s.txt}`}>{formatKoreanWon(node.total_amount)}</td>
        </tr>,
      );

      if (hasChildren && isOpen) {
        rows.push(...renderRows(node.children!, level + 1, key));
      }
    }
    return rows;
  };

  return (
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <h3 className={`text-sm font-bold mb-3 ${s.txt}`}>카테고리별 상세
        {selectedCatId && (
          <span className={`text-[11px] font-normal ml-2 ${s.txtSub}`}>
            (카테고리 클릭 → 좌측 차트 변경)
          </span>
        )}
      </h3>
      <div className="overflow-auto max-h-[500px]">
        <table className="w-full text-[12px]">
          <thead className={`sticky top-0 ${s.tHead}`}>
            <tr>
              <th className={`text-left px-2 py-1.5 font-medium ${s.txtSub}`}>카테고리</th>
              {headerBtn('product_count', '상품수')}
              {headerBtn('sold_count', '판매수')}
              {headerBtn('total_qty', '판매수량')}
              {headerBtn('total_amount', '매출액')}
            </tr>
          </thead>
          <tbody>
            {renderRows(categories, 0, '')}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopProductsTable({ products, ...s }: StyleProps & { products: TopProductRow[] }) {
  const [orderModal, setOrderModal] = useState<{ code: string; name: string } | null>(null);
  if (!products.length) return null;
  return (
    <>
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <h3 className={`text-sm font-bold mb-3 ${s.txt}`}>Top 판매상품</h3>
      <div className="overflow-auto">
        <table className="w-full text-[12px]">
          <thead className={s.tHead}>
            <tr>
              <th className={`text-center px-2 py-2 font-medium ${s.txtSub} w-8`}>#</th>
              <th className={`text-left px-2 py-2 font-medium ${s.txtSub}`}>상품명</th>
              <th className={`text-left px-2 py-2 font-medium ${s.txtSub} w-28`}>상품번호</th>
              <th className={`text-center px-2 py-2 font-medium ${s.txtSub} w-16`}>상태</th>
              <th className={`text-left px-2 py-2 font-medium ${s.txtSub} w-24`}>관리코드</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-16`}>수량</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-24`}>매출액</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-20`}>원가</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-24`}>수익</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-16`}>수익률</th>
              <th className={`text-right px-2 py-2 font-medium ${s.txtSub} w-16`}>주문수</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p, i) => {
              const margin = p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0;
              const badges = s.dark ? STATUS_BADGE : STATUS_BADGE_LIGHT;
              const badge = p.status_type ? badges[p.status_type] : null;
              return (
                <tr key={i} className={`border-t ${s.dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${s.tRow}`}>
                  <td className={`text-center px-2 py-2 ${s.txtSub}`}>{i + 1}</td>
                  <td className={`px-2 py-2 ${s.txt} max-w-[280px]`}>
                    {p.product_url ? (
                      <a href={p.product_url} target="_blank" rel="noopener noreferrer"
                        className="hover:text-[#03c75a] hover:underline truncate block"
                        title={p.product_name}>
                        {p.product_name}
                      </a>
                    ) : (
                      <span className="truncate block" title={p.product_name}>{p.product_name}</span>
                    )}
                  </td>
                  <td className={`px-2 py-2 font-mono text-[11px] ${s.txtSub}`}>
                    {p.channel_product_no ? (
                      p.product_url ? (
                        <a href={p.product_url} target="_blank" rel="noopener noreferrer"
                          className="hover:text-[#03c75a] hover:underline">{p.channel_product_no}</a>
                      ) : <span>{p.channel_product_no}</span>
                    ) : '-'}
                  </td>
                  <td className="text-center px-2 py-2">
                    {p.status && badge ? (
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${badge.bg} ${badge.text}`}>
                        {p.status}
                      </span>
                    ) : p.status ? (
                      <span className={`text-[10px] ${s.txtSub}`}>{p.status}</span>
                    ) : null}
                  </td>
                  <td className={`px-2 py-2 font-mono text-[11px] ${s.txtSub}`}>{p.seller_code}</td>
                  <td className={`text-right px-2 py-2 ${s.txt}`}>{p.qty.toLocaleString()}</td>
                  <td className={`text-right px-2 py-2 font-medium ${s.txt} cursor-pointer hover:text-[#03c75a] transition-colors`}
                    onClick={() => p.seller_code && setOrderModal({ code: p.seller_code, name: p.product_name })}
                    title="주문이력 보기">
                    {formatKoreanWon(p.revenue)}
                  </td>
                  <td className={`text-right px-2 py-2 ${s.txtSub}`}>{formatKoreanWon(p.cost)}</td>
                  <td className={`text-right px-2 py-2 font-medium ${p.profit >= 0 ? 'text-green-500' : 'text-red-400'}`}>{formatKoreanWon(p.profit)}</td>
                  <td className={`text-right px-2 py-2 ${margin >= 0 ? 'text-green-500' : 'text-red-400'}`}>{margin.toFixed(1)}%</td>
                  <td className={`text-right px-2 py-2 ${s.txt}`}>{p.order_count.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    {orderModal && (
      <ProductOrdersModal
        code={orderModal.code}
        productName={orderModal.name}
        onClose={() => setOrderModal(null)}
      />
    )}
    </>
  );
}

/* ════════════════════════════════════════════
   Registration Limit Panel
   ════════════════════════════════════════════ */

function RegistrationLimitPanel({ data, onReload, ...s }: StyleProps & { data: RegistrationLimitData; onReload: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState<PolicyCollectStatus | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const apiCount = data.stores.filter(st => st.limit_source === 'api').length;
  const running = !!status?.running;
  const logs = status?.logs ?? [];

  const poll = useCallback(() => {
    fetchPolicyStatus().then(st => {
      setStatus(st);
      if (!st.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        onReload();   // 수집 완료 → 실측값 다시 로드
      }
    }).catch(() => {});
  }, [onReload]);

  const handleCollect = useCallback(async () => {
    setShowLog(true);
    const r = await startPolicyCollect();
    if (r.ok || r.error === 'already_running') {
      poll();
      if (!pollRef.current) pollRef.current = setInterval(poll, 3000);
    } else {
      setStatus(prev => ({
        running: false, phase: 'error', login_idx: 0, total_logins: 0, store_idx: 0,
        current_login: null, current_store: null,
        logs: [...(prev?.logs ?? []), `[에러] 수집 시작 실패: ${r.error ?? 'unknown'}`],
        error: r.error ?? 'start_failed',
      }));
    }
  }, [poll]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // 새 로그 도착 시 맨 아래로 자동 스크롤
  useEffect(() => {
    if (showLog && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs.length, showLog]);

  return (
    <div className={`rounded-xl border p-4 ${s.card}`}>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h3 className={`text-sm font-bold cursor-pointer select-none ${s.txt}`} onClick={() => setExpanded(v => !v)}>
          {expanded ? '▼' : '▶'} 상품등록한도
          <span className={`text-[11px] font-normal ml-2 ${s.txtSub}`}>(네이버 판매정책준수현황 · 6/2 신정책)</span>
        </h3>
        <span className={`text-[11px] px-2 py-0.5 rounded ${s.dark ? 'bg-[#2a2a40] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
          실측 {apiCount}/{data.stores.length} · 미수집은 추정
        </span>
        <button
          onClick={handleCollect}
          disabled={running}
          className={`text-[11px] px-2.5 py-1 rounded font-semibold transition-colors ${running
            ? (s.dark ? 'bg-[#2a2a40] text-gray-500' : 'bg-gray-100 text-gray-400')
            : 'bg-[#03c75a] text-white hover:bg-[#02b350]'}`}
        >
          {running ? `수집중 ${status?.login_idx ?? 0}/${status?.total_logins ?? 0}…` : '↻ 한도 실측 수집'}
        </button>
        {running && status && (
          <span className={`text-[10px] ${s.txtSub}`}>
            {status.current_login ?? ''} {status.current_store ? `/ ${status.current_store}` : ''}
          </span>
        )}
        {(logs.length > 0 || showLog) && (
          <button
            onClick={() => setShowLog(v => !v)}
            className={`text-[11px] px-2 py-1 rounded transition-colors ${s.dark
              ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#33334d]'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
            {showLog ? '▲ 로그 숨기기' : '▼ 진행 로그'}
          </button>
        )}
        <button
          onClick={() => setShowGuide(v => !v)}
          className={`text-[11px] px-2 py-1 rounded transition-colors ${showGuide
            ? 'bg-[#03c75a]/15 text-[#03c75a]'
            : s.dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#33334d]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          ℹ 등록한도 기준
        </button>
      </div>

      {showGuide && (
        <div className={`mb-3 rounded-lg border overflow-hidden ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <div className={`flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold ${s.dark ? 'bg-[#12121e] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
            <span>네이버 스마트스토어 상품 등록 한도 기준 <span className="font-normal opacity-70">(2026-06-02 신정책)</span></span>
            <button onClick={() => setShowGuide(false)} className="opacity-60 hover:opacity-100">✕</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className={s.dark ? 'text-gray-400' : 'text-gray-500'}>
                  <th className={`text-left px-3 py-2 font-semibold border-b ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>상품 등록 한도</th>
                  <th className={`text-right px-3 py-2 font-semibold border-b ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>거래액 <span className="opacity-60">(최근 3개월)</span></th>
                  <th className={`text-right px-3 py-2 font-semibold border-b ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>판매건수 <span className="opacity-60">(최근 3개월)</span></th>
                  <th className={`text-right px-3 py-2 font-semibold border-b ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>판매 상품 비중</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { limit: '50,000개', amount: '6,000만원 이상', count: '1,000건 이상', ratio: '3% 이상' },
                  { limit: '20,000개', amount: '2,000만원 이상', count: '400건 이상', ratio: '3% 이상' },
                  { limit: '10,000개', amount: '1,000만원 이상', count: '200건 이상', ratio: '3% 이상' },
                  { limit: '5,000개', amount: '500만원 이상', count: '100건 이상', ratio: '3% 이상' },
                  { limit: '1,000개', amount: '500만원 미만', count: '100건 미만', ratio: '—' },
                ].map((r, i) => (
                  <tr key={r.limit} className={i % 2 ? (s.dark ? 'bg-[#12121e]/40' : 'bg-gray-50/60') : ''}>
                    <td className={`px-3 py-2 font-bold ${s.dark ? 'text-[#03c75a]' : 'text-[#02a34a]'}`}>{r.limit}</td>
                    <td className={`px-3 py-2 text-right ${s.txt}`}>{r.amount}</td>
                    <td className={`px-3 py-2 text-right ${s.txt}`}>{r.count}</td>
                    <td className={`px-3 py-2 text-right ${s.txtSub}`}>{r.ratio}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`px-3 py-2 text-[10px] leading-relaxed ${s.dark ? 'bg-[#0b0b14] text-gray-400' : 'bg-white text-gray-500'}`}>
            판매실적은 <b>거래액 또는 판매건수</b> 중 하나만 충족하면 됩니다 (둘 중 상위 조건 적용). 판매 상품 비중(전체 등록 상품 중 판매된 비율) <b>3% 이상</b>도 함께 충족해야 상위 한도가 부여됩니다. 기본 한도는 <b>1,000개</b>입니다.
          </div>
        </div>
      )}

      {showLog && (
        <div className={`mb-3 rounded-lg border overflow-hidden ${s.dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <div className={`flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold ${s.dark ? 'bg-[#12121e] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
            <span>
              한도 실측 수집 로그
              {running
                ? <span className="ml-2 text-[#03c75a]">● 진행중 {status?.login_idx ?? 0}/{status?.total_logins ?? 0}</span>
                : status
                  ? <span className={`ml-2 ${status.error ? 'text-red-400' : 'text-gray-400'}`}>{status.error ? '● 에러' : '● 완료'}</span>
                  : null}
            </span>
            <button onClick={() => setShowLog(false)} className="opacity-60 hover:opacity-100">✕</button>
          </div>
          <div
            ref={logBoxRef}
            className={`px-3 py-2 h-52 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap ${s.dark ? 'bg-[#0b0b14] text-gray-300' : 'bg-[#1c1c2e] text-gray-100'}`}
          >
            {logs.length === 0
              ? <span className="opacity-50">수집을 시작하면 진행 로그가 여기에 표시됩니다…</span>
              : logs.map((line, i) => (
                <div key={i} className={
                  line.includes('에러') || line.includes('실패') || line.toLowerCase().includes('error') ? 'text-red-400'
                    : line.includes('한도=') || line.includes('완료') ? 'text-[#03c75a]'
                      : ''
                }>{line}</div>
              ))}
          </div>
        </div>
      )}

      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {data.stores.map(st => (
            <RegLimitCard key={st.store_id} store={st} dark={s.dark} card={s.card} txt={s.txt} txtSub={s.txtSub} />
          ))}
        </div>
      )}
    </div>
  );
}

function RegLimitCard({ store: st, dark, txt, txtSub }: {
  store: RegistrationLimitStore; dark: boolean; card: string; txt: string; txtSub: string;
}) {
  const usagePct = st.current_limit > 0 ? Math.min((st.total_products / st.current_limit) * 100, 100) : 0;
  const overLimit = st.total_products > st.current_limit;
  const isMax = st.current_limit >= 50000;
  const isApi = st.limit_source === 'api';

  const barColor = overLimit ? 'bg-red-500' : usagePct > 80 ? 'bg-yellow-500' : 'bg-[#03c75a]';
  const barBg = dark ? 'bg-[#2a2a40]' : 'bg-gray-200';

  // 비중 3% 충족 여부 (실측은 API 이번달비중, 추정은 자체계산)
  const ratioVal = isApi ? st.api_monthly_ratio : st.sales_ratio;
  const ratioOk = isApi ? st.ratio_ok : st.sales_ratio >= 3;

  const showAmount = isApi && st.api_sale_amount != null ? st.api_sale_amount : st.transaction_amount;
  const showCount = isApi && st.api_sale_count != null ? st.api_sale_count : st.order_count;

  return (
    <div className={`rounded-lg border p-3 ${dark ? 'bg-[#1a1a2e] border-[#2a2a40]' : 'bg-gray-50 border-gray-200'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1 gap-1">
        <span className={`text-[12px] font-bold truncate ${txt}`}>{st.store_name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${isApi
            ? 'bg-blue-500/20 text-blue-400'
            : (dark ? 'bg-[#2a2a40] text-gray-500' : 'bg-gray-200 text-gray-500')}`}
            title={isApi ? `네이버 실측 (${st.captured_date ?? ''})` : '추정값 — 한도 실측 수집 전'}>
            {isApi ? '실측' : '추정'}
          </span>
          {isMax ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-bold">MAX</span>
          ) : (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${dark ? 'bg-[#2a2a40] text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
              한도 {st.current_limit.toLocaleString()}개{isApi && <span className="font-normal ml-0.5">(이번달)</span>}
            </span>
          )}
        </div>
      </div>

      {/* 원본 사업자명 · 로그인 아이디 */}
      <div className={`text-[10px] mb-2 truncate ${txtSub}`}>
        {st.business_name && <span className="font-semibold">{st.business_name}</span>}
        {st.business_name && st.login_id && <span className="mx-1">·</span>}
        {st.login_id && <span>{st.login_id}</span>}
      </div>

      {/* Progress bar */}
      <div className={`w-full h-2 rounded-full ${barBg} mb-1`}>
        <div className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${Math.min(usagePct, 100)}%` }} />
      </div>
      <div className={`text-[10px] mb-2 ${overLimit ? 'text-red-400 font-bold' : txtSub}`}>
        등록 {st.total_products.toLocaleString()} / {st.current_limit.toLocaleString()}
        {overLimit && ' (초과!)'}
        <span className="ml-1">({usagePct.toFixed(0)}%)</span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-1 text-[11px] mb-2">
        <div className="flex items-center justify-between">
          <span className={txtSub}>거래액 {isApi ? '(최근 3개월)' : '(3개월)'}</span>
          <span className={`font-bold ${txt}`}>{formatKoreanWon(showAmount)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className={txtSub}>판매 건수 {isApi ? '(최근 3개월)' : '(3개월)'}</span>
          <span className={`font-bold ${txt}`}>{showCount.toLocaleString()}건</span>
        </div>
        <div className="flex items-center justify-between">
          <span className={txtSub}>판매 상품 비중{isApi ? '(이번달)' : ''}</span>
          <span className={`font-bold ${ratioOk ? 'text-green-400' : 'text-red-400'}`}>
            {ratioVal != null ? ratioVal : '-'}%
            <span className={`font-normal ml-1 ${ratioOk ? 'text-green-400' : 'text-red-400'}`}>
              {ratioOk ? '✓ 3%↑' : '✗ <3%'}
            </span>
          </span>
        </div>
      </div>

      {/* 비중 산식 (실측 전용) */}
      {isApi && st.api_sale_product_count != null && st.api_90d_avg != null && (
        <div className={`text-[10px] rounded px-2 py-1.5 mb-2 ${dark ? 'bg-[#222238]' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center justify-between">
            <span className={txtSub}>판매상품수<span className="opacity-60">(13개월)</span></span>
            <span className={`font-bold ${txt}`}>{st.api_sale_product_count.toLocaleString()}개</span>
          </div>
          <div className="flex items-center justify-between">
            <span className={txtSub}>÷ 평균등록상품수<span className="opacity-60">(90일)</span></span>
            <span className={`font-bold ${txt}`}>{st.api_90d_avg.toLocaleString()}개</span>
          </div>
          <div className={`flex items-center justify-between pt-1 mt-1 border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
            <span className={txtSub}>= 비중<span className="opacity-60">(전일)</span></span>
            <span className={`font-bold ${(st.api_daily_ratio ?? 0) >= 3 ? 'text-green-400' : 'text-red-400'}`}>
              {st.api_daily_ratio != null ? st.api_daily_ratio : '-'}%
            </span>
          </div>
        </div>
      )}

      {/* 3% 미달 경고 + 도달 가이드 */}
      {isApi && !ratioOk && (
        <div className={`text-[10px] px-2 py-1 rounded mb-2 ${dark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
          판매상품비중 {ratioVal}% &lt; 3% → 기본 한도 1,000개 유지
        </div>
      )}

      {/* 90일 평균 추세 → 한도 상향 예상시점 */}
      {isApi && !ratioOk && (
        <div className={`text-[10px] px-2 py-1.5 rounded mb-2 flex items-center gap-1.5 ${dark ? 'bg-blue-500/10 text-blue-300' : 'bg-blue-50 text-blue-700'}`}>
          {st.eta_status === 'projected' && st.eta_date ? (
            <span>📈 예상 3% 도달 <b>{st.eta_date.slice(5).replace('-', '/')}</b>
              {st.eta_days != null && <> (~{st.eta_days}일)</>}
              {st.avg_slope_per_day != null && st.avg_slope_per_day < 0 && (
                <span className="opacity-70"> · 평균 {Math.abs(st.avg_slope_per_day).toLocaleString()}개/일↓</span>
              )}
            </span>
          ) : st.eta_status === 'collecting' ? (
            <span className="opacity-80">📊 추세 데이터 축적 중 ({st.trend_points}일치) — 일일 수집 필요</span>
          ) : st.eta_status === 'no_decline' ? (
            <span className="opacity-80">📊 평균등록 감소 추세 없음 — 상품 정리 필요</span>
          ) : st.eta_status === 'need_reduce' ? (
            <span className="opacity-80">📉 현재 등록수가 목표 초과 — 추가 감축해야 도달</span>
          ) : (
            <span className="opacity-80">📊 추세 분석 대기</span>
          )}
        </div>
      )}
      {isApi && ratioOk && (
        <div className={`text-[10px] px-2 py-1 rounded mb-2 ${dark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
          ✓ 비중 3% 충족 — 거래액·판매건 볼륨 충족 시 한도 상향
        </div>
      )}
      {isApi && !ratioOk && st.reg_target_3pct != null && (
        st.reg_current_ok ? (
          <div className={`text-[10px] px-2 py-1.5 rounded mb-2 ${dark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            🎯 3% 목표 평균등록 <b>{st.reg_target_3pct.toLocaleString()}개</b> 이하 ·
            현재 등록 {st.total_products.toLocaleString()}개 → <b>이미 충족, 90일 평균 반영 대기</b>
          </div>
        ) : (
          <div className={`text-[10px] px-2 py-1.5 rounded mb-2 ${dark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
            🎯 3% 도달: 등록상품 <b>{st.reg_target_3pct.toLocaleString()}개</b> 이하로
            {st.reg_reduce_avg != null && st.reg_reduce_avg > 0 && <> (현재평균 {st.api_90d_avg?.toLocaleString()} → 약 <b>{st.reg_reduce_avg.toLocaleString()}개↓</b>)</>}
          </div>
        )
      )}
      {isApi && (
        <div className={`text-[9px] leading-snug pt-1.5 border-t ${dark ? 'border-[#2a2a40] text-gray-500' : 'border-gray-200 text-gray-400'}`}>
          ⓘ 다음 달 한도는 <b>판매상품비중 3% 이상</b>일 때 상향됩니다.
          비중은 순 상품 주문건수 기준(부정거래 제외).
          {st.applied_ymd && <> · {st.applied_ymd.slice(0, 4)}.{st.applied_ymd.slice(4, 6)}.{st.applied_ymd.slice(6, 8)} 적용</>}
        </div>
      )}

      {/* Next tier (추정 기준에서만 — 신정책 산식 미확정) */}
      {!isApi && st.next_limit && st.sales_ratio >= 3 && (
        <div className={`text-[10px] pt-2 border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <div className={`font-bold mb-0.5 ${dark ? 'text-blue-400' : 'text-blue-600'}`}>
            ▷ 다음 {st.next_limit.toLocaleString()}개
          </div>
          <div className={txtSub}>
            {st.needed_amount != null && st.needed_amount > 0 && (
              <span>거래액 +{formatKoreanWon(st.needed_amount)}</span>
            )}
            {st.needed_amount != null && st.needed_amount > 0 && st.needed_orders != null && st.needed_orders > 0 && (
              <span> 또는 </span>
            )}
            {st.needed_orders != null && st.needed_orders > 0 && (
              <span>주문건 +{st.needed_orders.toLocaleString()}건</span>
            )}
            {(st.needed_amount === 0 || st.needed_amount == null) && (st.needed_orders === 0 || st.needed_orders == null) && (
              <span>비중 3% 이상 유지 필요</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, icon, dark, color }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; dark: boolean; color?: string;
}) {
  return (
    <div className={`rounded-xl border p-4 flex items-center gap-3 ${dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm'}`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${dark ? 'bg-[#2a2a40]' : 'bg-gray-50'}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className={`text-[11px] font-medium ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
        <div className={`text-[17px] font-extrabold truncate ${color || (dark ? 'text-white' : 'text-gray-900')}`}>{value}</div>
        {sub && <div className={`text-[10px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</div>}
      </div>
    </div>
  );
}

/* ── Icons ── */
function IconBox() { return <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>; }
function IconCheck() { return <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>; }
function IconWon() { return <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>; }
function IconCart() { return <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"/></svg>; }
function IconTrend() { return <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>; }
