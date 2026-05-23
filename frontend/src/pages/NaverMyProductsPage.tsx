import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchNaverProducts, fetchNaverFolders, syncNaverFolders,
  startImportFrom11st, fetchImportStatus, generateNaverName,
  enqueueGenerate, fetchQueueStatus, moveNaverProducts,
  fetchNaverProductDetail, patchNaverProduct, clearVisionCache,
  fetchKeywordPool, fetchRelatedKeywords, fetchRelatedKeywordsMulti, fetchKeywordRelevance,
  type NaverProductItem, type NaverProductFolder, type ImportState,
  type QueueStatus, type NaverProductDetail, type KeywordPool,
  type RelatedKeyword,
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [salesMode, setSalesMode] = useState(false);
  const pollRef = useRef<number | null>(null);
  const queuePollRef = useRef<number | null>(null);

  // ── Loaders ──
  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchNaverProducts(page, perPage, {
        folder_id: salesMode ? null : selectedFolderId,
        search: search || undefined,
        sort: salesMode ? 'sales' : undefined,
        include_sales: salesMode,
      });
      setProducts(r.items);
      setTotal(r.total);
      setTotalPages(r.total_pages);
    } catch {
      setProducts([]); setTotal(0); setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [page, perPage, selectedFolderId, search, salesMode]);

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

  const onMoveTo = async (folderId: number) => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const r = await moveNaverProducts(Array.from(selected), folderId);
      if (r.ok) {
        const folder = folders.find(f => f.id === folderId);
        flash(`📁 ${r.moved}개 → ${folder?.name || folderId} 이동`);
        setSelected(new Set());
        setMoveModalOpen(false);
        loadProducts();
        loadFolders();
      } else {
        flash(`이동 실패: ${r.error || 'unknown'}`);
      }
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePageAll = (on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (on) products.forEach(p => next.add(p.id));
      else products.forEach(p => next.delete(p.id));
      return next;
    });
  };

  // 폴더/검색 바뀌면 선택 해제
  useEffect(() => { setSelected(new Set()); }, [selectedFolderId, search, salesMode]);

  const onEnqueueTopSales = async (n: number) => {
    if (!confirm(`매출 상위 ${n}개 상품을 워커 큐에 추가합니다.\n(워커 11개로 처리, 약 ${Math.round(n * 0.6)}초 예상)`)) return;
    setBusy(true);
    try {
      const r = await enqueueGenerate({ top_sales: n, only_missing: false });
      flash(`📊 매출 상위 ${n} → 큐 ${r.queued}건 추가 (이미생성 ${r.requested - r.queued})`);
      loadQueueStatus();
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

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

        <button
          onClick={() => setMoveModalOpen(true)}
          disabled={busy || selected.size === 0}
          title="선택된 상품을 다른 폴더로 이동"
          className="px-3 py-1.5 text-xs font-bold rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
        >
          📁 폴더 이동{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>

        <label className={`flex items-center gap-1 text-xs cursor-pointer select-none px-2 py-1 rounded border ${
          salesMode
            ? 'bg-rose-500/20 border-rose-400 text-rose-700 dark:text-rose-300 font-bold'
            : `${C.border} ${C.sub} hover:${C.text}`
        }`}>
          <input type="checkbox" checked={salesMode}
                 onChange={e => { setSalesMode(e.target.checked); setPage(1); }} />
          📊 매출 정렬
        </label>

        <button
          onClick={() => onEnqueueTopSales(500)}
          disabled={busy}
          title="매출 상위 500개를 모두 워커 큐에 추가 (이미 생성된 것도 강제 재생성)"
          className="px-3 py-1.5 text-xs font-bold rounded bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
        >
          📊 매출 TOP500 생성
        </button>

        <button
          onClick={() => {
            const params = new URLSearchParams();
            if (salesMode) {
              const n = prompt('엑셀로 내보낼 매출 상위 N건 (예: 100, 500, 1000):', '500');
              if (!n) return;
              params.set('top_sales', n);
            } else {
              if (selectedFolderId != null) params.set('folder_id', String(selectedFolderId));
              if (search) params.set('search', search);
              params.set('limit', '5000');
            }
            window.location.href = `/api/smartstore/naver-products/excel/?${params.toString()}`;
          }}
          disabled={busy}
          title="현재 필터/정렬 그대로 엑셀 다운로드 (매출 모드면 TOP N 입력)"
          className="px-3 py-1.5 text-xs font-bold rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed shadow"
        >
          📥 엑셀
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
                    <th className="px-2 py-1.5 w-8">
                      <input
                        type="checkbox"
                        checked={products.length > 0 && products.every(p => selected.has(p.id))}
                        onChange={e => togglePageAll(e.target.checked)}
                        title="페이지 전체 선택/해제"
                      />
                    </th>
                    {salesMode && <th className="text-right px-2 py-1.5 font-bold">순위</th>}
                    <th className="text-left px-2 py-1.5 font-bold">이미지</th>
                    <th className="text-left px-2 py-1.5 font-bold">W코드</th>
                    <th className="text-left px-2 py-1.5 font-bold">상품명</th>
                    {salesMode && <th className="text-right px-2 py-1.5 font-bold">총 매출</th>}
                    {salesMode && <th className="text-right px-2 py-1.5 font-bold">판매수량</th>}
                    <th className="text-left px-2 py-1.5 font-bold">AI상품명</th>
                    <th className="text-left px-2 py-1.5 font-bold">네이버상품명</th>
                    {!salesMode && <th className="text-left px-2 py-1.5 font-bold">카테고리</th>}
                    {!salesMode && <th className="text-right px-2 py-1.5 font-bold">판매가</th>}
                    {!salesMode && <th className="text-right px-2 py-1.5 font-bold">오너클랜가</th>}
                    <th className="text-left px-2 py-1.5 font-bold">폴더</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p, idx) => {
                    const folder = folders.find(f => f.id === p.folder_id);
                    const isSelected = selected.has(p.id);
                    const rank = salesMode ? (page - 1) * perPage + idx + 1 : null;
                    return (
                      <tr key={p.id} className={`border-t ${C.border} ${C.rowHover} ${C.text} ${
                        isSelected ? (dark ? 'bg-amber-900/20' : 'bg-amber-50') : ''
                      }`}>
                        <td className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelected(p.id)}
                          />
                        </td>
                        {salesMode && (
                          <td className={`px-2 py-1 text-right font-bold ${
                            rank! <= 3 ? 'text-rose-500' : rank! <= 10 ? 'text-amber-500' : C.sub
                          }`}>
                            {rank}
                          </td>
                        )}
                        <td className="px-2 py-1 cursor-pointer" onClick={() => setDetailId(p.id)}>
                          {p.image_small ? (
                            <img src={p.image_small} alt="" className="w-10 h-10 object-cover rounded hover:ring-2 hover:ring-emerald-400" loading="lazy" />
                          ) : (
                            <div className={`w-10 h-10 rounded ${dark ? 'bg-[#252540]' : 'bg-gray-200'}`} />
                          )}
                        </td>
                        <td className={`px-2 py-1 font-mono text-[11px] ${C.sub}`}>{p.product_code}</td>
                        <td className="px-2 py-1 max-w-[280px] cursor-pointer" onClick={() => setDetailId(p.id)}>
                          <div className="truncate hover:underline" title={p.product_name || ''}>{p.product_name}</div>
                        </td>
                        {salesMode && (
                          <td className="px-2 py-1 text-right font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                            {p.sales ? `${p.sales.total_amount.toLocaleString()}원` : '—'}
                          </td>
                        )}
                        {salesMode && (
                          <td className={`px-2 py-1 text-right ${C.sub}`}>
                            {p.sales ? p.sales.total_quantity.toLocaleString() : '—'}
                          </td>
                        )}
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
                        {!salesMode && (
                          <td className={`px-2 py-1 text-[11px] ${C.sub} max-w-[200px]`}>
                            <div className="truncate" title={p.category_name || ''}>{p.category_name}</div>
                          </td>
                        )}
                        {!salesMode && <td className="px-2 py-1 text-right">{p.market_price?.toLocaleString() || 0}</td>}
                        {!salesMode && <td className={`px-2 py-1 text-right ${C.sub}`}>{p.ownerclan_price?.toLocaleString() || 0}</td>}
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

      {moveModalOpen && (
        <FolderMoveModal
          folders={folders}
          selectedCount={selected.size}
          currentFolderId={selectedFolderId}
          dark={dark}
          busy={busy}
          onClose={() => setMoveModalOpen(false)}
          onMove={onMoveTo}
        />
      )}

      {detailId != null && (
        <ProductDetailModal
          productId={detailId}
          folders={folders}
          dark={dark}
          onClose={() => setDetailId(null)}
          onSaved={() => { loadProducts(); }}
        />
      )}
    </div>
  );
}

function FolderMoveModal({
  folders, selectedCount, currentFolderId, dark, busy, onClose, onMove,
}: {
  folders: NaverProductFolder[];
  selectedCount: number;
  currentFolderId: number | null;
  dark: boolean;
  busy: boolean;
  onClose: () => void;
  onMove: (folderId: number) => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 py-4"
         onClick={onClose}>
      <div className={`rounded-xl shadow-2xl border w-full max-w-md max-h-[85vh] flex flex-col ${
             dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200'
           }`}
           onClick={e => e.stopPropagation()}>
        <div className={`flex items-center justify-between px-5 py-3 border-b ${
               dark ? 'border-[#2a2a40]' : 'border-gray-200'
             }`}>
          <h2 className={`text-sm font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>
            📁 폴더로 이동 ({selectedCount.toLocaleString()}건)
          </h2>
          <button onClick={onClose}
                  className={`text-xl ${dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-400 hover:text-gray-600'}`}>
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-1">
            {folders.map(f => {
              const isCurrent = f.id === currentFolderId;
              return (
                <li key={f.id}>
                  <button
                    onClick={() => onMove(f.id)}
                    disabled={isCurrent || busy}
                    className={`w-full text-left px-3 py-2 rounded text-xs flex items-center justify-between transition-colors
                      ${isCurrent
                        ? (dark ? 'bg-[#252540] text-gray-500 cursor-not-allowed' : 'bg-gray-100 text-gray-400 cursor-not-allowed')
                        : (dark ? 'bg-[#252540] hover:bg-amber-900/30 text-white' : 'bg-gray-50 hover:bg-amber-100 text-gray-900')
                      } disabled:opacity-60`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      <span style={{ color: f.color || (dark ? '#475569' : '#94a3b8') }}>●</span>
                      <span className="truncate">{f.is_system === 1 ? '📦 ' : ''}{f.name}</span>
                    </span>
                    <span className={`text-[10px] shrink-0 ml-2 ${dark ? 'text-gray-500' : 'text-gray-500'}`}>
                      {(f.product_count || 0).toLocaleString()}
                      {isCurrent && ' · 현재'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── 상세/편집 모달 ──────────────────────────────────────────


function ProductDetailModal({
  productId, folders, dark, onClose, onSaved,
}: {
  productId: number;
  folders: NaverProductFolder[];
  dark: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<NaverProductDetail | null>(null);
  const [pool, setPool] = useState<KeywordPool | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [newKw, setNewKw] = useState('');
  const [relatedKws, setRelatedKws] = useState<RelatedKeyword[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  // 정렬: 'pool' = 풀 그대로, 'vol_desc' = 조회수↓, 'vol_asc' = 조회수↑
  const [poolSort, setPoolSort] = useState<'pool' | 'vol_desc' | 'vol_asc'>('pool');
  const [minVol, setMinVol] = useState<number>(0);
  const [hideHighComp, setHideHighComp] = useState(false);
  // GPU 키워드 적합도
  const [relevantSet, setRelevantSet] = useState<Set<string>>(new Set());
  const [irrelevantSet, setIrrelevantSet] = useState<Set<string>>(new Set());
  const [relevanceBusy, setRelevanceBusy] = useState(false);
  const [hideIrrelevant, setHideIrrelevant] = useState(false);
  // 자동 사입 모달
  const [autoFillOpen, setAutoFillOpen] = useState(false);
  const [afMin, setAfMin] = useState(1000);
  const [afMax, setAfMax] = useState(50000);
  const [afExcludeHigh, setAfExcludeHigh] = useState(true);
  const [afStrategy, setAfStrategy] = useState<'desc' | 'longtail'>('desc');
  // 자체 추가 칩 + comment 만 form 으로
  const [extraKws, setExtraKws] = useState<string[]>([]);
  const [naverName, setNaverName] = useState('');
  const [comment, setComment] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        fetchNaverProductDetail(productId),
        fetchKeywordPool(productId).catch(() => null),
      ]);
      setD(r);
      setPool(p && p.ok ? p : null);
      setNaverName(r.naver_product_name || '');
      setComment(((r as unknown) as { comment?: string }).comment || '');
      setExtraKws([]);
      // 연관키워드 — multi-seed 대량 수집 (네이버 검색광고 한 호출에 ~1000개)
      const isHan = (s: string) => /[가-힣]/.test(s);
      const tokens = (r.product_name || '')
        .split(/[\s/,()[\]\-_+]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && isHan(t));
      // dedupe + 상위 5개 (API 한도)
      const seedSet = new Set<string>();
      const seeds: string[] = [];
      for (const t of tokens) {
        if (seedSet.has(t.toLowerCase())) continue;
        seedSet.add(t.toLowerCase());
        seeds.push(t);
        if (seeds.length >= 5) break;
      }
      if (seeds.length > 0) {
        setRelatedLoading(true);
        fetchRelatedKeywordsMulti(seeds, 1500)
          .then(res => setRelatedKws(res.items || []))
          .catch(() => setRelatedKws([]))
          .finally(() => setRelatedLoading(false));
      } else {
        setRelatedKws([]);
      }
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { reload(); }, [reload]);

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(prev => prev === m ? '' : prev), 3500); };

  // 토큰화 (한글/영문/숫자 단어 단위)
  const tokenize = (s: string | null | undefined): string[] => {
    if (!s) return [];
    return s.split(/[\s/,()[\]\-_]+/)
      .map(x => x.trim())
      .filter(t => t.length >= 1);
  };

  // 현재 네이버상품명에 들어가있는 토큰 set
  const currentTokens = useMemo(() => {
    const set = new Set<string>();
    tokenize(naverName).forEach(t => set.add(t.toLowerCase()));
    return set;
  }, [naverName]);

  const isSelected = (kw: string) => currentTokens.has(kw.toLowerCase());

  // 키워드의 모든 음절이 상품명 토큰들의 조합으로 cover 되는가? (그리디 분해)
  // 예: 상품명 "여성 블랙 숏 점퍼" → "여성숏점퍼" = covered (이미 부분 등장)
  const isCoveredByTokens = (kw: string): boolean => {
    if (!kw || kw.length < 3) return false;
    if (currentTokens.has(kw.toLowerCase())) return false; // selected = noun 으로 covered 아님 (다른 색)
    const tokens = tokenize(naverName).map(t => t.toLowerCase());
    if (tokens.length === 0) return false;
    // 길이 desc 정렬 (긴 토큰 먼저 매치)
    const sortedTokens = tokens.slice().sort((a, b) => b.length - a.length);
    let s = kw.toLowerCase();
    while (s.length > 0) {
      let matched = false;
      for (const t of sortedTokens) {
        if (t && s.startsWith(t)) {
          s = s.slice(t.length);
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  };

  // 키워드 풀 — 모든 후보 dedupe (case-insensitive)
  const pooledKeywords = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ kw: string; source: string }> = [];
    const add = (arr: string[] | null | undefined, source: string) => {
      (arr || []).forEach(k => {
        if (!k) return;
        const key = k.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push({ kw: k, source });
      });
    };
    // 1순위: 네이버 상품명 자체 토큰 (필수, 첫 줄)
    add(tokenize(naverName), 'naver');
    // 2순위: 11번가 AI 상품명 토큰
    add(tokenize(d?.ai_recommended_name || d?.ai_product_name), '11st');
    // 3순위: 비전 features + color
    if (pool) {
      add(pool.vision_features, 'vision');
      const vc = pool.vision_meta?.color;
      if (Array.isArray(vc)) add(vc, 'vision');
      if (pool.vision_meta?.material) add([pool.vision_meta.material], 'vision');
      if (pool.vision_meta?.form) add([pool.vision_meta.form], 'vision');
    }
    // 4순위: 원본 검색태그 (detail 은 별도 섹션으로 분리)
    add(pool?.preset_keywords, 'preset');
    // 5순위: 11번가 best/good/ad/functional
    add(pool?.best_picks, 'best');
    add(pool?.good_picks, 'good');
    add(pool?.ad_keywords, 'ad');
    add(pool?.functional_keywords, 'func');
    // 6순위: 저장된 네이버 키워드
    add(pool?.naver_keywords, 'saved');
    // 7순위: 사용자 직접 추가
    add(extraKws, 'extra');
    return result;
  }, [naverName, d, pool, extraKws]);

  // 상세 페이지 추출 키워드 — 별도 표시 (메인 풀과 분리)
  const detailKwsList = useMemo(() => {
    const main = new Set(pooledKeywords.map(p => p.kw.toLowerCase()));
    return (pool?.detail_keywords || []).filter(k => !main.has(k.toLowerCase()));
  }, [pool, pooledKeywords]);

  // 연관 키워드 — 메인 풀 + 상세 모두에서 dedupe
  const relatedKwsFiltered = useMemo(() => {
    const seen = new Set<string>(pooledKeywords.map(p => p.kw.toLowerCase()));
    detailKwsList.forEach(k => seen.add(k.toLowerCase()));
    return relatedKws.filter(r => !seen.has(r.keyword.toLowerCase()));
  }, [relatedKws, pooledKeywords, detailKwsList]);

  // 조회수 helper
  const volOf = (kw: string): number => {
    const v = pool?.keyword_volumes?.[kw];
    return v?.total ?? 0;
  };
  const compOf = (kw: string): string => pool?.keyword_volumes?.[kw]?.comp || '';
  const fmtVol = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  };

  // 자동 사입 — 미리보기 (pool + related 통합)
  const autoFillCandidates = useMemo(() => {
    type Cand = { kw: string; total: number; comp: string };
    const all: Cand[] = [];
    pooledKeywords.forEach(p => {
      const v = volOf(p.kw);
      const c = compOf(p.kw);
      if (v >= afMin && v <= afMax && (!afExcludeHigh || c !== '높음') && !isSelected(p.kw)) {
        all.push({ kw: p.kw, total: v, comp: c });
      }
    });
    relatedKws.forEach(r => {
      if (r.total >= afMin && r.total <= afMax && (!afExcludeHigh || r.comp !== '높음') && !isSelected(r.keyword)) {
        // dedupe with pool
        if (!all.find(a => a.kw.toLowerCase() === r.keyword.toLowerCase())) {
          all.push({ kw: r.keyword, total: r.total, comp: r.comp });
        }
      }
    });
    all.sort((a, b) => afStrategy === 'desc' ? b.total - a.total : a.total - b.total);
    return all;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pooledKeywords, relatedKws, afMin, afMax, afExcludeHigh, afStrategy, currentTokens, pool?.keyword_volumes]);

  // GPU 검증 실행
  const runRelevance = async (force = false) => {
    if (!pool) return;
    const allKws = pooledKeywords.map(p => p.kw).concat(detailKwsList).concat(relatedKws.map(r => r.keyword));
    const uniq = Array.from(new Set(allKws));
    if (uniq.length === 0) return;
    setRelevanceBusy(true);
    try {
      const r = await fetchKeywordRelevance(productId, uniq, force);
      if (r.ok) {
        setRelevantSet(new Set(r.relevant.map(k => k.toLowerCase())));
        setIrrelevantSet(new Set(r.irrelevant.map(k => k.toLowerCase())));
        flash(`🧠 GPU 검증: 적합 ${r.relevant.length} / 부적합 ${r.irrelevant.length} (${r.cached ? '캐시' : r.elapsed_ms + 'ms'})`);
      } else {
        flash(`검증 실패: ${r.error}`);
      }
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setRelevanceBusy(false);
    }
  };

  const applyAutoFill = () => {
    const adds = autoFillCandidates.filter(c => !currentTokens.has(c.kw.toLowerCase())).map(c => c.kw);
    if (adds.length === 0) { flash('추가할 키워드 없음'); return; }
    setSelectedOrder(prev => [...prev, ...adds]);
    setNaverName(prev => {
      const tokens = tokenize(prev);
      const used = new Set(tokens.map(t => t.toLowerCase()));
      const add: string[] = [];
      for (const k of adds) {
        if (used.has(k.toLowerCase())) continue;
        used.add(k.toLowerCase());
        add.push(k);
      }
      return [...tokens, ...add].join(' ');
    });
    flash(`🎯 ${adds.length}개 자동 추가`);
    setAutoFillOpen(false);
  };

  // 풀 정렬/필터 적용
  const visiblePool = useMemo(() => {
    let arr = pooledKeywords.slice();
    if (minVol > 0) arr = arr.filter(p => volOf(p.kw) >= minVol);
    if (hideHighComp) arr = arr.filter(p => compOf(p.kw) !== '높음');
    if (hideIrrelevant) arr = arr.filter(p => !irrelevantSet.has(p.kw.toLowerCase()));
    if (poolSort === 'vol_desc') arr.sort((a, b) => volOf(b.kw) - volOf(a.kw));
    if (poolSort === 'vol_asc')  arr.sort((a, b) => volOf(a.kw) - volOf(b.kw));
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pooledKeywords, poolSort, minVol, hideHighComp, hideIrrelevant, irrelevantSet, pool?.keyword_volumes]);

  // 클릭 = 네이버 상품명에 자동 추가/제거
  const toggleKw = (kw: string) => {
    const tokens = tokenize(naverName);
    const lc = kw.toLowerCase();
    if (currentTokens.has(lc)) {
      // 제거
      const filtered = tokens.filter(t => t.toLowerCase() !== lc);
      setNaverName(filtered.join(' '));
    } else {
      // 추가 (끝에)
      setNaverName(tokens.length ? `${tokens.join(' ')} ${kw}` : kw);
    }
  };

  const addExtraKw = () => {
    const k = newKw.trim();
    if (!k) return;
    if (!extraKws.includes(k)) setExtraKws(s => [...s, k]);
    setNewKw('');
    // 추가 즉시 상품명에 반영
    if (!currentTokens.has(k.toLowerCase())) {
      const tokens = tokenize(naverName);
      setNaverName(tokens.length ? `${tokens.join(' ')} ${k}` : k);
    }
  };

  const calcBytes = (s: string) => {
    let n = 0;
    for (const c of s || '') n += (c >= '가' && c <= '힣') ? 2 : 1;
    return n;
  };
  const nameBytes = calcBytes(naverName);

  const onSave = async () => {
    setSaving(true);
    try {
      const payload = {
        naver_product_name: naverName,
        comment: comment || null,
        naver_keywords: extraKws.length ? extraKws.join(', ') : (pool?.naver_keywords || []).join(', '),
      } as Partial<NaverProductDetail>;
      const r = await patchNaverProduct(productId, payload);
      if (r.ok) {
        flash('💾 저장 완료');
        onSaved();
      } else {
        flash(`저장 실패: ${r.error || 'unknown'}`);
      }
    } catch (e: unknown) {
      flash(`에러: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const onRegenerate = async () => {
    setGenBusy(true);
    try {
      const r = await generateNaverName(productId, true);
      if (r.ok && r.naver_product_name) {
        flash(`🤖 ${r.naver_product_name}`);
        await reload();
        onSaved();
      } else {
        flash(`재생성 실패: ${r.error || 'unknown'}`);
      }
    } finally {
      setGenBusy(false);
    }
  };

  const onReanalyzeVision = async () => {
    if (!confirm('이미지 비전 분석을 다시 실행합니다. 진행할까요?')) return;
    setVisionBusy(true);
    try {
      await clearVisionCache(productId);
      // generate-name 호출이 자동으로 vision 분석 → 캐시 후 텍스트 생성
      const r = await generateNaverName(productId, true);
      if (r.ok) {
        flash(`👁 비전 재분석 + 상품명 갱신: ${r.naver_product_name}`);
        await reload();
        onSaved();
      } else {
        flash(`재분석 실패: ${r.error}`);
      }
    } finally {
      setVisionBusy(false);
    }
  };

  const C = dark ? {
    bg: 'bg-[#1c1c2e]', border: 'border-[#2a2a40]',
    text: 'text-white', sub: 'text-gray-400', muted: 'text-gray-500',
    input: 'bg-[#252540] border-[#2a2a40] text-white placeholder-gray-500',
    panel: 'bg-[#252540]', label: 'text-gray-300',
  } : {
    bg: 'bg-white', border: 'border-gray-200',
    text: 'text-gray-900', sub: 'text-gray-600', muted: 'text-gray-500',
    input: 'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
    panel: 'bg-gray-50', label: 'text-gray-700',
  };

  // 소스별 색상
  const sourceColor = (src: string): string => {
    switch (src) {
      case 'naver':  return dark ? 'border-emerald-500' : 'border-emerald-400';
      case '11st':   return dark ? 'border-violet-500'  : 'border-violet-400';
      case 'vision': return dark ? 'border-sky-500'     : 'border-sky-400';
      case 'detail': return dark ? 'border-cyan-500'    : 'border-cyan-400';
      case 'preset': return dark ? 'border-gray-500'    : 'border-gray-400';
      case 'best':   return dark ? 'border-yellow-500'  : 'border-yellow-400';
      case 'good':   return dark ? 'border-orange-500'  : 'border-orange-400';
      case 'ad':     return dark ? 'border-pink-500'    : 'border-pink-400';
      case 'func':   return dark ? 'border-blue-500'    : 'border-blue-400';
      case 'saved':  return dark ? 'border-teal-500'    : 'border-teal-400';
      case 'extra':  return dark ? 'border-fuchsia-500' : 'border-fuchsia-400';
      default:       return C.border;
    }
  };
  const sourceLabel = (src: string): string => ({
    naver: '네이버', '11st': '11번가', vision: '비전', detail: '상세',
    preset: '원본', best: '베스트', good: '우수', ad: '광고', func: '기능성',
    saved: '저장', extra: '직접',
  })[src] || src;

  const v = (pool?.vision_meta) || {};

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 py-4"
         onClick={onClose}>
      <div className={`${C.bg} ${C.border} border rounded-xl shadow-2xl flex flex-col transition-all relative ${
             expanded ? 'w-[98vw] max-w-[98vw] h-[96vh] max-h-[96vh]' : 'w-full max-w-3xl max-h-[92vh]'
           }`}
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-2 border-b ${C.border}`}>
          <div className="flex items-center gap-2">
            <span>📋</span>
            <h2 className={`text-sm font-bold ${C.text}`}>상품 편집</h2>
            {d && <span className={`text-xs font-mono ${C.muted}`}>#{d.id} · W{d.product_code}</span>}
            {d?.is_modified === 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400">수정됨</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setExpanded(v2 => !v2)}
                    className={`px-2.5 py-1 text-[11px] rounded font-bold ${
                      expanded
                        ? 'bg-sky-600 text-white hover:bg-sky-700'
                        : dark ? 'bg-sky-900/30 text-sky-300 hover:bg-sky-900/50' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'
                    }`}>
              {expanded ? '◀ 상세 닫기' : '🔍 상세페이지'}
            </button>
            <button onClick={onClose} className={`text-xl ${C.muted} hover:text-rose-500`}>×</button>
          </div>
        </div>

        {msg && (
          <div className="px-4 py-1 text-xs bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-b border-emerald-200 dark:border-emerald-800">
            {msg}
          </div>
        )}

        {loading || !d ? (
          <div className={`flex-1 flex items-center justify-center text-sm ${C.muted}`}>로딩 중...</div>
        ) : (
          <div className={`flex-1 min-h-0 ${expanded ? 'flex flex-row' : ''}`}>

            {/* ── 좌측 편집 ── */}
            <div className={`overflow-y-auto p-4 space-y-3 ${expanded ? `flex-1 min-w-0 max-w-[55%] border-r ${C.border}` : ''}`}>

              {/* 1) 네이버 상품명 — 크게, 메인 */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={`text-[11px] font-bold ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>
                    🌐 네이버 상품명
                  </label>
                  <span className={`text-[10px] font-mono ${
                    nameBytes > 100 ? 'text-rose-500 font-bold' :
                    nameBytes > 80 ? 'text-amber-500' : C.muted
                  }`}>
                    {naverName.length}자 / {nameBytes}바이트 (권장 100)
                  </span>
                </div>
                <textarea
                  value={naverName}
                  onChange={e => setNaverName(e.target.value)}
                  rows={2}
                  className={`${C.input} border-2 rounded w-full px-2.5 py-2 text-base font-bold ${
                    dark ? 'border-emerald-700' : 'border-emerald-300'
                  }`}
                  placeholder="아래 키워드 풀에서 클릭하면 자동 추가/제거됩니다"
                />
              </div>

              {/* 2) 11번가 AI 상품명 (참고) */}
              <div>
                <label className={`block text-[10px] ${C.label} mb-0.5`}>11번가 AI 상품명 (참고)</label>
                <div className={`${C.panel} ${C.sub} rounded px-2 py-1.5 text-sm`}>
                  {d.ai_recommended_name || d.ai_product_name || '—'}
                </div>
              </div>

              {/* 3) 키워드 풀 — 자동 토큰화 + 하이라이트 */}
              <div className={`border-2 rounded-lg p-2.5 ${dark ? 'border-amber-700 bg-amber-900/10' : 'border-amber-300 bg-amber-50/40'}`}>
                <div className={`text-[11px] font-bold mb-1.5 flex items-center justify-between ${dark ? 'text-amber-300' : 'text-amber-700'}`}>
                  <span>✨ 키워드 풀 ({visiblePool.length}/{pooledKeywords.length})</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => runRelevance(false)}
                            disabled={relevanceBusy}
                            className="text-[10px] px-2 py-0.5 rounded bg-violet-600 hover:bg-violet-700 text-white font-bold disabled:opacity-40">
                      {relevanceBusy ? '⏳' : '🧠'} GPU 검증
                    </button>
                    <button onClick={() => setAutoFillOpen(true)}
                            className="text-[10px] px-2 py-0.5 rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold">
                      🎯 자동 채우기
                    </button>
                  </div>
                </div>
                {(relevantSet.size > 0 || irrelevantSet.size > 0) && (
                  <div className={`text-[10px] mb-1 flex items-center gap-3 ${C.muted}`}>
                    <span>🧠 GPU 적합도: <b className="text-emerald-600 dark:text-emerald-400">{relevantSet.size} 적합</b> / <span className="text-rose-500">{irrelevantSet.size} 부적합</span></span>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={hideIrrelevant} onChange={e => setHideIrrelevant(e.target.checked)} />
                      부적합 숨김
                    </label>
                  </div>
                )}
                {/* 정렬/필터 컨트롤 */}
                <div className={`flex flex-wrap items-center gap-2 mb-2 text-[10px] ${C.muted}`}>
                  <span>정렬:</span>
                  <select value={poolSort} onChange={e => setPoolSort(e.target.value as 'pool'|'vol_desc'|'vol_asc')}
                          className={`${C.input} border rounded px-1.5 py-0.5 text-[11px]`}>
                    <option value="pool">기본(소스순)</option>
                    <option value="vol_desc">📊 조회수 ↓</option>
                    <option value="vol_asc">📊 조회수 ↑ (롱테일)</option>
                  </select>
                  <span>최소 조회수:</span>
                  <input type="number" value={minVol} onChange={e => setMinVol(Number(e.target.value) || 0)}
                         className={`${C.input} border rounded px-1.5 py-0.5 text-[11px] w-20`}
                         placeholder="0" />
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="checkbox" checked={hideHighComp} onChange={e => setHideHighComp(e.target.checked)} />
                    경쟁 '높음' 제외
                  </label>
                </div>
                <div className="flex flex-wrap gap-1">
                  {visiblePool.map(({ kw, source }) => {
                    const on = isSelected(kw);
                    const covered = !on && isCoveredByTokens(kw);
                    const vol = volOf(kw);
                    const comp = compOf(kw);
                    const lcKw = kw.toLowerCase();
                    const isRel = relevantSet.has(lcKw);
                    const isIrrel = irrelevantSet.has(lcKw);
                    const intensity = Math.min(vol / 30000, 1);
                    const volBadgeColor = comp === '높음' ? 'text-rose-500' : comp === '중간' ? 'text-amber-500' : 'text-emerald-500';
                    return (
                      <button key={`${source}:${kw}`}
                              onClick={() => toggleKw(kw)}
                              title={`${sourceLabel(source)}${vol > 0 ? ` · 월간 ${vol.toLocaleString()} (PC ${pool?.keyword_volumes?.[kw]?.pc?.toLocaleString() || 0} / 모바일 ${pool?.keyword_volumes?.[kw]?.mobile?.toLocaleString() || 0}) · 경쟁 ${comp || '?'}` : ''}${isRel ? ' · 🧠 GPU 적합' : ''}${isIrrel ? ' · ⚠ GPU 부적합' : ''}${covered ? ' · ⚠ 토큰들이 이미 상품명에 분리되어 들어있음' : ''}`}
                              className={`px-2 py-0.5 rounded text-[12px] border-2 transition-all inline-flex items-center gap-1 ${
                                on
                                  ? 'bg-amber-400 text-gray-900 border-amber-500 font-bold shadow'
                                  : isIrrel
                                    ? `${dark ? 'bg-rose-900/20 text-rose-400 border-rose-700 opacity-50' : 'bg-rose-50 text-rose-400 border-rose-200 opacity-60'} hover:opacity-100`
                                    : covered
                                      ? `${dark ? 'bg-orange-900/20 text-orange-300 border-orange-700/60' : 'bg-orange-100/70 text-orange-700 border-orange-300'} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                                      : `${dark ? 'bg-[#1c1c2e] text-gray-200' : 'bg-white text-gray-700'} ${isRel ? (dark ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-emerald-500 ring-1 ring-emerald-300') : sourceColor(source)} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                              }`}
                              style={!on && !isIrrel && !covered && intensity > 0 ? { backgroundColor: dark ? `rgba(250,200,50,${intensity*0.15})` : `rgba(250,180,40,${intensity*0.2})` } : undefined}>
                        {isRel && !on && <span className="text-emerald-500 text-[10px]">✓</span>}
                        {isIrrel && !on && <span className="text-rose-400 text-[10px]">✕</span>}
                        <span>{kw}</span>
                        {vol > 0 && (
                          <span className={`text-[9px] font-mono ${on ? 'opacity-70' : volBadgeColor}`}>
                            {fmtVol(vol)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* 직접 추가 */}
                <div className="flex items-center gap-1.5 mt-2.5">
                  <input value={newKw} onChange={e => setNewKw(e.target.value)}
                         onKeyDown={e => { if (e.key === 'Enter') addExtraKw(); }}
                         placeholder="새 키워드 + Enter (즉시 상품명에 추가)"
                         className={`${C.input} flex-1 border rounded px-2 py-1 text-xs`} />
                  <button onClick={addExtraKw}
                          className="px-2 py-1 text-xs rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold">
                    + 추가
                  </button>
                </div>
              </div>

              {/* 3.3) 추천 (필수 포함) 키워드 — must_have */}
              {pool && (pool.must_have_keywords || []).length > 0 && (
                <div className={`border-2 rounded-lg p-2.5 ${dark ? 'border-emerald-700 bg-emerald-900/15' : 'border-emerald-400 bg-emerald-50/70'}`}>
                  <div className={`text-[11px] font-bold mb-1.5 ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>
                    ⭐ 추천 키워드 — 네이버 SEO 우대 단어, 빠져있어요. 클릭으로 추가
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(pool.must_have_keywords || []).map(kw => (
                      <button key={`must:${kw}`}
                              onClick={() => toggleKw(kw)}
                              className="px-2 py-0.5 rounded text-[12px] border-2 bg-emerald-500 text-white border-emerald-600 font-bold hover:bg-emerald-600 shadow animate-pulse">
                        ⭐ {kw}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 3.4) 어뷰징 키워드 — banned (반대 성별 등) */}
              {pool && (pool.banned_keywords || []).length > 0 && (
                <div className={`border rounded p-2 ${dark ? 'border-rose-800 bg-rose-900/15' : 'border-rose-200 bg-rose-50/60'}`}>
                  <div className={`text-[10px] font-bold mb-1 ${dark ? 'text-rose-300' : 'text-rose-700'}`}>
                    🚫 자동 제외 ({(pool.banned_keywords || []).length})
                    {pool.inferred_gender === 'female' && ' — 여성 상품, 남성 키워드 자동 차단'}
                    {pool.inferred_gender === 'male' && ' — 남성 상품, 여성 키워드 자동 차단'}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(pool.banned_keywords || []).map(kw => (
                      <span key={`banned:${kw}`}
                            title="원본 keywords 에 있던 반대 성별 단어 — 어뷰징 방지 자동 제외"
                            className={`px-1.5 py-0.5 rounded text-[10px] line-through ${
                              dark ? 'bg-rose-900/40 text-rose-300 border border-rose-800' : 'bg-rose-100 text-rose-600 border border-rose-300'
                            }`}>
                        {kw}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 3.45) 시즌 비호환 키워드 (의류 한정) */}
              {pool && (pool.season_banned_keywords || []).length > 0 && (
                <div className={`border rounded p-2 ${dark ? 'border-amber-800 bg-amber-900/15' : 'border-amber-200 bg-amber-50/60'}`}>
                  <div className={`text-[10px] font-bold mb-1 ${dark ? 'text-amber-300' : 'text-amber-700'}`}>
                    🍂 시즌 비추천 ({(pool.season_banned_keywords || []).length})
                    {pool.inferred_season === 'summer' && ' — 여름 상품, 겨울/간절기 단어 비추천'}
                    {pool.inferred_season === 'winter' && ' — 겨울 상품, 여름/간절기 단어 비추천'}
                    {pool.inferred_season === 'spring_fall' && ' — 봄·가을 간절기 상품, 여름/겨울 단어 비추천'}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(pool.season_banned_keywords || []).map(kw => (
                      <button key={`sb:${kw}`}
                              onClick={() => toggleKw(kw)}
                              title="시즌 비호환 — 클릭하면 강제 추가 가능"
                              className={`px-1.5 py-0.5 rounded text-[10px] line-through hover:no-underline ${
                                dark ? 'bg-amber-900/30 text-amber-300 border border-amber-800' : 'bg-amber-100 text-amber-700 border border-amber-300'
                              }`}>
                        {kw}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 3.5) 상세 페이지 키워드 — 별도 섹션 (형용사/문구 다수) */}
              {pool && (detailKwsList.length > 0 || (pool.detail_html_length || 0) > 0) && (
                <div className={`border-2 rounded-lg p-2.5 ${dark ? 'border-cyan-700 bg-cyan-900/10' : 'border-cyan-300 bg-cyan-50/40'}`}>
                  <div className={`text-[11px] font-bold mb-1.5 flex items-center justify-between ${dark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                    <span>📄 상세 페이지 키워드 ({detailKwsList.length}) — 클릭 = 상품명에 추가/제거</span>
                    <span className={`text-[9px] font-normal ${C.muted}`}>
                      HTML {(pool.detail_html_length || 0).toLocaleString()}자
                    </span>
                  </div>
                  {detailKwsList.length === 0 ? (
                    <div className={`text-[11px] ${C.muted} italic`}>
                      상세 HTML 에서 추출된 키워드가 모두 다른 풀과 중복됨
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {detailKwsList.map(kw => {
                        const on = isSelected(kw);
                        const covered = !on && isCoveredByTokens(kw);
                        return (
                          <button key={`detail:${kw}`}
                                  onClick={() => toggleKw(kw)}
                                  title={`상세 페이지 추출 · 클릭 = 상품명에 ${on ? '제거' : '추가'}${covered ? ' · ⚠ 분리 토큰으로 이미 포함' : ''}`}
                                  className={`px-2 py-0.5 rounded text-[12px] border-2 transition-all ${
                                    on
                                      ? 'bg-amber-400 text-gray-900 border-amber-500 font-bold shadow'
                                      : covered
                                        ? `${dark ? 'bg-orange-900/20 text-orange-300 border-orange-700/60' : 'bg-orange-100/70 text-orange-700 border-orange-300'} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                                        : `${dark ? 'bg-[#1c1c2e] text-gray-200' : 'bg-white text-gray-700'} ${dark ? 'border-cyan-500' : 'border-cyan-400'} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                                  }`}>
                            {kw}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 3.6) 연관 키워드 (네이버 검색광고 API, 풀+상세와 중복 제거) */}
              {(relatedLoading || relatedKwsFiltered.length > 0) && (
                <div className={`border-2 rounded-lg p-2.5 ${dark ? 'border-indigo-700 bg-indigo-900/10' : 'border-indigo-300 bg-indigo-50/40'}`}>
                  <div className={`text-[11px] font-bold mb-1.5 flex items-center justify-between ${dark ? 'text-indigo-300' : 'text-indigo-700'}`}>
                    <span>🔗 연관 키워드 ({relatedKwsFiltered.length}) — 네이버 검색광고 API · 조회수 desc</span>
                    {relatedLoading && <span className={`text-[9px] font-normal ${C.muted}`}>로딩…</span>}
                  </div>
                  {relatedKwsFiltered.length === 0 && !relatedLoading ? (
                    <div className={`text-[11px] ${C.muted} italic`}>연관 키워드가 모두 다른 풀과 중복됨 또는 검색 실패</div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {relatedKwsFiltered.slice(0, 50).map(r => {
                        const on = isSelected(r.keyword);
                        const covered = !on && isCoveredByTokens(r.keyword);
                        const compCol = r.comp === '높음' ? 'text-rose-500' : r.comp === '중간' ? 'text-amber-500' : 'text-emerald-500';
                        const intensity = Math.min(r.total / 30000, 1);
                        return (
                          <button key={`rel:${r.keyword}`}
                                  onClick={() => toggleKw(r.keyword)}
                                  title={`연관 · 월간 ${r.total.toLocaleString()} (PC ${r.pc.toLocaleString()} / 모바일 ${r.mobile.toLocaleString()}) · 경쟁 ${r.comp}${covered ? ' · ⚠ 분리 토큰으로 이미 포함' : ''}`}
                                  className={`px-2 py-0.5 rounded text-[12px] border-2 transition-all inline-flex items-center gap-1 ${
                                    on
                                      ? 'bg-amber-400 text-gray-900 border-amber-500 font-bold shadow'
                                      : covered
                                        ? `${dark ? 'bg-orange-900/20 text-orange-300 border-orange-700/60' : 'bg-orange-100/70 text-orange-700 border-orange-300'} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                                        : `${dark ? 'bg-[#1c1c2e] text-gray-200 border-indigo-500' : 'bg-white text-gray-700 border-indigo-400'} hover:bg-amber-100 dark:hover:bg-amber-900/30`
                                  }`}
                                  style={!on && !covered && intensity > 0 ? { backgroundColor: dark ? `rgba(250,200,50,${intensity*0.15})` : `rgba(250,180,40,${intensity*0.2})` } : undefined}>
                            <span>{r.keyword}</span>
                            {r.total > 0 && (
                              <span className={`text-[9px] font-mono ${on ? 'opacity-70' : compCol}`}>
                                {fmtVol(r.total)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 4) 코멘트 (프롬프트 엔지니어링) */}
              <div>
                <label className={`block text-[10px] font-bold ${dark ? 'text-violet-300' : 'text-violet-700'} mb-1`}>
                  📝 코멘트 (DB 저장 · 추후 프롬프트 학습용)
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={3}
                  placeholder="이 상품에서 좋았던 키워드, 나빴던 키워드, 비전 분석이 틀린 부분 등 자유 메모. 추후 모델 fine-tuning 에 활용."
                  className={`${C.input} border rounded w-full px-2 py-1.5 text-xs`}
                />
              </div>

              {/* 5) 비전 결과 (참고용 + 재분석 버튼) */}
              <div className={`${C.panel} rounded p-2.5 text-xs space-y-1`}>
                <div className={`font-bold ${C.text} flex items-center justify-between`}>
                  <span>👁 비전 분석</span>
                  <button onClick={onReanalyzeVision}
                          disabled={visionBusy}
                          className="text-[10px] px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 font-bold">
                    {visionBusy ? '⏳ 재분석 중...' : '🔄 비전+상품명 재생성'}
                  </button>
                </div>
                {v.form && <div><span className={C.muted}>형태:</span> <b className={C.text}>{v.form}</b></div>}
                {v.material && <div><span className={C.muted}>소재:</span> <b className={C.text}>{v.material}</b></div>}
                {Array.isArray(v.color) && v.color.length > 0 && (
                  <div><span className={C.muted}>색상:</span> {v.color.join(', ')}</div>
                )}
                {v.package_qty && <div><span className={C.muted}>패키지:</span> {v.package_qty}</div>}
                {pool?.vision_features && pool.vision_features.length > 0 && (
                  <div><span className={C.muted}>특징:</span> {pool.vision_features.join(', ')}</div>
                )}
                {v.readable_text && <div><span className={C.muted}>글자:</span> {v.readable_text}</div>}
                {!pool?.vision_meta?.form && (
                  <div className={`text-[10px] ${C.muted} italic`}>비전 분석 캐시 없음 — 재분석 권장</div>
                )}
              </div>
            </div>

            {/* ── 우측: 상세 페이지 ── */}
            {expanded && (
              <div className={`flex-1 min-w-0 overflow-y-auto p-3 ${dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'}`}>
                <div className={`text-xs font-bold mb-2 ${C.text}`}>🔍 상품 원본 상세</div>

                {/* 원본 상품명 — 썸네일 위 */}
                <div className={`${C.panel} rounded mb-2 p-2.5 border ${C.border}`}>
                  <div className={`text-[10px] font-bold mb-1 ${C.muted}`}>원본 상품명</div>
                  <div className={`text-sm ${C.text} leading-snug`}>{d.product_name || '—'}</div>
                </div>

                {d.image_large && (
                  <div className={`${C.panel} rounded mb-2 p-2 border ${C.border}`}>
                    <img src={d.image_large} alt="" className="w-full max-h-[350px] object-contain rounded" />
                  </div>
                )}

                {/* 네이버 상품명 — 썸네일 아래, 현재 편집 중인 값 실시간 반영 */}
                <div className={`rounded mb-2 p-2.5 border-2 ${
                  dark ? 'border-emerald-700 bg-emerald-900/15' : 'border-emerald-400 bg-emerald-50/70'
                }`}>
                  <div className={`text-[10px] font-bold mb-1 flex items-center justify-between ${
                    dark ? 'text-emerald-300' : 'text-emerald-700'
                  }`}>
                    <span>🌐 네이버 상품명 (편집 중)</span>
                    <span className={`font-mono font-normal ${C.muted}`}>
                      {naverName.length}자 / {calcBytes(naverName)}B
                    </span>
                  </div>
                  <div className={`text-sm font-bold leading-snug ${
                    dark ? 'text-emerald-200' : 'text-emerald-900'
                  }`}>
                    {naverName || <span className={`${C.muted} italic font-normal`}>(아직 입력 안 됨)</span>}
                  </div>
                </div>

                {(d.option1_name || d.option2_name || d.product_attribute) && (
                  <div className={`${C.panel} rounded p-2 mb-2 text-[11px] space-y-1`}>
                    <div className={`font-bold ${C.text}`}>📦 옵션/속성</div>
                    {d.option1_name && <div><span className={C.muted}>{d.option1_name}:</span> {d.option1_values}</div>}
                    {d.option2_name && <div><span className={C.muted}>{d.option2_name}:</span> {d.option2_values}</div>}
                    {d.product_attribute && <div><span className={C.muted}>속성:</span> {d.product_attribute}</div>}
                  </div>
                )}
                <div className={`${C.panel} rounded p-2 ${C.border} border`}>
                  <div className={`font-bold ${C.text} text-xs mb-1.5 flex items-center justify-between`}>
                    <span>📄 상세 페이지</span>
                    <span className={`text-[10px] font-normal ${C.muted}`}>
                      {d.detail_html ? `${d.detail_html.length.toLocaleString()}자` : '없음'}
                    </span>
                  </div>
                  {d.detail_html ? (
                    <div className="bg-white text-gray-900 rounded p-2 max-h-[55vh] overflow-y-auto text-xs"
                         dangerouslySetInnerHTML={{ __html: d.detail_html }} />
                  ) : (
                    <div className={`text-xs ${C.muted} italic`}>저장된 상세 HTML 없음</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 자동 사입 모달 (nested) */}
        {autoFillOpen && (
          <div className="absolute inset-0 z-[90] flex items-center justify-center bg-black/50"
               onClick={() => setAutoFillOpen(false)}>
            <div className={`${C.bg} ${C.border} border rounded-xl shadow-2xl w-full max-w-md p-4`}
                 onClick={e => e.stopPropagation()}>
              <div className={`text-sm font-bold mb-3 ${C.text}`}>🎯 자동 채우기 — 조회수 범위로 일괄 추가</div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className={`text-[11px] ${C.label}`}>최소 조회수
                  <input type="number" value={afMin} onChange={e => setAfMin(Number(e.target.value) || 0)}
                         className={`${C.input} border rounded w-full px-2 py-1 mt-0.5 text-xs`} />
                </label>
                <label className={`text-[11px] ${C.label}`}>최대 조회수
                  <input type="number" value={afMax} onChange={e => setAfMax(Number(e.target.value) || 0)}
                         className={`${C.input} border rounded w-full px-2 py-1 mt-0.5 text-xs`} />
                </label>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] cursor-pointer mb-2">
                <input type="checkbox" checked={afExcludeHigh} onChange={e => setAfExcludeHigh(e.target.checked)} />
                경쟁도 '높음' 제외
              </label>
              <div className="flex items-center gap-2 mb-3 text-[11px]">
                <span className={C.label}>우선순위:</span>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="radio" checked={afStrategy === 'desc'} onChange={() => setAfStrategy('desc')} />
                  조회수 ↓ (메인키워드)
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="radio" checked={afStrategy === 'longtail'} onChange={() => setAfStrategy('longtail')} />
                  조회수 ↑ (롱테일)
                </label>
              </div>
              <div className={`${C.panel} rounded p-2 mb-3 max-h-40 overflow-y-auto`}>
                <div className={`text-[10px] font-bold mb-1 ${C.muted}`}>
                  미리보기: {autoFillCandidates.length}개 추가 예정
                </div>
                <div className="flex flex-wrap gap-1">
                  {autoFillCandidates.slice(0, 30).map(c => (
                    <span key={`pv:${c.kw}`} className={`text-[10px] px-1.5 py-0.5 rounded ${dark ? 'bg-fuchsia-900/40 text-fuchsia-200' : 'bg-fuchsia-100 text-fuchsia-700'}`}>
                      {c.kw} <span className="opacity-60">{fmtVol(c.total)}</span>
                    </span>
                  ))}
                  {autoFillCandidates.length > 30 && (
                    <span className={`text-[10px] ${C.muted}`}>+ {autoFillCandidates.length - 30}개 더</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setAutoFillOpen(false)}
                        className={`flex-1 px-3 py-1.5 text-xs rounded ${dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-200 text-gray-700'}`}>
                  취소
                </button>
                <button onClick={applyAutoFill}
                        disabled={autoFillCandidates.length === 0}
                        className="flex-1 px-3 py-1.5 text-xs font-bold rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white disabled:opacity-40">
                  ✅ {autoFillCandidates.length}개 적용
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className={`border-t ${C.border} px-4 py-2.5 flex items-center gap-2 ${dark ? 'bg-[#181828]' : 'bg-gray-50'} rounded-b-xl`}>
          <button onClick={onRegenerate}
                  disabled={genBusy || loading}
                  className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">
            {genBusy ? '⏳ 생성 중...' : '🤖 재생성'}
          </button>
          <div className="flex-1" />
          <button onClick={onClose}
                  className={`px-3 py-1.5 text-xs rounded ${dark ? 'bg-[#252540] text-gray-300 hover:bg-[#2f2f50]' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
            취소
          </button>
          <button onClick={onSave}
                  disabled={saving || loading}
                  className="px-4 py-1.5 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40">
            {saving ? '저장 중...' : '💾 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
