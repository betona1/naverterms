import { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import { NaverLogo, RankIcon } from '../components/naver/NaverIcon';

interface RankSummary {
  id: number;
  keyword: string;
  target_type: string;
  target_value: string;
  display_name: string;
  current_rank: number | null;
  previous_rank: number | null;
  change: number | null;
  tracked_at: string | null;
}

interface RankHistory {
  id: number;
  target: number;
  rank_position: number | null;
  tab_type: string;
  total_results: number;
  found_product_name: string;
  found_product_price: number | null;
  found_review_count: number | null;
  tracked_at: string;
}

export default function NaverRankPage() {
  const { dark } = useTheme();
  const [summary, setSummary] = useState<RankSummary[]>([]);
  const [history, setHistory] = useState<RankHistory[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  const [stores, setStores] = useState<SmartStore[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newTargetType, setNewTargetType] = useState('store');
  const [newTargetValue, setNewTargetValue] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  const [tracking, setTracking] = useState(false);
  const [trackResult, setTrackResult] = useState<{ tracked: number; results: any[] } | null>(null);

  const loadSummary = useCallback(async () => {
    try { setSummary(await naverApi.getRankSummary()); } catch (e) { console.error(e); }
  }, []);

  const loadHistory = useCallback(async () => {
    try { setHistory(await naverApi.getRankHistory(selectedTarget ?? undefined, days)); } catch (e) { console.error(e); }
  }, [selectedTarget, days]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { fetchStores().then(setStores).catch(console.error); }, []);

  const handleAddTarget = async () => {
    if (!newKeyword || !newTargetValue) return;
    setLoading(true);
    await naverApi.addRankTarget({
      keyword: newKeyword, target_type: newTargetType,
      target_value: newTargetValue, display_name: newDisplayName,
    });
    setNewKeyword(''); setNewTargetValue(''); setNewDisplayName('');
    await loadSummary();
    setLoading(false);
  };

  const handleDeleteTarget = async (id: number) => {
    await naverApi.deleteRankTarget(id);
    await loadSummary();
  };

  const handleStartTracking = async () => {
    if (tracking) return;
    setTracking(true);
    setTrackResult(null);
    try {
      const result = await naverApi.runRankTracking();
      setTrackResult(result);
      await loadSummary();
      await loadHistory();
    } catch (e) {
      console.error(e);
    } finally {
      setTracking(false);
    }
  };

  const chartData = (() => {
    if (history.length === 0) return [];
    const grouped: Record<string, Record<number, number | null>> = {};
    for (const h of history) {
      const date = h.tracked_at.slice(0, 10);
      if (!grouped[date]) grouped[date] = {};
      grouped[date][h.target] = h.rank_position;
    }
    return Object.entries(grouped)
      .map(([date, targets]) => ({ date, ...targets }))
      .sort((a, b) => a.date.localeCompare(b.date));
  })();

  const targetColors = ['#03c75a', '#0078d7', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

  const changeArrow = (change: number | null) => {
    if (change === null) return '';
    if (change > 0) return `\u2191${change}`;
    if (change < 0) return `\u2193${Math.abs(change)}`;
    return '-';
  };

  const changeColor = (change: number | null) => {
    if (change === null) return txtMuted;
    if (change > 0) return 'text-green-500';
    if (change < 0) return 'text-red-500';
    return txtMuted;
  };

  // 스타일 변수
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';
  const tSelected = dark ? 'bg-[#1a2a3a]' : 'bg-green-50';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const inputCls = dark
    ? 'bg-[#1c1c2e] border-[#333] text-white placeholder-gray-500 focus:ring-[#03c75a]/50'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#03c75a]/50';
  const selectCls = dark
    ? 'bg-[#1c1c2e] border-[#333] text-white'
    : 'bg-white border-gray-300 text-gray-900';
  const chartGrid = dark ? '#2a2a40' : '#e5e7eb';
  const chartTick = dark ? '#888' : '#6b7280';
  const tooltipBg = dark ? '#1c1c2e' : '#ffffff';
  const tooltipBorder = dark ? '#2a2a40' : '#e5e7eb';

  return (
    <div className={`min-h-screen ${bg} transition-colors`} style={{ fontFamily: "'NanumSquare', 'Malgun Gothic', sans-serif" }}>
      <div className="max-w-[1800px] mx-auto px-4 py-5 md:px-6">

        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-5">
          <NaverLogo size={32} />
          <div>
            <h1 className={`text-[18px] font-extrabold tracking-tight ${txt}`}>네이버쇼핑 순위추적</h1>
            <p className={`text-[12px] ${txtSub}`}>키워드별 상품/스토어 순위 변동 모니터링</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {tracking && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#03c75a] animate-pulse" />
                <span className={`text-[11px] font-bold ${txtSub}`}>순위 조회 중...</span>
              </div>
            )}
            {trackResult && !tracking && (
              <span className={`text-[11px] font-bold ${txtSub}`}>
                {trackResult.tracked}개 조회 완료
              </span>
            )}
          </div>
        </div>

        {/* 추적 대상 추가 카드 */}
        <div className={`rounded-xl border p-4 mb-4 ${card}`}>
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[130px]">
              <label className={`text-[11px] font-bold block mb-1.5 ${txtSub}`}>키워드</label>
              <input value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition ${inputCls}`}
                placeholder="키워드 입력" />
            </div>
            <div className="min-w-[110px]">
              <label className={`text-[11px] font-bold block mb-1.5 ${txtSub}`}>유형</label>
              <select value={newTargetType} onChange={e => setNewTargetType(e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${selectCls}`}>
                <option value="store">스토어명</option>
                <option value="product_id">상품ID (nvMid)</option>
              </select>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className={`text-[11px] font-bold block mb-1.5 ${txtSub}`}>대상값</label>
              {newTargetType === 'store' && stores.length > 0 ? (
                <select value={newTargetValue}
                  onChange={e => {
                    const val = e.target.value;
                    setNewTargetValue(val);
                    const s = stores.find(st => st.store_name === val);
                    if (s) setNewDisplayName(s.store_name);
                  }}
                  className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${selectCls}`}>
                  <option value="">스토어 선택</option>
                  {stores.map(s => (
                    <option key={s.id} value={s.store_name}>{s.store_name}</option>
                  ))}
                </select>
              ) : (
                <input value={newTargetValue} onChange={e => setNewTargetValue(e.target.value)}
                  className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition ${inputCls}`}
                  placeholder={newTargetType === 'store' ? '스토어명' : 'nvMid'} />
              )}
            </div>
            <div className="flex-1 min-w-[130px]">
              <label className={`text-[11px] font-bold block mb-1.5 ${txtSub}`}>표시이름</label>
              <input value={newDisplayName} onChange={e => setNewDisplayName(e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition ${inputCls}`}
                placeholder="(선택)" />
            </div>
            <button onClick={handleAddTarget} disabled={loading}
              className="px-5 py-2 bg-[#03c75a] text-white text-[12px] font-bold rounded-lg hover:bg-[#02b350] active:scale-[0.97] transition disabled:opacity-50 shrink-0">
              추가
            </button>
            <button onClick={handleStartTracking} disabled={tracking || summary.length === 0}
              className="px-5 py-2 bg-[#03c75a] text-white text-[12px] font-bold rounded-lg hover:bg-[#02b350] active:scale-[0.97] transition flex items-center gap-1.5 shrink-0 disabled:opacity-50">
              {tracking ? (
                <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> 조회중...</>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15.5 14H14.71L14.43 13.73C15.41 12.59 16 11.11 16 9.5C16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16C11.11 16 12.59 15.41 13.73 14.43L14 14.71V15.5L19 20.49L20.49 19L15.5 14ZM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z" fill="white"/></svg> 순위조회</>
              )}
            </button>
            <button onClick={() => naverApi.downloadRankExcel(days)}
              className={`px-5 py-2 text-[12px] font-bold rounded-lg transition shrink-0 ${dark ? 'bg-[#1a3a5c] text-blue-300 hover:bg-[#1f4570]' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
              엑셀다운로드
            </button>
          </div>
        </div>

        {/* 추적 대상 테이블 카드 */}
        <div className={`rounded-xl border overflow-hidden mb-4 ${card}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className={tHead}>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>키워드</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>대상</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>유형</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>현재순위</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>변동</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>마지막 추적</th>
                  <th className={`px-3 py-3 text-center font-bold ${txtSub} w-12`}>삭제</th>
                </tr>
              </thead>
              <tbody>
                {summary.map(s => (
                  <tr key={s.id}
                    className={`border-t cursor-pointer transition-colors ${tRow} ${selectedTarget === s.id ? tSelected : ''}`}
                    onClick={() => setSelectedTarget(selectedTarget === s.id ? null : s.id)}>
                    <td className={`px-3 py-2.5 font-bold ${txt}`}>{s.keyword}</td>
                    <td className="px-3 py-2.5 text-[#03c75a] font-semibold">{s.display_name || s.target_value}</td>
                    <td className={`px-3 py-2.5 ${txtSub}`}>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        s.target_type === 'store'
                          ? (dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600')
                          : (dark ? 'bg-blue-500/15 text-blue-400' : 'bg-blue-50 text-blue-600')
                      }`}>
                        {s.target_type === 'store' ? '스토어' : '상품ID'}
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-extrabold ${txt}`}>
                      {s.current_rank ? (
                        <span className={s.current_rank <= 10 ? 'text-[#03c75a]' : ''}>{s.current_rank}위</span>
                      ) : '-'}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-bold ${changeColor(s.change)}`}>
                      {changeArrow(s.change)}
                    </td>
                    <td className={`px-3 py-2.5 text-[11px] ${txtMuted}`}>
                      {s.tracked_at ? new Date(s.tracked_at).toLocaleString('ko-KR') : '-'}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteTarget(s.id); }}
                        className={`w-6 h-6 rounded-full flex items-center justify-center transition ${dark ? 'hover:bg-red-900/40 text-red-400' : 'hover:bg-red-50 text-red-400'}`}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      </button>
                    </td>
                  </tr>
                ))}
                {summary.length === 0 && (
                  <tr><td colSpan={7} className={`text-center py-16 ${txtMuted}`}>
                    <RankIcon size={40} />
                    <p className="mt-3 text-[14px]">추적 대상을 추가하세요</p>
                    <p className="text-[12px] mt-1">상단 입력란에 키워드와 스토어명/상품ID를 입력</p>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 순위 변동 차트 카드 */}
        <div className={`rounded-xl border p-5 mb-4 ${card}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <RankIcon size={18} />
              <h3 className={`text-[14px] font-extrabold ${txt}`}>순위 변동 차트</h3>
            </div>
            <div className="flex gap-1.5">
              {[7, 30, 90].map(d => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition ${
                    days === d
                      ? 'bg-[#03c75a] text-white shadow-md shadow-[#03c75a]/20'
                      : (dark ? 'bg-[#2a2a40] text-gray-400 hover:text-white hover:bg-[#333]' : 'bg-gray-100 text-gray-500 hover:text-gray-700 hover:bg-gray-200')
                  }`}>
                  {d}일
                </button>
              ))}
            </div>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                <XAxis dataKey="date" tick={{ fill: chartTick, fontSize: 11 }} />
                <YAxis reversed tick={{ fill: chartTick, fontSize: 11 }} domain={[1, 'auto']} />
                <Tooltip
                  contentStyle={{
                    background: tooltipBg, border: `1px solid ${tooltipBorder}`,
                    fontSize: 12, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    fontFamily: "'NanumSquare', sans-serif",
                  }}
                  labelStyle={{ color: dark ? '#fff' : '#111', fontWeight: 700 }}
                />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: "'NanumSquare', sans-serif" }} />
                {summary.map((s, i) => (
                  <Line key={s.id}
                    dataKey={String(s.id)}
                    name={`${s.keyword} - ${s.display_name || s.target_value}`}
                    stroke={targetColors[i % targetColors.length]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5, strokeWidth: 2 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className={`text-center py-16 ${txtMuted}`}>
              <RankIcon size={36} />
              <p className="mt-3 text-[13px]">데이터가 없습니다</p>
            </div>
          )}
        </div>

        {/* 순위 이력 테이블 카드 */}
        <div className={`rounded-xl border overflow-hidden ${card}`}>
          <div className={`px-5 py-3 border-b flex items-center gap-2 ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#03c75a"><path d="M13 3C7.48 3 3 7.48 3 13H0L4 17.01L8 13H5C5 8.59 8.59 5 13 5S21 8.59 21 13 17.41 21 13 21C10.79 21 8.82 19.99 7.46 18.46L5.99 19.93C7.73 21.81 10.22 23 13 23C18.52 23 23 18.52 23 13S18.52 3 13 3ZM12 8V14L17.25 17.15L18 15.92L13.5 13.25V8H12Z"/></svg>
            <h3 className={`text-[13px] font-extrabold ${txt}`}>순위 이력</h3>
            <span className={`text-[11px] ${txtSub}`}>최근 {days}일</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className={tHead}>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>날짜시간</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>키워드</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>대상</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>순위</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub}`}>탭</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[250px]`}>상품명</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>가격</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>리뷰수</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 100).map(h => {
                  const target = summary.find(s => s.id === h.target);
                  return (
                    <tr key={h.id} className={`border-t transition-colors ${tRow}`}>
                      <td className={`px-3 py-2 ${txtMuted} text-[11px]`}>{new Date(h.tracked_at).toLocaleString('ko-KR')}</td>
                      <td className={`px-3 py-2 font-bold ${txt}`}>{target?.keyword || ''}</td>
                      <td className="px-3 py-2 text-[#03c75a] font-semibold">{target?.display_name || target?.target_value || ''}</td>
                      <td className={`px-3 py-2 text-right font-extrabold ${h.rank_position && h.rank_position <= 10 ? 'text-[#03c75a]' : txt}`}>
                        {h.rank_position ? `${h.rank_position}위` : <span className="text-red-400">미발견</span>}
                      </td>
                      <td className={`px-3 py-2 ${txtSub}`}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${dark ? 'bg-[#2a2a40]' : 'bg-gray-100'}`}>
                          {h.tab_type === 'total' ? '전체' : h.tab_type === 'model' ? '가격비교' : h.tab_type === 'checkout' ? '네이버페이' : h.tab_type}
                        </span>
                      </td>
                      <td className={`px-3 py-2 ${txtSub} max-w-[300px] truncate`}>{h.found_product_name}</td>
                      <td className={`px-3 py-2 text-right font-medium ${txt}`}>
                        {h.found_product_price ? `${h.found_product_price.toLocaleString()}원` : ''}
                      </td>
                      <td className={`px-3 py-2 text-right font-medium ${txt}`}>
                        {h.found_review_count?.toLocaleString() || ''}
                      </td>
                    </tr>
                  );
                })}
                {history.length === 0 && (
                  <tr><td colSpan={8} className={`text-center py-16 ${txtMuted}`}>
                    <p className="text-[13px]">이력이 없습니다</p>
                    <p className="text-[11px] mt-1">추적을 시작하면 순위 이력이 기록됩니다</p>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
