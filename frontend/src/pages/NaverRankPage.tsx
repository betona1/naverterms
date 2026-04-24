import { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import type { RankGroup, RankGroupKeyword, RankPivotData } from '../api/naverApi';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import { NaverLogo, RankIcon } from '../components/naver/NaverIcon';

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

// ── 타상품조회 입력 모달 ──
function parseTargetInput(input: string): { type: string; value: string; display: string } {
  const trimmed = input.trim();
  // 스마트스토어 상품 URL: smartstore.naver.com/스토어/products/12345
  const ssProdMatch = trimmed.match(/smartstore\.naver\.com\/([^\/\?]+)\/products\/(\d+)/);
  if (ssProdMatch) return { type: 'product_id', value: ssProdMatch[2], display: `${ssProdMatch[1]}#${ssProdMatch[2]}` };
  // 스마트스토어 스토어 URL: smartstore.naver.com/스토어명
  const ssMatch = trimmed.match(/smartstore\.naver\.com\/([^\/\?\s]+)/);
  if (ssMatch) return { type: 'store', value: ssMatch[1], display: ssMatch[1] };
  // 네이버쇼핑 상품 URL
  const spMatch = trimmed.match(/shopping\.naver\.com\/product[s]?\/(\d+)/);
  if (spMatch) return { type: 'product_id', value: spMatch[1], display: `상품#${spMatch[1]}` };
  const midMatch = trimmed.match(/nvMid=(\d+)/);
  if (midMatch) return { type: 'product_id', value: midMatch[1], display: `상품#${midMatch[1]}` };
  if (/^\d{5,}$/.test(trimmed)) return { type: 'product_id', value: trimmed, display: `상품#${trimmed}` };
  return { type: 'store', value: trimmed, display: trimmed };
}

function ExternalRankModal({ onClose, onSubmitted, dark }: {
  onClose: () => void;
  onSubmitted: (addedIds: number[]) => void;
  dark: boolean;
}) {
  const [keywords, setKeywords] = useState('');
  const [target, setTarget] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const inputCls = dark
    ? 'bg-[#1c1c2e] border-[#333] text-white placeholder-gray-500 focus:ring-[#03c75a]/50'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#03c75a]/50';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';

  const handleSubmit = async () => {
    const kwLines = keywords.split('\n').map(l => l.trim()).filter(Boolean);
    if (!kwLines.length || !target.trim()) return;
    setBusy(true);
    const parsed = parseTargetInput(target);
    const addedIds: number[] = [];
    try {
      for (const kw of kwLines) {
        const res = await naverApi.addRankTarget({
          keyword: kw,
          target_type: parsed.type,
          target_value: parsed.value,
          display_name: displayName || parsed.display,
        });
        if (res.id) addedIds.push(res.id);
      }
    } catch (e) { console.error(e); }
    setBusy(false);
    onSubmitted(addedIds);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${card} border rounded-xl shadow-2xl w-full max-w-md mx-4 flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center justify-between px-5 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <h3 className={`text-[14px] font-extrabold ${txt}`}>타상품 순위조회</h3>
          <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className={`text-[11px] font-bold block mb-1 ${txtSub}`}>키워드 (여러개시 줄바꿈)</label>
            <textarea value={keywords} onChange={e => setKeywords(e.target.value)} rows={3}
              className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition resize-none ${inputCls}`}
              placeholder="맥세이프그립톡&#10;그립톡 맥세이프" />
          </div>
          <div>
            <label className={`text-[11px] font-bold block mb-1 ${txtSub}`}>스토어명 / 상품URL / 상품ID</label>
            <input value={target} onChange={e => setTarget(e.target.value)}
              className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition ${inputCls}`}
              placeholder="스토어명, 상품URL, 또는 nvMid" />
            {target.trim() && (
              <div className={`text-[10px] mt-1 ${txtSub}`}>
                {(() => { const p = parseTargetInput(target); return `→ ${p.type === 'store' ? '스토어' : '상품ID'}: ${p.value}`; })()}
              </div>
            )}
          </div>
          <div>
            <label className={`text-[11px] font-bold block mb-1 ${txtSub}`}>표시이름 (선택)</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)}
              className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 transition ${inputCls}`}
              placeholder="자동설정" />
          </div>
        </div>
        <div className={`px-5 py-3 border-t flex gap-2 ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <button onClick={onClose} className={`flex-1 px-4 py-2.5 text-[12px] font-bold rounded-lg transition ${dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            취소
          </button>
          <button onClick={handleSubmit} disabled={busy || !keywords.trim() || !target.trim()}
            className="flex-1 px-4 py-2.5 text-[12px] font-bold rounded-lg bg-[#03c75a] text-white hover:bg-[#02b350] transition disabled:opacity-50 flex items-center justify-center gap-1.5">
            {busy ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> 추가중...</> : '추가 및 순위조회'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 자동추적 설정 모달 ──
const TIME_OPTIONS = [
  '00:00', '01:00', '02:00', '03:00', '04:00', '05:00',
  '06:00', '07:00', '08:00', '09:00', '10:00', '11:00',
  '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
  '18:00', '19:00', '20:00', '21:00', '22:00', '23:00',
];

function AutoTrackModal({ dark, group, onSave, onClose }: {
  dark: boolean;
  group: RankGroup;
  onSave: (enabled: boolean, times: string[]) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(group.auto_track);
  const [selected, setSelected] = useState<Set<string>>(new Set(group.auto_track_times));
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';

  const toggle = (t: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
      } else if (next.size < 4) {
        next.add(t);
      }
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${card} border rounded-xl shadow-2xl w-full max-w-sm mx-4`} onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className={`px-5 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <h3 className={`text-[14px] font-extrabold ${txt}`}>자동추적 설정</h3>
          <p className={`text-[11px] mt-0.5 ${txtSub} truncate`}>{group.display_name}</p>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* ON/OFF 스위치 */}
          <div className="flex items-center justify-between">
            <span className={`text-[13px] font-bold ${txt}`}>자동추적</span>
            <button
              onClick={() => setEnabled(v => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                enabled ? 'bg-[#03c75a]' : (dark ? 'bg-[#333]' : 'bg-gray-300')
              }`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          {/* 시간 선택 */}
          <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-[12px] font-bold ${txt}`}>수집 시간</span>
              <span className={`text-[10px] ${txtSub}`}>최대 4개 ({selected.size}/4)</span>
            </div>
            <div className="grid grid-cols-6 gap-1.5">
              {TIME_OPTIONS.map(t => {
                const isOn = selected.has(t);
                const isFull = selected.size >= 4 && !isOn;
                return (
                  <button key={t} onClick={() => toggle(t)}
                    disabled={isFull}
                    className={`px-1 py-2 rounded-lg text-[11px] font-bold transition ${
                      isOn
                        ? 'bg-[#03c75a] text-white shadow-sm'
                        : isFull
                          ? (dark ? 'bg-[#1a1a2e] text-gray-600 cursor-not-allowed' : 'bg-gray-50 text-gray-300 cursor-not-allowed')
                          : (dark ? 'bg-[#2a2a40] text-gray-400 hover:text-white hover:bg-[#333]' : 'bg-gray-100 text-gray-500 hover:bg-gray-200')
                    }`}>
                    {t.slice(0, 2)}시
                  </button>
                );
              })}
            </div>
            {enabled && selected.size === 0 && (
              <p className="text-[10px] text-amber-500 mt-2">시간을 선택하지 않으면 매시간 실행됩니다</p>
            )}
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className={`px-5 py-3 border-t flex gap-2 ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <button onClick={onClose}
            className={`flex-1 px-4 py-2.5 text-[12px] font-bold rounded-lg transition ${dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            취소
          </button>
          <button onClick={() => onSave(enabled, Array.from(selected).sort())}
            className="flex-1 px-4 py-2.5 text-[12px] font-bold rounded-lg bg-[#03c75a] text-white hover:bg-[#02b350] transition">
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 피벗 테이블 모달 (상품 클릭 → 키워드×날짜 매트릭스) ──
function PivotModal({ group, dark, onClose }: {
  group: RankGroup;
  dark: boolean;
  onClose: () => void;
}) {
  const [pivotDays, setPivotDays] = useState(30);
  const [pivotData, setPivotData] = useState<RankPivotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [transposed, setTransposed] = useState(false); // false=가로:키워드 세로:날짜, true=가로:날짜 세로:키워드

  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';
  const stickyBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const stickyHeadBg = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';

  useEffect(() => {
    setLoading(true);
    naverApi.getRankPivot(group.group_key, pivotDays)
      .then(setPivotData)
      .catch(() => setPivotData(null))
      .finally(() => setLoading(false));
  }, [group.group_key, pivotDays]);

  // 변동 계산: 키워드의 dateIdx에서 이전 날짜 대비
  const getChange = (kw: string, dateIdx: number): number | null => {
    if (!pivotData) return null;
    const dates = pivotData.dates;
    const kwData = pivotData.data[kw];
    if (!kwData) return null;
    const current = kwData[dates[dateIdx]];
    const prev = dateIdx + 1 < dates.length ? kwData[dates[dateIdx + 1]] : null;
    if (current == null || prev == null) return null;
    return prev - current;
  };

  const renderCell = (rank: number | null | undefined, change: number | null) => (
    rank != null ? (
      <div className="flex items-center justify-center gap-1">
        <span className={`font-extrabold ${rank <= 10 ? 'text-[#03c75a]' : txt}`}>{rank}</span>
        {change !== null && change !== 0 && (
          <span className={`text-[10px] font-bold ${change > 0 ? 'text-red-500' : 'text-blue-500'}`}>
            {change > 0 ? `↑${change}` : `↓${Math.abs(change)}`}
          </span>
        )}
      </div>
    ) : (
      <span className={txtMuted}>-</span>
    )
  );

  // 모달 너비 동적 계산
  const colCount = pivotData ? (transposed ? pivotData.dates.length : pivotData.keywords.length) : 3;
  const modalMaxW = Math.max(600, Math.min(1600, colCount * 130 + 200));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${card} border rounded-xl shadow-2xl w-full max-w-[95vw] max-h-[85vh] mx-4 flex flex-col`}
        style={{ maxWidth: modalMaxW }}
        onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className={`flex items-center justify-between px-5 py-3 border-b shrink-0 ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <div>
            <h3 className={`text-[14px] font-extrabold ${txt}`}>
              {group.display_name} <span className={txtSub}>— 순위변동 내역</span>
            </h3>
            <span className={`text-[11px] ${txtSub}`}>
              {group.target_type === 'store' ? '스토어' : '상품ID'} · {group.keyword_count}개 키워드
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* 가로세로 전환 버튼 */}
            <button onClick={() => setTransposed(v => !v)}
              className={`px-3 py-1 rounded-lg text-[11px] font-bold transition flex items-center gap-1 ${
                dark ? 'bg-[#2a2a40] text-gray-300 hover:text-white hover:bg-[#333]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              title="가로/세로 전환"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z"/></svg>
              {transposed ? '키워드→가로' : '날짜→가로'}
            </button>
            <div className="w-px h-5 bg-gray-300 dark:bg-gray-600" />
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setPivotDays(d)}
                className={`px-3 py-1 rounded-lg text-[11px] font-bold transition ${
                  pivotDays === d
                    ? 'bg-[#03c75a] text-white shadow-md shadow-[#03c75a]/20'
                    : (dark ? 'bg-[#2a2a40] text-gray-400 hover:text-white hover:bg-[#333]' : 'bg-gray-100 text-gray-500 hover:bg-gray-200')
                }`}>
                {d}일
              </button>
            ))}
            <button className="ml-2 text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
          </div>
        </div>

        {/* 피벗 테이블 */}
        <div className="overflow-auto flex-1">
          {loading ? (
            <div className={`flex items-center justify-center py-20 ${txtMuted}`}>
              <div className="w-5 h-5 border-2 border-[#03c75a] border-t-transparent rounded-full animate-spin mr-2" />
              로딩중...
            </div>
          ) : !pivotData || pivotData.dates.length === 0 ? (
            <div className={`text-center py-20 ${txtMuted}`}>데이터가 없습니다</div>
          ) : !transposed ? (
            /* 기본: 가로=키워드, 세로=날짜 */
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr className={tHead}>
                  <th className={`px-4 py-2.5 text-left font-bold sticky left-0 z-20 ${txtSub} ${stickyHeadBg}`}>
                    날짜
                  </th>
                  {pivotData.keywords.map(kw => (
                    <th key={kw} className={`px-4 py-2.5 text-center font-bold ${txtSub} min-w-[120px]`}>{kw}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pivotData.dates.map((date, di) => (
                  <tr key={date} className={`border-t transition-colors ${tRow}`}>
                    <td className={`px-4 py-2 font-medium whitespace-nowrap sticky left-0 ${stickyBg} ${txtMuted} text-[11px]`}>
                      {date}
                    </td>
                    {pivotData.keywords.map(kw => {
                      const rank = pivotData.data[kw]?.[date];
                      const change = getChange(kw, di);
                      return <td key={kw} className="px-4 py-2 text-center">{renderCell(rank, change)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            /* 전환: 가로=날짜, 세로=키워드 */
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr className={tHead}>
                  <th className={`px-4 py-2.5 text-left font-bold sticky left-0 z-20 ${txtSub} ${stickyHeadBg} min-w-[130px]`}>
                    키워드
                  </th>
                  {pivotData.dates.map(date => (
                    <th key={date} className={`px-3 py-2.5 text-center font-bold ${txtSub} min-w-[90px] whitespace-nowrap text-[10px]`}>{date}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pivotData.keywords.map(kw => (
                  <tr key={kw} className={`border-t transition-colors ${tRow}`}>
                    <td className={`px-4 py-2 font-bold whitespace-nowrap sticky left-0 ${stickyBg} ${txt}`}>
                      {kw}
                    </td>
                    {pivotData.dates.map((date, di) => {
                      const rank = pivotData.data[kw]?.[date];
                      const change = getChange(kw, di);
                      return <td key={date} className="px-3 py-2 text-center">{renderCell(rank, change)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 키워드 클릭 → 날짜별 히스토리 모달 ──
function RankHistoryModal({ targetId, keyword, displayName, dark, onClose }: {
  targetId: number;
  keyword: string;
  displayName: string;
  dark: boolean;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<RankHistory[]>([]);
  const [loading, setLoading] = useState(true);

  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';
  const chartGrid = dark ? '#2a2a40' : '#e5e7eb';
  const chartTick = dark ? '#888' : '#6b7280';
  const tooltipBg = dark ? '#1c1c2e' : '#ffffff';
  const tooltipBorder = dark ? '#2a2a40' : '#e5e7eb';

  useEffect(() => {
    setLoading(true);
    naverApi.getRankHistory(targetId, 90)
      .then(data => setHistory(Array.isArray(data) ? data : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [targetId]);

  const sorted = [...history].filter(h => h && h.tracked_at).sort((a, b) => b.tracked_at.localeCompare(a.tracked_at));
  const chartData = [...history]
    .filter(h => h && h.tracked_at)
    .sort((a, b) => a.tracked_at.localeCompare(b.tracked_at))
    .map(h => ({
      date: h.tracked_at.slice(5, 16).replace('T', ' '),
      rank: h.rank_position,
    }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${card} border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className={`flex items-center justify-between px-5 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} shrink-0`}>
          <div>
            <h3 className={`text-[14px] font-extrabold ${txt}`}>
              {keyword} <span className="text-[#03c75a]">— {displayName}</span>
            </h3>
            <span className={`text-[11px] ${txtSub}`}>총 {sorted.length}건 이력</span>
          </div>
          <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className={`flex items-center justify-center py-20 ${txtMuted}`}>
              <div className="w-5 h-5 border-2 border-[#03c75a] border-t-transparent rounded-full animate-spin mr-2" />
              로딩중...
            </div>
          ) : (
            <>
              {chartData.length > 1 && (
                <div className="px-5 pt-4 pb-2">
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} />
                      <XAxis dataKey="date" tick={{ fill: chartTick, fontSize: 10 }} />
                      <YAxis reversed tick={{ fill: chartTick, fontSize: 10 }} domain={[1, 'auto']} />
                      <Tooltip
                        contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, fontSize: 11, borderRadius: 8 }}
                        formatter={(val: any) => val != null ? [`${val}위`, '순위'] : ['미발견', '순위']}
                      />
                      <Line dataKey="rank" stroke="#03c75a" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className={tHead}>
                      <th className={`px-4 py-2.5 text-left font-bold ${txtSub}`}>날짜시간</th>
                      <th className={`px-4 py-2.5 text-right font-bold ${txtSub}`}>순위</th>
                      <th className={`px-4 py-2.5 text-right font-bold ${txtSub}`}>변동</th>
                      <th className={`px-4 py-2.5 text-left font-bold ${txtSub}`}>상품명</th>
                      <th className={`px-4 py-2.5 text-right font-bold ${txtSub}`}>가격</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((h, i) => {
                      const prev = sorted[i + 1];
                      const change = (h.rank_position !== null && prev?.rank_position !== null)
                        ? (prev.rank_position! - h.rank_position!) : null;
                      return (
                        <tr key={h.id} className={`border-t transition-colors ${tRow}`}>
                          <td className={`px-4 py-2 ${txtMuted} text-[11px]`}>{new Date(h.tracked_at).toLocaleString('ko-KR')}</td>
                          <td className={`px-4 py-2 text-right font-extrabold ${
                            h.rank_position === null ? 'text-red-400' : h.rank_position <= 10 ? 'text-[#03c75a]' : txt
                          }`}>
                            {h.rank_position !== null ? `${h.rank_position}위` : '미발견'}
                          </td>
                          <td className={`px-4 py-2 text-right font-bold ${
                            change === null ? txtMuted : change > 0 ? 'text-red-500' : change < 0 ? 'text-blue-500' : txtMuted
                          }`}>
                            {change === null ? '' : change > 0 ? `↑${change}` : change < 0 ? `↓${Math.abs(change)}` : '-'}
                          </td>
                          <td className={`px-4 py-2 ${txtSub} max-w-[250px] truncate`}>{h.found_product_name || '-'}</td>
                          <td className={`px-4 py-2 text-right font-medium ${txt}`}>
                            {h.found_product_price ? `${h.found_product_price.toLocaleString()}원` : ''}
                          </td>
                        </tr>
                      );
                    })}
                    {sorted.length === 0 && (
                      <tr><td colSpan={5} className={`text-center py-12 ${txtMuted}`}>이력이 없습니다</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════
// 메인 페이지
// ══════════════════════════════════════════
export default function NaverRankPage() {
  const { dark } = useTheme();
  const [groups, setGroups] = useState<RankGroup[]>([]);
  const [history, setHistory] = useState<RankHistory[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  const [stores, setStores] = useState<SmartStore[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newTargetType, setNewTargetType] = useState('store');
  const [newTargetValue, setNewTargetValue] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  const [tracking, setTracking] = useState(false);
  const [trackResult, setTrackResult] = useState<{ tracked: number; results: any[] } | null>(null);
  const [showExtModal, setShowExtModal] = useState(false);

  // 그룹 펼치기/접기
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 피벗 모달
  const [pivotGroup, setPivotGroup] = useState<RankGroup | null>(null);
  // 키워드별 히스토리 모달
  const [historyTarget, setHistoryTarget] = useState<{ id: number; keyword: string; displayName: string } | null>(null);
  // 자동추적 설정 모달
  const [autoTrackGroup, setAutoTrackGroup] = useState<RankGroup | null>(null);

  // 예약작업
  const [schedules, setSchedules] = useState<any[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const [scheduleTracking, setScheduleTracking] = useState(false);
  const [trackingTargetId, setTrackingTargetId] = useState<number | null>(null);

  const gk = (g: RankGroup) => g.group_key;

  const toggleExpanded = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loadGroups = useCallback(async () => {
    try { setGroups(await naverApi.getRankGroupedSummary()); } catch (e) { console.error(e); }
  }, []);

  const loadHistory = useCallback(async () => {
    try { setHistory(await naverApi.getRankHistory(undefined, days)); } catch (e) { console.error(e); }
  }, [days]);

  const loadSchedules = useCallback(async () => {
    try { setSchedules(await naverApi.getSchedules()); } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { loadSchedules(); }, [loadSchedules]);
  useEffect(() => { fetchStores().then(setStores).catch(console.error); }, []);

  const handleAddTarget = async () => {
    if (!newKeyword || !newTargetValue) return;
    setLoading(true);
    await naverApi.addRankTarget({
      keyword: newKeyword, target_type: newTargetType,
      target_value: newTargetValue, display_name: newDisplayName,
    });
    setNewKeyword(''); setNewTargetValue(''); setNewDisplayName('');
    await loadGroups();
    setLoading(false);
  };

  const handleDeleteGroup = async (g: RankGroup) => {
    if (!confirm(`"${g.display_name}" 그룹의 모든 키워드(${g.keyword_count}개)를 삭제하시겠습니까?`)) return;
    for (const kw of g.keywords) {
      await naverApi.deleteRankTarget(kw.target_id);
    }
    await loadGroups();
  };

  const handleStartTracking = async () => {
    if (tracking) return;
    setTracking(true);
    setTrackResult(null);
    try {
      const result = await naverApi.runRankTracking();
      setTrackResult(result);
      await loadGroups();
      await loadHistory();
    } catch (e) { console.error(e); } finally { setTracking(false); }
  };

  const handleExtSubmitted = async (addedIds: number[]) => {
    setShowExtModal(false);
    if (addedIds.length > 0) {
      setTracking(true);
      setTrackResult(null);
      try {
        const result = await naverApi.runRankTracking(addedIds);
        setTrackResult(result);
        await loadGroups();
        await loadHistory();
      } catch (e) { console.error(e); } finally { setTracking(false); }
    } else {
      await loadGroups();
    }
  };

  const handleAutoTrackSave = async (g: RankGroup, enabled: boolean, times: string[]) => {
    await naverApi.toggleRankAutoTrack(g.group_key, enabled, times);
    setGroups(prev => prev.map(gr =>
      gk(gr) === gk(g) ? { ...gr, auto_track: enabled, auto_track_times: times } : gr
    ));
    setAutoTrackGroup(null);
  };

  // 차트 데이터
  const allTargetIds = groups.flatMap(g => g.keywords.map(k => k.target_id));
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

  const targetColors = ['#03c75a', '#0078d7', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  const targetLabelMap: Record<number, string> = {};
  let colorIdx = 0;
  for (const g of groups) {
    for (const k of g.keywords) {
      targetLabelMap[k.target_id] = `${k.keyword} - ${g.display_name}`;
    }
  }

  // 스타일
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';
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
            <p className={`text-[12px] ${txtSub}`}>상품/스토어별 키워드 순위 변동 모니터링</p>
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
                placeholder="키워드 입력" onKeyDown={e => e.key === 'Enter' && handleAddTarget()} />
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
            <button onClick={handleStartTracking} disabled={tracking || groups.length === 0}
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
            <button onClick={() => setShowExtModal(true)}
              className={`px-5 py-2 text-[12px] font-bold rounded-lg transition shrink-0 ${dark ? 'bg-[#7c3aed] text-white hover:bg-[#6d28d9]' : 'bg-purple-500 text-white hover:bg-purple-600'}`}>
              타상품조회
            </button>
          </div>
        </div>

        {/* ══════════ 예약작업 ══════════ */}
        {schedules.length > 0 && (
          <div className={`rounded-xl border overflow-hidden mb-4 ${card}`}>
            {schedules.map((sch: any) => (
              <div key={sch.id}>
                {/* 예약작업 헤더 */}
                <div
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
                    dark ? 'hover:bg-[#222240]' : 'hover:bg-[#f8fafb]'
                  }`}
                  onClick={() => setScheduleOpen(v => !v)}
                >
                  <span className={`text-[13px] font-bold transition-transform ${scheduleOpen ? 'rotate-0' : '-rotate-90'} ${txtSub}`}>▼</span>
                  <span className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold ${
                    dark ? 'bg-orange-500/15 text-orange-400' : 'bg-orange-50 text-orange-600'
                  }`}>예약작업</span>
                  <span className={`text-[13px] font-extrabold ${txt}`}>{sch.name}</span>
                  <span className={`text-[11px] ${txtSub}`}>{sch.targets?.length || 0}개 상품</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    sch.is_active
                      ? (dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600')
                      : (dark ? 'bg-red-500/15 text-red-400' : 'bg-red-50 text-red-500')
                  }`}>{sch.is_active ? '활성' : '비활성'}</span>
                  <span className={`ml-auto text-[11px] ${txtSub}`}>
                    {sch.schedule_type === 'interval' ? `${sch.schedule_time}분 간격` : `매일 ${sch.schedule_time}`}
                  </span>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (scheduleTracking) return;
                      setScheduleTracking(true);
                      try {
                        const ids = sch.targets?.map((t: any) => t.id) || [];
                        await naverApi.runRankTracking(ids);
                        await loadSchedules();
                        await loadGroups();
                        await loadHistory();
                      } catch (err) { console.error(err); }
                      setScheduleTracking(false);
                    }}
                    disabled={scheduleTracking}
                    className="px-3 py-1.5 bg-[#03c75a] text-white text-[11px] font-bold rounded-lg hover:bg-[#02b350] transition disabled:opacity-50 flex items-center gap-1"
                  >
                    {scheduleTracking ? (
                      <><div className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> 추적중</>
                    ) : '순위추적'}
                  </button>
                </div>

                {/* 예약작업 상품 리스트 */}
                {scheduleOpen && sch.targets && (
                  <div className={`px-4 pb-3`}>
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className={`${tHead} text-[10px] font-bold`}>
                          <th className={`px-3 py-2 text-left ${txtSub}`}>#</th>
                          <th className={`px-3 py-2 text-left ${txtSub}`}>키워드</th>
                          <th className={`px-3 py-2 text-left ${txtSub}`}>스토어</th>
                          <th className={`px-3 py-2 text-left ${txtSub}`}>상품번호</th>
                          <th className={`px-3 py-2 text-center ${txtSub}`}>순위</th>
                          <th className={`px-3 py-2 text-center ${txtSub}`}>조회</th>
                          <th className={`px-3 py-2 text-right ${txtSub}`}>최근 추적</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sch.targets.map((t: any, idx: number) => (
                          <tr key={t.id} className={`border-t ${tRow}`}>
                            <td className={`px-3 py-2 ${txtSub}`}>{idx + 1}</td>
                            <td className={`px-3 py-2 font-bold ${txt}`}>{t.keyword}</td>
                            <td className={`px-3 py-2 ${txtSub}`}>{t.display_name}</td>
                            <td className={`px-3 py-2 font-mono text-[10px]`}>
                              {t.matched_product_id ? (
                                <a
                                  href={`https://smartstore.naver.com/main/products/${t.matched_product_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[#03c75a] hover:underline"
                                >{t.target_value}</a>
                              ) : (
                                <span className={txtMuted}>{t.target_value}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {t.rank ? (
                                <span className={`inline-block px-2 py-0.5 rounded-full font-bold ${
                                  t.rank <= 10 ? 'bg-[#03c75a]/15 text-[#03c75a]' :
                                  t.rank <= 50 ? (dark ? 'bg-blue-500/15 text-blue-400' : 'bg-blue-50 text-blue-600') :
                                  (dark ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500')
                                }`}>{t.rank}위</span>
                              ) : (
                                <span className={txtMuted}>-</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (trackingTargetId === t.id) return;
                                  setTrackingTargetId(t.id);
                                  try {
                                    await naverApi.runRankTracking([t.id]);
                                    await loadSchedules();
                                  } catch (err) { console.error(err); }
                                  setTrackingTargetId(null);
                                }}
                                disabled={trackingTargetId === t.id}
                                className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${
                                  trackingTargetId === t.id
                                    ? 'opacity-50 cursor-not-allowed'
                                    : dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333355]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {trackingTargetId === t.id ? '...' : '조회'}
                              </button>
                            </td>
                            <td className={`px-3 py-2 text-right ${txtMuted} text-[10px]`}>
                              {t.tracked_at ? new Date(t.tracked_at).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ══════════ 상품별 그룹 테이블 ══════════ */}
        <div className={`rounded-xl border overflow-hidden mb-4 ${card}`}>
          {groups.length === 0 ? (
            <div className={`text-center py-16 ${txtMuted}`}>
              <RankIcon size={40} />
              <p className="mt-3 text-[14px]">추적 대상을 추가하세요</p>
              <p className="text-[12px] mt-1">상단 입력란에 키워드와 스토어명/상품ID를 입력하거나 타상품조회 사용</p>
            </div>
          ) : (
            <div className="divide-y divide-transparent">
              {groups.map(g => {
                const key = gk(g);
                const isOpen = expanded.has(key);
                return (
                  <div key={key} className={dark ? 'border-b border-[#2a2a40] last:border-b-0' : 'border-b border-gray-100 last:border-b-0'}>
                    {/* 그룹 헤더 */}
                    <div
                      className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
                        dark ? 'hover:bg-[#222240]' : 'hover:bg-[#f8fafb]'
                      }`}
                      onClick={() => toggleExpanded(key)}
                    >
                      {/* 펼치기/접기 아이콘 */}
                      <span className={`text-[13px] font-bold transition-transform ${isOpen ? 'rotate-0' : '-rotate-90'} ${txtSub}`}>
                        ▼
                      </span>

                      {/* 대상명 (클릭 → 피벗 모달) */}
                      <button
                        className={`text-[13px] font-extrabold ${txt} hover:text-[#03c75a] transition`}
                        onClick={(e) => { e.stopPropagation(); setPivotGroup(g); }}
                        title="순위변동 피벗 보기"
                      >
                        {g.display_name}
                      </button>

                      {/* 유형 배지 */}
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        g.target_type === 'store'
                          ? (dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600')
                          : (dark ? 'bg-blue-500/15 text-blue-400' : 'bg-blue-50 text-blue-600')
                      }`}>
                        {g.target_type === 'store' ? '스토어' : '상품ID'}
                      </span>

                      {/* 키워드 수 */}
                      <span className={`text-[11px] ${txtSub}`}>{g.keyword_count}개 키워드</span>

                      {/* 수동 순위조회 버튼 */}
                      <button
                        className={`ml-auto px-3 py-1 rounded-lg text-[11px] font-bold transition ${
                          dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333355]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        } ${trackingTargetId !== null ? 'opacity-50 cursor-not-allowed' : ''}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (trackingTargetId !== null) return;
                          const ids = g.keywords.map((kw: RankGroupKeyword) => kw.target_id);
                          setTrackingTargetId(ids[0]);
                          try {
                            await naverApi.runRankTracking(ids);
                            await loadGroups();
                            await loadHistory();
                          } catch (err) { console.error(err); }
                          setTrackingTargetId(null);
                        }}
                        title="순위조회"
                      >
                        {trackingTargetId && g.keywords.some((kw: RankGroupKeyword) => kw.target_id === trackingTargetId) ? '조회중...' : '순위조회'}
                      </button>

                      {/* 자동추적 설정 버튼 */}
                      <button
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-bold transition ${
                          g.auto_track
                            ? 'bg-[#03c75a]/15 text-[#03c75a] hover:bg-[#03c75a]/25'
                            : (dark ? 'bg-[#2a2a40] text-gray-500 hover:text-gray-300' : 'bg-gray-100 text-gray-400 hover:text-gray-600')
                        }`}
                        onClick={(e) => { e.stopPropagation(); setAutoTrackGroup(g); }}
                        title="자동추적 설정"
                      >
                        <div className={`w-3 h-3 rounded-full border-2 transition ${
                          g.auto_track ? 'bg-[#03c75a] border-[#03c75a]' : (dark ? 'border-gray-600' : 'border-gray-300')
                        }`} />
                        자동추적
                        {g.auto_track && g.auto_track_times.length > 0 && (
                          <span className={`text-[9px] ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                            ({g.auto_track_times.map(t => t.slice(0,2) + '시').join(', ')})
                          </span>
                        )}
                      </button>

                      {/* 삭제 */}
                      <button
                        className={`w-7 h-7 rounded-full flex items-center justify-center transition shrink-0 ${
                          dark ? 'hover:bg-red-900/40 text-red-400' : 'hover:bg-red-50 text-red-400'
                        }`}
                        onClick={(e) => { e.stopPropagation(); handleDeleteGroup(g); }}
                        title="그룹 삭제"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                      </button>
                    </div>

                    {/* 키워드 목록 (펼침) */}
                    {isOpen && (
                      <div className={dark ? 'bg-[#151528]' : 'bg-[#fafbfc]'}>
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className={dark ? 'bg-[#1a2332]/60' : 'bg-[#f0f3f7]/60'}>
                              <th className={`px-6 py-2 text-left font-bold ${txtSub} w-8`}></th>
                              <th className={`px-4 py-2 text-left font-bold ${txtSub}`}>키워드</th>
                              <th className={`px-4 py-2 text-right font-bold ${txtSub}`}>현재순위</th>
                              <th className={`px-4 py-2 text-right font-bold ${txtSub}`}>변동</th>
                              <th className={`px-4 py-2 text-left font-bold ${txtSub}`}>마지막 추적</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.keywords.map((kw, ki) => (
                              <tr key={kw.target_id}
                                className={`border-t cursor-pointer transition-colors ${
                                  dark ? 'border-[#222240] hover:bg-[#1c1c3a]' : 'border-gray-100 hover:bg-[#f0f4f8]'
                                }`}
                                onClick={() => setHistoryTarget({
                                  id: kw.target_id,
                                  keyword: kw.keyword,
                                  displayName: g.display_name,
                                })}
                              >
                                <td className={`px-6 py-2 ${txtMuted} text-[10px]`}>
                                  {ki === g.keywords.length - 1 ? '└' : '├'}
                                </td>
                                <td className={`px-4 py-2 font-bold ${txt}`}>{kw.keyword}</td>
                                <td className={`px-4 py-2 text-right font-extrabold ${
                                  kw.current_rank === null ? 'text-red-400' : kw.current_rank <= 10 ? 'text-[#03c75a]' : txt
                                }`}>
                                  {kw.current_rank !== null ? `${kw.current_rank}위` : '미발견'}
                                </td>
                                <td className={`px-4 py-2 text-right font-bold ${
                                  kw.change === null || kw.change === 0 ? txtMuted
                                    : kw.change > 0 ? 'text-red-500' : 'text-blue-500'
                                }`}>
                                  {kw.change === null ? '' : kw.change > 0 ? `↑${kw.change}` : kw.change < 0 ? `↓${Math.abs(kw.change)}` : '-'}
                                </td>
                                <td className={`px-4 py-2 text-[11px] ${txtMuted}`}>
                                  {kw.tracked_at ? new Date(kw.tracked_at).toLocaleString('ko-KR') : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
                {allTargetIds.map((tid, i) => (
                  <Line key={tid}
                    dataKey={String(tid)}
                    name={targetLabelMap[tid] || String(tid)}
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
                  const label = targetLabelMap[h.target];
                  const parts = label?.split(' - ') || ['', ''];
                  return (
                    <tr key={h.id} className={`border-t transition-colors ${tRow}`}>
                      <td className={`px-3 py-2 ${txtMuted} text-[11px]`}>{new Date(h.tracked_at).toLocaleString('ko-KR')}</td>
                      <td className={`px-3 py-2 font-bold ${txt}`}>{parts[0]}</td>
                      <td className="px-3 py-2 text-[#03c75a] font-semibold">{parts[1] || ''}</td>
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

      {/* 타상품조회 모달 */}
      {showExtModal && (
        <ExternalRankModal dark={dark} onClose={() => setShowExtModal(false)} onSubmitted={handleExtSubmitted} />
      )}

      {/* 피벗 테이블 모달 */}
      {pivotGroup && (
        <PivotModal dark={dark} group={pivotGroup} onClose={() => setPivotGroup(null)} />
      )}

      {/* 키워드별 히스토리 모달 */}
      {historyTarget && (
        <RankHistoryModal
          dark={dark}
          targetId={historyTarget.id}
          keyword={historyTarget.keyword}
          displayName={historyTarget.displayName}
          onClose={() => setHistoryTarget(null)}
        />
      )}

      {/* 자동추적 설정 모달 */}
      {autoTrackGroup && (
        <AutoTrackModal
          dark={dark}
          group={autoTrackGroup}
          onSave={(enabled, times) => handleAutoTrackSave(autoTrackGroup, enabled, times)}
          onClose={() => setAutoTrackGroup(null)}
        />
      )}
    </div>
  );
}
