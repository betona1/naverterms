import { useCallback, useEffect, useState } from 'react';
import {
  fetchGpuWorkers, fetchCrawlWorkers, fetchCrawlLogs,
  type GpuWorkerRow, type CrawlWorkerRow, type CrawlLogEntry,
} from '../api/workersUnifiedApi';

interface Props {
  onClose: () => void;
}

const POLL_MS = 5000;

export default function UnifiedWorkerModal({ onClose }: Props) {
  const [tab, setTab] = useState<'gpu' | 'crawl'>('gpu');
  const [gpus, setGpus] = useState<GpuWorkerRow[]>([]);
  const [crawls, setCrawls] = useState<CrawlWorkerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [logsMap, setLogsMap] = useState<Record<string, CrawlLogEntry[]>>({});
  const [logsLoading, setLogsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([fetchGpuWorkers(), fetchCrawlWorkers()]);
      setGpus(g.workers);
      setCrawls(c.workers);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const onExpand = async (key: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    setLogsLoading(true);
    try {
      const r = await fetchCrawlLogs(key, 50);
      setLogsMap(prev => ({ ...prev, [key]: r.logs }));
    } catch { /* ignore */ } finally {
      setLogsLoading(false);
    }
  };

  const totalGpu = gpus.length;
  const aliveGpu = gpus.filter(g => !g.stale && g.status === 'ok').length;
  const totalCrawl = crawls.length;
  const okCrawl = crawls.filter(c => c.effective_status === 'ok').length;
  const deadCrawl = crawls.filter(c => c.effective_status === 'dead').length;
  const totalNaverWorks = gpus.reduce((s, g) => s + g.naver_1h, 0);
  const totalElevenWorks = gpus.reduce((s, g) => s + g.eleven_1h, 0);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 py-4"
         onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-[96vw] max-w-6xl max-h-[92vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-emerald-600 to-sky-600 text-white rounded-t-xl">
          <div className="flex items-center gap-3">
            <span className="text-lg">🖥</span>
            <h2 className="text-sm font-bold">통합 워커 모니터링</h2>
            <span className="text-[11px] text-white/80">
              GPU <b>{aliveGpu}</b>/<b>{totalGpu}</b> · 크롤 <b>{okCrawl}</b>/<b>{totalCrawl}</b>
              {deadCrawl > 0 && <span className="text-rose-200 ml-1">(dead {deadCrawl})</span>}
              <span className="mx-2">·</span>
              네이버 <b>{totalNaverWorks}</b> / 11번가 <b>{totalElevenWorks}</b> (1h)
            </span>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white text-xl">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
          <button onClick={() => setTab('gpu')}
                  className={`px-5 py-2 text-xs font-bold border-b-2 transition-colors ${
                    tab === 'gpu'
                      ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                  }`}>
            🚀 GPU 워커 ({totalGpu})
          </button>
          <button onClick={() => setTab('crawl')}
                  className={`px-5 py-2 text-xs font-bold border-b-2 transition-colors ${
                    tab === 'crawl'
                      ? 'border-sky-500 text-sky-700 dark:text-sky-300'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                  }`}>
            🕷 일반 크롤링 워커 ({totalCrawl})
            {deadCrawl > 0 && (
              <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-rose-500 text-white">
                {deadCrawl}
              </span>
            )}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="text-center text-sm text-gray-400 py-10">로딩 중...</div>
          ) : tab === 'gpu' ? (
            <GpuGrid rows={gpus} />
          ) : (
            <CrawlList rows={crawls} expandedKey={expandedKey} onExpand={onExpand}
                       logsMap={logsMap} logsLoading={logsLoading} />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-2 text-[10px] text-gray-500 dark:text-gray-400 flex items-center justify-between">
          <span>자동 갱신 5초 · GPU heartbeat 30초 · 크롤 워커 heartbeat 변동적</span>
          <span>플랫폼: <span className="text-emerald-600 dark:text-emerald-400">●</span> 네이버 <span className="text-violet-600 dark:text-violet-400 ml-1">●</span> 11번가</span>
        </div>
      </div>
    </div>
  );
}


function GpuGrid({ rows }: { rows: GpuWorkerRow[] }) {
  if (rows.length === 0) return <div className="text-center text-sm text-gray-400 py-10">GPU 워커 없음</div>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
      {rows.map(g => {
        const mem = g.gpu_mem_total_mb ? Math.round((g.gpu_mem_used_mb || 0) / g.gpu_mem_total_mb * 100) : 0;
        const aliveCls = g.stale
          ? 'border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/30'
          : g.status === 'dead'
            ? 'border-rose-400 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20'
            : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/15';
        return (
          <div key={g.endpoint} className={`rounded-lg border p-2.5 ${aliveCls}`}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-2 h-2 rounded-full ${
                g.stale ? 'bg-gray-400' :
                g.status === 'dead' ? 'bg-rose-500 animate-pulse' :
                'bg-emerald-500 animate-pulse'
              }`} />
              <span className="font-bold text-[12px] text-gray-800 dark:text-gray-100 truncate">
                {g.worker_name || g.endpoint.split(':')[0]}
              </span>
              <span className="ml-auto text-[10px] font-mono text-gray-500">{g.endpoint}</span>
            </div>

            {g.gpu_name && (
              <div className="text-[10px] text-gray-500 mb-1 truncate" title={g.gpu_name}>
                {g.gpu_name}
              </div>
            )}

            {g.gpu_mem_total_mb && (
              <>
                <div className="flex items-center justify-between text-[10px] text-gray-600 dark:text-gray-300 mb-0.5">
                  <span>VRAM</span>
                  <span className="font-mono">
                    {g.gpu_mem_used_mb} / {g.gpu_mem_total_mb} MB ({mem}%) {g.gpu_util_pct != null && <span className="text-sky-600 dark:text-sky-300 ml-1">util {g.gpu_util_pct}%</span>}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                  <div className={`h-full ${mem > 85 ? 'bg-rose-500' : mem > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                       style={{ width: `${mem}%` }} />
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5 mt-2 text-[10px]">
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" title="네이버 처리 1h">
                네이버 <b>{g.naver_1h}</b>
              </span>
              <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-700 dark:text-violet-300" title="11번가 처리 1h">
                11번가 <b>{g.eleven_1h}</b>
              </span>
              {g.errors_1h > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-700 dark:text-rose-300">
                  err <b>{g.errors_1h}</b>
                </span>
              )}
              <span className="ml-auto text-gray-500 font-mono">
                {g.avg_ms_1h ? `${(g.avg_ms_1h / 1000).toFixed(1)}s` : '—'}
              </span>
            </div>

            {g.last_error && (
              <div className="mt-1.5 text-[10px] text-rose-600 dark:text-rose-400 truncate" title={g.last_error}>
                ⚠ {g.last_error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


function CrawlList({ rows, expandedKey, onExpand, logsMap, logsLoading }: {
  rows: CrawlWorkerRow[];
  expandedKey: string | null;
  onExpand: (k: string) => void;
  logsMap: Record<string, CrawlLogEntry[]>;
  logsLoading: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-center text-sm text-gray-400 py-10">
        등록된 크롤 워커 없음. <br />
        <span className="text-[11px]">워커가 WorkerLog 로 heartbeat 보내면 자동 등록됩니다.</span>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {rows.map(c => {
        const expanded = expandedKey === c.worker_key;
        const logs = logsMap[c.worker_key] || [];
        const cls = c.effective_status === 'dead'
          ? 'border-rose-400 dark:border-rose-700 bg-rose-50 dark:bg-rose-900/20'
          : c.effective_status === 'degraded'
            ? 'border-amber-400 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/20'
            : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/15';
        const dot = c.effective_status === 'dead'
          ? 'bg-rose-500 animate-pulse'
          : c.effective_status === 'degraded'
            ? 'bg-amber-500'
            : 'bg-emerald-500';
        const hbStr = c.hb_age_sec == null ? '—'
          : c.hb_age_sec < 60 ? `${c.hb_age_sec}s`
          : c.hb_age_sec < 3600 ? `${Math.floor(c.hb_age_sec / 60)}m`
          : `${Math.floor(c.hb_age_sec / 3600)}h`;
        return (
          <div key={c.worker_key} className={`rounded border ${cls}`}>
            <button onClick={() => onExpand(c.worker_key)}
                    className="w-full text-left px-3 py-2 flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full ${dot} shrink-0`} />
              <span className="font-bold text-[12px] text-gray-800 dark:text-gray-100 shrink-0">
                {c.worker_name || c.worker_key}
              </span>
              <span className="text-[10px] font-mono text-gray-500 shrink-0 hidden md:inline">
                {c.worker_key}
              </span>
              <span className="flex-1 text-[11px] text-gray-700 dark:text-gray-300 truncate">
                {c.last_log_line || <span className="italic text-gray-400">no recent log</span>}
              </span>
              <span className="text-[10px] text-gray-500 shrink-0 flex items-center gap-2">
                <span title="최근 heartbeat">{hbStr}</span>
                {c.errors_1h > 0 && (
                  <span className="text-rose-600 dark:text-rose-400">err {c.errors_1h}</span>
                )}
                <span>{expanded ? '▲' : '▼'}</span>
              </span>
            </button>
            {expanded && (
              <div className="border-t border-gray-200 dark:border-gray-700 bg-white/60 dark:bg-black/30 px-3 py-2">
                {logsLoading && logs.length === 0 ? (
                  <div className="text-[11px] text-gray-400">로그 로딩...</div>
                ) : logs.length === 0 ? (
                  <div className="text-[11px] text-gray-400">로그 없음</div>
                ) : (
                  <div className="font-mono text-[10px] max-h-64 overflow-y-auto space-y-0.5">
                    {logs.map(l => (
                      <div key={l.id} className="flex items-start gap-2">
                        <span className="text-gray-400 shrink-0">{l.created_at.replace('T', ' ').slice(5, 19)}</span>
                        <span className={`shrink-0 font-bold ${
                          l.level === 'ERROR' ? 'text-rose-600 dark:text-rose-400' :
                          l.level === 'WARN' ? 'text-amber-600 dark:text-amber-400' :
                          'text-emerald-600 dark:text-emerald-400'
                        }`}>{l.level.padEnd(5)}</span>
                        <span className="text-gray-800 dark:text-gray-200 break-all">{l.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
