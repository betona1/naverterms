import { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';

interface PurchaseSummary {
  id: number;
  nv_mid: string;
  product_name: string;
  store_name: string;
  image_url: string;
  category: string;
  source_keyword: string;
  source_rank: number | null;
  current_purchase_count: number | null;
  previous_purchase_count: number | null;
  purchase_delta: number | null;
  current_review_count: number | null;
  current_keep_count: number | null;
  current_price: number | null;
  last_tracked_at: string | null;
  auto_track: boolean;
  auto_track_time: string;
}

interface PurchaseHistory {
  id: number;
  target_id: number;
  target_name: string;
  target_nv_mid: string;
  purchase_count: number | null;
  review_count: number | null;
  keep_count: number | null;
  price: number | null;
  crawl_success: boolean;
  error_message: string;
  tracked_at: string;
}

const COLORS = ['#03c75a', '#0078d7', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#10b981', '#f97316', '#6366f1',
  '#14b8a6', '#d946ef', '#84cc16', '#fb923c', '#a855f7', '#22d3ee', '#f43e5e', '#4ade80', '#fbbf24', '#818cf8'];

function fmt(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString();
}

function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 이력 상세 모달 ──
function HistoryModal({ target, dark, onClose }: {
  target: PurchaseSummary;
  dark: boolean;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<PurchaseHistory[]>([]);
  const [days, setDays] = useState(30);
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-white';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';

  useEffect(() => {
    naverApi.getPurchaseHistory(target.id, days).then(setHistory);
  }, [target.id, days]);

  const chartData = [...history]
    .filter(h => h.crawl_success && h.purchase_count != null)
    .reverse()
    .map(h => ({ date: fmtDateShort(h.tracked_at), count: h.purchase_count }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${bg} rounded-xl border ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} w-[800px] max-h-[85vh] overflow-auto p-6`}
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className={`text-[16px] font-bold ${txt}`}>{target.product_name}</h3>
            <p className={`text-[12px] ${sub}`}>{target.store_name} | nvMid: {target.nv_mid}</p>
          </div>
          <button onClick={onClose} className={`text-[20px] px-2 ${sub} hover:text-red-400`}>&times;</button>
        </div>

        <div className="flex gap-2 mb-4">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-1 rounded text-[12px] font-bold ${days === d
                ? 'bg-[#03c75a] text-white'
                : dark ? 'bg-[#2a2a40] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
              {d}일
            </button>
          ))}
        </div>

        {chartData.length > 1 && (
          <div className={`rounded-lg border p-4 mb-4 ${card}`}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2a2a40' : '#e5e7eb'} />
                <XAxis dataKey="date" tick={{ fill: dark ? '#888' : '#666', fontSize: 11 }} />
                <YAxis tick={{ fill: dark ? '#888' : '#666', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: dark ? '#1c1c2e' : '#fff', border: `1px solid ${dark ? '#2a2a40' : '#e5e7eb'}`, borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="count" stroke="#03c75a" strokeWidth={2} dot={{ r: 3 }} name="구매수" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className={`rounded-lg border overflow-auto ${card}`}>
          <table className="w-full text-[12px]">
            <thead>
              <tr className={dark ? 'bg-[#15152a]' : 'bg-gray-50'}>
                <th className={`px-3 py-2 text-left font-semibold ${sub}`}>날짜</th>
                <th className={`px-3 py-2 text-right font-semibold ${sub}`}>구매수</th>
                <th className={`px-3 py-2 text-right font-semibold ${sub}`}>변동</th>
                <th className={`px-3 py-2 text-right font-semibold ${sub}`}>리뷰</th>
                <th className={`px-3 py-2 text-right font-semibold ${sub}`}>찜</th>
                <th className={`px-3 py-2 text-right font-semibold ${sub}`}>가격</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, idx) => {
                const prev = history[idx + 1];
                const delta = h.purchase_count != null && prev?.purchase_count != null
                  ? h.purchase_count - prev.purchase_count : null;
                return (
                  <tr key={h.id} className={`border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${dark ? 'hover:bg-[#22223a]' : 'hover:bg-gray-50'}`}>
                    <td className={`px-3 py-1.5 ${sub}`}>{fmtDate(h.tracked_at)}</td>
                    <td className={`px-3 py-1.5 text-right font-bold ${txt}`}>{fmt(h.purchase_count)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {delta != null && delta !== 0 && (
                        <span className={delta > 0 ? 'text-red-400' : 'text-blue-400'}>
                          {delta > 0 ? `+${fmt(delta)}` : fmt(delta)}
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.review_count)}</td>
                    <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.keep_count)}</td>
                    <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.price)}</td>
                  </tr>
                );
              })}
              {!history.length && (
                <tr><td colSpan={6} className={`px-3 py-8 text-center ${sub}`}>이력 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── 자동추적 설정 모달 ──
function AutoTrackModal({ target, dark, onClose, onSave }: {
  target: PurchaseSummary;
  dark: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const [enabled, setEnabled] = useState(target.auto_track);
  const [time, setTime] = useState(target.auto_track_time || '09:00');
  const [busy, setBusy] = useState(false);
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-white';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';

  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);

  const handleSave = async () => {
    setBusy(true);
    await naverApi.togglePurchaseAutoTrack(target.id, enabled, time);
    setBusy(false);
    onSave();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className={`${bg} rounded-xl border ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} w-[400px] p-6`}
           onClick={e => e.stopPropagation()}>
        <h3 className={`text-[15px] font-bold mb-4 ${txt}`}>자동추적 설정</h3>
        <p className={`text-[12px] ${sub} mb-4`}>{target.product_name}</p>

        <div className="flex items-center gap-3 mb-4">
          <span className={`text-[13px] ${txt}`}>자동추적</span>
          <button onClick={() => setEnabled(!enabled)}
            className={`w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-[#03c75a]' : dark ? 'bg-[#333]' : 'bg-gray-300'}`}>
            <div className={`w-4 h-4 rounded-full bg-white transform transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {enabled && (
          <div className="mb-4">
            <p className={`text-[12px] ${sub} mb-2`}>수집 시간 (매일)</p>
            <div className="grid grid-cols-6 gap-1">
              {hours.map(h => (
                <button key={h} onClick={() => setTime(h)}
                  className={`py-1 rounded text-[11px] font-bold ${time === h
                    ? 'bg-[#03c75a] text-white'
                    : dark ? 'bg-[#2a2a40] text-gray-400 hover:bg-[#333]' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className={`px-4 py-2 rounded text-[13px] ${dark ? 'bg-[#2a2a40] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
            취소
          </button>
          <button onClick={handleSave} disabled={busy}
            className="px-4 py-2 rounded text-[13px] font-bold bg-[#03c75a] text-white hover:bg-[#02a34a] disabled:opacity-50">
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════
// 메인 페이지
// ══════════════════════════════════════════

export default function PurchaseTrackingPage() {
  const { dark } = useTheme();
  const [summary, setSummary] = useState<PurchaseSummary[]>([]);
  const [history, setHistory] = useState<PurchaseHistory[]>([]);
  const [chartDays, setChartDays] = useState(30);
  const [tracking, setTracking] = useState(false);
  const [crawlerStatus, setCrawlerStatus] = useState<any>(null);
  const [historyTarget, setHistoryTarget] = useState<PurchaseSummary | null>(null);
  const [autoTrackTarget, setAutoTrackTarget] = useState<PurchaseSummary | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logSinceRef = useRef(0);
  const [extTracking, setExtTracking] = useState(false);
  const [extStatus, setExtStatus] = useState<any>(null);

  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';

  const loadData = useCallback(async () => {
    const [s, h] = await Promise.all([
      naverApi.getPurchaseSummary(),
      naverApi.getPurchaseHistory(undefined, chartDays),
    ]);
    setSummary(s);
    setHistory(h);
  }, [chartDays]);

  useEffect(() => { loadData(); }, [loadData]);

  // 폴링
  const startPoll = useCallback(() => {
    if (pollRef.current) return;
    logSinceRef.current = 0;
    pollRef.current = setInterval(async () => {
      const st = await naverApi.getPurchaseTrackStatus(logSinceRef.current);
      setCrawlerStatus(st);
      if (st.logs?.length) logSinceRef.current += st.logs.length;
      if (!st.running) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setTracking(false);
        loadData();
      }
    }, 1000);
  }, [loadData]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // 초기 상태 체크
  useEffect(() => {
    naverApi.getPurchaseTrackStatus().then(st => {
      if (st.running) {
        setTracking(true);
        setCrawlerStatus(st);
        startPoll();
      }
    });
  }, [startPoll]);

  const handleStart = async () => {
    if (!summary.length) return;
    setTracking(true);
    setCrawlerStatus(null);
    logSinceRef.current = 0;
    await naverApi.runPurchaseTracking();
    startPoll();
  };

  const handleStop = async () => {
    await naverApi.stopPurchaseTracking();
  };

  // 확장프로그램 구매수 수집
  const handleExtStart = () => {
    if (!summary.length) return;
    const targets = summary.map(s => ({
      id: s.id,
      nv_mid: s.nv_mid,
      product_name: s.product_name,
      store_name: s.store_name,
    }));
    window.postMessage({ type: 'PURCHASE_TRACK_START', targets }, '*');
    setExtTracking(true);
    setExtStatus(null);
  };

  const handleExtStop = () => {
    window.postMessage({ type: 'PURCHASE_TRACK_STOP' }, '*');
    setExtTracking(false);
  };

  // 확장프로그램 메시지 리스너
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || !d.type) return;
      if (d.type === 'NAVER_PURCHASE_TRACK_PROGRESS') {
        setExtStatus(d);
        setExtTracking(d.running);
      }
      if (d.type === 'NAVER_PURCHASE_TRACK_COMPLETE') {
        setExtTracking(false);
        loadData();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [loadData]);

  const handleDelete = async (id: number) => {
    if (!confirm('이 상품을 추적 목록에서 삭제합니까?')) return;
    await naverApi.deletePurchaseTarget(id);
    loadData();
  };

  // 차트 데이터
  const buildChartData = () => {
    const byDate: Record<string, Record<number, number | null>> = {};
    const filtered = history.filter(h => h.crawl_success && h.purchase_count != null);
    for (const h of filtered) {
      const dateKey = fmtDateShort(h.tracked_at);
      if (!byDate[dateKey]) byDate[dateKey] = {};
      if (!byDate[dateKey][h.target_id]) {
        byDate[dateKey][h.target_id] = h.purchase_count;
      }
    }
    const dates = Object.keys(byDate).sort((a, b) => {
      const [am, ad] = a.split('/').map(Number);
      const [bm, bd] = b.split('/').map(Number);
      return am * 100 + ad - (bm * 100 + bd);
    });
    return dates.map(d => ({ date: d, ...byDate[d] }));
  };

  const chartData = buildChartData();
  const targetIds = [...new Set(history.filter(h => h.crawl_success).map(h => h.target_id))];

  return (
    <div className={`min-h-screen ${bg} ${txt}`}>
      <div className="max-w-[1400px] mx-auto px-4 py-6">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-extrabold">구매수 추적</h1>
            <p className={`text-[12px] ${sub}`}>상품별 구매건수 변동 모니터링 (상세페이지 크롤링)</p>
          </div>
          <div className="flex gap-2">
            {extTracking ? (
              <button onClick={handleExtStop}
                className="px-5 py-2 rounded-lg text-[13px] font-bold bg-red-500 text-white hover:bg-red-600">
                확장 수집중지
              </button>
            ) : (
              <button onClick={handleExtStart} disabled={!summary.length || tracking}
                className="px-5 py-2 rounded-lg text-[13px] font-bold bg-[#0078d7] text-white hover:bg-[#006bc2] disabled:opacity-40">
                확장프로그램 수집
              </button>
            )}
            {tracking ? (
              <button onClick={handleStop}
                className="px-5 py-2 rounded-lg text-[13px] font-bold bg-red-500 text-white hover:bg-red-600">
                수집중지
              </button>
            ) : (
              <button onClick={handleStart} disabled={!summary.length || extTracking}
                className="px-5 py-2 rounded-lg text-[13px] font-bold bg-[#03c75a] text-white hover:bg-[#02a34a] disabled:opacity-40">
                서버 수집
              </button>
            )}
          </div>
        </div>

        {/* 확장프로그램 수집 상태 */}
        {extTracking && extStatus && (
          <div className={`rounded-xl border p-4 mb-4 ${card}`}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#0078d7] animate-pulse" />
              <span className={`text-[13px] font-bold ${txt}`}>
                확장프로그램 수집중 {extStatus.completed || 0}/{extStatus.total || 0}
              </span>
              {extStatus.current && (
                <span className={`text-[12px] ${sub}`}>— {extStatus.current}</span>
              )}
            </div>
            <div className={`h-1.5 rounded-full ${dark ? 'bg-[#2a2a40]' : 'bg-gray-200'} overflow-hidden`}>
              <div className="h-full bg-[#0078d7] rounded-full transition-all"
                   style={{ width: `${extStatus.total ? Math.round((extStatus.completed / extStatus.total) * 100) : 0}%` }} />
            </div>
            {extStatus.logs?.length > 0 && (
              <div className={`mt-3 rounded-lg p-3 text-[11px] font-mono max-h-[150px] overflow-auto ${dark ? 'bg-[#0a0a18] text-gray-400' : 'bg-gray-50 text-gray-600'}`}>
                {(extStatus.logs || []).slice(-20).map((l: any, i: number) => (
                  <div key={i} className={l.msg?.includes('✓') ? 'text-[#03c75a]' : l.msg?.includes('실패') || l.msg?.includes('✗') ? 'text-red-400' : ''}>
                    {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 크롤러 상태 */}
        {tracking && crawlerStatus && (
          <div className={`rounded-xl border p-4 mb-4 ${card}`}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#03c75a] animate-pulse" />
              <span className={`text-[13px] font-bold ${txt}`}>
                수집중 {crawlerStatus.completed || 0}/{crawlerStatus.total || 0}
              </span>
              {crawlerStatus.current && (
                <span className={`text-[12px] ${sub}`}>— {crawlerStatus.current}</span>
              )}
            </div>
            <div className={`h-1.5 rounded-full ${dark ? 'bg-[#2a2a40]' : 'bg-gray-200'} overflow-hidden`}>
              <div className="h-full bg-[#03c75a] rounded-full transition-all"
                   style={{ width: `${crawlerStatus.total ? Math.round((crawlerStatus.completed / crawlerStatus.total) * 100) : 0}%` }} />
            </div>
            {crawlerStatus.logs?.length > 0 && (
              <div className={`mt-3 rounded-lg p-3 text-[11px] font-mono max-h-[150px] overflow-auto ${dark ? 'bg-[#0a0a18] text-gray-400' : 'bg-gray-50 text-gray-600'}`}>
                {(crawlerStatus.logs || []).slice(-20).map((l: any, i: number) => (
                  <div key={i} className={l.msg?.includes('★') ? 'text-[#03c75a]' : l.msg?.includes('실패') ? 'text-red-400' : ''}>
                    {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 타겟 목록 */}
        <div className={`rounded-xl border mb-6 overflow-hidden ${card}`}>
          <div className={`px-4 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-100'}`}>
            <h2 className="text-[14px] font-bold">추적 대상 ({summary.length})</h2>
          </div>
          {summary.length === 0 ? (
            <div className={`py-12 text-center ${sub}`}>
              <p className="text-[14px] mb-1">추적 대상 없음</p>
              <p className="text-[12px]">Term 분석 상품 팝업에서 상품을 선택하여 등록하세요</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className={dark ? 'bg-[#15152a]' : 'bg-gray-50'}>
                    <th className={`px-3 py-2 text-left font-semibold ${sub}`}>이미지</th>
                    <th className={`px-3 py-2 text-left font-semibold ${sub}`}>상품명</th>
                    <th className={`px-3 py-2 text-left font-semibold ${sub}`}>스토어</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>구매수</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>변동</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>리뷰</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>찜</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>가격</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}>키워드</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}>순위</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}>자동</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}>최근수집</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}></th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map(s => (
                    <tr key={s.id} className={`border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${dark ? 'hover:bg-[#22223a]' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-2">
                        {s.image_url ? (
                          <img src={s.image_url} alt="" className="w-10 h-10 rounded object-cover border border-gray-700" />
                        ) : (
                          <div className={`w-10 h-10 rounded flex items-center justify-center text-[10px] ${dark ? 'bg-[#2a2a40] text-gray-500' : 'bg-gray-100 text-gray-400'}`}>N/A</div>
                        )}
                      </td>
                      <td className={`px-3 py-2 max-w-[250px] truncate font-medium cursor-pointer hover:text-[#03c75a] ${txt}`}
                          onClick={() => setHistoryTarget(s)}>
                        {s.product_name}
                      </td>
                      <td className={`px-3 py-2 max-w-[120px] truncate ${sub}`}>{s.store_name || '-'}</td>
                      <td className={`px-3 py-2 text-right font-bold text-[13px] ${s.current_purchase_count != null && s.current_purchase_count >= 1000 ? 'text-[#03c75a]' : txt}`}>
                        {fmt(s.current_purchase_count)}
                      </td>
                      <td className="px-3 py-2 text-right font-bold">
                        {s.purchase_delta != null && s.purchase_delta !== 0 && (
                          <span className={s.purchase_delta > 0 ? 'text-red-400' : 'text-blue-400'}>
                            {s.purchase_delta > 0 ? `+${fmt(s.purchase_delta)}` : fmt(s.purchase_delta)}
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right ${sub}`}>{fmt(s.current_review_count)}</td>
                      <td className={`px-3 py-2 text-right ${sub}`}>{fmt(s.current_keep_count)}</td>
                      <td className={`px-3 py-2 text-right ${sub}`}>{fmt(s.current_price)}</td>
                      <td className={`px-3 py-2 text-center text-[11px] ${sub}`}>{s.source_keyword || '-'}</td>
                      <td className={`px-3 py-2 text-center text-[11px] font-bold ${s.source_rank ? 'text-[#f59e0b]' : sub}`}>
                        {s.source_rank || '-'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button onClick={() => setAutoTrackTarget(s)}
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${s.auto_track
                            ? 'bg-[#03c75a]/20 text-[#03c75a]'
                            : dark ? 'bg-[#2a2a40] text-gray-500' : 'bg-gray-100 text-gray-400'}`}>
                          {s.auto_track ? s.auto_track_time : 'OFF'}
                        </button>
                      </td>
                      <td className={`px-3 py-2 text-center text-[10px] ${sub}`}>{fmtDate(s.last_tracked_at)}</td>
                      <td className="px-3 py-2 text-center">
                        <button onClick={() => handleDelete(s.id)}
                          className="text-red-400 hover:text-red-300 text-[14px] px-1">&times;</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 구매수 차트 */}
        {chartData.length > 1 && (
          <div className={`rounded-xl border p-5 mb-6 ${card}`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[14px] font-bold">구매수 추이</h2>
              <div className="flex gap-1">
                {[7, 30, 90].map(d => (
                  <button key={d} onClick={() => setChartDays(d)}
                    className={`px-3 py-1 rounded text-[11px] font-bold ${chartDays === d
                      ? 'bg-[#03c75a] text-white'
                      : dark ? 'bg-[#2a2a40] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
                    {d}일
                  </button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2a2a40' : '#e5e7eb'} />
                <XAxis dataKey="date" tick={{ fill: dark ? '#888' : '#666', fontSize: 11 }} />
                <YAxis tick={{ fill: dark ? '#888' : '#666', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: dark ? '#1c1c2e' : '#fff', border: `1px solid ${dark ? '#2a2a40' : '#e5e7eb'}`, borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {targetIds.map((tid, i) => {
                  const t = summary.find(s => s.id === tid);
                  return (
                    <Line key={tid} type="monotone" dataKey={String(tid)} stroke={COLORS[i % COLORS.length]}
                          strokeWidth={2} dot={{ r: 2 }} connectNulls
                          name={t ? t.product_name.slice(0, 20) : `#${tid}`} />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* 최근 이력 테이블 */}
        {history.length > 0 && (
          <div className={`rounded-xl border overflow-hidden ${card}`}>
            <div className={`px-4 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-100'}`}>
              <h2 className="text-[14px] font-bold">최근 이력</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className={dark ? 'bg-[#15152a]' : 'bg-gray-50'}>
                    <th className={`px-3 py-2 text-left font-semibold ${sub}`}>날짜</th>
                    <th className={`px-3 py-2 text-left font-semibold ${sub}`}>상품</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>구매수</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>리뷰</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>찜</th>
                    <th className={`px-3 py-2 text-right font-semibold ${sub}`}>가격</th>
                    <th className={`px-3 py-2 text-center font-semibold ${sub}`}>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 100).map(h => (
                    <tr key={h.id} className={`border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-100'} ${dark ? 'hover:bg-[#22223a]' : 'hover:bg-gray-50'}`}>
                      <td className={`px-3 py-1.5 ${sub}`}>{fmtDate(h.tracked_at)}</td>
                      <td className={`px-3 py-1.5 max-w-[200px] truncate ${txt}`}>{h.target_name}</td>
                      <td className={`px-3 py-1.5 text-right font-bold ${txt}`}>{fmt(h.purchase_count)}</td>
                      <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.review_count)}</td>
                      <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.keep_count)}</td>
                      <td className={`px-3 py-1.5 text-right ${sub}`}>{fmt(h.price)}</td>
                      <td className="px-3 py-1.5 text-center">
                        {h.crawl_success ? (
                          <span className="text-[#03c75a] text-[10px] font-bold">OK</span>
                        ) : (
                          <span className="text-red-400 text-[10px] font-bold">FAIL</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 모달 */}
      {historyTarget && <HistoryModal target={historyTarget} dark={dark} onClose={() => setHistoryTarget(null)} />}
      {autoTrackTarget && <AutoTrackModal target={autoTrackTarget} dark={dark} onClose={() => setAutoTrackTarget(null)} onSave={loadData} />}
    </div>
  );
}
