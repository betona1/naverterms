import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchPowerWorkers, fetchPowerStatus, powerWake, powerShutdown,
  type PowerGroup, type PowerHost, type PowerStatusRow,
} from '../api/powerApi';

interface Props {
  onClose: () => void;
}

const POLL_MS = 10000;

export default function PowerControlModal({ onClose }: Props) {
  const [groups, setGroups] = useState<PowerGroup[]>([]);
  const [status, setStatus] = useState<Record<string, PowerStatusRow>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, 'wake' | 'shutdown' | null>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string>('');
  const [bulkRunning, setBulkRunning] = useState<'wake' | 'shutdown' | null>(null);

  const flash = (m: string, ms = 4500) => {
    setMsg(m);
    window.setTimeout(() => setMsg(prev => (prev === m ? '' : prev)), ms);
  };

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetchPowerStatus();
      const map: Record<string, PowerStatusRow> = {};
      for (const h of r.hosts) map[h.key] = h;
      setStatus(map);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [w] = await Promise.all([fetchPowerWorkers(), loadStatus()]);
        if (alive) setGroups(w.groups);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const id = window.setInterval(loadStatus, POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [loadStatus]);

  const allHosts: PowerHost[] = useMemo(() => groups.flatMap(g => g.hosts), [groups]);

  const toggleChecked = (key: string) => {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key); else next.add(key);
    setChecked(next);
  };
  const setCheckedAll = (keys: string[], on: boolean) => {
    const next = new Set(checked);
    if (on) keys.forEach(k => next.add(k));
    else keys.forEach(k => next.delete(k));
    setChecked(next);
  };

  const doWake = async (key: string, name: string) => {
    setBusy(prev => ({ ...prev, [key]: 'wake' }));
    try {
      const r = await powerWake(key);
      if (r.ok) flash(`⚡ ${name} 매직 패킷 전송 (${r.sent_packets}회)`);
      else flash(`Wake 실패 (${name}): ${r.error || 'unknown'}`);
    } catch (e: unknown) {
      flash(`Wake 실패 (${name}): ${(e as Error).message}`);
    } finally {
      setBusy(prev => ({ ...prev, [key]: null }));
    }
  };

  const doShutdown = async (key: string, name: string) => {
    setBusy(prev => ({ ...prev, [key]: 'shutdown' }));
    try {
      const r = await powerShutdown(key);
      if (r.ok) flash(`🛑 ${name} 1분 후 종료 예약`);
      else flash(`Off 실패 (${name}): ${r.error || 'agent 응답 없음'}`);
    } catch (e: unknown) {
      flash(`Off 실패 (${name}): ${(e as Error).message}`);
    } finally {
      setBusy(prev => ({ ...prev, [key]: null }));
    }
  };

  // ===== 일괄 액션 =====
  const bulkWake = async () => {
    const targets = allHosts.filter(h => checked.has(h.key) && h.wol_enabled);
    const skipped = allHosts.filter(h => checked.has(h.key) && !h.wol_enabled);
    if (targets.length === 0) {
      flash('Wake 대상 없음 — 선택한 호스트가 모두 WOL 비활성입니다');
      return;
    }
    if (!confirm(`선택한 ${targets.length}대에 매직 패킷을 전송합니다.${skipped.length ? ` (WOL 비활성 ${skipped.length}대 스킵)` : ''}\n진행할까요?`)) return;
    setBulkRunning('wake');
    let ok = 0, ng = 0;
    for (const h of targets) {
      try {
        const r = await powerWake(h.key);
        if (r.ok) ok++; else ng++;
      } catch { ng++; }
    }
    setBulkRunning(null);
    flash(`⚡ 일괄 Wake 완료 — 성공 ${ok} / 실패 ${ng}${skipped.length ? ` / 스킵 ${skipped.length}` : ''}`);
    window.setTimeout(loadStatus, 3000);
  };

  const bulkShutdown = async () => {
    const allChecked = allHosts.filter(h => checked.has(h.key));
    const windows = allChecked.filter(h => h.os === 'windows');
    const targets = allChecked.filter(h => h.shutdown_enabled && status[h.key]?.alive);
    const offline = allChecked.filter(h => h.shutdown_enabled && !status[h.key]?.alive);

    // 윈도우만 선택된 경우 → 메시지만 띄우고 종료
    if (windows.length > 0 && targets.length === 0) {
      flash(`⚠ 윈도우 PC ${windows.length}대 (${windows.map(h => h.name).join(', ')})는 종료 미구현입니다. (Wake만 가능)`, 7000);
      return;
    }
    if (targets.length === 0) {
      flash('Off 대상 없음 — 선택한 호스트가 모두 종료 불가 (꺼져있음 또는 미구현)');
      return;
    }

    const parts: string[] = [`선택한 호스트 중 ${targets.length}대를 1분 후 종료합니다.`];
    if (windows.length) parts.push(`⚠ 윈도우 ${windows.length}대 (${windows.map(h => h.name).join(', ')})는 종료 미구현 → 스킵`);
    if (offline.length) parts.push(`꺼져있는 ${offline.length}대 → 스킵`);
    parts.push('\n진행할까요?');
    if (!confirm(parts.join('\n'))) return;

    setBulkRunning('shutdown');
    let ok = 0, ng = 0;
    for (const h of targets) {
      try {
        const r = await powerShutdown(h.key);
        if (r.ok) ok++; else ng++;
      } catch { ng++; }
    }
    setBulkRunning(null);
    flash(`🛑 일괄 Off 완료 — 성공 ${ok} / 실패 ${ng}${windows.length ? ` / 윈도우스킵 ${windows.length}` : ''}${offline.length ? ` / 꺼짐스킵 ${offline.length}` : ''}`, 6000);
    window.setTimeout(loadStatus, 3000);
  };

  const summary = useMemo(() => {
    let alive = 0, dead = 0, total = 0;
    for (const h of allHosts) {
      total += 1;
      if (status[h.key]?.alive) alive += 1; else dead += 1;
    }
    return { alive, dead, total };
  }, [allHosts, status]);

  const checkedHostList = allHosts.filter(h => checked.has(h.key));
  const allKeys = allHosts.map(h => h.key);
  const allOn = allKeys.length > 0 && allKeys.every(k => checked.has(k));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[88vh] flex flex-col border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white rounded-t-xl">
          <div className="flex items-center gap-3">
            <span className="text-xl">⚡</span>
            <h2 className="text-base font-bold">원격 전원 관리</h2>
            <span className="text-[11px] text-white/80">
              ● 가동 <b>{summary.alive}</b> · ○ 종료 <b>{summary.dead}</b> · 총 <b>{summary.total}</b>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-white cursor-pointer select-none px-2 py-1 rounded bg-white/15 hover:bg-white/25">
              <input
                type="checkbox"
                checked={allOn}
                onChange={(e) => setCheckedAll(allKeys, e.target.checked)}
                className="accent-white"
              />
              전체선택
            </label>
            <button
              onClick={loadStatus}
              className="text-[11px] px-2 py-1 rounded bg-white/15 hover:bg-white/25 text-white"
              title="상태 즉시 갱신"
            >🔄</button>
            <button onClick={onClose} className="text-white/80 hover:text-white text-xl leading-none px-1">&times;</button>
          </div>
        </div>

        {/* Toast */}
        {msg && (
          <div className="px-5 py-1.5 text-xs bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-b border-violet-200 dark:border-violet-800">
            {msg}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="text-center text-sm text-gray-400 py-10">로딩 중...</div>
          ) : groups.length === 0 ? (
            <div className="text-center text-sm text-gray-400 py-10">등록된 호스트 없음</div>
          ) : groups.map(g => {
            const groupKeys = g.hosts.map(h => h.key);
            const groupAllOn = groupKeys.every(k => checked.has(k));
            return (
              <section key={g.key}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{g.icon}</span>
                  <h3 className="text-sm font-bold text-gray-800 dark:text-gray-200">{g.label}</h3>
                  <span className="text-[11px] text-gray-500">({g.hosts.length})</span>
                  <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={groupAllOn}
                      onChange={(e) => setCheckedAll(groupKeys, e.target.checked)}
                    />
                    그룹 전체
                  </label>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {g.hosts.map(h => {
                    const st = status[h.key];
                    const alive = st?.alive;
                    const b = busy[h.key];
                    const isChecked = checked.has(h.key);
                    return (
                      <div
                        key={h.key}
                        className={`relative rounded-lg border p-3 transition-all ${
                          isChecked
                            ? 'border-violet-400 dark:border-violet-500 ring-2 ring-violet-200 dark:ring-violet-800/60 bg-violet-50/50 dark:bg-violet-900/20'
                            : alive
                              ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/15'
                              : 'border-gray-300 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/40'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleChecked(h.key)}
                            className="accent-violet-600 cursor-pointer"
                            title="선택"
                          />
                          <span className={`w-2.5 h-2.5 rounded-full ${
                            alive == null ? 'bg-gray-400'
                            : alive       ? 'bg-emerald-500 animate-pulse'
                                          : 'bg-gray-400'
                          }`} />
                          <span className="font-bold text-[13px] text-gray-800 dark:text-gray-200">{h.name}</span>
                          <span className="ml-auto text-[10px] text-gray-500 font-mono">.{h.key}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono mb-2">{h.ip}</div>
                        {h.note && (
                          <div className="text-[10px] text-gray-500 dark:text-gray-400 mb-2 line-clamp-1" title={h.note}>{h.note}</div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <button
                            disabled={!h.wol_enabled || b !== null || bulkRunning !== null}
                            onClick={() => doWake(h.key, h.name)}
                            className="flex-1 px-2 py-1 text-[11px] font-bold rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                            title={h.wol_enabled ? 'WOL 매직 패킷 전송' : 'WOL 비활성 (MAC 미등록 또는 노트북)'}
                          >
                            {b === 'wake' ? '...' : '⚡ Wake'}
                          </button>
                          <button
                            disabled={b !== null || bulkRunning !== null}
                            onClick={() => {
                              if (!h.shutdown_enabled) {
                                if (h.os === 'windows') flash(`⚠ ${h.name} — 윈도우 PC 종료는 아직 미구현입니다.`);
                                else flash(`⚠ ${h.name} — 종료 비활성 호스트입니다.`);
                                return;
                              }
                              if (!alive) { flash(`${h.name}: 꺼져있어 종료할 수 없습니다.`); return; }
                              if (!confirm(`${h.name} 을(를) 1분 후 종료합니다. 진행할까요?`)) return;
                              doShutdown(h.key, h.name);
                            }}
                            className={`flex-1 px-2 py-1 text-[11px] font-bold rounded text-white disabled:opacity-40 disabled:cursor-not-allowed ${
                              h.shutdown_enabled && alive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-gray-400 hover:bg-gray-500'
                            }`}
                            title={
                              !h.shutdown_enabled ? (h.os === 'windows' ? '윈도우 종료 미구현' : '종료 비활성')
                              : !alive ? '꺼져있음'
                              : '1분 후 종료 (agent)'
                            }
                          >
                            {b === 'shutdown' ? '...' : '🛑 Off'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          <div className="text-[10px] text-gray-400 pt-2 border-t border-gray-200 dark:border-gray-700">
            상태는 10초마다 자동 갱신. 윈도우 PC 종료는 추후 개발 — 현재 ⚡ Wake 만 가능.
          </div>
        </div>

        {/* Footer — 일괄 액션 */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 bg-gray-50 dark:bg-gray-800/60 rounded-b-xl flex items-center gap-3">
          <div className="text-xs text-gray-600 dark:text-gray-300">
            선택 <b className="text-violet-600 dark:text-violet-300">{checkedHostList.length}</b>대
            {checkedHostList.length > 0 && (
              <span className="ml-2 text-[10px] text-gray-500">({checkedHostList.map(h => h.name).join(', ')})</span>
            )}
          </div>
          <button
            disabled={checkedHostList.length === 0 || bulkRunning !== null}
            onClick={() => setChecked(new Set())}
            className="ml-auto px-3 py-1.5 text-xs rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40"
          >해제</button>
          <button
            disabled={checkedHostList.length === 0 || bulkRunning !== null}
            onClick={bulkWake}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {bulkRunning === 'wake' ? '⚡ 진행 중...' : `⚡ 선택 Wake (${checkedHostList.length})`}
          </button>
          <button
            disabled={checkedHostList.length === 0 || bulkRunning !== null}
            onClick={bulkShutdown}
            className="px-3 py-1.5 text-xs rounded bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {bulkRunning === 'shutdown' ? '🛑 진행 중...' : `🛑 선택 Off (${checkedHostList.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
