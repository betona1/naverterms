import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchGpuStatus, fetchGpuLogs, fetchBulkProgress, type GpuWorker, type GpuLog, type BulkProgress, type FolderProgress, type WorkerRateWindow } from '../api/gpuMonitorApi';
import { UpscaleJobsPanel } from './UpscaleJobsPanel';
import { ProductAttrPanel } from './ProductAttrPanel';

type TabKey = 'monitor' | 'upscale' | 'attrs';

interface Props {
  open: boolean;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  ok: '정상', degraded: '느려짐', dead: '응답없음', unknown: '미확인',
};

const EVENT_COLOR: Record<string, string> = {
  start:           'text-blue-500',
  complete:        'text-emerald-600 dark:text-emerald-400',
  error:           'text-rose-600 dark:text-rose-400 font-bold',
  model_fallback:  'text-amber-600 dark:text-amber-400',
  timeout:         'text-orange-600 dark:text-orange-400 font-bold',
  health_check:    'text-gray-500',
  recovered:       'text-emerald-700',
  dead:            'text-rose-700 font-bold',
};

export default function GpuMonitorModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('monitor');
  const [workers, setWorkers] = useState<GpuWorker[]>([]);
  const [logs, setLogs] = useState<GpuLog[]>([]);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetched, setLastFetched] = useState<string>('');
  const [tgReportEnabled, setTgReportEnabled] = useState<boolean>(false);
  const [tgToggling, setTgToggling] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  // 칩 스트립 — 윈도우별 처리량 표시 + 처리량 정렬 토글
  const [rateWindow, setRateWindow] = useState<WorkerRateWindow>('1h');
  const [sortByRate, setSortByRate] = useState(false);
  // 작업 큐 편집 상태 — 두 섹션 패널 (풀 / 큐)
  const [dragFid, setDragFid] = useState<number | null>(null);
  const [queueIds, setQueueIds] = useState<number[]>([]);
  const [overZone, setOverZone] = useState<'pool' | 'queue' | null>(null);
  const [overQueueIdx, setOverQueueIdx] = useState<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, l, p] = await Promise.all([
        fetchGpuStatus(),
        fetchGpuLogs(selectedEndpoint || undefined, 80),
        fetchBulkProgress(),
      ]);
      setWorkers(s.workers);
      setLogs(l.logs);
      setProgress(p);
      setLastFetched(new Date().toLocaleTimeString());
    } catch (e) {
      // 무시
    }
  }, [selectedEndpoint]);

  useEffect(() => {
    if (!open) return;
    load();
    fetch('/api/smartstore/naver-products/tg-report/')
      .then(r => r.json()).then(d => setTgReportEnabled(!!d.enabled)).catch(() => {});
  }, [open, load]);

  const toggleTgReport = async (checked: boolean) => {
    setTgToggling(true);
    try {
      const r = await fetch('/api/smartstore/naver-products/tg-report/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });
      const d = await r.json();
      setTgReportEnabled(!!d.enabled);
      if (d.enabled && d.sent_now) {
        // 즉시 1회 보고 + 매시 정각 보고
      }
    } finally {
      setTgToggling(false);
    }
  };

  useEffect(() => {
    if (!open || !autoRefresh) {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = window.setInterval(load, 5000);
    return () => { if (intervalRef.current) window.clearInterval(intervalRef.current); };
  }, [open, autoRefresh, load]);

  // 서버 응답에서 큐 동기화 (드래그 중이 아닐 때만).
  // 미분류(1) 도 일반 폴더와 동일 — 사용자가 큐 순서 자유 지정 (정책 변경 2026-05-21).
  useEffect(() => {
    if (!progress || dragFid !== null) return;
    const ordered = progress.folders
      .filter(f => f.queue_position != null)
      .sort((a, b) => (a.queue_position! - b.queue_position!));
    const ids = ordered.map(f => f.folder_id);
    setQueueIds(prev => (prev.length === ids.length && prev.every((v, i) => v === ids[i])) ? prev : ids);
  }, [progress, dragFid]);

  const folderMap = useMemo(() => {
    const m = new Map<number, FolderProgress>();
    progress?.folders.forEach(f => m.set(f.folder_id, f));
    return m;
  }, [progress]);

  const poolIds = useMemo(() => {
    if (!progress) return [] as number[];
    const qSet = new Set(queueIds);
    // 미분류(1) 도 일반 폴더와 동일 처리 (정책 변경 2026-05-21).
    return progress.folders
      .filter(f => !qSet.has(f.folder_id))
      .map(f => f.folder_id);
  }, [progress, queueIds]);

  const saveQueue = useCallback(async (newIds: number[]) => {
    setQueueIds(newIds);
    try {
      const r = await fetch('/api/smartstore/naver-products/folder-queue/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_ids: newIds }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert('큐 저장 실패: ' + (j.error || 'unknown'));
        return;
      }
      // 완료 폴더 추가 시도면 confirm → force_regenerate
      if (Array.isArray(j.already_complete) && j.already_complete.length > 0) {
        const names = j.already_complete
          .map((fid: number) => {
            const f = (progress?.folders || []).find(x => x.folder_id === fid);
            return f?.folder_name || `#${fid}`;
          })
          .join(', ');
        const ok = window.confirm(
          `이미 100% 완료된 폴더입니다: ${names}\n\n` +
          `이 폴더를 다시 작업하시겠습니까?\n(YES → 모든 상품의 네이버 상품명 초기화 후 재추론)`
        );
        if (ok) {
          const r2 = await fetch('/api/smartstore/naver-products/folder-queue/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_ids: newIds, force_regenerate: true }),
          });
          const j2 = await r2.json();
          if (j2.ok) {
            alert(`✅ ${names} 재추론 시작 — 5초 안에 워커가 픽업합니다`);
          } else {
            alert('재추론 실패: ' + (j2.error || 'unknown'));
          }
        }
      }
    } catch (e) {
      alert('큐 저장 오류: ' + e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.folders]);

  const handleDropToQueue = useCallback((insertIdx?: number) => {
    if (dragFid == null) return;
    let next = queueIds.filter(x => x !== dragFid);
    const at = insertIdx == null ? next.length : Math.min(insertIdx, next.length);
    next.splice(at, 0, dragFid);
    setDragFid(null); setOverZone(null); setOverQueueIdx(null);
    void saveQueue(next);
  }, [dragFid, queueIds, saveQueue]);

  const handleDropToPool = useCallback(() => {
    if (dragFid == null) return;
    setDragFid(null); setOverZone(null); setOverQueueIdx(null);
    if (queueIds.includes(dragFid)) {
      void saveQueue(queueIds.filter(x => x !== dragFid));
    }
  }, [dragFid, queueIds, saveQueue]);

  const handleRemoveFromQueue = useCallback((fid: number) => {
    void saveQueue(queueIds.filter(x => x !== fid));
  }, [queueIds, saveQueue]);

  // 진짜 죽은 워커(응답없음)만 강한 경고. stale(heartbeat 끊김)은 약한 인디케이터.
  const deadWorkers = useMemo(() => workers.filter(w => w.status === 'dead'), [workers]);
  const staleWorkers = useMemo(() => workers.filter(w => w.status !== 'dead' && w.stale), [workers]);

  // 워커별 model set 중 모두 공통으로 가진 것만 헤더에 표시. 빠진 워커는 카드에서 ⚠ 표시.
  const { commonModels } = useMemo(() => {
    if (workers.length === 0) return { commonModels: [] as string[], perWorkerMissing: {} as Record<string, string[]> };
    const sets = workers.map(w => new Set(w.available_models || []));
    const union = new Set<string>();
    sets.forEach(s => s.forEach(m => union.add(m)));
    const common = Array.from(union).filter(m => sets.every(s => s.has(m))).sort();
    const missing: Record<string, string[]> = {};
    workers.forEach((w, i) => {
      const lack = common.filter(m => !sets[i].has(m));
      if (lack.length > 0 || (w.available_models || []).length === 0) {
        missing[w.endpoint] = lack;
      }
    });
    return { commonModels: common, perWorkerMissing: missing };
  }, [workers]);

  const latestLog = logs[0];
  // 중대한 이벤트 (오류/타임아웃/응답없음/모델 fallback) 가 있으면 우선 표시
  const CRITICAL_TYPES = new Set(['error', 'timeout', 'dead', 'model_fallback']);
  const latestCriticalLog = useMemo(() => logs.find(l => CRITICAL_TYPES.has(l.event_type)) || null, [logs]);

  // 전체 처리량 합계 (모든 워커 1시간 합산)
  const totalCompletions1h = useMemo(
    () => workers.reduce((s, w) => s + (w.completions_1h || 0), 0),
    [workers]
  );
  // "추론중" = 최근 선택 윈도우 안에 1건 이상 처리한 워커.
  // gpu_util_pct 는 nvidia-smi polling 순간이라 idle 으로 잡힐 수 있어 신뢰 X.
  const activeWorkers = useMemo(
    () => workers.filter(w => (
      rateWindow === '5min'  ? w.completions_5min  :
      rateWindow === '10min' ? w.completions_10min :
      rateWindow === '30min' ? w.completions_30min :
                                w.completions_1h
    ) > 0).length,
    [workers, rateWindow]
  );
  const avgRate = workers.length ? Math.round(totalCompletions1h / workers.length) : 0;

  // 선택된 윈도우 기준 처리량
  const rateOf = (w: GpuWorker): number => (
    rateWindow === '5min'  ? w.completions_5min  :
    rateWindow === '10min' ? w.completions_10min :
    rateWindow === '30min' ? w.completions_30min :
                              w.completions_1h
  );
  const displayedWorkers = sortByRate
    ? [...workers].sort((a, b) => rateOf(b) - rateOf(a))
    : workers;

  // 워커 라벨 — 작은 칩에 표시할 짧은 이름. 집은 '집', 88-GPU는 '88-N', 나머지는 IP 끝자리.
  const workerChipLabel = (w: GpuWorker): string => {
    if (w.endpoint.startsWith('119.67.47.184')) return '집';
    if (w.endpoint.startsWith('localhost:11434')) return '80';
    if (w.endpoint.startsWith('localhost:11435')) return '88-0';
    if (w.endpoint.startsWith('localhost:11436')) return '88-1';
    if (w.endpoint.startsWith('localhost:11437')) return '88-2';
    if (w.endpoint.startsWith('localhost:11438')) return '100';
    const m = w.endpoint.match(/192\.168\.219\.(\d+)/);
    if (m) return m[1];
    return w.worker_name;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="rounded-xl shadow-2xl w-[96vw] max-w-7xl h-[92vh] flex flex-col bg-white dark:bg-gray-900"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold text-violet-700 dark:text-violet-300">🖥 GPU 워커 모니터링</h3>
            <span className="text-[11px] text-gray-500">총 {workers.length}대</span>
            {deadWorkers.length > 0 && (
              <span title={`응답없음 ${deadWorkers.length}대: ${deadWorkers.map(w => w.worker_name).join(', ')}`}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold animate-pulse">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-white" />
                {deadWorkers.length}
              </span>
            )}
            {staleWorkers.length > 0 && (
              <span title={`heartbeat 끊김 ${staleWorkers.length}대 (실제로는 응답할 수 있음): ${staleWorkers.map(w => w.worker_name).join(', ')}`}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-[10px]">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                {staleWorkers.length}
              </span>
            )}
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="w-3 h-3 accent-violet-600" />
              자동 새로고침 (5초)
            </label>
            <label className={`inline-flex items-center gap-1 text-[11px] cursor-pointer ${tgReportEnabled ? 'text-sky-600 dark:text-sky-400 font-bold' : 'text-gray-500'}`}
              title="체크 즉시 1회 보고 + 매시 정각마다 텔레그램으로 큐 진척 자동 보고">
              <input type="checkbox" checked={tgReportEnabled}
                onChange={e => toggleTgReport(e.target.checked)}
                disabled={tgToggling}
                className="w-3 h-3 accent-sky-600" />
              📨 텔레그램 1시간 보고
            </label>
            {lastFetched && <span className="text-[10px] text-gray-400">last: {lastFetched}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load}
              className="px-2 py-1 text-[11px] rounded bg-violet-600 text-white hover:bg-violet-700">새로고침</button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl ml-1">×</button>
          </div>
        </div>

        {/* 탭 헤더 */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
          <button onClick={() => setTab('monitor')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-t transition-all flex items-center gap-1.5 ${
                    tab === 'monitor'
                      ? 'bg-gradient-to-b from-violet-600 to-violet-700 text-white shadow'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}>
            🖥 GPU 모니터링
          </button>
          <button onClick={() => setTab('upscale')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-t transition-all flex items-center gap-1.5 ${
                    tab === 'upscale'
                      ? 'bg-gradient-to-b from-emerald-600 to-emerald-700 text-white shadow'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}>
            🎨 AI 이미지 작업
          </button>
          <button onClick={() => setTab('attrs')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-t transition-all flex items-center gap-1.5 ${
                    tab === 'attrs'
                      ? 'bg-gradient-to-b from-amber-500 to-amber-600 text-white shadow'
                      : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}>
            🤖 상품속성
          </button>
        </div>

        {/* 탭 본문 */}
        {tab === 'upscale' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <UpscaleJobsPanel />
          </div>
        )}
        {tab === 'attrs' && (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <ProductAttrPanel />
          </div>
        )}
        {tab === 'monitor' && <>

        {/* GPU 상태 스트립 — 11대 한눈에. 클릭 시 해당 워커 로그 필터.
            우측: 라디오(5/10/30/60분) + 정렬 토글. 각 칩 위에 선택 윈도우의 처리 건수. */}
        {workers.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 flex items-center gap-2">
            <div className="flex-1 flex items-center justify-center gap-1 flex-wrap">
              {displayedWorkers.map(w => {
                // "오래된 데이터는 초록이 아니라 회색" — stale 은 가동중이 아닌 unknown(=꺼짐 가능성).
                // dispatch 가 5초마다 갱신하므로 60초+ stale = dispatch 가 죽었거나 worker_status 기록 자체가 끊김.
                const st = w.stale && w.status !== 'dead' ? 'unknown' : w.status;
                const bg =
                  st === 'dead'     ? 'bg-rose-500 text-white animate-pulse' :
                  st === 'degraded' ? 'bg-amber-400 text-amber-900' :
                  st === 'unknown'  ? 'bg-gray-400 text-gray-900' :
                                      'bg-emerald-500 text-white';
                const inferring = (w.gpu_util_pct || 0) > 10;
                const isSelected = selectedEndpoint === w.endpoint;
                const rate = rateOf(w);
                return (
                  <div key={w.endpoint} className="flex flex-col items-center gap-0.5">
                    <span className={`text-[10px] font-bold font-mono leading-none ${
                      rate > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-400'
                    }`}>
                      {rate}
                    </span>
                    <button
                      onClick={() => setSelectedEndpoint(isSelected ? '' : w.endpoint)}
                      title={`${w.worker_name} · ${w.endpoint} · ${STATUS_LABEL[st] || st} · 5분/10분/30분/1h = ${w.completions_5min}/${w.completions_10min}/${w.completions_30min}/${w.completions_1h}${w.last_error ? '\n' + w.last_error : ''}`}
                      className={`relative inline-flex items-center justify-center min-w-[44px] px-2 py-1 rounded-md text-[11px] font-bold font-mono shadow-sm transition-all hover:scale-110 ${bg} ${
                        isSelected ? 'ring-2 ring-violet-500 ring-offset-1 dark:ring-offset-gray-800' : ''
                      }`}
                    >
                      {workerChipLabel(w)}
                      {inferring && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-300 border border-white animate-pulse" title="추론중" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {/* 우측 — 윈도우 선택 + 처리량 정렬 토글 + 활성 워커 카운트 */}
            <div className="flex items-center gap-2 shrink-0 border-l border-gray-300 dark:border-gray-600 pl-2">
              <span className="text-[11px] text-gray-600 dark:text-gray-300 whitespace-nowrap">
                처리중 <span className="font-bold text-emerald-700 dark:text-emerald-300">{activeWorkers}</span>/{workers.length}
              </span>
              <div className="flex rounded overflow-hidden border border-gray-300 dark:border-gray-600 text-[10px] font-bold">
                {(['5min', '10min', '30min', '1h'] as WorkerRateWindow[]).map(w => (
                  <button
                    key={w}
                    onClick={() => setRateWindow(w)}
                    className={`px-1.5 py-0.5 transition-colors ${
                      rateWindow === w
                        ? 'bg-violet-600 text-white'
                        : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-violet-50 dark:hover:bg-violet-900/30'
                    }`}
                    title={`최근 ${w === '1h' ? '1시간' : w.replace('min', '분')} 처리량`}
                  >
                    {w === '1h' ? '1h' : w.replace('min', 'm')}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setSortByRate(v => !v)}
                title={sortByRate ? '정렬 해제 (원래 순서)' : '처리량 높은 순으로 정렬'}
                className={`px-1.5 py-1 rounded border text-[11px] transition-colors ${
                  sortByRate
                    ? 'bg-violet-600 text-white border-violet-700'
                    : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-violet-50 dark:hover:bg-violet-900/30'
                }`}
              >
                {sortByRate ? '↓⬛' : '↓⬜'}
              </button>
            </div>
          </div>
        )}

        {/* 진척률 progress bar + 폴더 풀/큐 — flex-1 로 카드 자리까지 차지해 큐가 이벤트 로그 직전까지 표시 */}
        {progress && (
          <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-violet-50 to-fuchsia-50 dark:from-violet-900/20 dark:to-fuchsia-900/20 flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[12px] font-bold text-violet-700 dark:text-violet-300">
                📊 전체 폴더 AI수집 진척 — {progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({progress.pct}%)
              </div>
              <div className="text-[11px] text-gray-600 dark:text-gray-300 flex items-center gap-2">
                {/* 진척바 누적치(83.9% 등)는 멈춰도 그대로라 "진행 중"으로 착각하기 쉬움.
                    rate_10min=0 & 남은 작업 > 0 이면 명시적 정체 배지. */}
                {progress.stalled && (
                  <span
                    title={`최근 10분 처리 0건 — dispatch / 워커 / DB 점검 필요`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-bold text-rose-700 bg-rose-100 dark:bg-rose-900/40 dark:text-rose-200 animate-pulse"
                  >⚠ 정체</span>
                )}
                <span className={`font-bold ${progress.stalled ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                  {progress.rate_1h}건/h
                </span>
                <span className="text-gray-500">(최근 10분 {progress.rate_10min})</span>
                {progress.avg_ms > 0 && <span className="text-gray-500">평균 {(progress.avg_ms/1000).toFixed(1)}s/건</span>}
                {progress.eta_hours !== null && (
                  <span className="font-bold">ETA {progress.eta_hours < 1
                    ? `${Math.round(progress.eta_hours * 60)}분`
                    : `${progress.eta_hours}h`}</span>
                )}
              </div>
            </div>
            <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3">
              <div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                style={{ width: `${progress.pct}%` }} />
            </div>

            {/* ===== 폴더 풀 (상단) ===== */}
            <div
              onDragOver={(e) => { e.preventDefault(); setOverZone('pool'); }}
              onDragLeave={() => setOverZone(curr => curr === 'pool' ? null : curr)}
              onDrop={(e) => { e.preventDefault(); handleDropToPool(); }}
              className={`mb-2 rounded border-2 transition-all ${
                overZone === 'pool' && dragFid != null && queueIds.includes(dragFid)
                  ? 'border-rose-400 bg-rose-50/60 dark:bg-rose-900/20'
                  : 'border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-gray-800/40'
              }`}
            >
              <div className="px-2 py-1 text-[11px] font-bold text-gray-700 dark:text-gray-200 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
                📋 폴더 풀 ({poolIds.length}) <span className="text-[10px] font-normal text-gray-500">— 아래 큐로 드래그해 추가</span>
              </div>
              <div className="p-1.5 flex flex-wrap gap-1">
                {poolIds.map(fid => {
                  const f = folderMap.get(fid); if (!f) return null;
                  return (
                    <span
                      key={fid}
                      draggable
                      onDragStart={() => { setDragFid(fid); setOverZone(null); }}
                      onDragEnd={() => { setDragFid(null); setOverZone(null); setOverQueueIdx(null); }}
                      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border bg-white dark:bg-gray-700 select-none cursor-grab active:cursor-grabbing transition-all ${
                        dragFid === fid ? 'opacity-40' : 'border-gray-300 dark:border-gray-600 hover:border-violet-400'
                      }`}
                      title="드래그해서 작업 큐로 이동"
                    >
                      <span className="font-bold">{f.folder_name}</span>
                      <span className={`text-[10px] ${f.status === 'done' ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {f.done.toLocaleString()}/{f.total.toLocaleString()} ({f.pct}%)
                      </span>
                    </span>
                  );
                })}
                {poolIds.length === 0 && (
                  <span className="text-[10px] text-gray-400 px-1">(모든 폴더가 큐에 있음)</span>
                )}
              </div>
            </div>

            {/* ===== 작업 큐 (하단) ===== */}
            <div
              onDragOver={(e) => { e.preventDefault(); if (overZone !== 'queue') setOverZone('queue'); }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setOverZone(curr => curr === 'queue' ? null : curr);
                setOverQueueIdx(null);
              }}
              onDrop={(e) => { e.preventDefault(); handleDropToQueue(overQueueIdx ?? undefined); }}
              className={`rounded border-2 transition-all flex-1 min-h-0 flex flex-col overflow-hidden ${
                overZone === 'queue' && dragFid != null && !queueIds.includes(dragFid)
                  ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-900/20'
                  : 'border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20'
              }`}
            >
              <div className="px-2 py-1 text-[11px] font-bold text-amber-800 dark:text-amber-200 border-b border-amber-200 dark:border-amber-800 flex items-center gap-2 shrink-0">
                🎯 작업 큐 ({queueIds.length}) <span className="text-[10px] font-normal text-amber-700/70 dark:text-amber-300/70">— 위에서 아래로 순서 처리. 드래그 재정렬 / ✕로 제거</span>
              </div>
              {/* 큐 리스트 — 컨테이너 높이만큼 차지하고 내부 스크롤. 폴더 많아도 이벤트 로그 직전까지 다 표시. */}
              <div className="p-1.5 flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
                {queueIds.length === 0 && (
                  <div className="py-4 text-center text-[11px] text-gray-400">
                    큐가 비어있습니다. 위 풀에서 폴더를 드래그해 추가하세요.
                  </div>
                )}
                {queueIds.map((fid, idx) => {
                  const f = folderMap.get(fid); if (!f) return null;
                  const isDragOver = overQueueIdx === idx && dragFid != null && dragFid !== fid;
                  return (
                    <div
                      key={fid}
                      draggable
                      onDragStart={() => setDragFid(fid)}
                      onDragEnd={() => { setDragFid(null); setOverQueueIdx(null); }}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOverQueueIdx(idx); setOverZone('queue'); }}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDropToQueue(idx); }}
                      className={`flex items-center gap-2 px-2 py-1 rounded border bg-white dark:bg-gray-700 select-none cursor-grab active:cursor-grabbing transition-all ${
                        dragFid === fid ? 'opacity-40' : 'border-amber-300 dark:border-amber-600'
                      } ${isDragOver ? 'ring-2 ring-emerald-500' : ''}`}
                    >
                      <span className="w-6 text-center text-[11px] font-mono font-bold text-amber-700 dark:text-amber-300 shrink-0">{idx + 1}</span>
                      <span className="text-[11px] font-bold min-w-[80px] shrink-0">{f.folder_name}</span>
                      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-600 rounded overflow-hidden">
                        <div className={`h-full transition-all ${
                          f.status === 'done' ? 'bg-emerald-500' :
                          f.pct > 10 ? 'bg-violet-500' :
                          f.pct > 0 ? 'bg-blue-400' : 'bg-gray-300 dark:bg-gray-500'
                        }`} style={{ width: `${f.pct}%` }} />
                      </div>
                      <span className="text-[10px] font-mono text-gray-600 dark:text-gray-300 shrink-0 w-28 text-right">
                        {f.done.toLocaleString()}/{f.total.toLocaleString()} ({f.pct}%)
                      </span>
                      <span className="text-[10px] text-gray-500 shrink-0 w-16 text-right">잔여 {f.remaining.toLocaleString()}</span>
                      <button
                        onClick={() => handleRemoveFromQueue(fid)}
                        className="text-rose-500 hover:text-rose-700 text-sm leading-none w-5 h-5 rounded hover:bg-rose-100 dark:hover:bg-rose-900/30 shrink-0"
                        title="큐에서 제거"
                      >✕</button>
                    </div>
                  );
                })}
              </div>
              <div className="px-2 py-1 text-[10px] text-amber-700/70 dark:text-amber-300/70 border-t border-amber-200 dark:border-amber-800">
                저장은 자동. 현재 batch에 영향 없고 다음 batch부터 새 순서로 처리됩니다.
              </div>
            </div>
          </div>
        )}

        {/* 공통 모델 한 줄 */}
        {commonModels.length > 0 && (
          <div className="px-5 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold text-gray-600 dark:text-gray-300">📦 모델 ({commonModels.length}):</span>
            {commonModels.map(m => (
              <span key={m} className="px-2 py-0.5 text-[10px] rounded bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 font-mono">
                {m}
              </span>
            ))}
          </div>
        )}

        {/* 합계 한 줄 — 카드값과 헷갈리지 않도록 명시 */}
        {workers.length > 0 && (
          <div className="px-5 py-2 border-b border-gray-200 dark:border-gray-700 bg-emerald-50 dark:bg-emerald-900/20 flex items-center gap-4 flex-wrap text-[12px]">
            <span className="font-bold text-emerald-800 dark:text-emerald-200">
              🔥 전체 처리량 합계: <span className="text-base font-mono">{totalCompletions1h.toLocaleString()}</span>건/시
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              ({workers.length}대 평균 <span className="font-mono">{avgRate}</span>건/시)
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              · 추론중 <span className="font-bold text-emerald-700 dark:text-emerald-300">{activeWorkers}</span>/{workers.length}대
            </span>
          </div>
        )}

        {/* 워커 카드 섹션 제거됨 (2026-05-21): 상단 칩 스트립 + 호버 툴팁으로 충분.
            진척바/큐 컨테이너가 flex-1 로 늘어나 이벤트 로그 바로 위까지 차지. */}

        {/* 하단 이벤트 로그 — 기본 한 줄, ▼ 클릭 시 펼침 */}
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 shrink-0">
          <button onClick={() => setLogsExpanded(v => !v)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
              latestCriticalLog && !logsExpanded
                ? 'bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700/30'
            }`}>
            <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200 shrink-0">
              📋 이벤트 로그 ({logs.length})
            </span>
            {latestCriticalLog && !logsExpanded && (
              <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold animate-pulse shrink-0">중대</span>
            )}
            {selectedEndpoint && (
              <span className="text-[10px] text-violet-600 dark:text-violet-400 font-mono shrink-0">{selectedEndpoint}</span>
            )}
            {!logsExpanded && (latestCriticalLog || latestLog) ? (() => {
              const l = latestCriticalLog || latestLog;
              return (
                <span className="flex items-center gap-2 text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate flex-1 min-w-0">
                  <span className="text-gray-400">{new Date(l.created_at).toLocaleTimeString()}</span>
                  <span className={EVENT_COLOR[l.event_type] || 'text-gray-600'}>[{l.event_type}]</span>
                  <span className="text-gray-500">{l.endpoint}</span>
                  {l.product_id && <span className="text-violet-500">#{l.product_id}</span>}
                  {l.folder_name && (
                    <span className="px-1.5 py-px rounded text-[10px] bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 whitespace-nowrap">{l.folder_name}</span>
                  )}
                  {l.elapsed_ms !== null && <span>{(l.elapsed_ms / 1000).toFixed(1)}s</span>}
                  {l.error_msg && <span className="text-rose-500 truncate">{l.error_msg}</span>}
                </span>
              );
            })() : (
              <span className="flex-1" />
            )}
            <span className="text-gray-400 text-xs shrink-0">{logsExpanded ? '▲' : '▼'}</span>
          </button>

          {logsExpanded && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between px-3 py-1.5 bg-gray-100 dark:bg-gray-800/60">
                {selectedEndpoint ? (
                  <span className="text-[10px] text-gray-500">
                    선택: <span className="text-violet-600 dark:text-violet-400 font-mono">{selectedEndpoint}</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-500">전체 워커</span>
                )}
                {selectedEndpoint && (
                  <button onClick={() => setSelectedEndpoint('')}
                    className="text-[10px] px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300">전체 보기</button>
                )}
              </div>
              <div className="h-[32vh] overflow-y-auto p-2 space-y-0.5 font-mono text-[11px]">
                {logs.length === 0 ? (
                  <div className="text-center text-gray-400 py-8">아직 로그 없음</div>
                ) : (
                  logs.map(l => (
                    <div key={l.id} className="flex gap-2 px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700/30 rounded">
                      <span className="text-gray-400 text-[10px] whitespace-nowrap">{new Date(l.created_at).toLocaleTimeString()}</span>
                      <span className={`whitespace-nowrap ${EVENT_COLOR[l.event_type] || 'text-gray-600'}`}>
                        [{l.event_type}]
                      </span>
                      {!selectedEndpoint && (
                        <span className="text-gray-500 text-[10px] whitespace-nowrap">{l.endpoint}</span>
                      )}
                      {l.product_id && <span className="text-violet-500 text-[10px]">#{l.product_id}</span>}
                      {l.folder_name && (
                        <span className="px-1.5 py-px rounded text-[10px] bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 whitespace-nowrap">{l.folder_name}</span>
                      )}
                      {l.model_used && <span className="text-blue-500 text-[10px]">{l.model_used}</span>}
                      {l.elapsed_ms !== null && <span className="text-gray-500 text-[10px]">{(l.elapsed_ms / 1000).toFixed(1)}s</span>}
                      {l.error_msg && (
                        <span className="text-rose-600 dark:text-rose-400 truncate" title={l.error_msg}>
                          {l.error_msg}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        </>}{/* /monitor 탭 */}
      </div>
    </div>
  );
}
