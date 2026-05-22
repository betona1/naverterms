import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchNaverProducts, fetchNaverFolders, syncNaverFolders,
  startImportFrom11st, fetchImportStatus, generateNaverName,
  enqueueGenerate, fetchQueueStatus, moveNaverProducts,
  fetchNaverProductDetail, patchNaverProduct, clearVisionCache,
  fetchKeywordPool,
  type NaverProductItem, type NaverProductFolder, type ImportState,
  type QueueStatus, type NaverProductDetail, type KeywordPool,
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
  const [clearBusy, setClearBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [expanded, setExpanded] = useState(false);

  // 키워드 추가 입력
  const [newKw, setNewKw] = useState('');
  const [extraKws, setExtraKws] = useState<string[]>([]);  // 사용자가 직접 추가한 칩
  // 선택된 키워드 (포함됨, 순서 유지)
  const [selectedOrder, setSelectedOrder] = useState<string[]>([]);
  // base 텍스트 (브랜드+핵심명사) — 기본은 brand + form
  const [baseText, setBaseText] = useState('');

  // 편집 가능 필드 (form state)
  const [form, setForm] = useState({
    product_name: '',
    naver_product_name: '',
    edited_product_name: '',
    naver_keywords: '',
    keywords: '',
    category_name: '',
    brand: '',
    manufacturer: '',
    origin: '',
    model_name: '',
    folder_id: 1,
  });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        fetchNaverProductDetail(productId),
        fetchKeywordPool(productId).catch(() => null),
      ]);
      setD(r);
      setPool(p && p.ok ? p : null);
      setForm({
        product_name: r.product_name || '',
        naver_product_name: r.naver_product_name || '',
        edited_product_name: r.edited_product_name || '',
        naver_keywords: r.naver_keywords || '',
        keywords: r.keywords || '',
        category_name: r.category_name || '',
        brand: r.brand || '',
        manufacturer: r.manufacturer || '',
        origin: r.origin || '',
        model_name: r.model_name || '',
        folder_id: r.folder_id || 1,
      });
      // base = brand + vision_meta.form (default), 비면 product_name 앞 부분
      const brand = r.brand || r.manufacturer || '';
      const form_ = p?.vision_meta?.form || '';
      const composed = [brand, form_].filter(Boolean).join(' ').trim();
      setBaseText(composed || (r.product_name || '').slice(0, 20));
      // selectedOrder 는 빈 상태로 시작 (사용자가 클릭으로 채움)
      setSelectedOrder([]);
      setExtraKws([]);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => { reload(); }, [reload]);

  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(prev => prev === m ? '' : prev), 3500); };

  // ── 키워드 풀 헬퍼 ──
  const calcBytes = (s: string) => {
    let n = 0;
    for (const c of s || '') n += (c >= '가' && c <= '힣') ? 2 : 1;
    return n;
  };
  const MAX_BYTES_KW = 100;

  // 동적 미리보기: baseText + 선택된 키워드 들 (100바이트 안에서 채움, ' ' 구분)
  const buildPreview = useMemo(() => {
    const used = new Set<string>();
    const norm = (s: string) => s.toLowerCase().trim();
    const baseTokens = (baseText || '').split(/\s+/).filter(Boolean);
    baseTokens.forEach(t => used.add(norm(t)));

    const out: string[] = [...baseTokens];
    let bytes = calcBytes(out.join(' '));
    for (const kw of selectedOrder) {
      const k = norm(kw);
      if (!k || used.has(k)) continue;
      const add = (out.length > 0 ? 1 : 0) + calcBytes(kw);
      if (bytes + add > MAX_BYTES_KW) continue;
      out.push(kw);
      used.add(k);
      bytes += add;
    }
    return out.join(' ');
  }, [baseText, selectedOrder]);

  const previewBytes = calcBytes(buildPreview);

  const toggleKeyword = (kw: string) => {
    setSelectedOrder(prev => prev.includes(kw) ? prev.filter(x => x !== kw) : [...prev, kw]);
  };

  const applyPreviewToForm = () => {
    if (!buildPreview.trim()) return;
    setForm(s => ({ ...s, naver_product_name: buildPreview }));
    flash(`✅ 미리보기 → 네이버 상품명 (${buildPreview.length}자/${previewBytes}B)`);
  };

  const addExtraKw = () => {
    const k = newKw.trim();
    if (!k) return;
    if (!extraKws.includes(k)) setExtraKws(s => [...s, k]);
    setSelectedOrder(s => s.includes(k) ? s : [...s, k]);
    setNewKw('');
  };

  const removeExtraKw = (kw: string) => {
    setExtraKws(s => s.filter(x => x !== kw));
    setSelectedOrder(s => s.filter(x => x !== kw));
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const r = await patchNaverProduct(productId, form);
      if (r.ok) {
        flash('💾 저장 완료');
        if (r.detail) setD(r.detail);
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
      const r = await generateNaverName(productId);
      if (r.ok && r.naver_product_name) {
        flash(`🤖 재생성: ${r.naver_product_name} (${r.byte_length}B / ${r.elapsed_ms}ms)`);
        await reload();
        onSaved();
      } else {
        flash(`재생성 실패: ${r.error || 'unknown'}`);
      }
    } finally {
      setGenBusy(false);
    }
  };

  const onClearVision = async () => {
    if (!confirm('비전 분석 캐시를 삭제하시겠어요? 다음 생성 시 이미지 다시 분석합니다.')) return;
    setClearBusy(true);
    try {
      const r = await clearVisionCache(productId);
      if (r.ok) {
        flash('🗑 비전 캐시 삭제');
        await reload();
      } else {
        flash(`실패: ${r.error || 'unknown'}`);
      }
    } finally {
      setClearBusy(false);
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

  const v = d?.image_analysis;
  const folderName = folders.find(f => f.id === form.folder_id)?.name || `#${form.folder_id}`;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 py-4"
         onClick={onClose}>
      <div className={`${C.bg} ${C.border} border rounded-xl shadow-2xl flex flex-col transition-all ${
             expanded ? 'w-[98vw] max-w-[98vw] h-[96vh] max-h-[96vh]' : 'w-full max-w-5xl max-h-[92vh]'
           }`}
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-3 border-b ${C.border}`}>
          <div className="flex items-center gap-3">
            <span className="text-lg">📋</span>
            <h2 className={`text-sm font-bold ${C.text}`}>
              상품 상세 / 편집
              {d && <span className={`ml-2 text-xs font-mono ${C.muted}`}>#{d.id} · W{d.product_code}</span>}
            </h2>
            {d?.is_modified === 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400">수정됨</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setExpanded(v => !v)}
                    title={expanded ? '상세페이지 닫기' : '상세페이지 펼치기 (우측에 큰 이미지 + 상세 HTML)'}
                    className={`px-2.5 py-1 text-[11px] rounded font-bold border ${
                      expanded
                        ? 'bg-sky-600 text-white border-sky-700 hover:bg-sky-700'
                        : dark
                          ? 'bg-sky-900/30 text-sky-300 border-sky-700 hover:bg-sky-900/50'
                          : 'bg-sky-50 text-sky-700 border-sky-300 hover:bg-sky-100'
                    }`}>
              {expanded ? '◀ 상세 닫기' : '🔍 상세페이지'}
            </button>
            <button onClick={onClose}
                    className={`text-xl ${dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700'}`}>
              ×
            </button>
          </div>
        </div>

        {msg && (
          <div className="px-5 py-1.5 text-xs bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-b border-emerald-200 dark:border-emerald-800">
            {msg}
          </div>
        )}

        {loading || !d ? (
          <div className={`flex-1 flex items-center justify-center text-sm ${C.muted}`}>
            로딩 중...
          </div>
        ) : (
          <div className={`flex-1 min-h-0 ${expanded ? 'flex flex-row' : ''}`}>
          <div className={`overflow-y-auto p-5 grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5 ${
            expanded ? 'flex-1 min-w-0 max-w-[55%] border-r ' + C.border : ''
          }`}>
            {/* 좌측: 이미지 + 비전 분석 */}
            <div className="space-y-3">
              {d.image_large ? (
                <a href={d.image_large} target="_blank" rel="noreferrer">
                  <img src={d.image_large} alt={d.product_name || ''}
                       className={`w-full h-auto rounded border ${C.border} object-contain`} />
                </a>
              ) : (
                <div className={`w-full aspect-square rounded ${C.panel}`} />
              )}

              <div className={`${C.panel} rounded p-3 text-xs space-y-1.5`}>
                <div className={`font-bold ${C.text} flex items-center justify-between`}>
                  <span>👁 비전 분석</span>
                  {v && d.image_analyzed_at && (
                    <span className={`text-[10px] ${C.muted}`}>{d.image_analyzed_at.slice(5,16).replace('T',' ')}</span>
                  )}
                </div>
                {!v ? (
                  <div className={C.muted}>아직 분석 안됨 (재생성 버튼 누르면 자동 분석)</div>
                ) : (
                  <>
                    {v.form && <div><span className={C.muted}>형태:</span> <b className={C.text}>{v.form}</b></div>}
                    {v.color && Array.isArray(v.color) && v.color.length > 0 && (
                      <div><span className={C.muted}>색상:</span> {v.color.join(', ')}</div>
                    )}
                    {v.material && <div><span className={C.muted}>소재:</span> {v.material}</div>}
                    {v.package_qty && <div><span className={C.muted}>패키지:</span> {v.package_qty}</div>}
                    {v.readable_text && <div><span className={C.muted}>글자:</span> {v.readable_text}</div>}
                    {v.key_features && Array.isArray(v.key_features) && v.key_features.length > 0 && (
                      <div><span className={C.muted}>특징:</span> {v.key_features.join(', ')}</div>
                    )}
                  </>
                )}
              </div>

              {/* 가격 / 메타 */}
              <div className={`${C.panel} rounded p-3 text-xs space-y-1`}>
                <div className={`font-bold ${C.text}`}>💰 가격 / 메타</div>
                <div><span className={C.muted}>판매가:</span> {d.market_price?.toLocaleString() || 0}원</div>
                <div><span className={C.muted}>오너클랜:</span> {d.ownerclan_price?.toLocaleString() || 0}원</div>
                <div><span className={C.muted}>배송비:</span> {d.shipping_fee?.toLocaleString() || 0}원 / 반품 {d.return_fee?.toLocaleString() || 0}원</div>
                {d.source_id && <div><span className={C.muted}>11st source_id:</span> {d.source_id}</div>}
                {d.copied_at && <div><span className={C.muted}>가져온 시각:</span> {d.copied_at.slice(0,16).replace('T',' ')}</div>}
              </div>
            </div>

            {/* 우측: 편집 폼 */}
            <div className="space-y-3 text-xs">
              {/* 11번가 AI상품명 (read-only) */}
              {d.ai_recommended_name && (
                <div>
                  <label className={`block ${C.label} font-bold mb-1`}>11번가 AI 상품명 (참고)</label>
                  <div className={`${C.panel} rounded px-2 py-1.5 ${C.sub}`}>{d.ai_recommended_name}</div>
                </div>
              )}

              {/* 네이버 상품명 — 가장 중요 */}
              <div>
                <label className={`block ${C.label} font-bold mb-1`}>
                  🌐 네이버 상품명 (이 컬럼이 네이버용 최종 결과)
                  <span className={`ml-2 text-[10px] ${C.muted}`}>
                    {form.naver_product_name.length}자 / 권장 50자
                  </span>
                </label>
                <textarea
                  value={form.naver_product_name}
                  onChange={e => setForm(s => ({ ...s, naver_product_name: e.target.value }))}
                  rows={2}
                  className={`${C.input} border rounded w-full px-2 py-1.5`}
                />
              </div>

              {/* 원본 상품명 */}
              <div>
                <label className={`block ${C.label} font-bold mb-1`}>원본 상품명</label>
                <textarea
                  value={form.product_name}
                  onChange={e => setForm(s => ({ ...s, product_name: e.target.value }))}
                  rows={2}
                  className={`${C.input} border rounded w-full px-2 py-1.5`}
                />
              </div>

              {/* 사용자 편집명 */}
              <div>
                <label className={`block ${C.label} font-bold mb-1`}>사용자 편집명 (선택)</label>
                <input
                  value={form.edited_product_name}
                  onChange={e => setForm(s => ({ ...s, edited_product_name: e.target.value }))}
                  className={`${C.input} border rounded w-full px-2 py-1.5`}
                />
              </div>

              {/* 카테고리 / 브랜드 / 제조사 / 원산지 / 모델명 / 폴더 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={`block ${C.label} mb-0.5`}>카테고리</label>
                  <input value={form.category_name}
                         onChange={e => setForm(s => ({ ...s, category_name: e.target.value }))}
                         className={`${C.input} border rounded w-full px-2 py-1`} />
                </div>
                <div>
                  <label className={`block ${C.label} mb-0.5`}>브랜드</label>
                  <input value={form.brand}
                         onChange={e => setForm(s => ({ ...s, brand: e.target.value }))}
                         className={`${C.input} border rounded w-full px-2 py-1`} />
                </div>
                <div>
                  <label className={`block ${C.label} mb-0.5`}>제조사</label>
                  <input value={form.manufacturer}
                         onChange={e => setForm(s => ({ ...s, manufacturer: e.target.value }))}
                         className={`${C.input} border rounded w-full px-2 py-1`} />
                </div>
                <div>
                  <label className={`block ${C.label} mb-0.5`}>원산지</label>
                  <input value={form.origin}
                         onChange={e => setForm(s => ({ ...s, origin: e.target.value }))}
                         className={`${C.input} border rounded w-full px-2 py-1`} />
                </div>
                <div>
                  <label className={`block ${C.label} mb-0.5`}>모델명</label>
                  <input value={form.model_name}
                         onChange={e => setForm(s => ({ ...s, model_name: e.target.value }))}
                         className={`${C.input} border rounded w-full px-2 py-1`} />
                </div>
                <div>
                  <label className={`block ${C.label} mb-0.5`}>폴더 → {folderName}</label>
                  <select value={form.folder_id}
                          onChange={e => setForm(s => ({ ...s, folder_id: Number(e.target.value) }))}
                          className={`${C.input} border rounded w-full px-2 py-1`}>
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.is_system === 1 ? '📦 ' : ''}{f.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── 키워드 풀 + 동적 미리보기 ── */}
              <div className={`border-2 rounded-lg p-2.5 ${dark ? 'border-amber-700 bg-amber-900/10' : 'border-amber-300 bg-amber-50/30'}`}>
                <div className={`text-[11px] font-bold mb-1.5 ${dark ? 'text-amber-300' : 'text-amber-700'}`}>
                  ✨ 키워드 풀 — 클릭으로 포함/제외 토글, 미리보기 확인 후 [적용]
                </div>

                {/* base 텍스트 (브랜드 + 핵심) */}
                <div className="mb-2">
                  <label className={`block ${C.label} text-[10px] mb-0.5`}>기본(필수) — 브랜드 + 핵심 명사</label>
                  <input
                    value={baseText}
                    onChange={e => setBaseText(e.target.value)}
                    placeholder="예: 시온전자 무선 차임벨"
                    className={`${C.input} border rounded w-full px-2 py-1 text-xs`}
                  />
                </div>

                {/* 키워드 버킷들 (칩) */}
                {pool && (() => {
                  const buckets: Array<[string, string, string[]]> = [
                    ['👁 비전 특징', dark ? 'bg-emerald-900/30 border-emerald-700' : 'bg-emerald-50 border-emerald-300', pool.vision_features],
                    ['📌 원본 검색태그', dark ? 'bg-gray-700/50 border-gray-600' : 'bg-gray-100 border-gray-300', pool.preset_keywords],
                    ['🌐 네이버 키워드(저장)', dark ? 'bg-sky-900/30 border-sky-700' : 'bg-sky-50 border-sky-300', pool.naver_keywords],
                    ['🌟 11번가 베스트', dark ? 'bg-yellow-900/30 border-yellow-700' : 'bg-yellow-50 border-yellow-300', pool.best_picks],
                    ['⭐ 11번가 우수', dark ? 'bg-orange-900/30 border-orange-700' : 'bg-orange-50 border-orange-300', pool.good_picks],
                    ['✨ 11번가 광고', dark ? 'bg-violet-900/30 border-violet-700' : 'bg-violet-50 border-violet-300', pool.ad_keywords],
                    ['🔧 11번가 기능성', dark ? 'bg-blue-900/30 border-blue-700' : 'bg-blue-50 border-blue-300', pool.functional_keywords],
                    ['➕ 직접 추가', dark ? 'bg-fuchsia-900/30 border-fuchsia-700' : 'bg-fuchsia-50 border-fuchsia-300', extraKws],
                  ];
                  return buckets.map(([label, cls, items]) => items.length > 0 && (
                    <div key={label} className={`mb-1.5 p-1.5 rounded border ${cls}`}>
                      <div className={`text-[9px] font-bold mb-1 ${C.muted}`}>{label} ({items.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {items.map(kw => {
                          const on = selectedOrder.includes(kw);
                          const isExtra = extraKws.includes(kw);
                          return (
                            <span key={kw}
                                  onClick={() => toggleKeyword(kw)}
                                  className={`px-1.5 py-0.5 rounded text-[11px] cursor-pointer border transition-all ${
                                    on
                                      ? 'bg-amber-500 text-white border-amber-600 font-bold'
                                      : dark
                                        ? 'bg-[#1c1c2e] border-[#2a2a40] text-gray-300 hover:border-amber-500'
                                        : 'bg-white border-gray-300 text-gray-700 hover:border-amber-500'
                                  }`}>
                              {kw}
                              {isExtra && (
                                <button onClick={e => { e.stopPropagation(); removeExtraKw(kw); }}
                                        className="ml-1 text-rose-400 hover:text-rose-600 text-[10px]"
                                        title="이 추가 키워드 삭제">×</button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()}

                {/* 직접 키워드 추가 */}
                <div className="flex items-center gap-1.5 mt-2">
                  <input value={newKw} onChange={e => setNewKw(e.target.value)}
                         onKeyDown={e => { if (e.key === 'Enter') addExtraKw(); }}
                         placeholder="키워드 입력 후 Enter / 추가"
                         className={`${C.input} flex-1 border rounded px-2 py-1 text-xs`} />
                  <button onClick={addExtraKw}
                          className="px-2 py-1 text-xs rounded bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold">
                    + 추가
                  </button>
                </div>

                {/* 미리보기 */}
                <div className={`mt-2.5 p-2 rounded border-2 ${dark ? 'border-amber-500 bg-amber-900/20' : 'border-amber-400 bg-amber-100/50'}`}>
                  <div className={`text-[10px] font-bold mb-0.5 flex items-center justify-between ${dark ? 'text-amber-300' : 'text-amber-800'}`}>
                    <span>📋 미리보기</span>
                    <span className={`text-[10px] font-normal ${
                      previewBytes > MAX_BYTES_KW ? 'text-rose-500' :
                      previewBytes > 80 ? 'text-amber-500' : C.muted
                    }`}>
                      {buildPreview.length}자 / {previewBytes}바이트 (한도 {MAX_BYTES_KW})
                    </span>
                  </div>
                  <div className={`text-sm font-medium ${dark ? 'text-amber-200' : 'text-amber-900'}`}>
                    {buildPreview || <span className={C.muted}>키워드를 선택하세요</span>}
                  </div>
                  <button onClick={applyPreviewToForm}
                          disabled={!buildPreview.trim()}
                          className="mt-1.5 px-2.5 py-1 text-[11px] font-bold rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 disabled:cursor-not-allowed">
                    ⬇ 적용해서 네이버 상품명에 반영
                  </button>
                </div>
              </div>

              {/* 11번가 원본 keywords (참고만, 편집 가능) */}
              <div>
                <label className={`block ${C.label} mb-1 text-[10px]`}>11번가 원본 keywords (저장됨)</label>
                <textarea
                  value={form.keywords}
                  onChange={e => setForm(s => ({ ...s, keywords: e.target.value }))}
                  rows={2}
                  className={`${C.input} border rounded w-full px-2 py-1 text-[11px]`}
                />
              </div>
              <div>
                <label className={`block ${C.label} mb-1 text-[10px]`}>네이버 전용 키워드 (저장됨, 쉼표 구분)</label>
                <textarea
                  value={form.naver_keywords}
                  onChange={e => setForm(s => ({ ...s, naver_keywords: e.target.value }))}
                  rows={2}
                  className={`${C.input} border rounded w-full px-2 py-1 text-[11px]`}
                />
              </div>
            </div>
          </div>

          {/* ── 확장 시 우측 상세 panel ── */}
          {expanded && (
            <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'}`}>
              <div className={`text-xs font-bold mb-2 flex items-center gap-2 ${C.text}`}>
                <span>🔍 상품 원본 상세</span>
                {d.image_large && (
                  <a href={d.image_large} target="_blank" rel="noreferrer"
                     className={`text-[10px] font-normal underline ${dark ? 'text-sky-300' : 'text-sky-600'}`}>
                    이미지 새창
                  </a>
                )}
              </div>

              {/* 큰 이미지 (있으면) */}
              {d.image_large && (
                <div className={`${C.panel} rounded mb-3 p-2 border ${C.border}`}>
                  <img src={d.image_large} alt={d.product_name || ''}
                       className="w-full max-h-[400px] object-contain rounded" />
                </div>
              )}

              {/* 옵션 / 상품 속성 */}
              {(d.option1_name || d.option2_name || d.combined_option || d.product_attribute) && (
                <div className={`${C.panel} rounded p-3 mb-3 text-[11px] space-y-1.5`}>
                  <div className={`font-bold ${C.text}`}>📦 옵션 / 속성</div>
                  {d.option1_name && (
                    <div><span className={C.muted}>옵션1 ({d.option1_name}):</span> <span className={C.text}>{d.option1_values}</span></div>
                  )}
                  {d.option2_name && (
                    <div><span className={C.muted}>옵션2 ({d.option2_name}):</span> <span className={C.text}>{d.option2_values}</span></div>
                  )}
                  {d.product_attribute && (
                    <div><span className={C.muted}>속성:</span> <span className={C.text}>{d.product_attribute}</span></div>
                  )}
                </div>
              )}

              {/* 상세 HTML */}
              <div className={`${C.panel} rounded p-3 ${C.border} border`}>
                <div className={`font-bold ${C.text} text-xs mb-2 flex items-center justify-between`}>
                  <span>📄 상세 페이지</span>
                  <span className={`text-[10px] font-normal ${C.muted}`}>
                    {d.detail_html ? `${d.detail_html.length.toLocaleString()}자` : '없음'}
                  </span>
                </div>
                {d.detail_html ? (
                  <div className={`prose prose-sm max-w-none ${dark ? 'prose-invert' : ''} bg-white text-gray-900 rounded p-3 max-h-[60vh] overflow-y-auto`}
                       dangerouslySetInnerHTML={{ __html: d.detail_html }} />
                ) : (
                  <div className={`text-xs ${C.muted} italic`}>저장된 상세 HTML 없음</div>
                )}
              </div>
            </div>
          )}
          </div>
        )}

        {/* Footer */}
        <div className={`border-t ${C.border} px-5 py-3 flex items-center gap-2 ${dark ? 'bg-[#181828]' : 'bg-gray-50'} rounded-b-xl`}>
          <button
            onClick={onClearVision}
            disabled={clearBusy || loading || !d?.image_analysis}
            title="비전 분석 캐시 삭제 (다음 생성 시 이미지 재분석)"
            className={`px-3 py-1.5 text-xs rounded ${dark ? 'bg-[#252540] text-gray-300 hover:bg-[#2f2f50]' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} disabled:opacity-40`}
          >
            🗑 비전 캐시 삭제
          </button>
          <button
            onClick={onRegenerate}
            disabled={genBusy || loading}
            className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40"
          >
            {genBusy ? '⏳ 생성 중...' : '🤖 재생성'}
          </button>
          <div className="flex-1" />
          <button onClick={onClose}
                  className={`px-3 py-1.5 text-xs rounded ${dark ? 'bg-[#252540] text-gray-300 hover:bg-[#2f2f50]' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
            취소
          </button>
          <button
            onClick={onSave}
            disabled={saving || loading}
            className="px-4 py-1.5 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40"
          >
            {saving ? '저장 중...' : '💾 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
