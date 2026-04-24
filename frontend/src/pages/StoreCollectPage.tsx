import { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchStores,
  startCollect,
  getCollectStatus,
  stopCollect,
  getCollectCsvUrl,
  getCollectCsvByLogId,
  getCollectLogs,
  deleteErrorLogs,
  type SmartStore,
  type CollectStatus,
  type CollectLog,
} from '../api/smartstoreApi';

export default function StoreCollectPage() {
  const { dark } = useTheme();
  const [stores, setStores] = useState<SmartStore[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [status, setStatus] = useState<CollectStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [logs, setLogs] = useState<CollectLog[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLogs = useCallback(() => {
    getCollectLogs(30).then(setLogs).catch(() => {});
  }, []);

  useEffect(() => {
    fetchStores().then(setStores);
    loadLogs();
    getCollectStatus().then((st) => {
      setStatus(st);
      if (st.running) setPolling(true);
    });
  }, [loadLogs]);

  // 폴링
  useEffect(() => {
    if (!polling) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    timerRef.current = setInterval(async () => {
      try {
        const st = await getCollectStatus();
        setStatus(st);
        if (!st.running) {
          setPolling(false);
          loadLogs();
        }
      } catch { /* */ }
    }, 1500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [polling, loadLogs]);

  // 로그 자동 스크롤
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [status?.logs]);

  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelected(new Set());
    } else {
      setSelected(new Set(stores.map(s => s.id)));
    }
    setSelectAll(!selectAll);
  }, [selectAll, stores]);

  const handleToggle = useCallback((id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleStartClick = () => {
    if (selected.size === 0 && !selectAll) return;
    setShowConfirm(true);
  };

  const handleConfirmStart = async () => {
    setShowConfirm(false);
    const ids = selected.size > 0 && selected.size < stores.length
      ? Array.from(selected)
      : undefined;
    try {
      const res = await startCollect(ids);
      if (res.ok) {
        setPolling(true);
      } else {
        alert(res.message);
      }
    } catch (e: any) {
      alert(e?.response?.data?.message || '수집 시작 실패');
    }
  };

  const handleStop = async () => {
    await stopCollect();
  };

  const isRunning = status?.running ?? false;
  const phase = status?.phase ?? 'idle';
  const isDone = phase === 'done' && !isRunning;
  const phaseLabel: Record<string, string> = {
    idle: '대기',
    init: '초기화',
    login: '로그인 중',
    navigate: '페이지 이동',
    download: '다운로드 중',
    parse: 'CSV 파싱',
    save: 'DB 저장',
    done: '완료',
    error: '오류',
  };

  // 선택된 스토어명 목록
  const selectedNames = stores.filter(s => selected.has(s.id)).map(s => s.store_name);

  const cardBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const borderColor = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const textMain = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';

  return (
    <div className="p-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { window.location.hash = 'products'; }}
            className={`text-sm ${textSub} hover:text-[#03c75a]`}
          >
            &larr; 스마트스토어상품
          </button>
          <h1 className={`text-xl font-bold ${textMain}`}>스토어 상품수집</h1>
        </div>
      </div>

      {/* Store selector */}
      <div className={`${cardBg} border ${borderColor} rounded-lg p-4 mb-4`}>
        <div className="flex items-center justify-between mb-3">
          <label className={`flex items-center gap-2 text-sm ${textMain}`}>
            <input
              type="checkbox"
              checked={selectAll}
              onChange={handleSelectAll}
              className="rounded"
            />
            전체선택 ({stores.length}개)
          </label>
          <div className="flex gap-2">
            {!isRunning ? (
              <button
                onClick={handleStartClick}
                disabled={selected.size === 0 && !selectAll}
                className="px-4 py-2 bg-[#03c75a] text-white rounded font-medium hover:bg-[#02a94d] disabled:opacity-40 disabled:cursor-not-allowed text-sm"
              >
                수집하기
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="px-4 py-2 bg-red-500 text-white rounded font-medium hover:bg-red-600 text-sm"
              >
                중지
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-60 overflow-y-auto">
          {stores.map(s => {
            const lastLog = logs.find(l => l.store_name === s.store_name && l.status === 'success');
            return (
              <label
                key={s.id}
                className={`flex items-center gap-2 text-sm px-2 py-1.5 rounded cursor-pointer ${
                  selected.has(s.id)
                    ? dark ? 'bg-[#2a2a40]' : 'bg-blue-50'
                    : ''
                } ${textMain}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => handleToggle(s.id)}
                  className="rounded"
                />
                <span className="truncate flex-1">{s.store_name}</span>
                {lastLog && (
                  <span className={`text-[10px] ${textSub} whitespace-nowrap flex items-center gap-1`}>
                    {new Date(lastLog.completed_at).toLocaleString('ko-KR', {
                      month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', hour12: false,
                    })}
                    {lastLog.csv_file_path && (
                      <a
                        href={getCollectCsvByLogId(lastLog.id)}
                        onClick={e => e.stopPropagation()}
                        className="px-1 py-0.5 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                        title="CSV 다운로드"
                      >
                        ↓
                      </a>
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      {/* Task Desk - 작업 상태 */}
      {(isRunning || (status && status.logs.length > 0)) && (
        <div className={`${cardBg} border ${borderColor} rounded-lg mb-4 overflow-hidden`}>
          {/* 작업 헤더 - 항상 표시 */}
          <div className={`flex items-center justify-between px-4 py-3 ${
            isRunning ? (dark ? 'bg-blue-900/20' : 'bg-blue-50') :
            isDone ? (dark ? 'bg-green-900/20' : 'bg-green-50') :
            ''
          }`}>
            <div className="flex items-center gap-3">
              {isRunning && (
                <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              )}
              {isDone && (
                <div className="w-2 h-2 rounded-full bg-green-400" />
              )}
              <span className={`text-sm font-medium ${textMain}`}>
                {isRunning ? (
                  <>
                    {status?.store_name || '작업 시작'} 수집 중
                    <span className={`ml-2 ${textSub}`}>
                      ({status?.store_idx}/{status?.total_stores})
                    </span>
                  </>
                ) : isDone ? (
                  '수집 완료'
                ) : (
                  '작업 대기'
                )}
              </span>
              {isRunning && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  phase === 'download' ? 'bg-blue-500/20 text-blue-400' :
                  phase === 'login' ? 'bg-yellow-500/20 text-yellow-400' :
                  phase === 'save' ? 'bg-green-500/20 text-green-400' :
                  dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
                }`}>
                  {phaseLabel[phase] || phase}
                  {phase === 'download' && status && status.progress_pct > 0 && ` ${status.progress_pct}%`}
                </span>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {isRunning && status && status.total_stores > 0 && (
            <div className={`px-4 pb-2 pt-1`}>
              <div className={`w-full h-1.5 rounded-full ${dark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                <div
                  className="h-full rounded-full bg-[#03c75a] transition-all"
                  style={{ width: `${(status.store_idx / status.total_stores) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* 로그 영역 */}
          <div className="px-4 pb-3">
            <pre
              ref={logRef}
              className={`text-xs font-mono leading-relaxed overflow-auto max-h-48 p-3 rounded mt-2 ${
                dark ? 'bg-[#0f0f1a] text-gray-300' : 'bg-gray-50 text-gray-700'
              }`}
            >
              {(status?.logs ?? []).map((l, i) => (
                <div key={i}>
                  <span className={textSub}>
                    {new Date(l.t).toLocaleTimeString('ko-KR', { hour12: false })}
                  </span>
                  {' '}{l.msg}
                </div>
              ))}
              {status?.logs?.length === 0 && <span className={textSub}>로그 대기 중...</span>}
            </pre>
          </div>

          {/* 완료 시 결과 + CSV 다운로드 (펼치기) */}
          {isDone && status?.last_result && Object.keys(status.last_result).length > 0 && (
            <div className={`px-4 pb-4 border-t ${borderColor}`}>
              <div className="pt-3">
                <h4 className={`text-sm font-medium ${textMain} mb-2`}>첨부파일</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(status.last_result).map(([name, r]) => (
                    <div key={name} className={`flex items-center gap-2 px-3 py-2 rounded text-sm ${
                      dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'
                    }`}>
                      <span className={textMain}>{name}</span>
                      {r.error ? (
                        <span className="text-xs text-red-400">({r.error})</span>
                      ) : (
                        <>
                          <span className={`text-xs ${textSub}`}>{r.synced.toLocaleString()}건</span>
                          {status.csv_files[name] && (
                            <a
                              href={getCollectCsvUrl(name)}
                              className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                            >
                              CSV
                            </a>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {status?.error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
          {status.error}
        </div>
      )}

      {/* 수집 이력 (접기/펴기) */}
      {logs.length > 0 && (
        <div className={`${cardBg} border ${borderColor} rounded-lg overflow-hidden`}>
          <div className="flex items-center justify-between px-4 py-3">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className={`flex items-center gap-2 text-left`}
            >
              <span className={`text-sm font-medium ${textMain}`}>
                수집 이력 ({logs.length}건)
              </span>
              <span className={`text-xs ${textSub} transition-transform ${historyOpen ? 'rotate-180' : ''}`}>
                &#9660;
              </span>
            </button>
            {historyOpen && logs.some(l => l.status === 'error') && (
              <button
                onClick={async () => {
                  if (!confirm('실패 로그를 모두 삭제하시겠습니까?')) return;
                  try {
                    const res = await deleteErrorLogs();
                    alert(`${res.deleted}건 삭제됨`);
                    loadLogs();
                  } catch { alert('삭제 실패'); }
                }}
                className="text-xs px-2 py-1 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
              >
                실패로그 삭제
              </button>
            )}
          </div>

          {historyOpen && (
            <div className={`border-t ${borderColor}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={`${dark ? 'text-gray-400' : 'text-gray-600'} border-b ${borderColor}`}>
                      <th className="text-left py-2 px-4">시간</th>
                      <th className="text-left py-2 px-4">스토어</th>
                      <th className="text-right py-2 px-4">상품 수</th>
                      <th className="text-center py-2 px-4">상태</th>
                      <th className="text-center py-2 px-4">파일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => (
                      <tr key={log.id} className={`border-b ${borderColor}`}>
                        <td className={`py-2 px-4 text-xs ${textSub}`}>
                          {new Date(log.completed_at).toLocaleString('ko-KR', {
                            month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit', hour12: false,
                          })}
                        </td>
                        <td className={`py-2 px-4 ${textMain}`}>{log.store_name}</td>
                        <td className={`py-2 px-4 text-right ${textMain}`}>
                          {log.total_products > 0 ? log.total_products.toLocaleString() : '-'}
                        </td>
                        <td className="py-2 px-4 text-center">
                          {log.status === 'success' ? (
                            <span className="text-xs text-green-400">성공</span>
                          ) : (
                            <span className="text-xs text-red-400" title={log.error_msg || ''}>실패</span>
                          )}
                        </td>
                        <td className="py-2 px-4 text-center">
                          {log.csv_file_path ? (
                            <a
                              href={getCollectCsvByLogId(log.id)}
                              className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                            >
                              다운로드
                            </a>
                          ) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 확인 모달 */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className={`${cardBg} border ${borderColor} rounded-lg p-6 max-w-sm mx-4 shadow-xl`}>
            <h3 className={`text-base font-bold ${textMain} mb-3`}>상품수집 시작</h3>
            <p className={`text-sm ${textMain} mb-2`}>
              선택 사이트: <span className="font-medium">{selectedNames.length > 3
                ? `${selectedNames.slice(0, 3).join(', ')} 외 ${selectedNames.length - 3}개`
                : selectedNames.join(', ')
              }</span>
            </p>
            <p className={`text-sm ${textSub} mb-5`}>
              작업데스크를 확인하여 완료되면 첨부파일을 받으세요.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className={`px-4 py-2 text-sm rounded ${dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'}`}
              >
                취소
              </button>
              <button
                onClick={handleConfirmStart}
                className="px-4 py-2 text-sm bg-[#03c75a] text-white rounded font-medium hover:bg-[#02a94d]"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
