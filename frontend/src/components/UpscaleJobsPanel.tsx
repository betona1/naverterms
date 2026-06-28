/**
 * UpscaleJobsPanel — GPU 모니터 UI 그대로 (GpuMonitorModal 레이아웃/항목 복제, 10일 검증된 베스트 UI).
 *
 * 구성 (위→아래):
 *   1) 헤더 — 제목 + 워커 수 + 자동새로고침 + 저장위치(우측) + 가이드/새로고침
 *   2) 워커 칩 스트립 — 업스케일 워커 1대당 1칩 (busy_count, alive 색상)
 *   3) 진척바 + 폴더 풀/큐 — 풀에서 큐로 드래그하면 그 폴더로 작업 시작
 *   4) 배율 칩 줄 (📦 1.25 / 1.5 / 2 / 3 / 4 x) + 전체 시작
 *   5) 합계 한 줄 — 전체 처리량/시 + 활성 워커
 *   6) 작업 로그 — 펼침/접힘 (jobs, 에러 우선)
 *   7) 헬프 모달 — Windows 워커 자동설치 가이드 (그대로 유지)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchNaverFolders, fetchUpscaleWorkers, fetchUpscaleJobs,
  startUpscaleJob, fetchUpscaleProgress, controlUpscaleJob,
  fetchUpscaleStorageStats,
  type NaverProductFolder, type UpscaleWorker, type UpscaleStorage,
  type UpscaleJob, type UpscaleProgress, type UpscaleStorageStats,
} from '../api/naverProductApi';

const SCALE_OPTIONS = [1.25, 1.5, 2.0, 3.0, 4.0];

const ONE_LINE_CMD = '$ProgressPreference="SilentlyContinue"; Remove-Item $env:USERPROFILE\\install_all.ps1 -EA SilentlyContinue; iwr "http://192.168.219.100:8900/install_all.ps1" -O $env:USERPROFILE\\install_all.ps1; & $env:USERPROFILE\\install_all.ps1';
const RESUME_CMD = '$ProgressPreference="SilentlyContinue"; & $env:USERPROFILE\\install_all.ps1';

const JOB_STATUS_COLOR: Record<string, string> = {
  pending: 'text-gray-500',
  running: 'text-emerald-600 dark:text-emerald-400',
  paused:  'text-amber-600 dark:text-amber-400',
  done:    'text-emerald-700 dark:text-emerald-300',
  error:   'text-rose-600 dark:text-rose-400 font-bold',
};
const JOB_STATUS_LABEL: Record<string, string> = {
  pending: '대기', running: '실행중', paused: '일시정지', done: '완료', error: '에러',
};

export function UpscaleJobsPanel() {
  const [folders, setFolders] = useState<NaverProductFolder[]>([]);
  const [workers, setWorkers] = useState<UpscaleWorker[]>([]);
  const [storage, setStorage] = useState<UpscaleStorage | null>(null);
  const [jobs, setJobs] = useState<UpscaleJob[]>([]);
  const [progress, setProgress] = useState<Record<number, UpscaleProgress>>({});
  const [scale, setScale] = useState(1.5);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetched, setLastFetched] = useState('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [dragFid, setDragFid] = useState<number | null>(null);
  const [storageStats, setStorageStats] = useState<UpscaleStorageStats | null>(null);

  const intervalRef = useRef<number | null>(null);
  const progressIntervalRef = useRef<number | null>(null);

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const reload = useCallback(async () => {
    try {
      const [f, w, j, s] = await Promise.all([
        fetchNaverFolders(),
        fetchUpscaleWorkers(),
        fetchUpscaleJobs(100),
        fetchUpscaleStorageStats().catch(() => null),
      ]);
      setFolders(f.items.filter((x) => x.is_system !== 1));
      setWorkers(w.workers);
      setStorage(w.storage);
      setJobs(j.items);
      if (s) setStorageStats(s);
      setLastFetched(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, []);

  const reloadProgress = useCallback(async () => {
    const active = jobs.filter((j) => j.status === 'running' || j.status === 'pending' || j.status === 'paused');
    if (!active.length) return;
    const results = await Promise.all(
      active.map((j) => fetchUpscaleProgress(j.id).catch(() => null))
    );
    setProgress((prev) => {
      const next = { ...prev };
      results.forEach((p, i) => { if (p) next[active[i].id] = p; });
      return next;
    });
  }, [jobs]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = window.setInterval(reload, 10000);
    return () => { if (intervalRef.current) window.clearInterval(intervalRef.current); };
  }, [autoRefresh, reload]);

  useEffect(() => {
    if (!autoRefresh || jobs.length === 0) {
      if (progressIntervalRef.current) window.clearInterval(progressIntervalRef.current);
      return;
    }
    progressIntervalRef.current = window.setInterval(reloadProgress, 3000);
    reloadProgress();
    return () => { if (progressIntervalRef.current) window.clearInterval(progressIntervalRef.current); };
  }, [autoRefresh, jobs.length, reloadProgress]);

  async function startForFolder(folder_id: number | null) {
    setError(''); setBusy(folder_id == null ? 'all' : `f${folder_id}`);
    try {
      const r = await startUpscaleJob({ folder_id, scale });
      if (!r.ok) throw new Error(r.error || '시작 실패');
      await reload();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy('');
    }
  }

  async function jobAction(id: number, action: 'pause' | 'resume' | 'cancel') {
    setBusy(`${action}-${id}`);
    try { await controlUpscaleJob(id, action); await reload(); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(''); }
  }

  function fmtMin(min: number | null): string {
    if (min == null) return '—';
    if (min < 60) return `${min.toFixed(0)}분`;
    return `${Math.floor(min / 60)}시 ${Math.round(min % 60)}분`;
  }
  function fmtBytes(b: number): string {
    if (b < 1024) return `${b}B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }

  // 워커 칩 라벨 — 짧은 식별자. 이름이 짧으면 그대로, 아니면 IP 끝자리.
  function workerChipLabel(w: UpscaleWorker): string {
    if (w.name && w.name.length <= 6) return w.name;
    const m = w.endpoint.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    if (m) return m[4];
    const hp = w.endpoint.replace(/.*\/\//, '').split(':')[0];
    return hp.slice(0, 6);
  }

  const downWorkers = useMemo(() => workers.filter(w => !w.alive), [workers]);
  const activeWorkerCount = useMemo(() => workers.filter(w => w.busy_count > 0).length, [workers]);

  // 작업 큐 / 폴더 풀 분리 — 활성 작업의 folder_id 집합으로 풀 차감
  // 정렬: job id 오름차순 = dispatcher 실제 처리 순서 (위에서부터 처리됨)
  const activeJobs = useMemo(
    () => jobs
      .filter(j => j.status === 'running' || j.status === 'paused' || j.status === 'pending')
      .sort((a, b) => a.id - b.id),
    [jobs]
  );
  const activeFolderIds = useMemo(
    () => new Set(activeJobs.map(j => j.folder_id).filter((x): x is number => x != null)),
    [activeJobs]
  );
  const poolFolders = useMemo(() => folders.filter(f => !activeFolderIds.has(f.id)), [folders, activeFolderIds]);

  // 전체 진척 = 활성 작업들의 progress 합산 (없으면 job 자체 값으로 fallback)
  const overall = useMemo(() => {
    let total = 0, done = 0, errors = 0, bytes = 0, ratePerMin = 0;
    let etaSum = 0, etaCount = 0;
    activeJobs.forEach(j => {
      const p = progress[j.id];
      if (p) {
        total += p.total; done += p.done; errors += p.error;
        bytes += p.bytes_total; ratePerMin += p.rate_per_min;
        if (p.eta_min != null) { etaSum += p.eta_min; etaCount += 1; }
      } else {
        total += j.total_targets; done += j.done_count; errors += j.error_count;
        bytes += j.bytes_total;
      }
    });
    const pct = total > 0 ? (done / total) * 100 : 0;
    const remaining = total - done - errors;
    // ETA: 활성 합계 처리량 우선, 없으면 작업별 ETA 평균
    const etaMin = ratePerMin > 0 ? remaining / ratePerMin : (etaCount > 0 ? etaSum / etaCount : null);
    return { total, done, errors, bytes, ratePerMin, etaMin, pct };
  }, [activeJobs, progress]);

  const totalRatePerHour = Math.round(overall.ratePerMin * 60);
  const avgRatePerHour = workers.length ? Math.round(totalRatePerHour / workers.length) : 0;

  // 로그 — 가장 최근, 가장 최근 에러
  const latestJob = jobs[0];
  const latestErrorJob = useMemo(() => jobs.find(j => j.status === 'error' || !!j.last_error) || null, [jobs]);

  function folderName(fid: number | null): string {
    if (fid == null) return '전체 (미분류 제외)';
    return folders.find(f => f.id === fid)?.name || `폴더 #${fid}`;
  }

  function onFolderDragStart(e: React.DragEvent, folder: NaverProductFolder) {
    e.dataTransfer.setData('application/x-folder-id', String(folder.id));
    e.dataTransfer.setData('text/plain', folder.name);
    e.dataTransfer.effectAllowed = 'copy';
    setDragFid(folder.id);
  }
  function onFolderDragEnd() {
    setDragFid(null);
    setDragOver(false);
  }
  async function onQueueDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const fid = e.dataTransfer.getData('application/x-folder-id');
    setDragFid(null);
    if (!fid) return;
    await startForFolder(Number(fid));
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-white dark:bg-gray-900">

      {/* === 1) 헤더 === */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0 gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-300">🎨 AI 이미지 업스케일</h3>
          <span className="text-[11px] text-gray-500">총 {workers.length}대</span>
          {downWorkers.length > 0 && (
            <span title={`응답없음 ${downWorkers.length}대: ${downWorkers.map(w => w.name).join(', ')}`}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold animate-pulse">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-white" />
              {downWorkers.length}
            </span>
          )}
          <label className="inline-flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="w-3 h-3 accent-emerald-600" />
            자동 새로고침 (3초)
          </label>
          {lastFetched && <span className="text-[10px] text-gray-400">last: {lastFetched}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {storage && (
            <span title={`${storage.host} · ${storage.path}${storageStats ? `\n총 ${storageStats.count.toLocaleString()}건 · 분당 +${storageStats.rate_per_min} (60s window)` : ''}`}
              className="hidden md:inline-flex items-center gap-1 text-[10px] text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded font-mono">
              💾 <b>{storage.host}</b>
              {storageStats && (
                <>
                  <span className="text-gray-400">|</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                    {storageStats.count.toLocaleString()}건
                  </span>
                  <span className={`font-bold ${storageStats.rate_per_min > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}`}>
                    +{storageStats.rate_per_min}/분
                  </span>
                </>
              )}
            </span>
          )}
          <button onClick={() => setHelpOpen(true)}
            className="px-2 py-1 text-[11px] rounded bg-sky-600 hover:bg-sky-700 text-white font-bold"
            title="Windows PC 자동설치 가이드">📖 가이드</button>
          <button onClick={reload}
            className="px-2 py-1 text-[11px] rounded bg-violet-600 hover:bg-violet-700 text-white">새로고침</button>
        </div>
      </div>

      {/* === 2) 워커 칩 스트립 === */}
      {workers.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 flex items-center gap-2 shrink-0">
          <div className="flex-1 flex items-center justify-center gap-1 flex-wrap">
            {workers.map(w => {
              const bg =
                !w.alive         ? 'bg-rose-500 text-white animate-pulse' :
                w.busy_count > 0 ? 'bg-emerald-500 text-white' :
                                   'bg-gray-400 text-gray-900';
              return (
                <div key={w.endpoint} className="flex flex-col items-center gap-0.5">
                  <span className={`text-[10px] font-bold font-mono leading-none ${
                    w.busy_count > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-400'
                  }`}>
                    {w.busy_count}
                  </span>
                  <span
                    title={`${w.name} · ${w.endpoint}\n동시처리 ${w.busy_count}/${w.concurrency} · GPU 여유 ${w.gpu_free_mb}MB`}
                    className={`relative inline-flex items-center justify-center min-w-[44px] px-2 py-1 rounded-md text-[11px] font-bold font-mono shadow-sm transition-all ${bg}`}
                  >
                    {workerChipLabel(w)}
                    {w.busy_count > 0 && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-300 border border-white animate-pulse" title="처리중" />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 shrink-0 border-l border-gray-300 dark:border-gray-600 pl-2">
            <span className="text-[11px] text-gray-600 dark:text-gray-300 whitespace-nowrap">
              처리중 <span className="font-bold text-emerald-700 dark:text-emerald-300">{activeWorkerCount}</span>/{workers.length}
            </span>
          </div>
        </div>
      )}

      {/* === 3) 진척바 + 폴더 풀/큐 === */}
      <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[12px] font-bold text-emerald-700 dark:text-emerald-300">
            📊 전체 업스케일 진척 — {overall.done.toLocaleString()} / {overall.total.toLocaleString()} ({overall.pct.toFixed(1)}%)
          </div>
          <div className="text-[11px] text-gray-600 dark:text-gray-300 flex items-center gap-2">
            {activeJobs.length === 0 ? (
              <span className="text-gray-400">대기 중 — 폴더를 큐에 드래그</span>
            ) : (
              <>
                <span className="font-bold text-emerald-700 dark:text-emerald-400">
                  {overall.ratePerMin.toFixed(1)}/분
                </span>
                <span className="text-gray-500">({totalRatePerHour.toLocaleString()}/시)</span>
                <span className="text-gray-500">{fmtBytes(overall.bytes)}</span>
                {overall.errors > 0 && <span className="text-rose-500">실패 {overall.errors}</span>}
                {overall.etaMin !== null && <span className="font-bold">ETA {fmtMin(overall.etaMin)}</span>}
              </>
            )}
          </div>
        </div>
        <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all"
            style={{ width: `${overall.pct}%` }} />
        </div>

        {/* ===== 폴더 풀 ===== */}
        <div className="mb-2 rounded border-2 border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-gray-800/40">
          <div className="px-2 py-1 text-[11px] font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
            📋 폴더 풀 ({poolFolders.length}) <span className="text-[10px] font-normal text-gray-500">— 아래 큐로 드래그해 작업 시작 (배율 {scale}x)</span>
          </div>
          <div className="p-1.5 flex flex-wrap gap-1">
            {poolFolders.map(f => (
              <span
                key={f.id}
                draggable
                onDragStart={(e) => onFolderDragStart(e, f)}
                onDragEnd={onFolderDragEnd}
                className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border bg-white dark:bg-gray-700 select-none cursor-grab active:cursor-grabbing transition-all ${
                  dragFid === f.id ? 'opacity-40' : 'border-gray-300 dark:border-gray-600 hover:border-emerald-400'
                }`}
                title={`${f.name} · 상품 ${(f.product_count || 0).toLocaleString()}개 · 드래그해 작업 시작`}
              >
                <span className="font-bold">{f.name}</span>
                <span className="text-[10px] text-gray-400 font-mono">{(f.product_count || 0).toLocaleString()}</span>
              </span>
            ))}
            {poolFolders.length === 0 && (
              <span className="text-[10px] text-gray-400 px-1">(모든 폴더가 작업 중)</span>
            )}
          </div>
        </div>

        {/* ===== 작업 큐 ===== */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={onQueueDrop}
          className={`rounded border-2 transition-all flex-1 min-h-0 flex flex-col overflow-hidden ${
            dragOver
              ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-900/30'
              : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20'
          }`}
        >
          <div className="px-2 py-1 text-[11px] font-bold text-emerald-800 dark:text-emerald-200 border-b border-emerald-200 dark:border-emerald-800 flex items-center gap-2 shrink-0">
            🎯 작업 큐 ({activeJobs.length}) <span className="text-[10px] font-normal text-emerald-700/70 dark:text-emerald-300/70">— 위 풀에서 드래그로 추가 · ⏸/▶ 일시정지/재개 · ✕ 취소</span>
          </div>
          <div className="p-1.5 flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
            {activeJobs.length === 0 && (
              <div className="py-4 text-center text-[11px] text-gray-400">
                큐가 비어있습니다. 위 풀에서 폴더를 드래그해 시작하세요.
              </div>
            )}
            {activeJobs.map((job, idx) => {
              const p = progress[job.id];
              const pct = p?.pct ?? (job.total_targets > 0 ? (job.done_count / job.total_targets) * 100 : 0);
              const done = p?.done ?? job.done_count;
              const total = p?.total ?? job.total_targets;
              const remaining = (total - done - (p?.error ?? job.error_count));
              return (
                <div
                  key={job.id}
                  className="flex items-center gap-2 px-2 py-1 rounded border bg-white dark:bg-gray-700 border-emerald-300 dark:border-emerald-600"
                >
                  <span className="w-6 text-center text-[11px] font-mono font-bold text-emerald-700 dark:text-emerald-300 shrink-0">{idx + 1}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                    job.status === 'running' ? 'bg-emerald-600 text-white' :
                    job.status === 'paused'  ? 'bg-amber-500 text-white' :
                                               'bg-gray-500 text-white'
                  }`}>
                    {JOB_STATUS_LABEL[job.status] || job.status}
                  </span>
                  <span className="text-[11px] font-bold min-w-[80px] max-w-[140px] truncate shrink-0">{folderName(job.folder_id)}</span>
                  <span className="text-[10px] text-violet-500 font-mono shrink-0">{job.scale}x</span>
                  <span className="text-[10px] text-gray-400 font-mono shrink-0">#{job.id}</span>
                  <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-600 rounded overflow-hidden">
                    <div className={`h-full transition-all ${
                      job.status === 'paused' ? 'bg-amber-400' :
                      pct > 10                ? 'bg-emerald-500' :
                      pct > 0                 ? 'bg-blue-400' : 'bg-gray-300 dark:bg-gray-500'
                    }`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-gray-600 dark:text-gray-300 shrink-0 w-28 text-right">
                    {done.toLocaleString()}/{total.toLocaleString()} ({pct.toFixed(1)}%)
                  </span>
                  <span className="text-[10px] text-gray-500 shrink-0 w-16 text-right">잔여 {remaining.toLocaleString()}</span>
                  {p && p.rate_per_min > 0 && (
                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0 w-14 text-right font-mono">{p.rate_per_min.toFixed(0)}/분</span>
                  )}
                  {job.status === 'running' && (
                    <button onClick={() => jobAction(job.id, 'pause')} disabled={!!busy}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-white shrink-0 disabled:opacity-40" title="일시정지">⏸</button>
                  )}
                  {job.status === 'paused' && (
                    <button onClick={() => jobAction(job.id, 'resume')} disabled={!!busy}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white shrink-0 disabled:opacity-40" title="재개">▶</button>
                  )}
                  <button
                    onClick={() => jobAction(job.id, 'cancel')}
                    disabled={!!busy}
                    className="text-rose-500 hover:text-rose-700 text-sm leading-none w-5 h-5 rounded hover:bg-rose-100 dark:hover:bg-rose-900/30 shrink-0 disabled:opacity-40"
                    title="취소"
                  >✕</button>
                </div>
              );
            })}
          </div>
          <div className="px-2 py-1 text-[10px] text-emerald-700/70 dark:text-emerald-300/70 border-t border-emerald-200 dark:border-emerald-800">
            드래그 = 새 작업 시작. 활성 작업은 즉시 워커에 분배됩니다 (우선순위 큐 없음).
          </div>
        </div>
      </div>

      {/* === 4) 배율 칩 줄 (📦 모델 위치) + 전체 시작 === */}
      <div className="px-5 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-2 flex-wrap shrink-0">
        <span className="text-[11px] font-bold text-gray-600 dark:text-gray-300">📦 배율 ({SCALE_OPTIONS.length}):</span>
        {SCALE_OPTIONS.map(s => (
          <button key={s} onClick={() => setScale(s)}
            className={`px-2 py-0.5 text-[10px] rounded font-mono transition-colors ${
              scale === s
                ? 'bg-violet-600 text-white'
                : 'bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 hover:bg-violet-200 dark:hover:bg-violet-900/60'
            }`}>
            {s}x
          </button>
        ))}
        <span className="text-[10px] text-gray-400 ml-1">선택: <b className="text-violet-700 dark:text-violet-300 font-mono">{scale}x</b> · 모델 SD 1.5</span>
        <button
          onClick={() => startForFolder(null)}
          disabled={!!busy}
          className="ml-auto px-3 py-1 text-[11px] rounded bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-700 hover:to-teal-600 text-white font-bold shadow disabled:opacity-40"
        >
          {busy === 'all' ? '⏳ 시작중...' : '▶ 전체 시작 (미분류 제외)'}
        </button>
      </div>

      {/* === 5) 합계 한 줄 === */}
      {workers.length > 0 && (
        <div className="px-5 py-2 border-b border-gray-200 dark:border-gray-700 bg-emerald-50 dark:bg-emerald-900/20 flex items-center gap-4 flex-wrap text-[12px] shrink-0">
          <span className="font-bold text-emerald-800 dark:text-emerald-200">
            🔥 전체 처리량 합계: <span className="text-base font-mono">{totalRatePerHour.toLocaleString()}</span>건/시
          </span>
          <span className="text-gray-600 dark:text-gray-300">
            ({workers.length}대 평균 <span className="font-mono">{avgRatePerHour}</span>건/시)
          </span>
          <span className="text-gray-600 dark:text-gray-300">
            · 처리중 <span className="font-bold text-emerald-700 dark:text-emerald-300">{activeWorkerCount}</span>/{workers.length}대
          </span>
          <span className="text-gray-600 dark:text-gray-300">
            · 활성 작업 <span className="font-bold text-emerald-700 dark:text-emerald-300">{activeJobs.length}</span>
          </span>
        </div>
      )}

      {/* === 6) 작업 로그 (펼침/접힘) === */}
      <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 shrink-0">
        <button onClick={() => setLogsExpanded(v => !v)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
            latestErrorJob && !logsExpanded
              ? 'bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30'
              : 'hover:bg-gray-100 dark:hover:bg-gray-700/30'
          }`}>
          <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200 shrink-0">
            📋 작업 로그 ({jobs.length})
          </span>
          {latestErrorJob && !logsExpanded && (
            <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold animate-pulse shrink-0">에러</span>
          )}
          {!logsExpanded && (latestErrorJob || latestJob) ? (() => {
            const j = latestErrorJob || latestJob;
            return (
              <span className="flex items-center gap-2 text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate flex-1 min-w-0">
                <span className="text-gray-400">{new Date(j.created_at).toLocaleTimeString()}</span>
                <span className={JOB_STATUS_COLOR[j.status] || 'text-gray-600'}>[{j.status}]</span>
                <span className="text-gray-500">#{j.id}</span>
                <span className="px-1.5 py-px rounded text-[10px] bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 whitespace-nowrap">{folderName(j.folder_id)}</span>
                <span className="text-violet-500">{j.scale}x</span>
                <span>{j.done_count}/{j.total_targets}</span>
                {j.last_error && <span className="text-rose-500 truncate">{j.last_error}</span>}
              </span>
            );
          })() : (
            <span className="flex-1" />
          )}
          <span className="text-gray-400 text-xs shrink-0">{logsExpanded ? '▲' : '▼'}</span>
        </button>

        {logsExpanded && (
          <div className="border-t border-gray-200 dark:border-gray-700">
            <div className="h-[32vh] overflow-y-auto p-2 space-y-0.5 font-mono text-[11px]">
              {jobs.length === 0 ? (
                <div className="text-center text-gray-400 py-8">아직 작업 없음</div>
              ) : jobs.map(j => (
                <div key={j.id} className="flex gap-2 px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700/30 rounded items-center">
                  <span className="text-gray-400 text-[10px] whitespace-nowrap">{new Date(j.created_at).toLocaleTimeString()}</span>
                  <span className={`whitespace-nowrap ${JOB_STATUS_COLOR[j.status] || 'text-gray-600'}`}>
                    [{j.status}]
                  </span>
                  <span className="text-gray-500 text-[10px]">#{j.id}</span>
                  <span className="px-1.5 py-px rounded text-[10px] bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 whitespace-nowrap">{folderName(j.folder_id)}</span>
                  <span className="text-blue-500 text-[10px]">{j.scale}x</span>
                  <span className="text-[10px]">{j.done_count}/{j.total_targets}</span>
                  {j.error_count > 0 && <span className="text-rose-500 text-[10px]">err {j.error_count}</span>}
                  <span className="text-gray-500 text-[10px]">{fmtBytes(j.bytes_total)}</span>
                  {j.last_error && (
                    <span className="text-rose-600 dark:text-rose-400 truncate" title={j.last_error}>
                      {j.last_error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 에러 알림 (있을 때만) */}
      {error && (
        <div className="bg-rose-500/10 border-t border-rose-500/40 text-rose-600 dark:text-rose-400 text-xs px-3 py-2 shrink-0 flex items-center justify-between">
          <span>⚠ {error}</span>
          <button onClick={() => setError('')} className="text-xs hover:text-rose-800">×</button>
        </div>
      )}

      {/* === 헬프 모달 (그대로 유지) === */}
      {helpOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4"
             onClick={() => setHelpOpen(false)}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-base font-bold text-gray-900 dark:text-white">📖 Windows 워커 추가 가이드</h3>
              <button onClick={() => setHelpOpen(false)} className="text-2xl text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">×</button>
            </div>

            <div className="p-5 space-y-4">
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/40">
                <div className="text-sm font-bold text-emerald-800 dark:text-emerald-300 mb-1">
                  ⚡ 한 줄 자동 설치 — OpenSSH + Python + Git + ComfyUI + SD 1.5 모델 일괄
                </div>
                <div className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                  각 윈도우 PC 에서 <b>PowerShell 관리자 권한</b>으로 실행. 약 15~25분 (다운로드 ~10GB).
                </div>
              </div>

              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-white mb-1.5">1️⃣ PowerShell 명령어 (한 줄)</div>
                <div className="relative bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-700 rounded-lg p-3 font-mono text-[11px] break-all">
                  <pre className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{ONE_LINE_CMD}</pre>
                  <button onClick={() => copyToClipboard(ONE_LINE_CMD)}
                          className={`absolute top-2 right-2 px-3 py-1.5 rounded text-xs font-bold ${
                            copied ? 'bg-emerald-500 text-white' : 'bg-violet-600 hover:bg-violet-700 text-white'
                          }`}>
                    {copied ? '✓ 복사됨!' : '📋 복사'}
                  </button>
                </div>
                <div className="text-[10px] text-gray-500 mt-1 leading-relaxed">
                  복사 후 PowerShell에서 <b>마우스 우클릭</b>으로 붙여넣기 → <b>Enter</b><br/>
                  <span className="text-emerald-500">↳ 다운 속도 100배 ↑ (ProgressPreference fix) · curl.exe 사용 · 한 방에</span>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-700/40">
                <div className="text-xs font-bold text-sky-800 dark:text-sky-300 mb-2">
                  🏠 외부(집/원격) PC 에서 설치하려면
                </div>
                <div className="text-[11px] text-gray-700 dark:text-gray-300 mb-2 leading-relaxed">
                  외부 PC는 사내 LAN (192.168.219.100) 에 접근 불가. <b>ps1 파일을 USB/이메일로 옮긴 후 실행</b>:
                </div>
                <a href="/install_all.ps1" download="install_all.ps1" target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-700 hover:to-blue-700 text-white text-sm font-bold shadow">
                  ⬇ install_all.ps1 다운로드
                </a>
                <div className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  1. 위 버튼으로 ps1 파일 다운로드 (현재 PC 에)<br/>
                  2. USB / 클라우드 (드롭박스/네이버MYBOX) / 이메일로 외부 PC 에 복사<br/>
                  3. 외부 PC PowerShell 관리자에서:
                </div>
                <div className="relative bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-700 rounded p-2 font-mono text-[10px] break-all mt-1.5">
                  <pre className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{'$ProgressPreference="SilentlyContinue"; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; & .\\install_all.ps1'}</pre>
                  <button onClick={() => copyToClipboard('$ProgressPreference="SilentlyContinue"; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; & .\\install_all.ps1')}
                          className={`absolute top-1.5 right-1.5 px-2 py-1 rounded text-[10px] font-bold ${copied ? 'bg-emerald-500 text-white' : 'bg-sky-600 hover:bg-sky-700 text-white'}`}>
                    {copied ? '✓' : '📋'}
                  </button>
                </div>
                <div className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                  외부 PC 가 사내 백엔드에 결과 보내려면: 사내 인프라(VPN/포트포워딩) 별도 필요. 현재는 외부 PC 가 처리한 결과는 218 서버 대신 그 PC 의 ComfyUI output 폴더에 임시 저장됨 — 추후 합류 가이드 별도.
                </div>
              </div>

              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
                <div className="text-xs font-bold text-amber-800 dark:text-amber-300 mb-1">
                  ⚠️ 이미 ps1 진행중인데 너무 느림? <span className="font-normal">(Invoke-WebRequest 가 한톨한톨 받는 중)</span>
                </div>
                <div className="text-[10px] text-gray-700 dark:text-gray-300 mb-2 leading-relaxed">
                  PowerShell 창에서 <b>Ctrl+C</b> → 새 PowerShell 관리자 → 아래 명령 (이미 받은 파일은 skip):
                </div>
                <div className="relative bg-gray-100 dark:bg-black/40 border border-gray-200 dark:border-gray-700 rounded p-2 font-mono text-[10px] break-all">
                  <pre className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{RESUME_CMD}</pre>
                  <button onClick={() => copyToClipboard(RESUME_CMD)}
                          className={`absolute top-1.5 right-1.5 px-2 py-1 rounded text-[10px] font-bold ${
                            copied ? 'bg-emerald-500 text-white' : 'bg-amber-600 hover:bg-amber-700 text-white'
                          }`}>
                    {copied ? '✓' : '📋 빠른재시작'}
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-white mb-1.5">2️⃣ 단계별 안내</div>
                <ol className="text-xs text-gray-700 dark:text-gray-300 space-y-1.5 list-decimal list-inside leading-relaxed pl-2">
                  <li><b>Win + X</b> → <b>"터미널 (관리자)"</b> 또는 <b>"Windows PowerShell (관리자)"</b> 클릭</li>
                  <li>UAC 창에서 <b>예</b> 클릭</li>
                  <li>위 명령어 <b>📋 복사</b> 버튼 클릭 → PowerShell 창에 마우스 우클릭 (또는 <b>Ctrl+V</b>) → <b>Enter</b></li>
                  <li>15~25분 대기 (PyTorch + 모델 다운로드)</li>
                  <li>완료되면 자동으로 ComfyUI 시작. <b>http://localhost:8188</b> 접근 가능</li>
                </ol>
              </div>

              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-white mb-1.5">3️⃣ 자동 처리되는 것들</div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px] text-gray-700 dark:text-gray-300">
                  <div>✅ OpenSSH 서버 + SSH 키 등록</div>
                  <div>✅ Python 3.12 (winget)</div>
                  <div>✅ Git (winget)</div>
                  <div>✅ ComfyUI clone</div>
                  <div>✅ PyTorch CUDA 12.1 (~2.5GB)</div>
                  <div>✅ DreamShaper 8 Inpaint (2GB)</div>
                  <div>✅ DreamShaper 8 Base (2GB)</div>
                  <div>✅ IP-Adapter Plus SD15</div>
                  <div>✅ CLIP-ViT-H (2.4GB)</div>
                  <div>✅ 방화벽 8188 / 22 열기</div>
                  <div>✅ 부팅 시 자동 시작</div>
                  <div>✅ 백그라운드 즉시 실행</div>
                </div>
              </div>

              <div className="p-2.5 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 text-[11px] text-gray-700 dark:text-gray-300">
                ⚠️ <b>요구사항:</b> Windows 10/11, NVIDIA GPU (RTX 30xx+ 권장), 인터넷 + 디스크 ~12GB 여유
              </div>

              <div className="p-2.5 rounded bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-700/40 text-[11px] text-gray-700 dark:text-gray-300">
                💡 <b>설치 끝나면</b>: 자동으로 100서버에서 SSH로 워커 감지 + dispatcher 에 추가 → 즉시 분산 합류. 재시작 불필요.
              </div>

              <div>
                <div className="text-xs font-bold text-gray-900 dark:text-white mb-1.5">📡 200서버 SMB 에 복사 (옵션)</div>
                <div className="text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed">
                  설치 ps1 을 사내 공유 폴더에 두면 여러 PC에서 더 빠르게 접근 가능:
                  <ol className="list-decimal list-inside mt-1 space-y-0.5">
                    <li>윈도우 탐색기 → <code className="px-1 bg-gray-200 dark:bg-black/30">\\192.168.219.200\betona\a</code> 이동</li>
                    <li><a href="/install_all.ps1" target="_blank" rel="noreferrer" className="text-violet-500 underline">install_all.ps1 다운로드</a> → 그 폴더에 복사</li>
                    <li>다른 PC 에서 <code className="px-1 bg-gray-200 dark:bg-black/30">\\192.168.219.200\betona\a\install_all.ps1</code> 마우스 우클릭 → "PowerShell로 실행"</li>
                  </ol>
                </div>
              </div>

              <div className="text-[10px] text-gray-500 text-center pt-3 border-t border-gray-200 dark:border-gray-700">
                직접 다운로드: <a href="/install_all.ps1" target="_blank" rel="noreferrer" className="text-violet-500 underline">install_all.ps1</a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
