import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import { fetchWorkers, type WorkerStatus, type AggregateStatus } from '../api/workersApi';

const TASK_LABEL: Record<string, string> = {
  api_attr_crawl: 'API 크롤',
  attr_label_crawl: '라벨 크롤',
  register_auto_candidates: '자동등록',
  search_quality_crawl: '검색품질',
  category_schema_crawl: '카테고리 스키마',
};

const TASK_COLOR: Record<string, string> = {
  api_attr_crawl: '#03c75a',
  attr_label_crawl: '#0078d7',
  register_auto_candidates: '#f59e0b',
  search_quality_crawl: '#ec4899',
  category_schema_crawl: '#a855f7',
};

const GROUP_LABEL: Record<string, string> = {
  cluster: 'Cluster',
  vm: 'VM',
  main: 'Main',
};

function ageStr(s: number | null) {
  if (s === null || s === undefined) return '-';
  if (s < 60) return `${s}초전`;
  if (s < 3600) return `${Math.round(s / 60)}분전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간전`;
  return `${Math.round(s / 86400)}일전`;
}

export default function WorkersPage() {
  const { dark } = useTheme();
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [agg, setAgg] = useState<AggregateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const intervalRef = useRef<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchWorkers()
      .then(d => { setWorkers(d.workers); setAgg(d.aggregate); setLastRefresh(new Date()); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = window.setInterval(load, 15000);
    }
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [autoRefresh, load]);

  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  // 그룹별로 묶기
  const grouped: Record<string, WorkerStatus[]> = {};
  for (const w of workers) {
    const g = w.group || 'other';
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(w);
  }

  return (
    <div className={`min-h-[calc(100vh-42px)] ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'} p-6`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className={`text-xl font-bold ${text}`}>워커 대시보드</h1>
          <p className={`text-[12px] mt-0.5 ${textSub}`}>
            14대 워커의 SSH 점검 — 상태 / 작업 / 로그
            <span className="ml-3">마지막: {lastRefresh.toLocaleTimeString()}</span>
            {loading && <span className="ml-2 text-[#03c75a]">갱신 중...</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className={`flex items-center gap-1.5 text-[12px] ${textSub}`}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            15초 자동 갱신
          </label>
          <button onClick={load}
                  className={`px-3 py-1.5 rounded text-[12px] border ${dark?'border-[#2a2a40] hover:bg-[#252540] text-gray-300':'border-gray-300 hover:bg-gray-100 text-gray-600'}`}>
            새로고침
          </button>
        </div>
      </div>

      {agg && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <StatCard dark={dark} label="온라인" value={`${agg.online} / ${agg.total}`} sub={`offline ${agg.offline}`} accent="#03c75a" />
          <StatCard dark={dark} label="작업 중" value={`${agg.busy}`} sub={`idle ${agg.idle}`} accent="#f59e0b" />
          <StatCard dark={dark} label="총 task 프로세스" value={`${Object.values(agg.task_totals).reduce((s,v) => s+v, 0)}`}
                    sub={Object.entries(agg.task_totals).map(([k,v]) => `${TASK_LABEL[k]||k}:${v}`).join(' · ') || '-'} accent="#0078d7" />
          <div className={`rounded-lg border p-4 ${card}`}>
            <div className={`text-[12px] ${textSub} mb-2`}>작업 종류</div>
            <div className="flex flex-wrap gap-1">
              {Object.keys(TASK_LABEL).map(k => {
                const cnt = agg.task_totals[k] || 0;
                return (
                  <span key={k}
                        className={`text-[11px] px-2 py-0.5 rounded`}
                        style={{ background: cnt > 0 ? TASK_COLOR[k] : (dark ? '#252540' : '#f3f4f6'),
                                 color: cnt > 0 ? '#fff' : (dark ? '#9ca3af' : '#6b7280') }}>
                    {TASK_LABEL[k]} {cnt > 0 && `×${cnt}`}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {['cluster', 'vm', 'main', 'other'].map(g => {
          const list = grouped[g];
          if (!list || list.length === 0) return null;
          return (
            <div key={g} className={`rounded-lg border ${card}`}>
              <div className={`px-4 py-2 border-b ${border} font-bold text-[13px] ${text}`}>
                {GROUP_LABEL[g] || g} <span className={`text-[11px] font-normal ${textSub}`}>({list.length}대)</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 p-3">
                {list.map(w => <WorkerCard key={w.host} dark={dark} w={w} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ dark, label, value, sub, accent }:
  { dark: boolean; label: string; value: string; sub: string; accent: string }) {
  return (
    <div className={`rounded-lg border p-4 ${dark?'bg-[#1c1c2e] border-[#2a2a40]':'bg-white border-gray-200'}`}>
      <div className={`text-[12px] mb-1 ${dark?'text-gray-400':'text-gray-500'}`}>{label}</div>
      <div className="text-[22px] font-bold" style={{ color: accent }}>{value}</div>
      <div className={`text-[11px] mt-1 ${dark?'text-gray-500':'text-gray-400'}`}>{sub}</div>
    </div>
  );
}

function WorkerCard({ dark, w }: { dark: boolean; w: WorkerStatus }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const cardBg = dark ? 'bg-[#252540]' : 'bg-gray-50';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const busy = w.reachable && Object.keys(w.tasks || {}).length > 0;
  const statusColor = !w.reachable ? '#ef4444' : busy ? '#f59e0b' : '#03c75a';
  const statusText = !w.reachable ? 'OFFLINE' : busy ? 'BUSY' : 'IDLE';

  // load 색상 (높으면 빨강)
  const loadColor = w.load === null ? textSub
    : w.load > 2 ? 'text-red-400'
    : w.load > 1 ? 'text-orange-400'
    : w.load > 0.5 ? 'text-yellow-400'
    : 'text-[#03c75a]';

  return (
    <div className={`rounded border ${border} ${cardBg} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor }} />
          <span className={`font-bold text-[13px] ${text}`}>{w.host}</span>
          <span className={`text-[10px] ${textSub} font-mono`}>{w.ip}</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
              style={{ background: statusColor + '33', color: statusColor }}>
          {statusText}
        </span>
      </div>

      {!w.reachable ? (
        <div className={`text-[11px] ${textSub}`}>{w.error || 'unreachable'}</div>
      ) : (
        <>
          <div className="flex items-center gap-3 text-[11px] mb-2">
            <span className={textSub}>load:</span>
            <span className={`font-bold ${loadColor}`}>{w.load?.toFixed(2) ?? '?'}</span>
            {w.uptime && <span className={textSub}>· {w.uptime}</span>}
          </div>

          {Object.keys(w.tasks).length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {Object.entries(w.tasks).map(([k, v]) => (
                <span key={k}
                      className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
                      style={{ background: TASK_COLOR[k] || '#6b7280' }}>
                  {TASK_LABEL[k] || k} ×{v}
                </span>
              ))}
            </div>
          )}

          {w.last_log && (
            <div className={`text-[10px] ${textSub} font-mono truncate border-t ${border} pt-1.5 mt-1`}
                 title={w.last_log}>
              {ageStr(w.log_age_s)} · {w.last_log.slice(0, 80)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
