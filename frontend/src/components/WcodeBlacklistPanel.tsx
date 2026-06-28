import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchWcodeBlacklist, upsertWcodeBlacklist, uploadWcodeBlacklistExcel,
  deleteWcodeBlacklist, matchWcodeBlacklist, processWcodeBlacklist,
  enforceWcodeBlacklist,
  type WcodeBlacklistItem, type WcodeBlacklistMatchResp, type BlacklistMatchRow,
} from '../api/wcodeBlacklistApi';

interface Props {
  open: boolean;
  onClose: () => void;
  dark: boolean;
}

type Tab = 'register' | 'my' | 'pre' | 'oc';

export default function WcodeBlacklistPanel({ open, onClose, dark }: Props) {
  const [items, setItems] = useState<WcodeBlacklistItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [onlyUnprocessed, setOnlyUnprocessed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [codesInput, setCodesInput] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [match, setMatch] = useState<WcodeBlacklistMatchResp | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('register');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleteBusy, setDeleteBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(p => p === m ? '' : p), 3500); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchWcodeBlacklist({ search, only_unprocessed: onlyUnprocessed, per_page: 200 });
      setItems(r.items);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }, [search, onlyUnprocessed]);

  useEffect(() => { if (open) reload(); }, [open, reload]);

  const onUpsert = async () => {
    if (!codesInput.trim()) { flash('W코드를 입력하세요'); return; }
    setBusy(true);
    try {
      const r = await upsertWcodeBlacklist(codesInput, reason);
      if (r.ok) {
        flash(`✅ 신규 ${r.inserted} / 사유보강 ${r.filled} / 유지 ${r.unchanged} (총 ${r.total})`);
        setCodesInput('');
        await reload();
      } else {
        flash(`❌ ${r.error || '등록 실패'}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const r = await uploadWcodeBlacklistExcel(file, reason);
      if (r.ok) {
        flash(
          `📂 엑셀 ${r.parsed}개 파싱 (사유 ${r.with_reason ?? 0}) → ` +
          `신규 ${r.inserted} / 사유보강 ${r.filled} / 유지 ${r.unchanged}`,
        );
        await reload();
      } else {
        flash(`❌ ${r.error || '업로드 실패'}`);
      }
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onUnregister = async (codes: string[]) => {
    if (codes.length === 0) return;
    if (!confirm(`${codes.length}개 W코드를 블랙리스트에서 해제합니다. (상품 자체는 그대로) 진행할까요?`)) return;
    setBusy(true);
    try {
      const r = await deleteWcodeBlacklist(codes);
      flash(`🗑 해제 ${r.deleted}건`);
      await reload();
      setChecked(new Set());
    } finally {
      setBusy(false);
    }
  };

  const onMatch = async () => {
    setMatchBusy(true);
    try {
      const r = await matchWcodeBlacklist(true);
      setMatch(r);
      flash(`🔎 매칭 — 마이 ${r.my.count} / 예비 ${r.preliminary.count} / 오너클랜 ${r.ownerclan.count}`);
      await reload();
      setTab('my');
    } catch (e: unknown) {
      flash(`❌ ${(e as Error).message}`);
    } finally {
      setMatchBusy(false);
    }
  };

  const onEnforce = async () => {
    if (!confirm('블랙리스트 전체 W코드를 마이/예비/오너클랜 DB 에서 일괄 DELETE.\n외부 sync 가 재등록한 행 정리용. 비가역. 진행할까요?')) return;
    setDeleteBusy(true);
    try {
      const r = await enforceWcodeBlacklist();
      if (r.ok) {
        flash(`🛡 일괄 차단 완료 — 마이 ${r.deleted.my} / 예비 ${r.deleted.pre} / 오너클랜 ${r.deleted.oc} (블랙리스트 ${r.total_codes}개 적용)`);
        await onMatch();
      } else {
        flash(`❌ ${r.error || '일괄 차단 실패'}`);
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const onProcess = async () => {
    const codes = Array.from(checked);
    if (codes.length === 0) { flash('체크된 W코드 없음'); return; }
    if (tab === 'register') { flash('매칭 탭(마이/예비/오너클랜)에서 진행하세요'); return; }
    const target = tab as 'my' | 'pre' | 'oc';
    const tgtLabel = ({my:'마이상품', pre:'예비상품', oc:'오너클랜'})[target];
    if (!confirm(`${codes.length}개 W코드를 [${tgtLabel}] DB 에서 행 삭제합니다.\n비가역 작업입니다. 진행할까요?`)) return;
    setDeleteBusy(true);
    try {
      const r = await processWcodeBlacklist(codes, [target]);
      if (r.ok) {
        flash(`🗑 [${tgtLabel}] 삭제 완료 — ${r.deleted[target]}개`);
        setChecked(new Set());
        await onMatch();
      } else {
        flash(`❌ ${r.error || '삭제 실패'}`);
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const C = useMemo(() => dark ? {
    bg: 'bg-[#1c1c2e]', border: 'border-[#2a2a40]',
    text: 'text-white', sub: 'text-gray-400', muted: 'text-gray-500',
    input: 'bg-[#252540] border-[#2a2a40] text-white placeholder-gray-500',
    panel: 'bg-[#252540]', hover: 'hover:bg-[#2a2a45]',
  } : {
    bg: 'bg-white', border: 'border-gray-200',
    text: 'text-gray-900', sub: 'text-gray-600', muted: 'text-gray-500',
    input: 'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
    panel: 'bg-gray-50', hover: 'hover:bg-gray-100',
  }, [dark]);

  if (!open) return null;

  const rowsForTab: BlacklistMatchRow[] = (
    tab === 'my' ? match?.my.items :
    tab === 'pre' ? match?.preliminary.items :
    tab === 'oc' ? match?.ownerclan.items : []
  ) || [];

  const tabCount = (t: Tab): number => {
    if (t === 'my') return match?.my.count ?? 0;
    if (t === 'pre') return match?.preliminary.count ?? 0;
    if (t === 'oc') return match?.ownerclan.count ?? 0;
    return 0;
  };

  const toggleCheck = (code: string) => {
    setChecked(s => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
  };

  const toggleCheckAll = () => {
    const tabCodes = rowsForTab.map(r => r.product_code);
    setChecked(s => {
      const allChecked = tabCodes.every(c => s.has(c));
      const n = new Set(s);
      if (allChecked) { tabCodes.forEach(c => n.delete(c)); }
      else { tabCodes.forEach(c => n.add(c)); }
      return n;
    });
  };

  return (
    <div className="fixed inset-0 z-[80] flex"
         onClick={onClose}>
      {/* 배경 */}
      <div className="flex-1 bg-black/50" />
      {/* 오른쪽 사이드 패널 */}
      <div
        className={`${C.bg} ${C.border} border-l shadow-2xl flex flex-col w-full max-w-[920px] h-full`}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-2.5 border-b ${C.border}`}>
          <div className="flex items-center gap-2">
            <span className="text-base">🚫</span>
            <h2 className={`text-sm font-bold ${C.text}`}>W코드 블랙리스트 상품</h2>
            <span className={`text-xs ${C.muted}`}>총 {total}개 등록</span>
            {match && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${dark ? 'bg-amber-900/40 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                매칭 마이{match.my.count}/예비{match.preliminary.count}/오너클랜{match.ownerclan.count}
              </span>
            )}
          </div>
          <button onClick={onClose} className={`text-2xl ${C.muted} hover:text-rose-500 leading-none`}>×</button>
        </div>

        {msg && (
          <div className={`px-4 py-1 text-xs border-b ${dark ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
            {msg}
          </div>
        )}

        {/* Tabs */}
        <div className={`flex items-center gap-1 px-3 py-1.5 border-b ${C.border} ${C.panel}`}>
          {([
            ['register', '📝 등록/관리', total],
            ['my', '🛍 마이상품', tabCount('my')],
            ['pre', '📦 예비상품', tabCount('pre')],
            ['oc', '🏬 오너클랜', tabCount('oc')],
          ] as Array<[Tab, string, number]>).map(([t, label, cnt]) => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-3 py-1 text-[11px] rounded font-bold ${
                      tab === t
                        ? 'bg-violet-600 text-white'
                        : dark ? 'bg-[#181828] text-gray-400 hover:text-white' : 'bg-white text-gray-500 hover:text-gray-900 border border-gray-200'
                    }`}>
              {label} <span className="opacity-70 font-mono">({cnt})</span>
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={onEnforce}
                  disabled={deleteBusy}
                  title="블랙리스트 전체 W코드를 3개 DB 에서 일괄 DELETE (외부 sync 재등록분 정리)"
                  className="text-[11px] px-2.5 py-1 rounded bg-rose-700 hover:bg-rose-800 text-white font-bold disabled:opacity-40">
            🛡 일괄 차단
          </button>
          <button onClick={onMatch}
                  disabled={matchBusy}
                  className="text-[11px] px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold disabled:opacity-40">
            {matchBusy ? '⏳ 매칭 중...' : '🔎 3-DB 매칭 실행'}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">

          {/* 등록 탭 */}
          {tab === 'register' && (
            <div className="p-3 space-y-3">
              {/* 등록 폼 */}
              <div className={`rounded-lg border-2 p-3 ${dark ? 'border-violet-700 bg-violet-900/10' : 'border-violet-300 bg-violet-50/50'}`}>
                <div className={`text-[11px] font-bold mb-1.5 ${dark ? 'text-violet-300' : 'text-violet-700'}`}>
                  📝 W코드 등록 (쉼표/공백/줄바꿈 구분, 형식 W + hex 6자리)
                </div>
                <textarea
                  value={codesInput}
                  onChange={e => setCodesInput(e.target.value)}
                  rows={3}
                  placeholder="예) W001234 W005678, W00ABCD"
                  className={`${C.input} border rounded w-full px-2 py-1.5 text-xs font-mono`} />
                <div className="flex items-center gap-2 mt-1.5">
                  <input
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="사유 (선택)"
                    className={`${C.input} flex-1 border rounded px-2 py-1 text-xs`} />
                  <button onClick={onUpsert}
                          disabled={busy}
                          className="px-3 py-1 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40">
                    {busy ? '⏳' : '+ 등록'}
                  </button>
                </div>
                <div className={`mt-2 pt-2 border-t ${C.border} flex items-center gap-2`}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
                  <button onClick={() => fileInputRef.current?.click()}
                          disabled={busy}
                          className="px-3 py-1.5 text-xs font-bold rounded bg-blue-600 hover:bg-blue-700 text-white shadow disabled:opacity-40 flex items-center gap-1">
                    📂 엑셀 파일 업로드 (.xlsx)
                  </button>
                  <span className={`text-[10px] ${C.muted} flex-1`}>
                    첫 컬럼 또는 헤더에 <b>W코드</b>/<b>product_code</b> 자동 인식
                  </span>
                </div>
              </div>

              {/* 검색/필터 */}
              <div className="flex items-center gap-2">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="🔍 W코드 검색"
                  className={`${C.input} flex-1 border rounded px-2 py-1 text-xs`} />
                <label className={`flex items-center gap-1 text-[11px] cursor-pointer ${C.sub}`}>
                  <input type="checkbox" checked={onlyUnprocessed}
                         onChange={e => setOnlyUnprocessed(e.target.checked)} />
                  미처리만
                </label>
                <button onClick={reload}
                        className={`px-2 py-1 text-[11px] rounded ${dark ? 'bg-[#252540] text-gray-200 hover:bg-[#2f2f50]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                  🔄
                </button>
              </div>

              {/* 등록 목록 */}
              <div className={`rounded border ${C.border}`}>
                <table className="w-full text-[11px]">
                  <thead className={C.panel}>
                    <tr className={`text-left ${C.muted}`}>
                      <th className="px-2 py-1.5">W코드</th>
                      <th className="px-2 py-1.5">사유</th>
                      <th className="px-2 py-1.5 w-[12%] text-center">출처</th>
                      <th className="px-2 py-1.5 w-[18%]">매칭 (마이/예비/오너)</th>
                      <th className="px-2 py-1.5 w-[14%]">등록일</th>
                      <th className="px-2 py-1.5 w-[60px] text-center">해제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr><td colSpan={6} className={`px-3 py-6 text-center ${C.muted}`}>로딩 중...</td></tr>
                    )}
                    {!loading && items.length === 0 && (
                      <tr><td colSpan={6} className={`px-3 py-6 text-center ${C.muted}`}>등록된 W코드 없음</td></tr>
                    )}
                    {items.map(it => (
                      <tr key={it.product_code}
                          className={`border-t ${C.border} ${C.hover} ${it.is_processed ? 'opacity-50' : ''}`}>
                        <td className={`px-2 py-1 font-mono font-bold ${C.text}`}>
                          {it.is_processed && <span title="처리 완료(삭제됨)" className="mr-1">✅</span>}
                          {it.product_code}
                        </td>
                        <td className={`px-2 py-1 ${C.sub} truncate max-w-[180px]`} title={it.reason || ''}>{it.reason || '—'}</td>
                        <td className="px-2 py-1 text-center">
                          <span className={`text-[9px] px-1 rounded ${
                            it.source === 'excel'
                              ? (dark ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-100 text-blue-700')
                              : (dark ? 'bg-violet-900/40 text-violet-300' : 'bg-violet-100 text-violet-700')
                          }`}>{it.source}</span>
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px]">
                          <span className={it.matched_my ? 'text-emerald-500 font-bold' : C.muted}>{it.matched_my ? 'Y' : '·'}</span>
                          {' / '}
                          <span className={it.matched_pre ? 'text-amber-500 font-bold' : C.muted}>{it.matched_pre ? 'Y' : '·'}</span>
                          {' / '}
                          <span className={it.matched_oc ? 'text-sky-500 font-bold' : C.muted}>{it.matched_oc ? 'Y' : '·'}</span>
                        </td>
                        <td className={`px-2 py-1 font-mono text-[10px] ${C.muted}`}>
                          {it.created_at?.slice(5, 16).replace('T', ' ')}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <button onClick={() => onUnregister([it.product_code])}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white">
                            해제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 매칭 결과 탭 (my/pre/oc 공통) */}
          {tab !== 'register' && (
            <div className="p-3 space-y-2">
              {!match && (
                <div className={`text-center py-10 ${C.muted} text-xs`}>
                  먼저 상단 <b>🔎 3-DB 매칭 실행</b> 버튼을 눌러주세요.
                </div>
              )}
              {match && (
                <>
                  {/* 삭제 액션 바 — 현재 탭이 곧 삭제 대상 */}
                  <div className={`flex items-center gap-2 p-2 rounded border ${C.border} ${C.panel} sticky top-0 z-[2]`}>
                    <button onClick={toggleCheckAll}
                            className={`text-[11px] px-2 py-1 rounded ${dark ? 'bg-[#1c1c2e] text-gray-200' : 'bg-white text-gray-700 border border-gray-200'}`}>
                      ☑ 전체선택
                    </button>
                    <span className={`text-[11px] ${C.sub}`}>체크 {checked.size}개</span>
                    <div className="flex-1" />
                    <div className={`text-[11px] font-bold ${dark ? 'text-rose-300' : 'text-rose-700'}`}>
                      삭제 대상: {({my:'마이상품', pre:'예비상품', oc:'오너클랜'} as const)[tab as 'my'|'pre'|'oc']}
                    </div>
                    <button onClick={onProcess}
                            disabled={deleteBusy || checked.size === 0 || tab === 'register'}
                            className="px-3 py-1 text-[11px] font-bold rounded bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-40">
                      {deleteBusy ? '⏳' : `🗑 체크 ${checked.size}개 삭제`}
                    </button>
                  </div>

                  {/* 매칭 결과 테이블 */}
                  <div className={`rounded border ${C.border}`}>
                    {rowsForTab.length === 0 ? (
                      <div className={`text-center py-10 ${C.muted} text-xs`}>
                        이 탭에 매칭된 상품 없음
                      </div>
                    ) : (
                      <table className="w-full text-[11px]">
                        <thead className={`${C.panel} sticky top-[40px]`}>
                          <tr className={`text-left ${C.muted}`}>
                            <th className="px-2 py-1.5 w-8 text-center"></th>
                            <th className="px-2 py-1.5">W코드</th>
                            <th className="px-2 py-1.5">상품명</th>
                            <th className="px-2 py-1.5">카테고리</th>
                            {tab !== 'my' && <th className="px-2 py-1.5 text-right">가격</th>}
                            {tab === 'oc' && <th className="px-2 py-1.5 text-center">상태</th>}
                            <th className="px-2 py-1.5 w-[12%]">갱신</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rowsForTab.map(r => {
                            const isChecked = checked.has(r.product_code);
                            return (
                              <tr key={`${tab}-${r.id}`}
                                  onClick={() => toggleCheck(r.product_code)}
                                  className={`border-t ${C.border} cursor-pointer ${C.hover} ${isChecked ? (dark ? 'bg-rose-900/20' : 'bg-rose-50') : ''}`}>
                                <td className="px-2 py-1 text-center">
                                  <input type="checkbox" checked={isChecked} onChange={() => toggleCheck(r.product_code)} onClick={e => e.stopPropagation()} />
                                </td>
                                <td className={`px-2 py-1 font-mono font-bold ${C.text}`}>{r.product_code}</td>
                                <td className={`px-2 py-1 ${C.sub} truncate max-w-[280px]`}
                                    title={r.naver_product_name || r.market_product_name || r.product_name || ''}>
                                  {tab === 'my'
                                    ? (r.naver_product_name || r.product_name)
                                    : (r.market_product_name || r.product_name)}
                                </td>
                                <td className={`px-2 py-1 ${C.muted} truncate max-w-[140px]`} title={r.category_name || ''}>
                                  {r.category_name || '—'}
                                </td>
                                {tab !== 'my' && (
                                  <td className={`px-2 py-1 text-right font-mono ${C.sub}`}>
                                    {r.market_price ? r.market_price.toLocaleString() : '—'}
                                  </td>
                                )}
                                {tab === 'oc' && (
                                  <td className="px-2 py-1 text-center font-mono">
                                    {r.sale_status === 1 ? '판매' : r.sale_status === 2 ? '일시품절' : r.sale_status === 3 ? '품절' : '?'}
                                  </td>
                                )}
                                <td className={`px-2 py-1 font-mono text-[10px] ${C.muted}`}>
                                  {r.updated_at?.slice(5, 16).replace('T', ' ')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-4 py-2 border-t ${C.border} ${dark ? 'bg-[#181828]' : 'bg-gray-50'} text-[10px] ${C.muted} text-center`}>
          ⚠ 안전 기본 = 마이상품 DB 행만 삭제. 예비/오너클랜은 명시 체크 시. 마켓(네이버 커머스) API 호출 없음.
        </div>
      </div>
    </div>
  );
}
