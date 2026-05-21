import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchNaverProducts, fetchNaverFolders, syncNaverFolders,
  startImportFrom11st, fetchImportStatus, generateNaverName,
  enqueueGenerate, fetchQueueStatus,
  type NaverProductItem, type NaverProductFolder, type ImportState,
  type QueueStatus,
} from '../api/naverProductApi';

const POLL_MS = 1500;

export default function NaverMyProductsPage() {
  const { dark } = useTheme();
  const [products, setProducts] = useState<NaverProductItem[]>([]);
  const [folders, setFolders] = useState<NaverProductFolder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null); // null = 전체
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [genBusy, setGenBusy] = useState<Set<number>>(new Set());
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const pollRef = useRef<number | null>(null);
  const queuePollRef = useRef<number | null>(null);

  // ── Loaders ──
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchNaverProducts(page, perPage, {
        folder_id: selectedFolderId,
        search: search || undefined,
      });
      setProducts(r.items);
      setTotal(r.total);
      setTotalPages(r.total_pages);
    } catch {
      setProducts([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [page, perPage, selectedFolderId, search]);

  const loadFolders = useCallback(async () => {
    try {
      const r = await fetchNaverFolders();
      setFolders(r.items);
    } catch { /* */ }
  }, []);

  const loadImportStatus = useCallback(async () => {
    try {
      const s = await fetchImportStatus();
      setImportState(s);
      if (!s.running && pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
        // 끝나면 데이터/폴더 리로드
        loadProducts();
        loadFolders();
      }
    } catch { /* */ }
  }, [loadProducts, loadFolders]);

  // ── Effects ──
  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  useEffect(() => { loadImportStatus(); /* mount 시 1회 */ }, [loadImportStatus]);
  useEffect(() => () => { if (pollRef.current != null) window.clearInterval(pollRef.current); }, []);

  // ── Actions ──
  const flash = (m: string, ms = 4500) => {
    setMsg(m);
    window.setTimeout(() => setMsg(prev => prev === m ? '' : prev), ms);
  };

  const onSearch = () => {
    setSearch(searchInput.trim());
    setPage(1);
  };

  const onImport = async () => {
    if (importState?.running) return;
    if (!confirm('11번가 ads.my_product 전체(약 20만건)를 가져옵니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await startImportFrom11st(2000);
      if (!r.ok) {
        flash(`가져오기 실패: ${r.error || 'unknown'}`);
      } else {
        setImportState(r.state);
        // 폴링 시작
        if (pollRef.current != null) window.clearInterval(pollRef.current);
        pollRef.current = window.setInterval(loadImportStatus, POLL_MS);
      }
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const loadQueueStatus = useCallback(async () => {
    try {
      setQueueStatus(await fetchQueueStatus());
    } catch { /* */ }
  }, []);

  useEffect(() => { loadQueueStatus(); }, [loadQueueStatus]);
  useEffect(() => {
    // 큐에 항목 있으면 3초 폴링, 비면 30초
    const hasWork = (queueStatus?.pending || 0) + (queueStatus?.running || 0) > 0;
    if (queuePollRef.current != null) window.clearInterval(queuePollRef.current);
    queuePollRef.current = window.setInterval(loadQueueStatus, hasWork ? 3000 : 30000);
    return () => { if (queuePollRef.current != null) window.clearInterval(queuePollRef.current); };
  }, [queueStatus?.pending, queueStatus?.running, loadQueueStatus]);

  const onEnqueueFolder = async () => {
    if (selectedFolderId == null) {
      flash('폴더를 선택하세요 (좌측 사이드바)');
      return;
    }
    if (!confirm('현재 선택 폴더의 미생성 상품을 모두 큐에 추가합니다. 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await enqueueGenerate({ folder_id: selectedFolderId, only_missing: true });
      flash(`✅ 큐 ${r.queued}건 추가 (요청 ${r.requested}, 이미큐 ${r.already_queued || 0})`);
      loadQueueStatus();
    } catch (e: unknown) {
      flash(`❌ 큐 추가 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onEnqueueAllMissing = async () => {
    if (!confirm('빠진 상품명 전체를 큐에 추가합니다. (수만 건일 수 있음) 진행할까요?')) return;
    setBusy(true);
    try {
      const r = await enqueueGenerate({ only_missing: true });
      flash(`✅ 큐 ${r.queued}건 추가 (전체 미생성 ${r.requested}건)`);
      loadQueueStatus();
    } catch (e: unknown) {
      flash(`❌ 큐 추가 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onGenerateName = async (p: NaverProductItem) => {
    setGenBusy(prev => { const n = new Set(prev); n.add(p.id); return n; });
    try {
      const r = await generateNaverName(p.id);
      if (r.ok && r.naver_product_name) {
        setProducts(prev => prev.map(x =>
          x.id === p.id ? { ...x, naver_product_name: r.naver_product_name! } : x
        ));
        flash(`✅ ${p.product_code}: ${r.naver_product_name} (${r.byte_length}B / ${r.elapsed_ms}ms / ${r.model})`);
      } else {
        flash(`❌ ${p.product_code} 생성 실패: ${r.error || 'unknown'}`);
      }
    } catch (e: unknown) {
      flash(`❌ ${p.product_code} 에러: ${(e as Error).message}`);
    } finally {
      setGenBusy(prev => { const n = new Set(prev); n.delete(p.id); return n; });
    }
  };

  const onSyncFolders = async () => {
    setBusy(true);
    try {
      const r = await syncNaverFolders();
      flash(`폴더 동기화: 생성 ${r.folders_created} / 갱신 ${r.folders_updated} (총 ${r.stores_total}개 스토어)`);
      await loadFolders();
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const totalProducts = useMemo(
    () => folders.reduce((s, f) => s + f.product_count, 0),
    [folders],
  );

  // ── 색상 클래스 (다크/라이트 분기) ──
  const C = dark ? {
    bg: 'bg-[#0f0f1a]',
    panel: 'bg-[#1c1c2e]',
    border: 'border-[#2a2a40]',
    text: 'text-white',
    sub: 'text-gray-400',
    muted: 'text-gray-500',
    tableHead: 'bg-[#252540] text-gray-300',
    rowHover: 'hover:bg-[#252540]',
    input: 'bg-[#252540] border-[#2a2a40] text-white placeholder-gray-500',
    folderActive: 'bg-[#03c75a]/20 border-[#03c75a] text-white',
    folderIdle: 'border-[#2a2a40] text-gray-300 hover:bg-[#252540]',
  } : {
    bg: 'bg-[#f7f8fa]',
    panel: 'bg-white',
    border: 'border-gray-200',
    text: 'text-gray-900',
    sub: 'text-gray-600',
    muted: 'text-gray-500',
    tableHead: 'bg-gray-100 text-gray-700',
    rowHover: 'hover:bg-gray-50',
    input: 'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
    folderActive: 'bg-[#03c75a]/15 border-[#03c75a] text-gray-900',
    folderIdle: 'border-gray-200 text-gray-700 hover:bg-gray-50',
  };

  const ip = importState;
  const ipPct = ip && ip.total > 0 ? Math.round((ip.processed / ip.total) * 100) : 0;

  return (
    <div className={`${C.bg} min-h-[calc(100vh-42px)] p-4`}>
      {/* Header */}
      <div className={`${C.panel} ${C.border} border rounded-lg p-3 mb-3 flex flex-wrap items-center gap-2`}>
        <div className="flex items-center gap-2">
          <span className="text-lg">🛒</span>
          <h1 className={`text-base font-bold ${C.text}`}>네이버상품목록</h1>
          <span className={`text-xs ${C.muted}`}>총 <b className={C.text}>{total.toLocaleString()}</b>건 / 폴더합계 {totalProducts.toLocaleString()}건</span>
        </div>

        <div className="flex-1" />

        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSearch(); }}
          placeholder="W코드 / 상품명 / AI상품명 검색"
          className={`${C.input} border rounded px-2 py-1 text-xs w-64`}
        />
        <button onClick={onSearch}
                className="px-3 py-1 text-xs font-bold rounded bg-gray-600 hover:bg-gray-700 text-white">
          검색
        </button>

        <button
          onClick={onSyncFolders}
          disabled={busy || ip?.running}
          title="myproduct.smartstoreIdList 활성 스토어를 폴더로 동기화"
          className="px-3 py-1 text-xs font-bold rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40"
        >
          📁 폴더 동기화
        </button>

        <button
          onClick={onImport}
          disabled={busy || ip?.running}
          className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
          title="ads.my_product 전체 → naverdb.naver_my_product UPSERT"
        >
          {ip?.running ? '⏳ 가져오는 중...' : '⬇ 11번가 나의상품 가져오기'}
        </button>

        <button
          onClick={onEnqueueFolder}
          disabled={busy || selectedFolderId == null}
          title="현재 선택 폴더의 빠진 상품명을 워커 큐에 추가"
          className="px-3 py-1.5 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
        >
          🤖 폴더 일괄 생성
        </button>

        <button
          onClick={onEnqueueAllMissing}
          disabled={busy}
          title="모든 폴더의 빠진 상품명을 워커 큐에 추가"
          className="px-3 py-1.5 text-xs font-bold rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
        >
          🤖 전체 빠진 것 생성
        </button>
      </div>

      {/* Queue status card */}
      {queueStatus && (queueStatus.pending + queueStatus.running + queueStatus.done_recent + queueStatus.error > 0) && (
        <div className={`${C.panel} ${C.border} border rounded-lg p-3 mb-3 flex flex-wrap items-center gap-3`}>
          <span className="text-lg">⚙️</span>
          <span className={`text-xs ${C.text} font-bold`}>워커 큐</span>
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded ${queueStatus.pending > 0 ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : C.muted}`}>
              대기 <b>{queueStatus.pending.toLocaleString()}</b>
            </span>
            <span className={`px-1.5 py-0.5 rounded ${queueStatus.running > 0 ? 'bg-sky-500/20 text-sky-600 dark:text-sky-400 animate-pulse' : C.muted}`}>
              진행 <b>{queueStatus.running.toLocaleString()}</b>
            </span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
              완료(1h) <b>{queueStatus.done_recent.toLocaleString()}</b>
            </span>
            {queueStatus.error > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-600 dark:text-rose-400">
                에러 <b>{queueStatus.error}</b>
              </span>
            )}
          </div>
          {queueStatus.by_worker.length > 0 && (
            <div className="flex items-center gap-1 ml-auto flex-wrap">
              {queueStatus.by_worker.map(w => (
                <span key={w.endpoint}
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        w.running > 0
                          ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300 animate-pulse'
                          : 'bg-gray-500/10 ' + C.muted
                      }`}
                      title={`${w.endpoint} — 진행 ${w.running} / 완료 ${w.done}`}>
                  {w.endpoint.replace(/^.*?(\d+)[.:]\d+$/, '$1')}{w.running > 0 ? '⏳' : ''} {w.done}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Import progress bar */}
      {ip && (ip.running || (ip.finished_at && ip.error == null)) && (
        <div className={`${C.panel} ${C.border} border rounded-lg p-3 mb-3`}>
          <div className="flex items-center justify-between mb-1.5">
            <div className={`text-xs ${C.text}`}>
              {ip.running ? '진행 중' : '완료'} —
              {' '}<b>{ip.processed.toLocaleString()}</b> / {ip.total.toLocaleString()}건
              {' '}(신규 <b>{ip.inserted.toLocaleString()}</b> / 갱신 <b>{ip.updated.toLocaleString()}</b>)
            </div>
            <div className={`text-xs ${C.muted}`}>{ipPct}%</div>
          </div>
          <div className={`h-2 rounded overflow-hidden ${dark ? 'bg-[#252540]' : 'bg-gray-200'}`}>
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${ipPct}%` }} />
          </div>
          {ip.message && <div className={`text-[11px] mt-1.5 ${C.muted}`}>{ip.message}</div>}
        </div>
      )}
      {ip?.error && (
        <div className="bg-rose-50 dark:bg-rose-900/30 border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 text-xs rounded p-2 mb-3">
          가져오기 에러: {ip.error}
        </div>
      )}
      {msg && (
        <div className="bg-violet-50 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-xs rounded p-2 mb-3">
          {msg}
        </div>
      )}

      <div className="flex gap-3">
        {/* 좌측: 폴더 사이드바 (네이버 ID = 스마트스토어) */}
        <aside className={`${C.panel} ${C.border} border rounded-lg p-2 w-56 shrink-0 h-[calc(100vh-180px)] overflow-y-auto`}>
          <div className={`text-xs font-bold ${C.text} px-1 py-1 flex items-center justify-between`}>
            <span>폴더 (네이버 ID)</span>
            <span className={`text-[10px] ${C.muted}`}>{folders.length}개</span>
          </div>
          <button
            onClick={() => { setSelectedFolderId(null); setPage(1); }}
            className={`w-full mt-1 mb-1 border rounded px-2 py-1.5 text-xs text-left flex items-center justify-between ${
              selectedFolderId == null ? C.folderActive : C.folderIdle
            }`}
          >
            <span>전체</span>
            <span className={`text-[10px] ${C.muted}`}>{totalProducts.toLocaleString()}</span>
          </button>
          <div className="flex flex-col gap-0.5">
            {folders.map(f => (
              <button
                key={f.id}
                onClick={() => { setSelectedFolderId(f.id); setPage(1); }}
                className={`border rounded px-2 py-1.5 text-xs text-left flex items-center justify-between gap-1 ${
                  selectedFolderId === f.id ? C.folderActive : C.folderIdle
                }`}
                title={f.store_id ? `store_id=${f.store_id}` : '미분류'}
              >
                <span className="truncate flex items-center gap-1">
                  {f.is_system === 1 && <span className="text-[10px]">📦</span>}
                  {f.name}
                </span>
                <span className={`text-[10px] ${C.muted}`}>{f.product_count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* 우측: 상품 테이블 */}
        <main className={`${C.panel} ${C.border} border rounded-lg flex-1 overflow-hidden flex flex-col`}>
          <div className={`flex items-center gap-2 px-3 py-2 border-b ${C.border}`}>
            <span className={`text-xs ${C.muted}`}>표시:</span>
            <select
              value={perPage}
              onChange={e => { setPerPage(Number(e.target.value)); setPage(1); }}
              className={`${C.input} border rounded px-1.5 py-0.5 text-xs`}
            >
              {[20, 50, 100, 200].map(n => <option key={n} value={n}>{n}건</option>)}
            </select>
            <div className="flex-1" />
            {/* 페이지네이션 */}
            <div className="flex items-center gap-1">
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                      className={`px-2 py-0.5 text-xs border rounded ${C.border} ${C.text} disabled:opacity-30`}>◀</button>
              <span className={`text-xs ${C.muted} min-w-[80px] text-center`}>
                {page.toLocaleString()} / {totalPages.toLocaleString() || 1}
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                      className={`px-2 py-0.5 text-xs border rounded ${C.border} ${C.text} disabled:opacity-30`}>▶</button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className={`text-center py-10 text-xs ${C.muted}`}>로딩 중...</div>
            ) : products.length === 0 ? (
              <div className={`text-center py-10 text-xs ${C.muted}`}>
                {total === 0 && !ip?.finished_at
                  ? '데이터 없음 — 우측 상단 [⬇ 11번가 나의상품 가져오기] 를 먼저 실행하세요'
                  : '결과 없음'}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className={`${C.tableHead} sticky top-0 z-10`}>
                  <tr>
                    <th className="text-left px-2 py-1.5 font-bold">이미지</th>
                    <th className="text-left px-2 py-1.5 font-bold">W코드</th>
                    <th className="text-left px-2 py-1.5 font-bold">상품명</th>
                    <th className="text-left px-2 py-1.5 font-bold">AI상품명</th>
                    <th className="text-left px-2 py-1.5 font-bold">네이버상품명</th>
                    <th className="text-left px-2 py-1.5 font-bold">카테고리</th>
                    <th className="text-right px-2 py-1.5 font-bold">판매가</th>
                    <th className="text-right px-2 py-1.5 font-bold">오너클랜가</th>
                    <th className="text-left px-2 py-1.5 font-bold">폴더</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map(p => {
                    const folder = folders.find(f => f.id === p.folder_id);
                    return (
                      <tr key={p.id} className={`border-t ${C.border} ${C.rowHover} ${C.text}`}>
                        <td className="px-2 py-1">
                          {p.image_small ? (
                            <img src={p.image_small} alt="" className="w-10 h-10 object-cover rounded" loading="lazy" />
                          ) : (
                            <div className={`w-10 h-10 rounded ${dark ? 'bg-[#252540]' : 'bg-gray-200'}`} />
                          )}
                        </td>
                        <td className={`px-2 py-1 font-mono text-[11px] ${C.sub}`}>{p.product_code}</td>
                        <td className="px-2 py-1 max-w-[280px]">
                          <div className="truncate" title={p.product_name || ''}>{p.product_name}</div>
                        </td>
                        <td className="px-2 py-1 max-w-[260px]">
                          <div className="truncate" title={p.ai_recommended_name || p.ai_product_name || ''}>
                            {p.ai_recommended_name || p.ai_product_name || <span className={C.muted}>—</span>}
                          </div>
                        </td>
                        <td className="px-2 py-1 max-w-[280px]">
                          <div className="flex items-center gap-1.5">
                            <div className="truncate flex-1" title={p.naver_product_name || ''}>
                              {p.naver_product_name || <span className={C.muted}>—</span>}
                            </div>
                            <button
                              onClick={() => onGenerateName(p)}
                              disabled={genBusy.has(p.id)}
                              title={p.naver_product_name ? '재생성' : '네이버 상품명 생성'}
                              className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {genBusy.has(p.id) ? '⏳' : '🤖'}
                            </button>
                          </div>
                        </td>
                        <td className={`px-2 py-1 text-[11px] ${C.sub} max-w-[200px]`}>
                          <div className="truncate" title={p.category_name || ''}>{p.category_name}</div>
                        </td>
                        <td className="px-2 py-1 text-right">{p.market_price?.toLocaleString() || 0}</td>
                        <td className={`px-2 py-1 text-right ${C.sub}`}>{p.ownerclan_price?.toLocaleString() || 0}</td>
                        <td className={`px-2 py-1 text-[11px] ${C.sub}`}>{folder?.name || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
