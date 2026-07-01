import { useState, useEffect, useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  fetchProducts,
  syncProducts,
  fetchProductStats,
  downloadProductExcel,
  fetchWCodes,
  fetchProductCount,
  fetchOrphanWCodes,
  previewSuspend,
  suspendProducts as apiSuspendProducts,
  toggleFocus,
  toggleRestockChecked,
  refreshTracking,
  startAudit,
  getAuditStatus,
  stopAudit,
  getAuditLogs,
  getAuditLogDetail,
  type SmartStoreProduct,
  type ProductStats,
  type SuspendPreviewResult,
  type AuditStatus,
  type AuditLog,
  type AuditLogDetail,
  fetchZeroMarginPreview,
  executeZeroMarginUpdate,
  fetchZeroMarginLogs,
  fetchZeroMarginLogDetail,
  fetchRestockSummary,
  type RestockSummary,
  type ZeroMarginPreviewItem,
  type ZeroMarginUpdateResult,
  type ZeroMarginLog,
  type ZeroMarginLogItem,
  fetchOrphanSoldout,
  startReconcile,
  fetchReconcileStatus,
  type OrphanSoldoutResult,
  type ReconcileStatus,
} from '../api/smartstoreProductApi';
import { fetchStores, fetchStoreCounts, type SmartStore, type StoreCount } from '../api/smartstoreApi';
import * as naverApi from '../api/naverApi';
import { fetchProductMeta, type ProductMeta } from '../api/bulkRegisterApi';
import ProductOrdersModal from '../components/smartstore/ProductOrdersModal';
import { ProductAttrModal } from '../components/ProductAttrModal';

const STATUS_LABELS: Record<string, string> = {
  SALE: '판매중',
  SUSPENSION: '판매중지',
  CLOSE: '판매종료',
  PROHIBITION: '판매금지',
  WAIT: '대기',
  UNKNOWN: '기타',
};

const STATUS_COLORS: Record<string, string> = {
  SALE: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  SUSPENSION: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  CLOSE: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  PROHIBITION: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

export default function SmartStoreProductsPage() {
  const [storeId, setStoreId] = useState(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const v = params.get('store_id');
    return v !== null ? Number(v) : 0;
  });
  const isAllStores = storeId === 0;

  const [, setStoreName] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [apiStores, setApiStores] = useState<SmartStore[]>([]);
  const [storeCounts, setStoreCounts] = useState<StoreCount[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [products, setProducts] = useState<SmartStoreProduct[]>([]);
  const [productMeta, setProductMeta] = useState<Record<string, ProductMeta>>({});
  const [attrModal, setAttrModal] = useState<{ code: string; store: number } | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [perPage] = useState(50);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [restockSummary, setRestockSummary] = useState<RestockSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [soldoutFilter] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'focus' | 'premium' | 'sold' | 'changes' | 'status_mm' | 'field_chg' | 'reverse_margin' | 'no_master'>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [excelOpen, setExcelOpen] = useState(false);
  const [excelDownloading, setExcelDownloading] = useState(false);
  const [detailProduct, setDetailProduct] = useState<SmartStoreProduct | null>(null);
  // 체크박스 + 품절처리
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [suspendPreview, setSuspendPreview] = useState<SuspendPreviewResult | null>(null);
  const [suspendLoading, setSuspendLoading] = useState(false);
  const [suspendExecuting, setSuspendExecuting] = useState(false);
  const [suspendResult, setSuspendResult] = useState<{ success: number; fail: number } | null>(null);
  const [orderModal, setOrderModal] = useState<{ code: string; name: string } | null>(null);
  const [rankTrackProduct, setRankTrackProduct] = useState<SmartStoreProduct | null>(null);
  const [trackedProductIds, setTrackedProductIds] = useState<Set<number>>(new Set());
  // 오너클랜 이탈 SALE 박제(고아 품절)
  const [orphan, setOrphan] = useState<OrphanSoldoutResult | null>(null);
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);
  // 전체동기화(리콘실)
  const [reconcile, setReconcile] = useState<ReconcileStatus | null>(null);
  const [reconcileModalOpen, setReconcileModalOpen] = useState(false);
  const [reconcileConfirmOpen, setReconcileConfirmOpen] = useState(false);
  const reconcilePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 구매키워드 모달
  const [buyKwModal, setBuyKwModal] = useState<{ productCode: string; productName: string } | null>(null);
  const [trackingRefreshing, setTrackingRefreshing] = useState(false);
  // 전상품 검증
  const [auditStatus, setAuditStatus] = useState<AuditStatus | null>(null);
  const [auditPolling, setAuditPolling] = useState(false);
  const [auditConfirmOpen, setAuditConfirmOpen] = useState(false);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditDetail, setAuditDetail] = useState<AuditLogDetail | null>(null);
  const [auditDetailId, setAuditDetailId] = useState(0);
  const auditTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const auditLogRef = useRef<HTMLPreElement>(null);
  // 0마진 처리
  const [zmOpen, setZmOpen] = useState(false);
  const [zmPreview, setZmPreview] = useState<ZeroMarginPreviewItem[] | null>(null);
  const [zmLoading, setZmLoading] = useState(false);
  const [zmExecuting, setZmExecuting] = useState(false);
  const [zmResult, setZmResult] = useState<ZeroMarginUpdateResult | null>(null);
  const [zmTab, setZmTab] = useState<'preview' | 'logs'>('preview');
  const [zmLogs, setZmLogs] = useState<ZeroMarginLog[]>([]);
  const [zmLogDetail, setZmLogDetail] = useState<ZeroMarginLogItem[] | null>(null);
  // 뷰 모드: 'default' = 기존 테이블, 'detail' = 대장보기(상세)
  const [viewMode, setViewMode] = useState<'default' | 'detail'>('default');
  // 정렬
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // 전상품 검증 초기 상태 확인 + 폴링
  useEffect(() => {
    getAuditStatus().then(st => {
      setAuditStatus(st);
      if (st.running) setAuditPolling(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!auditPolling) {
      if (auditTimerRef.current) clearInterval(auditTimerRef.current);
      auditTimerRef.current = null;
      return;
    }
    auditTimerRef.current = setInterval(async () => {
      try {
        const st = await getAuditStatus();
        setAuditStatus(st);
        if (!st.running) {
          setAuditPolling(false);
          loadProducts();
          loadStats();
        }
      } catch { /* */ }
    }, 1500);
    return () => {
      if (auditTimerRef.current) clearInterval(auditTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditPolling]);

  useEffect(() => {
    if (auditLogRef.current) {
      auditLogRef.current.scrollTop = auditLogRef.current.scrollHeight;
    }
  }, [auditStatus?.logs]);

  const handleAuditStart = async (source: 'api' | 'ownerclan' = 'api') => {
    setAuditConfirmOpen(false);
    try {
      const res = await startAudit(source);
      if (res.ok) {
        setAuditPolling(true);
      } else {
        alert(res.message);
      }
    } catch (e: any) {
      alert(e?.response?.data?.message || '검증 시작 실패');
    }
  };

  const handleAuditStop = async () => {
    await stopAudit();
  };

  const handleAuditLogsOpen = async () => {
    try {
      const logs = await getAuditLogs(20);
      setAuditLogs(logs);
      setAuditLogsOpen(true);
      setAuditDetail(null);
      setAuditDetailId(0);
    } catch { /* */ }
  };

  const handleAuditDetailOpen = async (id: number) => {
    try {
      const detail = await getAuditLogDetail(id);
      setAuditDetail(detail);
      setAuditDetailId(id);
    } catch { /* */ }
  };

  // 순위추적 배지용 product ID 조회
  useEffect(() => {
    naverApi.getTrackedProductIds().then(ids => setTrackedProductIds(new Set(ids))).catch(() => {});
  }, []);

  // 상점명 + API 상점 목록 조회
  useEffect(() => {
    if (storeId < 0) return;
    fetchStores(true).then(stores => {
      if (isAllStores) {
        setStoreName('전체상점');
        setStoreUrl('');
      } else {
        const s = stores.find(st => st.id === storeId);
        if (s) {
          setStoreName(s.store_name);
          setStoreUrl(s.store_url || '');
        }
      }
      setApiStores(stores.filter(st => st.is_active && st.commerce_api_key));
    });
  }, [storeId, isAllStores]);

  // 좌측 사이드바 — 스토어별 카운트 (총 / 판매중)
  useEffect(() => {
    let alive = true;
    fetchStoreCounts().then(r => {
      if (alive) setStoreCounts(r.items);
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, []);

  // 재입고 재활성화 요약 — 판매중지 필터일 때만 표시
  useEffect(() => {
    if (status === 'SUSPENSION' && storeId >= 0) {
      let alive = true;
      fetchRestockSummary(storeId)
        .then(r => { if (alive) setRestockSummary(r); })
        .catch(() => { if (alive) setRestockSummary(null); });
      return () => { alive = false; };
    }
    setRestockSummary(null);
  }, [status, storeId]);

  // 상품 목록 조회
  const loadProducts = useCallback(async () => {
    if (storeId < 0) return;
    setLoading(true);
    try {
      const hasChangesVal = filterMode === 'changes' ? 1 : filterMode === 'status_mm' ? 2 : filterMode === 'field_chg' ? 3 : undefined;
      const reverseMarginVal = filterMode === 'reverse_margin' ? 1 : undefined;
      const noMasterVal = filterMode === 'no_master' ? 1 : undefined;
      const res = await fetchProducts(storeId, page, perPage, status || undefined, search || undefined, soldoutFilter ? 1 : undefined, filterMode === 'focus' ? 1 : undefined, filterMode === 'sold' ? 1 : undefined, sortBy || undefined, sortBy ? sortDir : undefined, filterMode === 'premium' ? 500000 : undefined, hasChangesVal, reverseMarginVal, undefined, noMasterVal);
      setProducts(res.items);
      setTotal(res.total);
      setTotalPages(res.total_pages);
      const codes = res.items.map((it: any) => it.seller_management_code).filter(Boolean);
      if (codes.length) fetchProductMeta(codes, storeId).then(setProductMeta).catch(() => {});
    } catch {
      setProducts([]);
      setTotal(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [storeId, page, perPage, status, search, soldoutFilter, filterMode, sortBy, sortDir]);

  // 통계 조회
  const loadStats = useCallback(async () => {
    if (storeId < 0) return;
    const s = await fetchProductStats(storeId);
    setStats(s);
  }, [storeId]);

  // 오너클랜 이탈 SALE 박제 조회
  const loadOrphan = useCallback(async () => {
    if (storeId < 0) return;
    try { setOrphan(await fetchOrphanSoldout(storeId)); } catch { /* noop */ }
  }, [storeId]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadOrphan(); }, [loadOrphan]);

  // 진행 중인 리콘실 있으면 마운트 시 폴링 재개
  useEffect(() => {
    (async () => {
      try {
        const st = await fetchReconcileStatus();
        if (st.running) { setReconcile(st); startReconcilePoll(); }
        else if (st.results.length) setReconcile(st);
      } catch { /* noop */ }
    })();
    return () => { if (reconcilePollRef.current) clearInterval(reconcilePollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startReconcilePoll = () => {
    if (reconcilePollRef.current) clearInterval(reconcilePollRef.current);
    reconcilePollRef.current = setInterval(async () => {
      try {
        const st = await fetchReconcileStatus();
        setReconcile(st);
        if (!st.running) {
          if (reconcilePollRef.current) clearInterval(reconcilePollRef.current);
          reconcilePollRef.current = null;
          loadProducts(); loadStats(); loadOrphan();
        }
      } catch { /* noop */ }
    }, 2000);
  };

  // 전체동기화 실행 (확인 모달에서 호출)
  const doReconcile = async () => {
    setReconcileConfirmOpen(false);
    setReconcileModalOpen(true);
    try {
      const r = await startReconcile({ apply: true });
      if (!r.ok) { alert(r.error || '시작 실패'); return; }
      const st = await fetchReconcileStatus();
      setReconcile(st);
      startReconcilePoll();
    } catch {
      alert('전체동기화 시작 실패');
    }
  };

  // 동기화
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await syncProducts(storeId);
      setSyncMsg(`${res.synced}개 상품 동기화 완료`);
      loadProducts();
      loadStats();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setSyncMsg(err.response?.data?.error || '동기화 실패');
    } finally {
      setSyncing(false);
    }
  };

  // 검색
  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const handleStatusChange = (v: string) => {
    setStatus(v);
    setPage(1);
  };

  // 정렬 토글: desc → asc → 해제
  const toggleSort = (col: string) => {
    if (sortBy !== col) {
      setSortBy(col);
      setSortDir('desc');
    } else if (sortDir === 'desc') {
      setSortDir('asc');
    } else {
      setSortBy('');
      setSortDir('desc');
    }
    setPage(1);
  };
  // 판매금액 전용 토글: order_amount desc → asc → ss_order_amount desc → asc → 해제
  const toggleAmountSort = () => {
    if (sortBy === 'order_amount' && sortDir === 'desc') {
      setSortDir('asc');
    } else if (sortBy === 'order_amount' && sortDir === 'asc') {
      setSortBy('ss_order_amount');
      setSortDir('desc');
    } else if (sortBy === 'ss_order_amount' && sortDir === 'desc') {
      setSortDir('asc');
    } else if (sortBy === 'ss_order_amount' && sortDir === 'asc') {
      setSortBy('');
      setSortDir('desc');
    } else {
      setSortBy('order_amount');
      setSortDir('desc');
    }
    setPage(1);
  };
  const sortIcon = (col: string) => {
    if (sortBy !== col) return '';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  };
  const amountSortLabel = () => {
    if (sortBy === 'order_amount') return `판매금액${sortDir === 'desc' ? ' ↓' : ' ↑'}`;
    if (sortBy === 'ss_order_amount') return `SS판매금액${sortDir === 'desc' ? ' ↓' : ' ↑'}`;
    return '판매금액';
  };

  // 체크박스 핸들러
  const handleToggleId = (id: number) => {
    setSelectAll(false);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handlePageSelectAll = () => {
    setSelectAll(false);
    const allOnPage = products.map(p => p.id);
    const allChecked = allOnPage.every(id => selectedIds.has(id));
    if (allChecked) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        allOnPage.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        allOnPage.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectAll(false);
      setSelectedIds(new Set());
    } else {
      setSelectAll(true);
      setSelectedIds(new Set());
    }
  };

  const selectionCount = selectAll ? total : selectedIds.size;
  const hasSelection = selectionCount > 0;

  // 품절처리 프리뷰
  const handleSuspendClick = async () => {
    setSuspendLoading(true);
    setSuspendPreview(null);
    setSuspendResult(null);
    try {
      const result = await previewSuspend(
        Array.from(selectedIds),
        selectAll,
        {
          store_id: storeId,
          status: status || undefined,
          search: search || undefined,
          ownerclan_soldout: soldoutFilter ? 1 : undefined,
        },
      );
      setSuspendPreview(result);
      setSuspendModalOpen(true);
    } catch {
      alert('품절처리 대상 조회 실패');
    } finally {
      setSuspendLoading(false);
    }
  };

  // 품절처리 실행
  const handleSuspendConfirm = async () => {
    setSuspendExecuting(true);
    try {
      const result = await apiSuspendProducts(
        Array.from(selectedIds),
        selectAll,
        {
          store_id: storeId,
          status: status || undefined,
          search: search || undefined,
          ownerclan_soldout: soldoutFilter ? 1 : undefined,
        },
      );
      setSuspendResult({ success: result.success_count, fail: result.fail_count });
      if (result.fail_count > 0 && result.errors.length > 0) {
        console.warn('품절처리 실패 항목:', result.errors);
      }
      // 완료 후 리프레시
      setSelectedIds(new Set());
      setSelectAll(false);
      loadProducts();
      loadStats();
    } catch {
      alert('품절처리 실행 실패');
    } finally {
      setSuspendExecuting(false);
    }
  };

  // 집중관리 토글
  const handleToggleFocus = async (productId: number, currentFocus: number) => {
    await toggleFocus([productId], currentFocus ? 0 : 1);
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, is_focus: currentFocus ? 0 : 1 } : p));
  };

  const handleBulkFocus = async (isFocus: number) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await toggleFocus(ids, isFocus);
    setSelectedIds(new Set());
    setSelectAll(false);
    loadProducts();
  };

  // 관리코드 전체 복사
  const [copyDone, setCopyDone] = useState(false);
  const handleCopyCodes = () => {
    const codes = products.map(p => p.seller_management_code).filter(Boolean).join('\n');
    if (!codes) return;
    navigator.clipboard.writeText(codes).then(() => {
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 1500);
    });
  };

  // 현재 필터로 엑셀 직접 다운로드
  const handleDirectExcel = async () => {
    setExcelDownloading(true);
    try {
      await downloadProductExcel({
        storeIds: isAllStores ? undefined : [storeId],
        statuses: status ? [status] : undefined,
        search: search || undefined,
        hasOrders: filterMode === 'sold' || undefined,
        isFocus: filterMode === 'focus' || undefined,
        sortBy: sortBy || undefined,
        sortDir: sortBy ? sortDir : undefined,
      });
    } catch {
      alert('엑셀 다운로드 실패');
    } finally {
      setExcelDownloading(false);
    }
  };

  // storeId는 항상 0 이상 (0=전체, n=개별상점)

  const colSpan = isAllStores ? 13 : 12;
  const getStoreUrlById = (sid: number) => apiStores.find(st => st.id === sid)?.store_url || '';

  const totalAcrossStores = storeCounts.reduce((s, st) => s + st.total_count, 0);
  const totalSaleAcross = storeCounts.reduce((s, st) => s + st.sale_count, 0);

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* 좌측 폴더 사이드바 (네이버 ID 별) */}
      {sidebarOpen ? (
        <aside className="w-56 shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 overflow-y-auto sticky top-[42px] self-start max-h-[calc(100vh-42px)]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <span className="text-xs font-bold text-gray-700 dark:text-gray-200">📁 스토어 ({storeCounts.length})</span>
            <button onClick={() => setSidebarOpen(false)}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm"
                    title="사이드바 접기">◀</button>
          </div>
          <div className="p-1.5 space-y-0.5">
            <button
              onClick={() => { setStoreId(0); setPage(1); setSelectedIds(new Set()); setSelectAll(false); }}
              className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between border ${
                storeId === 0
                  ? 'bg-[#03c75a]/15 border-[#03c75a] text-gray-900 dark:text-white font-bold'
                  : 'border-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}>
              <span>📦 전체상점</span>
              <span className="text-[10px] text-gray-500">
                <span className="text-green-600 dark:text-green-400 font-mono">{totalSaleAcross.toLocaleString()}</span>
                <span className="opacity-60">/{totalAcrossStores.toLocaleString()}</span>
              </span>
            </button>
            {storeCounts.map(st => {
              const active = storeId === st.id;
              return (
                <button key={st.id}
                        onClick={() => { setStoreId(st.id); setPage(1); setSelectedIds(new Set()); setSelectAll(false); }}
                        title={`판매중 ${st.sale_count.toLocaleString()} / 총 ${st.total_count.toLocaleString()}`}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between border ${
                          active
                            ? 'bg-[#03c75a]/15 border-[#03c75a] text-gray-900 dark:text-white font-bold'
                            : 'border-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}>
                  <span className="truncate">{st.store_name}</span>
                  <span className="text-[10px] text-gray-500 shrink-0 ml-2">
                    <span className="text-green-600 dark:text-green-400 font-mono">{st.sale_count.toLocaleString()}</span>
                    <span className="opacity-60">/{st.total_count.toLocaleString()}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      ) : (
        <button onClick={() => setSidebarOpen(true)}
                className="w-6 shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 text-xs"
                title="사이드바 펼치기">▶</button>
      )}

    <div className="flex-1 min-w-0 text-gray-800 dark:text-gray-200">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-lg"
              onClick={() => history.back()}
              title="뒤로가기"
            >
              &larr;
            </button>
            <select
              className="text-sm font-bold border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700"
              value={storeId}
              onChange={(e) => {
                setStoreId(Number(e.target.value));
                setPage(1);
                setSelectedIds(new Set());
                setSelectAll(false);
              }}
            >
              <option value={0}>전체상점</option>
              {apiStores.map(s => (
                <option key={s.id} value={s.id}>{s.store_name}</option>
              ))}
            </select>
            <button
              onClick={() => { window.location.hash = 'store-collect'; }}
              className="text-gray-400 text-sm hover:text-[#03c75a] transition-colors cursor-pointer"
            >
              스토어관리
            </button>
            <button
              onClick={() => setViewMode(viewMode === 'default' ? 'detail' : 'default')}
              className={`text-sm px-2.5 py-1 rounded-full border transition-all ${
                viewMode === 'detail'
                  ? 'bg-[#03c75a] text-white border-[#03c75a] shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:border-[#03c75a] hover:text-[#03c75a]'
              }`}
            >
              {viewMode === 'detail' ? '간략보기' : '대장보기'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {hasSelection && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {selectAll ? `전체 ${total.toLocaleString()}개` : `${selectedIds.size.toLocaleString()}개`} 선택
              </span>
            )}
            {hasSelection && !selectAll && (
              <>
                <button
                  className="px-3 py-1.5 text-sm bg-yellow-500 text-white rounded hover:bg-yellow-600 font-medium"
                  onClick={() => handleBulkFocus(1)}
                >
                  ★ 집중관리
                </button>
                <button
                  className="px-3 py-1.5 text-sm bg-gray-400 text-white rounded hover:bg-gray-500 font-medium"
                  onClick={() => handleBulkFocus(0)}
                >
                  ☆ 해제
                </button>
              </>
            )}
            <button
              className="px-3 py-1.5 text-sm bg-pink-500 text-white rounded hover:bg-pink-600 disabled:opacity-50 font-medium"
              onClick={async () => {
                const ids = Array.from(selectedIds);
                const selected = products.filter(p => ids.includes(p.id));
                if (selected.length === 0) return;
                const payload = selected.map(p => ({
                  origin_product_no: p.origin_product_no,
                  store_name: p.store_name || '',
                  store_id: p.store_id,
                  product_name: p.name,
                  sale_price: p.sale_price,
                  category_id: p.category_id || '',
                  product_image_url: p.product_image_url || '',
                  seller_management_code: p.seller_management_code || '',
                }));
                try {
                  const res = await naverApi.addRankCunningProducts(payload);
                  alert(`순위컨닝에 ${res.added}개 추가 완료`);
                } catch (e) { alert('추가 실패'); }
              }}
              disabled={!hasSelection}
            >
              순위컨닝
            </button>
            <button
              className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 font-medium"
              onClick={handleSuspendClick}
              disabled={!hasSelection || suspendLoading}
            >
              {suspendLoading ? '조회 중...' : '품절처리'}
            </button>
            <button
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
              onClick={handleDirectExcel}
              disabled={excelDownloading}
            >
              {excelDownloading ? '다운로드중...' : '엑셀받기'}
            </button>
            <button
              className="px-2 py-1.5 text-sm bg-gray-500 text-white rounded hover:bg-gray-600 font-medium"
              onClick={() => setExcelOpen(true)}
              title="W코드추출 / 커스텀 엑셀"
            >
              W코드
            </button>
            {isAllStores && (
              <button
                className="px-4 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 font-medium"
                onClick={() => auditStatus?.running ? undefined : setAuditConfirmOpen(true)}
                disabled={auditStatus?.running}
                title="전체 상품 네이버 API 검증"
              >
                {auditStatus?.running ? `검증중 ${auditStatus.progress_pct}%` : '품단종 검증'}
              </button>
            )}
            {!isAllStores && (
              <button
                className="px-4 py-1.5 text-sm bg-[#03c75a] text-white rounded hover:bg-[#02b351] disabled:opacity-50 font-medium"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? '동기화 중...' : '동기화'}
              </button>
            )}
            <button
              className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 font-medium"
              onClick={() => (reconcile?.running ? setReconcileModalOpen(true) : setReconcileConfirmOpen(true))}
              title="전 마켓 네이버 라이브와 DB 상품수 일치 (삭제분 반영)"
            >
              {reconcile?.running
                ? `전체동기화 ${reconcile.done}/${reconcile.total}`
                : '전체동기화'}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* Sync message */}
        {syncMsg && (
          <div className={`text-sm px-3 py-2 rounded ${
            syncMsg.includes('실패') || syncMsg.includes('오류')
              ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
          }`}>
            {syncMsg}
            <button className="ml-2 text-xs underline opacity-60" onClick={() => setSyncMsg('')}>닫기</button>
          </div>
        )}

        {/* Audit progress bar */}
        {auditStatus && (auditStatus.running || (auditStatus.checked > 0 && auditStatus.audit_log_id > 0)) && (
          <div className="bg-[#1c1c2e] dark:bg-[#1c1c2e] bg-white border border-[#2a2a40] dark:border-[#2a2a40] border-gray-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white dark:text-white text-gray-900">
                  {auditStatus.running
                    ? (auditStatus.current_api_key === 'ownerclan' ? '오너클랜 비교 진행 중' : '전상품 API 검증 진행 중')
                    : (auditStatus.current_api_key === 'ownerclan' ? '오너클랜 비교 완료' : '검증 완료')}
                </span>
                {auditStatus.running && (
                  <span className="inline-block w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
                )}
              </div>
              <div className="flex items-center gap-2">
                {auditStatus.running && (
                  <button
                    onClick={handleAuditStop}
                    className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                  >중지</button>
                )}
                <button
                  onClick={handleAuditLogsOpen}
                  className="px-3 py-1 text-xs bg-gray-600 text-white rounded hover:bg-gray-700"
                >이력</button>
                {!auditStatus.running && (
                  <button
                    onClick={() => { setAuditStatus(null); }}
                    className="text-xs text-gray-400 hover:text-gray-200"
                  >닫기</button>
                )}
              </div>
            </div>
            {/* Progress bar */}
            <div className="w-full bg-gray-700 dark:bg-gray-700 bg-gray-200 rounded-full h-3 overflow-hidden">
              <div
                className="bg-orange-500 h-3 rounded-full transition-all duration-300"
                style={{ width: `${Math.min(auditStatus.progress_pct, 100)}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-300 dark:text-gray-300 text-gray-600">
              <span>{auditStatus.progress_pct}% ({auditStatus.checked.toLocaleString()} / {auditStatus.total.toLocaleString()})</span>
              <span>일치: <span className="text-green-400">{auditStatus.match.toLocaleString()}</span></span>
              <span>불일치: <span className="text-yellow-400">{auditStatus.mismatch.toLocaleString()}</span></span>
              <span>수정: <span className="text-blue-400">{auditStatus.fixed.toLocaleString()}</span></span>
              <span>CLOSE: <span className="text-gray-400">{auditStatus.closed.toLocaleString()}</span></span>
              <span>에러: <span className="text-red-400">{auditStatus.errors.toLocaleString()}</span></span>
              <span>경과: {Math.floor(auditStatus.elapsed / 60)}분 {Math.floor(auditStatus.elapsed % 60)}초</span>
            </div>
            {/* Live logs */}
            {auditStatus.logs.length > 0 && (
              <pre
                ref={auditLogRef}
                className="bg-black/40 dark:bg-black/40 bg-gray-100 rounded p-2 text-xs text-gray-300 dark:text-gray-300 text-gray-700 max-h-32 overflow-y-auto font-mono"
              >
                {auditStatus.logs.slice(-20).join('\n')}
              </pre>
            )}
          </div>
        )}

        {/* Stats bar */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
            {/* 전체 */}
            <StatCard
              label="전체" labelColor="text-gray-400"
              count={stats.total} countColor=""
              soldCount={stats.sold_count} ssSoldCount={stats.ss_sold_count}
              isCountActive={filterMode === 'all' && !status}
              isSoldActive={filterMode === 'sold' && !status}
              onCountClick={() => { setFilterMode('all'); setStatus(''); setPage(1); }}
              onSoldClick={() => {
                if (filterMode === 'sold' && !status) { setFilterMode('all'); } else { setFilterMode('sold'); setStatus(''); }
                setPage(1);
              }}
            />
            {/* 판매중 */}
            <StatCard
              label="판매중" labelColor="text-green-500"
              count={stats.by_status['SALE'] || 0} countColor="text-green-600"
              soldCount={stats.sold_by_status?.['SALE'] || 0} ssSoldCount={stats.ss_sold_by_status?.['SALE'] || 0}
              isCountActive={filterMode === 'all' && status === 'SALE'}
              isSoldActive={filterMode === 'sold' && status === 'SALE'}
              onCountClick={() => {
                if (filterMode === 'all' && status === 'SALE') { setStatus(''); } else { setFilterMode('all'); setStatus('SALE'); }
                setPage(1);
              }}
              onSoldClick={() => {
                if (filterMode === 'sold' && status === 'SALE') { setFilterMode('all'); setStatus(''); } else { setFilterMode('sold'); setStatus('SALE'); }
                setPage(1);
              }}
            />
            {/* 판매중지 */}
            <StatCard
              label="판매중지" labelColor="text-yellow-500"
              count={stats.by_status['SUSPENSION'] || 0} countColor="text-yellow-600"
              soldCount={stats.sold_by_status?.['SUSPENSION'] || 0} ssSoldCount={stats.ss_sold_by_status?.['SUSPENSION'] || 0}
              isCountActive={filterMode === 'all' && status === 'SUSPENSION'}
              isSoldActive={filterMode === 'sold' && status === 'SUSPENSION'}
              onCountClick={() => {
                if (filterMode === 'all' && status === 'SUSPENSION') { setStatus(''); } else { setFilterMode('all'); setStatus('SUSPENSION'); }
                setPage(1);
              }}
              onSoldClick={() => {
                if (filterMode === 'sold' && status === 'SUSPENSION') { setFilterMode('all'); setStatus(''); } else { setFilterMode('sold'); setStatus('SUSPENSION'); }
                setPage(1);
              }}
            />
            {/* 기타 */}
            {(() => {
              const etcCount = stats.total - (stats.by_status['SALE'] || 0) - (stats.by_status['SUSPENSION'] || 0);
              const etcSold = stats.sold_count - (stats.sold_by_status?.['SALE'] || 0) - (stats.sold_by_status?.['SUSPENSION'] || 0);
              const etcSsSold = stats.ss_sold_count - (stats.ss_sold_by_status?.['SALE'] || 0) - (stats.ss_sold_by_status?.['SUSPENSION'] || 0);
              return (
                <StatCard
                  label="기타" labelColor="text-gray-400"
                  count={etcCount} countColor=""
                  soldCount={etcSold} ssSoldCount={etcSsSold}
                  isCountActive={false} isSoldActive={false}
                />
              );
            })()}
            {/* 오너클랜 이탈 SALE 박제(품절) */}
            <button
              type="button"
              onClick={() => orphan && orphan.count > 0 && setOrphanModalOpen(true)}
              className={`text-left bg-white dark:bg-gray-800 rounded border px-3 py-2 transition
                ${orphan && orphan.count > 0
                  ? 'border-red-400 dark:border-red-500 hover:ring-2 hover:ring-red-300 cursor-pointer'
                  : 'border-gray-200 dark:border-gray-700 cursor-default'}`}
              title="오너클랜 카탈로그에서 사라졌는데 판매중으로 박제된 상품 (사입불가)"
            >
              <div className="text-xs text-red-500 flex items-center gap-1">
                품절박제 <span className="text-[10px] text-gray-400">(오너클랜이탈)</span>
              </div>
              <div className={`text-xl font-bold ${orphan && orphan.count > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {orphan ? orphan.count.toLocaleString() : '-'}
              </div>
            </button>
            {/* 마지막 동기화 */}
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-gray-400">마지막 동기화</div>
              <div className="text-sm font-medium truncate" title={stats.last_synced_at || ''}>
                {stats.last_synced_at ? new Date(stats.last_synced_at).toLocaleString('ko-KR') : '-'}
              </div>
            </div>
          </div>
        )}

        {/* 재입고 재활성화 안내 — 판매중지 필터일 때만 */}
        {status === 'SUSPENSION' && restockSummary && restockSummary.candidates > 0 && (
          <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
            <div className="flex items-center gap-2">
              <span className="text-emerald-600 dark:text-emerald-400 text-lg">🔄</span>
              <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                판매중지 → 판매중 전환 대기(오너클랜 재입고){' '}
                <b className="text-base">{restockSummary.candidates.toLocaleString()}</b>개
              </span>
            </div>
            <span className="text-sm text-emerald-700 dark:text-emerald-300">
              상품수 제한으로 지금 <b className="text-base">{restockSummary.reactivatable.toLocaleString()}</b>건만 가능합니다
            </span>
            {restockSummary.blocked_over_limit > 0 && (
              <span className="text-sm text-amber-600 dark:text-amber-400">
                한도초과로 대기 {restockSummary.blocked_over_limit.toLocaleString()}건
              </span>
            )}
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">
              매일 자동 전환 (한도 여유분만 · 역마진 시 가격 자동수정)
            </span>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded overflow-hidden border border-gray-300 dark:border-gray-600">
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'all' && !status ? 'bg-[#03c75a] text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode('all'); setStatus(''); setPage(1); }}
            >전체</button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'focus' ? 'bg-yellow-500 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode('focus'); setStatus(''); setPage(1); }}
            >★ 집중관리</button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'premium' ? 'bg-orange-500 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode('premium'); setStatus(''); setPage(1); }}
            >◆ 우수상품</button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'sold' && !status ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode(filterMode === 'sold' && !status ? 'all' : 'sold'); setStatus(''); setPage(1); }}
            >판매된상품{stats ? ` ${stats.sold_count.toLocaleString()}` : ''}{stats && stats.ss_sold_count !== stats.sold_count ? <span className="text-[#03c75a] ml-0.5">({stats.ss_sold_count.toLocaleString()})</span> : ''}</button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'changes' ? 'bg-orange-500 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode(filterMode === 'changes' ? 'all' : 'changes'); setStatus(''); setPage(1); }}
            >수정사항{stats && stats.changes_count > 0 ? ` ${stats.changes_count.toLocaleString()}` : ''}</button>
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'reverse_margin' ? 'bg-red-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode(filterMode === 'reverse_margin' ? 'all' : 'reverse_margin'); setStatus(''); setPage(1); }}
            >역마진{stats && stats.reverse_margin_count > 0 ? ` ${stats.reverse_margin_count.toLocaleString()}` : ''}</button>
            {filterMode === 'reverse_margin' && stats && stats.reverse_margin_count > 0 && (
              <button
                className="px-3 py-1.5 text-sm font-medium bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors rounded"
                onClick={async () => {
                  setZmOpen(true); setZmLoading(true); setZmResult(null); setZmPreview(null);
                  try {
                    const res = await fetchZeroMarginPreview(storeId);
                    setZmPreview(res.items);
                  } catch { setZmPreview([]); }
                  setZmLoading(false);
                }}
              >0마진처리</button>
            )}
            <button
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${filterMode === 'no_master' ? 'bg-purple-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
              onClick={() => { setFilterMode(filterMode === 'no_master' ? 'all' : 'no_master'); setStatus(''); setPage(1); }}
            >원본없음{stats && stats.no_master_count > 0 ? ` ${stats.no_master_count.toLocaleString()}` : ''}</button>
          </div>
          {(filterMode === 'changes' || filterMode === 'status_mm' || filterMode === 'field_chg') && (
            <div className="flex items-center gap-1">
              <div className="flex rounded overflow-hidden border border-orange-300 dark:border-orange-600">
                <button
                  className={`px-2 py-1 text-xs font-medium transition-colors ${filterMode === 'changes' ? 'bg-orange-500 text-white' : 'bg-white dark:bg-gray-800 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20'}`}
                  onClick={() => { setFilterMode('changes'); setPage(1); }}
                >전체 {stats?.changes_count?.toLocaleString()}</button>
                <button
                  className={`px-2 py-1 text-xs font-medium transition-colors ${filterMode === 'status_mm' ? 'bg-red-500 text-white' : 'bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'}`}
                  onClick={() => { setFilterMode('status_mm'); setPage(1); }}
                >상태불일치 {stats?.status_mismatch_count?.toLocaleString()}</button>
                <button
                  className={`px-2 py-1 text-xs font-medium transition-colors ${filterMode === 'field_chg' ? 'bg-amber-500 text-white' : 'bg-white dark:bg-gray-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20'}`}
                  onClick={() => { setFilterMode('field_chg'); setPage(1); }}
                >필드변경 {stats?.field_changes_count?.toLocaleString()}</button>
              </div>
              <button
                className="px-2 py-1 text-xs font-medium rounded border border-orange-300 dark:border-orange-600 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 disabled:opacity-50"
                disabled={trackingRefreshing}
                onClick={async () => {
                  setTrackingRefreshing(true);
                  try {
                    await refreshTracking(storeId);
                    loadProducts();
                    loadStats();
                  } catch { /* ignore */ }
                  setTrackingRefreshing(false);
                }}
              >{trackingRefreshing ? '갱신중...' : '갱신'}</button>
            </div>
          )}
          <select
            className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-800"
            value={status}
            onChange={(e) => handleStatusChange(e.target.value)}
          >
            <option value="">전체 상태</option>
            <option value="SALE">판매중</option>
            <option value="SUSPENSION">판매중지</option>
            <option value="CLOSE">판매종료</option>
            <option value="PROHIBITION">판매금지</option>
          </select>
          <div className="flex">
            <input
              className="text-sm border border-gray-300 dark:border-gray-600 rounded-l px-2 py-1.5 bg-white dark:bg-gray-800 w-48"
              placeholder="상품명 / 관리코드 (다수 가능)"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData.getData('text');
                const normalized = text.replace(/[\r\n\t]+/g, ' ').trim();
                setSearchInput(normalized);
              }}
              title="여러 코드를 엔터/공백/쉼표로 구분하여 붙여넣기 가능"
            />
            <button
              className="text-sm px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-r hover:bg-gray-300 dark:hover:bg-gray-600 border border-l-0 border-gray-300 dark:border-gray-600"
              onClick={handleSearch}
            >
              검색
            </button>
          </div>
          {/* 상단 미니 페이지네이션 */}
          {totalPages > 1 && (
            <div className="flex items-center gap-0.5 ml-2">
              <button
                className="px-1.5 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-30"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >&lt;</button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                let p: number;
                if (totalPages <= 5) p = i + 1;
                else if (page <= 3) p = i + 1;
                else if (page >= totalPages - 2) p = totalPages - 4 + i;
                else p = page - 2 + i;
                return (
                  <button key={p}
                    className={`px-1.5 py-1 text-xs rounded border ${p === page ? 'bg-[#03c75a] text-white border-[#03c75a]' : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                    onClick={() => setPage(p)}
                  >{p}</button>
                );
              })}
              <button
                className="px-1.5 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-30"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >&gt;</button>
            </div>
          )}
          <div className="ml-auto text-sm text-gray-400 self-center">
            {(search || status || filterMode !== 'all') && stats ? (
              <><span className="text-blue-500 font-medium">검색 {total.toLocaleString()}개</span> / 총 {stats.total.toLocaleString()}개</>
            ) : (
              <>총 {total.toLocaleString()}개</>
            )}
          </div>
        </div>

        {/* 대장보기 (detail view) */}
        {viewMode === 'detail' && (
          <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  <th className="px-2 py-2 w-8">
                    <input type="checkbox" className="rounded"
                      checked={products.length > 0 && products.every(p => selectedIds.has(p.id))}
                      onChange={handlePageSelectAll}
                    />
                  </th>
                  {isAllStores && <th className="px-2 py-2">상점</th>}
                  <th className="px-2 py-2">이미지</th>
                  <th className="px-2 py-2 min-w-[200px]">상품명</th>
                  <th className="px-2 py-2">관리코드</th>
                  <th className="px-2 py-2">카테고리</th>
                  <th className="px-2 py-2 text-right">판매가</th>
                  <th className="px-2 py-2 text-right">정가</th>
                  <th className="px-2 py-2 text-right">할인</th>
                  <th className="px-2 py-2 text-right">재고</th>
                  <th className="px-2 py-2 text-center">상태</th>
                  <th className="px-2 py-2">배송</th>
                  <th className="px-2 py-2">제조/브랜드</th>
                  <th className="px-2 py-2">등록일</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {loading ? (
                  <tr><td colSpan={14} className="text-center py-8 text-gray-400">로딩 중...</td></tr>
                ) : products.length === 0 ? (
                  <tr><td colSpan={14} className="text-center py-8 text-gray-400">상품이 없습니다.</td></tr>
                ) : products.map((p) => {
                  const hasDiscount = p.discount_price > 0 && p.discount_price !== p.sale_price;
                  const discountPct = hasDiscount ? Math.round((1 - p.sale_price / p.discount_price) * 100) : 0;
                  const categoryStr = [p.category1, p.category2, p.category3, p.category4].filter(Boolean).join(' > ');
                  return (
                    <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 align-top">
                      <td className="px-2 py-2">
                        <input type="checkbox" className="rounded"
                          checked={selectAll || selectedIds.has(p.id)}
                          onChange={() => handleToggleId(p.id)}
                        />
                      </td>
                      {isAllStores && (
                        <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap">{p.store_name || '-'}</td>
                      )}
                      <td className="px-2 py-2">
                        <SSHoverImage src={p.product_image_url} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="line-clamp-2 text-xs leading-relaxed cursor-pointer text-blue-600 dark:text-blue-400 hover:underline max-w-[250px]"
                          onClick={() => setDetailProduct(p)}
                          title={p.name}
                        >{p.name}</div>
                        {p.options === 'Y' && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 mt-0.5 inline-block">옵션</span>
                        )}
                        {p.additional_products === 'Y' && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 mt-0.5 ml-0.5 inline-block">추가상품</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs">
                        {p.seller_management_code ? (
                          p.seller_management_code.startsWith('W') ? (
                            <a href={`https://ownerclan.com/V2/product/view.php?selfcode=${p.seller_management_code}`}
                              target="_blank" rel="noopener noreferrer"
                              className="text-orange-600 dark:text-orange-400 hover:underline"
                            >{p.seller_management_code}</a>
                          ) : <span className="text-gray-500">{p.seller_management_code}</span>
                        ) : <span className="text-gray-300">-</span>}
                        {(() => { const meta = p.seller_management_code ? productMeta[p.seller_management_code] : null; if (!meta || (!meta.tag_count && !meta.attr_count)) return null;
                          return <div className="flex gap-1 mt-0.5">
                            {meta.tag_count > 0 && <span className="px-1 rounded text-[9px] bg-[#03c75a]/20 text-[#03c75a]" title="등록 태그수">🏷{meta.tag_count}</span>}
                            {meta.attr_count > 0 && <span onClick={() => p.seller_management_code && setAttrModal({ code: p.seller_management_code, store: p.store_id || storeId })} className="px-1 rounded text-[9px] bg-indigo-500/20 text-indigo-400 cursor-pointer hover:bg-indigo-500/40" title="속성 현황 보기">🔧{meta.attr_count}</span>}
                          </div>; })()}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-400 max-w-[180px]">
                        {categoryStr ? (
                          <span className="line-clamp-2" title={categoryStr}>{categoryStr}</span>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs font-medium whitespace-nowrap">
                        <span className="text-gray-900 dark:text-gray-100">{p.sale_price.toLocaleString()}</span>
                      </td>
                      <td className="px-2 py-2 text-right text-xs whitespace-nowrap">
                        {hasDiscount ? (
                          <span className="text-gray-400 line-through">{p.discount_price.toLocaleString()}</span>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs whitespace-nowrap">
                        {hasDiscount ? (
                          <div>
                            <span className="text-red-500 font-medium">-{discountPct}%</span>
                            {p.seller_discount > 0 && (
                              <div className="text-[10px] text-gray-400">판매자 {p.seller_discount.toLocaleString()}</div>
                            )}
                          </div>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        <span className={p.stock_quantity === 0 ? 'text-red-500 font-bold' : ''}>
                          {p.stock_quantity.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          STATUS_COLORS[p.status_type || ''] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {STATUS_LABELS[p.status_type || ''] || p.status_type || '-'}
                        </span>
                        {p.display_status && p.display_status !== p.status_type && (
                          <div className="text-[10px] text-gray-400 mt-0.5">{p.display_status}</div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs whitespace-nowrap">
                        {p.delivery_fee_type ? (
                          <div>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              p.delivery_fee_type === '무료' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : p.delivery_fee_type === '유료' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                            }`}>{p.delivery_fee_type}</span>
                            {p.basic_delivery_fee > 0 && (
                              <span className="text-[10px] text-gray-500 ml-1">{p.basic_delivery_fee.toLocaleString()}</span>
                            )}
                            {p.bundle_delivery && (
                              <div className="text-[10px] text-indigo-500 dark:text-indigo-400 mt-0.5">묶음</div>
                            )}
                          </div>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-400 max-w-[120px]">
                        {(p.manufacturer || p.brand_name) ? (
                          <div className="line-clamp-2">
                            {p.manufacturer && <div title={p.manufacturer}>{p.manufacturer}</div>}
                            {p.brand_name && p.brand_name !== p.manufacturer && (
                              <div className="text-[10px] text-gray-400" title={p.brand_name}>{p.brand_name}</div>
                            )}
                          </div>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {p.registered_at ? p.registered_at.slice(0, 10) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Product table (default view) */}
        {viewMode === 'default' && <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                <th className="px-2 py-2 w-20">
                  <div className="flex flex-col items-center gap-0.5">
                    <label className="flex items-center gap-1 cursor-pointer" title="모든 페이지 전체 선택">
                      <input
                        type="checkbox"
                        checked={selectAll}
                        onChange={handleSelectAll}
                        className="rounded"
                      />
                      <span className="text-[10px]">전체</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer" title="현재 페이지 전체 선택">
                      <input
                        type="checkbox"
                        checked={products.length > 0 && products.every(p => selectedIds.has(p.id))}
                        onChange={handlePageSelectAll}
                        className="rounded"
                      />
                      <span className="text-[10px]">페이지</span>
                    </label>
                  </div>
                </th>
                <th className="px-3 py-2 w-10 text-center" title="집중관리">★</th>
                {isAllStores && <th className="px-3 py-2 w-24">상점</th>}
                <th className="px-3 py-2 w-16">이미지</th>
                <th className="px-3 py-2">상품명</th>
                <th className="px-3 py-2 w-28">
                  <span className="flex items-center gap-1">
                    <button
                      className={`p-0.5 rounded transition-colors ${copyDone ? 'text-green-500' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                      onClick={handleCopyCodes}
                      title="현재 페이지 관리코드 전체 복사"
                    >
                      {copyDone ? (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      )}
                    </button>
                    관리코드
                  </span>
                </th>
                <th
                  className={`px-3 py-2 w-24 text-right cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${sortBy === 'sale_price' ? 'text-blue-600 dark:text-blue-400' : ''}`}
                  onClick={() => toggleSort('sale_price')}
                  title="판매가순 정렬"
                >판매가{sortIcon('sale_price')}</th>
                <th className="px-3 py-2 w-20 text-right" title="정산가(판매가×0.93) - 오너클랜단가">마진</th>
                <th
                  className={`px-3 py-2 w-20 text-right cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${sortBy === 'stock' ? 'text-blue-600 dark:text-blue-400' : ''}`}
                  onClick={() => toggleSort('stock')}
                  title="재고순 정렬"
                >재고{sortIcon('stock')}</th>
                <th className="px-3 py-2 w-20 text-center">상태</th>
                <th className="px-3 py-2 w-28 text-center">변경</th>
                <th className="px-3 py-2 w-20 text-right">주문건수</th>
                <th
                  className={`px-3 py-2 w-32 text-right cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${sortBy === 'order_amount' || sortBy === 'ss_order_amount' ? 'text-blue-600 dark:text-blue-400' : ''}`}
                  onClick={toggleAmountSort}
                  title="판매금액 → SS판매금액 순환 정렬"
                >{amountSortLabel()}</th>
                <th
                  className={`px-3 py-2 w-24 text-right cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${sortBy === 'order_qty' ? 'text-blue-600 dark:text-blue-400' : ''}`}
                  onClick={() => toggleSort('order_qty')}
                  title="판매수량순 정렬"
                >판매수량{sortIcon('order_qty')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading ? (
                <tr><td colSpan={colSpan} className="text-center py-8 text-gray-400">로딩 중...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={colSpan} className="text-center py-8 text-gray-400">
                  {total === 0 && !search && !status ? '동기화 버튼을 눌러 상품을 가져오세요.' : '검색 결과가 없습니다.'}
                </td></tr>
              ) : products.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={selectAll || selectedIds.has(p.id)}
                      onChange={() => handleToggleId(p.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button
                      className={`text-lg leading-none transition-colors ${p.is_focus ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600 hover:text-yellow-400'}`}
                      onClick={() => handleToggleFocus(p.id, p.is_focus)}
                      title={p.is_focus ? '집중관리 해제' : '집중관리 지정'}
                    >{p.is_focus ? '★' : '☆'}</button>
                  </td>
                  {isAllStores && (
                    <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {p.store_name || '-'}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <SSHoverImage src={p.product_image_url} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <div
                        className="line-clamp-2 text-xs leading-relaxed cursor-pointer text-blue-600 dark:text-blue-400 hover:underline"
                        onClick={() => setDetailProduct(p)}
                      >{p.name}</div>
                      {trackedProductIds.has(p.origin_product_no) && (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400">
                          순위추적
                        </span>
                      )}
                    </div>
                    {(() => {
                      const code = String(p.channel_product_no || p.origin_product_no);
                      return (
                        <button
                          className="text-[10px] text-blue-500 dark:text-blue-400 hover:underline mt-0.5 inline-block"
                          onClick={(e) => { e.stopPropagation(); setBuyKwModal({ productCode: code, productName: p.name }); }}
                          title="구매키워드 보기"
                        >{p.channel_product_no || `#${p.origin_product_no}`}</button>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-[140px]" title={p.seller_management_code || ''}>
                    {p.seller_management_code ? (
                      <div>
                        <span className="flex items-center gap-1">
                          <span className="text-gray-500">{p.seller_management_code}</span>
                          {p.has_orders && (
                            <button
                              className="text-[10px] px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 whitespace-nowrap"
                              onClick={() => setOrderModal({ code: p.seller_management_code || '', name: p.name })}
                              title="주문이력 보기"
                            >주문</button>
                          )}
                        </span>
                      </div>
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-medium">
                    {p.sale_price.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {p.master_price && p.master_price > 0 ? (() => {
                      const settle = Math.round(p.sale_price * 0.93);
                      const margin = settle - p.master_price;
                      const pct = Math.round((margin / p.master_price) * 100);
                      return (
                        <div title={`정산가: ${settle.toLocaleString()} / 오너단가: ${p.master_price.toLocaleString()}`}>
                          <span className={`font-medium ${margin < 0 ? 'text-red-600 dark:text-red-400' : margin < p.master_price * 0.05 ? 'text-yellow-600 dark:text-yellow-400' : 'text-green-600 dark:text-green-400'}`}>
                            {margin < 0 ? '' : '+'}{margin.toLocaleString()}
                          </span>
                          <span className={`block text-[10px] ${margin < 0 ? 'text-red-400 dark:text-red-500' : 'text-gray-400'}`}>{pct}%</span>
                        </div>
                      );
                    })() : <span className="text-gray-300 dark:text-gray-600">-</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    <span className={p.stock_quantity === 0 ? 'text-red-500 font-bold' : ''}>
                      {p.stock_quantity.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      STATUS_COLORS[p.status_type || ''] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {STATUS_LABELS[p.status_type || ''] || p.status_type || '-'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex flex-wrap gap-0.5 justify-center">
                      {p.restock_at && p.restock_checked === 0 && (
                        <button
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-900/50"
                          title={`재입고: ${p.restock_at?.slice(0, 16)}${p.restock_price_changed ? ' | 가격변동' : ''}${p.restock_reverse_margin ? ' | 역마진' : ''}\n클릭하여 확인완료`}
                          onClick={async (e) => { e.stopPropagation(); await toggleRestockChecked([p.id], 1); loadProducts(); loadStats(); }}
                        >재입고{p.restock_price_changed ? ' $' : ''}{p.restock_reverse_margin ? ' !' : ''}</button>
                      )}
                      {p.status_mismatch === 1 && (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">상태</span>
                      )}
                      {p.pending_change_groups && p.pending_change_groups.split(',').map(g => {
                        const labels: Record<string, string> = { price: '가격', shipping: '배송', product_name: '상품명', detail: '상세', image: '이미지', option: '옵션', info: '정보', compliance: '인증', notice: '공지' };
                        return (
                          <span key={g} className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">{labels[g] || g}</span>
                        );
                      })}
                      {!p.has_pending_changes && !p.status_mismatch && !(p.restock_at && p.restock_checked === 0) && (
                        <span className="text-gray-300 dark:text-gray-600">-</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {p.all_order_count > 0 ? (
                      <div>
                        <div className="font-medium text-gray-900 dark:text-gray-100">{p.all_order_count.toLocaleString()}</div>
                        {p.total_order_count > 0 && p.total_order_count !== p.all_order_count && (
                          <div className="text-[10px] text-[#03c75a] leading-tight">({p.total_order_count.toLocaleString()})</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {p.all_order_amount > 0 ? (
                      <div
                        className="cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        onClick={() => setOrderModal({ code: p.seller_management_code || '', name: p.name })}
                        title="주문이력 보기"
                      >
                        <div className="font-medium text-gray-900 dark:text-gray-100">{p.all_order_amount.toLocaleString()}</div>
                        {p.total_order_amount > 0 && p.total_order_amount !== p.all_order_amount && (
                          <div className="text-[10px] text-[#03c75a] leading-tight">({p.total_order_amount.toLocaleString()})</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {p.all_order_qty > 0 ? (
                      <div>
                        <div className="font-medium text-gray-900 dark:text-gray-100">{p.all_order_qty.toLocaleString()}</div>
                        {p.total_order_qty > 0 && p.total_order_qty !== p.all_order_qty && (
                          <div className="text-[10px] text-[#03c75a] leading-tight">({p.total_order_qty.toLocaleString()})</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-300 dark:text-gray-600">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1">
            <button
              className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 disabled:opacity-30"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              &lt;
            </button>
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
              let p: number;
              if (totalPages <= 10) {
                p = i + 1;
              } else if (page <= 5) {
                p = i + 1;
              } else if (page >= totalPages - 4) {
                p = totalPages - 9 + i;
              } else {
                p = page - 4 + i;
              }
              return (
                <button
                  key={p}
                  className={`px-2.5 py-1 text-sm rounded border ${
                    p === page
                      ? 'bg-[#03c75a] text-white border-[#03c75a]'
                      : 'border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              );
            })}
            <button
              className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 disabled:opacity-30"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              &gt;
            </button>
          </div>
        )}
      </div>

      {/* Excel Modal */}
      {excelOpen && (
        <ExcelModal stores={apiStores} onClose={() => setExcelOpen(false)}
          currentFilters={{ search, hasOrders: filterMode === 'sold', isFocus: filterMode === 'focus', sortBy, sortDir }}
        />
      )}

      {/* Product Detail Modal */}
      {detailProduct && (
        <SSProductDetailModal
          product={detailProduct}
          storeUrl={isAllStores ? getStoreUrlById(detailProduct.store_id) : storeUrl}
          onClose={() => setDetailProduct(null)}
          onRankTrack={(p) => { setDetailProduct(null); setRankTrackProduct(p); }}
        />
      )}

      {/* Rank Tracking Modal */}
      {rankTrackProduct && (
        <RankTrackingModal
          product={rankTrackProduct}
          stores={apiStores}
          onClose={() => setRankTrackProduct(null)}
        />
      )}

      {/* Product Orders Modal */}
      {orderModal && (
        <ProductOrdersModal
          code={orderModal.code}
          productName={orderModal.name}
          onClose={() => setOrderModal(null)}
        />
      )}

      {attrModal && <ProductAttrModal sellerCode={attrModal.code} storeId={attrModal.store} onClose={() => setAttrModal(null)} />}

      {/* 품절박제(오너클랜 이탈 SALE) 모달 */}
      {orphanModalOpen && orphan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOrphanModalOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
              <div>
                <h3 className="font-bold text-red-600">품절박제 상품 <span className="text-gray-800 dark:text-gray-100">{orphan.count.toLocaleString()}건</span></h3>
                <p className="text-xs text-gray-400">오너클랜 카탈로그에서 사라졌는데 판매중(SALE)으로 박제 — 주문 들어와도 사입 불가</p>
              </div>
              <button className="text-gray-400 hover:text-gray-600 text-2xl leading-none" onClick={() => setOrphanModalOpen(false)}>&times;</button>
            </div>
            {orphan.by_store.length > 0 && (
              <div className="px-5 py-2 flex flex-wrap gap-1.5 border-b border-gray-100 dark:border-gray-700">
                {orphan.by_store.map(b => (
                  <span key={b.store_id} className="text-xs px-2 py-0.5 rounded bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                    {b.store_name} {b.count.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
            <div className="overflow-auto flex-1">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                  <tr className="text-gray-500">
                    <th className="px-3 py-2 text-left">스토어</th>
                    <th className="px-3 py-2 text-left">W코드</th>
                    <th className="px-3 py-2 text-left">상품명</th>
                    <th className="px-3 py-2 text-right">판매가</th>
                    <th className="px-3 py-2 text-right">재고</th>
                  </tr>
                </thead>
                <tbody>
                  {orphan.products.map(p => (
                    <tr key={p.id} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="px-3 py-1.5 whitespace-nowrap">{p.store_name}</td>
                      <td className="px-3 py-1.5 font-mono text-gray-500">{p.seller_management_code}</td>
                      <td className="px-3 py-1.5 max-w-xs truncate" title={p.name}>{p.name}</td>
                      <td className="px-3 py-1.5 text-right">{p.sale_price.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-gray-400">{p.stock_quantity.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {orphan.count > orphan.products.length && (
                <div className="px-3 py-2 text-xs text-gray-400 text-center">… 외 {(orphan.count - orphan.products.length).toLocaleString()}건 (상위 {orphan.products.length}건 표시)</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 전체동기화 확인 모달 */}
      {reconcileConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setReconcileConfirmOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="font-bold flex items-center gap-2">
                <span className="text-indigo-500">🔄</span> 전체동기화
              </h3>
              <button className="text-gray-400 hover:text-gray-600 text-2xl leading-none" onClick={() => setReconcileConfirmOpen(false)}>&times;</button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-600 dark:text-gray-300 space-y-2">
              <p>전 마켓의 <b>네이버 라이브 상품수와 DB를 일치</b>시킵니다.</p>
              <ul className="text-xs space-y-1 bg-gray-50 dark:bg-gray-700/40 rounded p-3">
                <li>• 네이버에서 <b className="text-red-600">삭제된 상품은 DB에서도 제거</b> (DB 미러만, 네이버 원본 보존)</li>
                <li>• 신규/변경 상품은 추가·갱신(UPSERT)</li>
                <li>• <b className="text-orange-500">삭제비율 50% 초과</b> 스토어는 안전상 자동 보류</li>
                <li>• 24개 스토어 병렬 처리 · 진행률 표시 · 완료 후 마켓ID별 리포트</li>
              </ul>
            </div>
            <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button className="px-4 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                onClick={() => setReconcileConfirmOpen(false)}>취소</button>
              <button className="px-4 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 font-medium"
                onClick={doReconcile}>동기화 시작</button>
            </div>
          </div>
        </div>
      )}

      {/* 전체동기화 리포트 모달 */}
      {reconcileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!reconcile?.running) setReconcileModalOpen(false); }}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
              <div>
                <h3 className="font-bold flex items-center gap-2">
                  전체동기화 리포트
                  {reconcile?.running && <span className="text-xs font-normal text-indigo-500 animate-pulse">진행 중 {reconcile.done}/{reconcile.total}</span>}
                  {reconcile && !reconcile.running && reconcile.phase === 'done' && <span className="text-xs font-normal text-green-600">완료</span>}
                </h3>
                <p className="text-xs text-gray-400">네이버 라이브 ↔ DB 상품수 일치 (삭제분 반영, DB 미러만)</p>
              </div>
              <button className="text-gray-400 hover:text-gray-600 text-2xl leading-none disabled:opacity-30" disabled={reconcile?.running} onClick={() => setReconcileModalOpen(false)}>&times;</button>
            </div>
            {reconcile?.running && (
              <div className="px-5 pt-3">
                <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${reconcile.total ? (reconcile.done / reconcile.total) * 100 : 0}%` }} />
                </div>
              </div>
            )}
            <div className="overflow-auto flex-1 p-3">
              {reconcile && reconcile.results.length > 0 ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                    <tr className="text-gray-500">
                      <th className="px-2 py-2 text-left">마켓ID</th>
                      <th className="px-2 py-2 text-left">스토어</th>
                      <th className="px-2 py-2 text-right">라이브</th>
                      <th className="px-2 py-2 text-right">DB전</th>
                      <th className="px-2 py-2 text-right">삭제</th>
                      <th className="px-2 py-2 text-right">DB후</th>
                      <th className="px-2 py-2 text-center">결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...reconcile.results].sort((a, b) => a.store_id - b.store_id).map(r => {
                      const badge = r.status === 'api_error' ? ['API오류', 'text-red-500']
                        : r.status === 'empty_skip' ? ['빈응답스킵', 'text-yellow-500']
                        : r.status === 'ratio_block' ? ['비율초과보류', 'text-orange-500']
                        : r.matched ? ['일치 ✓', 'text-green-600']
                        : ['처리', 'text-gray-400'];
                      return (
                        <tr key={r.store_id} className="border-t border-gray-100 dark:border-gray-700">
                          <td className="px-2 py-1.5 text-gray-500">{r.store_id}</td>
                          <td className="px-2 py-1.5">{r.name}</td>
                          <td className="px-2 py-1.5 text-right">{(r.live || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400">{(r.db_before || 0).toLocaleString()}</td>
                          <td className={`px-2 py-1.5 text-right ${r.deleted ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{(r.deleted || 0).toLocaleString()}</td>
                          <td className="px-2 py-1.5 text-right font-medium">{(r.db_after || r.db_before || 0).toLocaleString()}</td>
                          <td className={`px-2 py-1.5 text-center ${badge[1]}`}>{badge[0]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="text-center text-gray-400 py-10 text-sm">{reconcile?.running ? '스토어 처리 중…' : '데이터 없음'}</div>
              )}
            </div>
            {reconcile && reconcile.summary && (
              <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 text-xs flex flex-wrap gap-x-4 gap-y-1">
                <span>스토어 <b>{reconcile.summary.stores}</b></span>
                <span className="text-green-600">일치 <b>{reconcile.summary.matched}</b></span>
                <span className="text-red-600">총삭제 <b>{reconcile.summary.total_deleted.toLocaleString()}</b></span>
                <span>DB합계 <b>{reconcile.summary.db_total.toLocaleString()}</b></span>
                {reconcile.summary.blocked.length > 0 && <span className="text-orange-500">보류 {reconcile.summary.blocked.join(',')}</span>}
                {reconcile.summary.errors.length > 0 && <span className="text-red-500">오류 {reconcile.summary.errors.join(',')}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 구매키워드 모달 */}
      {buyKwModal && (
        <BuyKeywordModal
          productCode={buyKwModal.productCode}
          productName={buyKwModal.productName}
          onClose={() => setBuyKwModal(null)}
        />
      )}

      {/* Suspend Confirm Modal */}
      {suspendModalOpen && suspendPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!suspendExecuting) { setSuspendModalOpen(false); setSuspendResult(null); } }}>
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="font-bold text-sm">품절처리 확인</h3>
              {!suspendExecuting && (
                <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={() => { setSuspendModalOpen(false); setSuspendResult(null); }}>&times;</button>
              )}
            </div>

            <div className="px-4 py-4 space-y-3">
              {suspendResult ? (
                <>
                  <div className="text-sm text-center py-2">
                    <div className="text-green-600 dark:text-green-400 font-bold text-lg mb-1">품절처리 완료</div>
                    <div>성공: <span className="font-bold">{suspendResult.success.toLocaleString()}</span>건</div>
                    {suspendResult.fail > 0 && (
                      <div className="text-red-500">실패: <span className="font-bold">{suspendResult.fail.toLocaleString()}</span>건</div>
                    )}
                  </div>
                  <button
                    className="w-full px-4 py-2 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 font-medium"
                    onClick={() => { setSuspendModalOpen(false); setSuspendResult(null); }}
                  >
                    닫기
                  </button>
                </>
              ) : (
                <>
                  {suspendPreview.total_count === 0 ? (
                    <div className="text-sm text-center text-gray-500 py-4">
                      품절처리 대상 상품이 없습니다.<br />
                      <span className="text-xs text-gray-400">(판매중 + 오너클랜품절인 상품만 대상)</span>
                    </div>
                  ) : (
                    <>
                      <div className="text-sm">
                        다른상점에서도 <span className="font-bold text-red-600 dark:text-red-400">판매중이고 오너클랜품절</span>인 상품
                        <span className="font-bold text-lg ml-1">{suspendPreview.total_count.toLocaleString()}</span>건을
                        품절 처리하겠습니까?
                      </div>
                      <div className="bg-gray-50 dark:bg-gray-700/50 rounded p-3 space-y-1">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">상점별 건수</div>
                        {suspendPreview.by_store.map(s => (
                          <div key={s.store_name} className="flex justify-between text-sm">
                            <span>{s.store_name}</span>
                            <span className="font-medium">{s.count.toLocaleString()}건</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="flex gap-2">
                    <button
                      className="flex-1 px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 font-medium"
                      onClick={() => { setSuspendModalOpen(false); setSuspendResult(null); }}
                      disabled={suspendExecuting}
                    >
                      취소
                    </button>
                    {suspendPreview.total_count > 0 && (
                      <button
                        className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 font-medium"
                        onClick={handleSuspendConfirm}
                        disabled={suspendExecuting}
                      >
                        {suspendExecuting ? '처리 중...' : '확인'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}


      {/* 0마진 처리 모달 */}
      {zmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!zmExecuting) { setZmOpen(false); setZmResult(null); setZmLogDetail(null); } }}>
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* 헤더 + 탭 */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-sm">0마진 처리</h3>
                <div className="flex rounded overflow-hidden border border-gray-300 dark:border-gray-600">
                  <button
                    className={`px-2.5 py-1 text-[11px] font-medium ${zmTab === 'preview' ? 'bg-red-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                    onClick={() => setZmTab('preview')}
                  >미리보기</button>
                  <button
                    className={`px-2.5 py-1 text-[11px] font-medium ${zmTab === 'logs' ? 'bg-red-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                    onClick={async () => {
                      setZmTab('logs'); setZmLogDetail(null);
                      try { const logs = await fetchZeroMarginLogs(); setZmLogs(logs); } catch { setZmLogs([]); }
                    }}
                  >처리이력</button>
                </div>
              </div>
              {!zmExecuting && (
                <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={() => { setZmOpen(false); setZmResult(null); setZmLogDetail(null); }}>&times;</button>
              )}
            </div>

            <div className="px-4 py-3 flex-1 overflow-y-auto min-h-0">
              {/* 미리보기 탭 */}
              {zmTab === 'preview' && (
                <>
                  {zmLoading ? (
                    <div className="text-center py-8 text-gray-500 animate-pulse">미리보기 로딩중...</div>
                  ) : zmResult ? (
                    <div className="space-y-3">
                      <div className="text-center py-2">
                        <div className="text-green-600 dark:text-green-400 font-bold text-lg mb-1">처리 완료</div>
                        <div className="text-sm">성공 <span className="font-bold text-green-600">{zmResult.success}</span> / 실패 <span className="font-bold text-red-500">{zmResult.fail}</span> / 전체 {zmResult.total}</div>
                      </div>
                      {zmResult.items.length > 0 && (
                        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                                <th className="text-left px-2 py-1.5">상품명</th>
                                <th className="text-right px-2 py-1.5">변경전</th>
                                <th className="text-right px-2 py-1.5">변경후</th>
                                <th className="text-center px-2 py-1.5">결과</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                              {zmResult.items.map(it => (
                                <tr key={it.origin_product_no}>
                                  <td className="px-2 py-1.5 truncate max-w-[200px]" title={it.name}>{it.name}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{it.old_price.toLocaleString()}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{it.new_price.toLocaleString()}</td>
                                  <td className="px-2 py-1.5 text-center">
                                    {it.ok ? <span className="text-green-600">OK</span> : <span className="text-red-500" title={it.error}>실패</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <button
                        className="w-full px-4 py-2 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 font-medium"
                        onClick={() => { setZmOpen(false); setZmResult(null); loadProducts(); loadStats(); }}
                      >닫기</button>
                    </div>
                  ) : zmPreview && zmPreview.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">역마진 상품이 없습니다.</div>
                  ) : zmPreview ? (
                    <div className="space-y-3">
                      <div className="text-sm text-gray-700 dark:text-gray-300">
                        역마진 상품 <span className="font-bold text-red-600 dark:text-red-400">{zmPreview.length}</span>개의 가격을
                        <span className="font-bold"> 수익 0원</span> (10원 단위 올림)으로 수정합니다.
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500">
                        공식: 올림(오너단가 / 0.93 / 10) x 10 (네이버 수수료 7% 포함)
                      </div>
                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                              <th className="text-left px-2 py-1.5">상품명</th>
                              <th className="text-left px-2 py-1.5">스토어</th>
                              <th className="text-right px-2 py-1.5">현재가</th>
                              <th className="text-right px-2 py-1.5">오너단가</th>
                              <th className="text-right px-2 py-1.5 text-red-500">손해</th>
                              <th className="text-right px-2 py-1.5 text-blue-500">수정가</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {zmPreview.map(it => (
                              <tr key={it.origin_product_no}>
                                <td className="px-2 py-1.5 truncate max-w-[180px]" title={it.name}>{it.name}</td>
                                <td className="px-2 py-1.5 text-gray-500">{it.store_name}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{it.sale_price.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{it.master_price.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-red-600 dark:text-red-400 font-medium">{it.margin.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-blue-600 dark:text-blue-400 font-medium">{it.new_price.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="flex-1 px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 font-medium"
                          onClick={() => { setZmOpen(false); setZmResult(null); }}
                          disabled={zmExecuting}
                        >취소</button>
                        <button
                          className="flex-1 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 font-medium"
                          disabled={zmExecuting}
                          onClick={async () => {
                            setZmExecuting(true);
                            try {
                              const res = await executeZeroMarginUpdate(storeId);
                              setZmResult(res);
                            } catch (e: any) {
                              alert(e?.response?.data?.error || '0마진 처리 실패');
                            }
                            setZmExecuting(false);
                          }}
                        >{zmExecuting ? '처리 중...' : `${zmPreview.length}개 가격 수정`}</button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              {/* 이력 탭 */}
              {zmTab === 'logs' && (
                <>
                  {zmLogDetail ? (
                    <div className="space-y-3">
                      <button className="text-xs text-blue-500 hover:underline" onClick={() => setZmLogDetail(null)}>&larr; 이력 목록</button>
                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                              <th className="text-left px-2 py-1.5">상품명</th>
                              <th className="text-left px-2 py-1.5">스토어</th>
                              <th className="text-right px-2 py-1.5">변경전</th>
                              <th className="text-right px-2 py-1.5">변경후</th>
                              <th className="text-right px-2 py-1.5">오너단가</th>
                              <th className="text-center px-2 py-1.5">결과</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {zmLogDetail.map((it, i) => (
                              <tr key={i}>
                                <td className="px-2 py-1.5 truncate max-w-[160px]" title={it.name}>{it.name}</td>
                                <td className="px-2 py-1.5 text-gray-500">{it.store_name}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{it.old_price.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums font-medium">{it.new_price.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums">{it.master_price.toLocaleString()}</td>
                                <td className="px-2 py-1.5 text-center">
                                  {it.ok ? <span className="text-green-600">OK</span> : <span className="text-red-500" title={it.error_msg || ''}>실패</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : zmLogs.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">처리 이력이 없습니다.</div>
                  ) : (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                            <th className="text-left px-2 py-1.5">일시</th>
                            <th className="text-right px-2 py-1.5">대상</th>
                            <th className="text-right px-2 py-1.5 text-green-500">성공</th>
                            <th className="text-right px-2 py-1.5 text-red-500">실패</th>
                            <th className="text-right px-2 py-1.5">총 가격인상</th>
                            <th className="text-center px-2 py-1.5">상세</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {zmLogs.map(log => (
                            <tr key={log.id}>
                              <td className="px-2 py-1.5">{log.created_at?.slice(0, 16).replace('T', ' ')}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{log.total}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-green-600">{log.success_count}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums text-red-500">{log.fail_count}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">+{log.total_diff.toLocaleString()}원</td>
                              <td className="px-2 py-1.5 text-center">
                                <button
                                  className="text-blue-500 hover:underline"
                                  onClick={async () => {
                                    const res = await fetchZeroMarginLogDetail(log.id);
                                    setZmLogDetail(res.items);
                                  }}
                                >보기</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 전상품 검�� 확인 모달 */}
      {auditConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setAuditConfirmOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="font-bold text-sm">품단종 검증</h3>
              <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={() => setAuditConfirmOpen(false)}>&times;</button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="text-sm text-gray-700 dark:text-gray-300 mb-1">검증 방식을 선택하세요</div>
              {/* 오너클랜 비교 */}
              <button
                className="w-full text-left px-3 py-3 rounded-lg border-2 border-purple-500/60 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 transition"
                onClick={() => handleAuditStart('ownerclan')}
              >
                <div className="text-sm font-bold text-purple-700 dark:text-purple-300">오너클랜 비교</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  오너클랜 sale_status와 SS status_type을 W코드로 비교 (5초)
                </div>
              </button>
              {/* API 검증 */}
              <button
                className="w-full text-left px-3 py-3 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                onClick={() => handleAuditStart('api')}
              >
                <div className="text-sm font-bold text-orange-600 dark:text-orange-400">네이버 API 전수 검증</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  25만건 네이버 API 호출로 실제 상태 확인 (~80분)
                </div>
              </button>
              <button
                className="w-full px-4 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 font-medium"
                onClick={() => setAuditConfirmOpen(false)}
              >취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 검증 이력 모달 */}
      {auditLogsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setAuditLogsOpen(false); setAuditDetail(null); }}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <h3 className="font-bold text-sm">
                {auditDetail ? `검증 상세 #${auditDetailId}` : '검증 이력'}
              </h3>
              <div className="flex items-center gap-2">
                {auditDetail && (
                  <button className="text-xs text-blue-400 hover:underline" onClick={() => { setAuditDetail(null); setAuditDetailId(0); }}>목록으로</button>
                )}
                <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={() => { setAuditLogsOpen(false); setAuditDetail(null); }}>&times;</button>
              </div>
            </div>
            <div className="px-4 py-3 overflow-y-auto flex-1">
              {auditDetail ? (
                <div className="space-y-3">
                  {/* 요약 */}
                  <div className="flex flex-wrap gap-2">
                    {auditDetail.summary.map(s => (
                      <span key={s.action} className={`px-2 py-1 rounded text-xs font-medium ${
                        s.action === 'fixed' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' :
                        s.action === 'closed' ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' :
                        s.action === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' :
                        'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                      }`}>
                        {s.action}: {s.cnt}건
                      </span>
                    ))}
                  </div>
                  {/* 변경 목록 */}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500">
                        <th className="text-left py-1 px-1">W코드</th>
                        <th className="text-left py-1 px-1">상점</th>
                        <th className="text-center py-1 px-1">DB상태</th>
                        <th className="text-center py-1 px-1">API상태</th>
                        <th className="text-center py-1 px-1">조치</th>
                        <th className="text-left py-1 px-1">비고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditDetail.changes.map(c => (
                        <tr key={c.id} className="border-b border-gray-100 dark:border-gray-700/50">
                          <td className="py-1 px-1 font-mono">{c.seller_management_code || c.origin_product_no}</td>
                          <td className="py-1 px-1">{c.store_name}</td>
                          <td className="py-1 px-1 text-center">{c.db_status}</td>
                          <td className="py-1 px-1 text-center">{c.api_status}</td>
                          <td className="py-1 px-1 text-center">
                            <span className={`px-1.5 py-0.5 rounded ${
                              c.action === 'fixed' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                              c.action === 'closed' ? 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300' :
                              'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            }`}>{c.action}</span>
                          </td>
                          <td className="py-1 px-1 text-gray-400 truncate max-w-[120px]">{c.error_detail || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {auditDetail.changes.length === 0 && (
                    <div className="text-center text-sm text-gray-400 py-4">변경 사항 없음 (전부 일치)</div>
                  )}
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500">
                      <th className="text-left py-1.5 px-1">일시</th>
                      <th className="text-center py-1.5 px-1">유형</th>
                      <th className="text-right py-1.5 px-1">대상</th>
                      <th className="text-right py-1.5 px-1">확인</th>
                      <th className="text-right py-1.5 px-1">일치</th>
                      <th className="text-right py-1.5 px-1">불일치</th>
                      <th className="text-right py-1.5 px-1">CLOSE</th>
                      <th className="text-right py-1.5 px-1">에러</th>
                      <th className="text-right py-1.5 px-1">시간</th>
                      <th className="py-1.5 px-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map(log => (
                      <tr key={log.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="py-1.5 px-1">{log.started_at ? new Date(log.started_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                        <td className="py-1.5 px-1 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            log.source === 'ownerclan' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                              : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                          }`}>{log.source === 'ownerclan' ? 'OC비교' : 'API'}</span>
                        </td>
                        <td className="py-1.5 px-1 text-right">{log.total_target.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right">{log.checked.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right text-green-600 dark:text-green-400">{log.match_count.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right text-yellow-600 dark:text-yellow-400">{log.mismatch_count.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right">{log.closed_count.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right text-red-500">{log.api_error_count.toLocaleString()}</td>
                        <td className="py-1.5 px-1 text-right">{log.elapsed_sec ? `${Math.floor(log.elapsed_sec / 60)}분` : '-'}</td>
                        <td className="py-1.5 px-1">
                          <button
                            className="text-blue-400 hover:underline"
                            onClick={() => handleAuditDetailOpen(log.id)}
                          >상세</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}


function StatCard({ label, labelColor, count, countColor, soldCount, ssSoldCount, isCountActive, isSoldActive, onCountClick, onSoldClick }: {
  label: string; labelColor: string; count: number; countColor: string;
  soldCount: number; ssSoldCount?: number; isCountActive: boolean; isSoldActive: boolean;
  onCountClick?: () => void; onSoldClick?: () => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
      <div className={`text-xs ${labelColor}`}>{label}</div>
      <div className="flex items-baseline gap-1.5 flex-wrap">
        {onCountClick ? (
          <button
            className={`text-lg font-bold transition-colors ${isCountActive ? `${countColor || 'text-gray-900 dark:text-white'} underline` : `${countColor || 'text-gray-900 dark:text-white'} hover:underline`}`}
            onClick={onCountClick}
          >{count.toLocaleString()}</button>
        ) : (
          <span className={`text-lg font-bold ${countColor}`}>{count.toLocaleString()}</span>
        )}
        {soldCount > 0 && onSoldClick && (
          <button
            className={`text-xs font-bold transition-colors ${
              isSoldActive
                ? 'text-blue-600 dark:text-blue-400 underline'
                : 'text-blue-400 dark:text-blue-500 hover:text-blue-600 dark:hover:text-blue-400'
            }`}
            onClick={onSoldClick}
            title={`${label} 중 판매된 상품만 보기`}
          >
            {soldCount.toLocaleString()}
            {ssSoldCount !== undefined && ssSoldCount !== soldCount && (
              <span className="text-[#03c75a] ml-0.5">({ssSoldCount.toLocaleString()})</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ pct, label, status }: { pct: number; label: string; status: 'loading' | 'done' | 'error' }) {
  const isIndeterminate = pct < 0;
  const barColor = status === 'error' ? 'bg-red-500' : status === 'done' ? 'bg-green-500' : 'bg-blue-500';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-300">{label}</span>
        <span className="text-gray-400">
          {status === 'done' ? '완료' : status === 'error' ? '실패' : isIndeterminate ? '처리 중...' : `${pct}%`}
        </span>
      </div>
      <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        {isIndeterminate && status === 'loading' ? (
          <div
            className={`h-full ${barColor} rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite]`}
            style={{ width: '40%' }}
          />
        ) : (
          <div
            className={`h-full ${barColor} rounded-full transition-all duration-300 ease-out`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        )}
      </div>
    </div>
  );
}

function ExcelModal({ stores, onClose, currentFilters }: {
  stores: SmartStore[]; onClose: () => void;
  currentFilters?: { search?: string; hasOrders?: boolean; isFocus?: boolean; sortBy?: string; sortDir?: string };
}) {
  const [allStores, setAllStores] = useState(true);
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<number>>(
    () => new Set(stores.map(s => s.id)),
  );
  const [statusAll, setStatusAll] = useState(true);
  const [statusSale, setStatusSale] = useState(true);
  const [statusSuspension, setStatusSuspension] = useState(true);
  const [statusEtc, setStatusEtc] = useState(true);
  const [wOnly, setWOnly] = useState(false);
  const [wCodes, setWCodes] = useState('');
  const [productCount, setProductCount] = useState<number | null>(null);
  const [orphanCodes, setOrphanCodes] = useState<string[] | null>(null);
  const [orphanLoading, setOrphanLoading] = useState(false);

  // Progress states
  const [excelProgress, setExcelProgress] = useState<{ pct: number; status: 'loading' | 'done' | 'error' } | null>(null);
  const [wProgress, setWProgress] = useState<{ pct: number; status: 'loading' | 'done' | 'error' } | null>(null);

  const isBusy = (excelProgress?.status === 'loading') || (wProgress?.status === 'loading');

  // 조건 변경 시 상품 수 조회
  useEffect(() => {
    const load = async () => {
      try {
        const count = await fetchProductCount({
          storeIds: allStores ? undefined : Array.from(selectedStoreIds),
          statuses: (statusSale && statusSuspension && statusEtc) ? undefined :
            [...(statusSale ? ['SALE'] : []), ...(statusSuspension ? ['SUSPENSION'] : []), ...(statusEtc ? ['CLOSE','PROHIBITION','WAIT'] : [])],
          wOnly,
        });
        setProductCount(count);
      } catch { setProductCount(null); }
    };
    load();
  }, [allStores, selectedStoreIds, statusSale, statusSuspension, statusEtc, wOnly]);

  const handleAllStores = () => {
    if (allStores) {
      setAllStores(false);
      setSelectedStoreIds(new Set());
    } else {
      setAllStores(true);
      setSelectedStoreIds(new Set(stores.map(s => s.id)));
    }
  };

  const handleStoreToggle = (id: number) => {
    setSelectedStoreIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const isAll = next.size === stores.length;
      setAllStores(isAll);
      return next;
    });
  };

  const handleStatusAll = () => {
    if (statusAll) {
      setStatusAll(false);
      setStatusSale(true);
      setStatusSuspension(false);
      setStatusEtc(false);
    } else {
      setStatusAll(true);
      setStatusSale(true);
      setStatusSuspension(true);
      setStatusEtc(true);
    }
  };

  const syncAll = (sale: boolean, suspension: boolean, etc: boolean) => {
    setStatusAll(sale && suspension && etc);
  };

  const getStatuses = (): string[] | undefined => {
    if (statusSale && statusSuspension && statusEtc) return undefined;
    const arr: string[] = [];
    if (statusSale) arr.push('SALE');
    if (statusSuspension) arr.push('SUSPENSION');
    if (statusEtc) arr.push('CLOSE', 'PROHIBITION', 'WAIT');
    return arr.length ? arr : undefined;
  };

  const getStoreIds = (): number[] | undefined => {
    if (allStores || selectedStoreIds.size === stores.length) return undefined;
    return Array.from(selectedStoreIds);
  };

  const handleExcelDownload = async () => {
    setExcelProgress({ pct: 0, status: 'loading' });
    try {
      await downloadProductExcel(
        {
          storeIds: getStoreIds(), statuses: getStatuses(), wOnly,
          search: currentFilters?.search || undefined,
          hasOrders: currentFilters?.hasOrders || undefined,
          isFocus: currentFilters?.isFocus || undefined,
          sortBy: currentFilters?.sortBy || undefined,
          sortDir: currentFilters?.sortDir || undefined,
        },
        (pct) => setExcelProgress({ pct, status: 'loading' }),
      );
      setExcelProgress({ pct: 100, status: 'done' });
      setTimeout(() => setExcelProgress(null), 2000);
    } catch {
      setExcelProgress({ pct: 100, status: 'error' });
      setTimeout(() => setExcelProgress(null), 3000);
    }
  };

  const handleExtractWCodes = async () => {
    setWProgress({ pct: 0, status: 'loading' });
    setWCodes('');
    try {
      const codes = await fetchWCodes(
        { storeIds: getStoreIds(), statuses: getStatuses() },
        (pct) => setWProgress({ pct, status: 'loading' }),
      );
      setWCodes(codes.join('\n'));
      setWProgress({ pct: 100, status: 'done' });
      setTimeout(() => setWProgress(null), 2000);
    } catch {
      setWCodes('W코드 추출 실패');
      setWProgress({ pct: 100, status: 'error' });
      setTimeout(() => setWProgress(null), 3000);
    }
  };

  return (
    <>
      <style>{`
        @keyframes indeterminate {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div
          className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="font-bold text-sm">엑셀받기</h3>
            <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
          </div>

          <div className="px-4 py-3 space-y-4">
            {/* 상점 선택 */}
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">상점 선택</div>
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={allStores} onChange={handleAllStores} className="rounded" />
                  <span className="font-medium">모든사이트</span>
                </label>
                {stores.map(s => (
                  <label key={s.id} className="flex items-center gap-1 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedStoreIds.has(s.id)}
                      onChange={() => handleStoreToggle(s.id)}
                      className="rounded"
                    />
                    {s.store_name}
                  </label>
                ))}
              </div>
            </div>

            {/* 상태 필터 */}
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">상태 필터</div>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={statusAll} onChange={handleStatusAll} className="rounded" />
                  <span className="font-medium">전체</span>
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusSale}
                    onChange={() => { const v = !statusSale; setStatusSale(v); syncAll(v, statusSuspension, statusEtc); }}
                    className="rounded"
                  />
                  판매중
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusSuspension}
                    onChange={() => { const v = !statusSuspension; setStatusSuspension(v); syncAll(statusSale, v, statusEtc); }}
                    className="rounded"
                  />
                  판매중지
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={statusEtc}
                    onChange={() => { const v = !statusEtc; setStatusEtc(v); syncAll(statusSale, statusSuspension, v); }}
                    className="rounded"
                  />
                  기타
                </label>
              </div>
            </div>

            {/* 오너클랜(W) 체크박스 */}
            <div>
              <label className="flex items-center gap-1 text-sm cursor-pointer">
                <input type="checkbox" checked={wOnly} onChange={() => setWOnly(!wOnly)} className="rounded" />
                <span className="font-medium">오너클랜(W)</span>
                <span className="text-xs text-gray-400 ml-1">관리코드가 W로 시작하는 상품만</span>
              </label>
            </div>

            {/* 상품 수 표시 */}
            {productCount !== null && (
              <div className="text-center py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                <span className="text-xs text-gray-500 dark:text-gray-400">대상 상품: </span>
                <span className="text-sm font-bold text-gray-900 dark:text-white">{productCount.toLocaleString()}개</span>
              </div>
            )}

            {/* 버튼 */}
            <div className="flex gap-2">
              <button
                className="flex-1 px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-medium disabled:opacity-50"
                onClick={handleExcelDownload}
                disabled={isBusy}
              >
                저장 (엑셀)
              </button>
              <button
                className="flex-1 px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700 font-medium disabled:opacity-50"
                onClick={handleExtractWCodes}
                disabled={isBusy}
              >
                W코드추출
              </button>
            </div>

            {/* 프로그레스바 */}
            {excelProgress && (
              <ProgressBar pct={excelProgress.pct} label="엑셀 다운로드" status={excelProgress.status} />
            )}
            {wProgress && (
              <ProgressBar pct={wProgress.pct} label="W코드 추출" status={wProgress.status} />
            )}

            {/* W코드 결과 */}
            {wCodes && !wProgress && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">{wCodes.split('\n').filter(Boolean).length}개 W코드</span>
                  <button
                    className="text-xs text-blue-500 hover:underline"
                    onClick={() => { navigator.clipboard.writeText(wCodes); }}
                  >
                    복사
                  </button>
                </div>
                <textarea
                  className="w-full h-40 text-xs border border-gray-300 dark:border-gray-600 rounded p-2 bg-gray-50 dark:bg-gray-900 font-mono"
                  readOnly
                  value={wCodes}
                />
              </div>
            )}

            {/* 원본없음 W코드 찾기 */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <button
                className="w-full px-4 py-2 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 font-medium disabled:opacity-50"
                onClick={async () => {
                  setOrphanLoading(true);
                  try {
                    const res = await fetchOrphanWCodes(getStoreIds());
                    setOrphanCodes(res.codes);
                  } catch { setOrphanCodes([]); }
                  finally { setOrphanLoading(false); }
                }}
                disabled={orphanLoading || isBusy}
              >
                {orphanLoading ? '조회 중...' : '오너클랜 상품대장에 없는 W코드 찾기'}
              </button>
            </div>

            {orphanCodes !== null && !orphanLoading && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">원본없음 {orphanCodes.length.toLocaleString()}개</span>
                  {orphanCodes.length > 0 && (
                    <button
                      className="text-xs text-blue-500 hover:underline"
                      onClick={() => { navigator.clipboard.writeText(orphanCodes.join('\n')); }}
                    >
                      복사
                    </button>
                  )}
                </div>
                {orphanCodes.length > 0 ? (
                  <textarea
                    className="w-full h-40 text-xs border border-purple-300 dark:border-purple-600 rounded p-2 bg-purple-50 dark:bg-purple-900/20 font-mono"
                    readOnly
                    value={orphanCodes.join('\n')}
                  />
                ) : (
                  <p className="text-xs text-gray-500 text-center py-2">모든 W코드가 오너클랜 상품대장에 존재합니다.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}


function SSHoverImage({ src }: { src: string | null }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (!src) {
    return (
      <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded flex items-center justify-center text-gray-400 text-[10px]">N/A</div>
    );
  }

  return (
    <div
      className="relative inline-block"
      onMouseEnter={(e: ReactMouseEvent) => { setPos({ x: e.clientX, y: e.clientY }); setShow(true); }}
      onMouseMove={(e: ReactMouseEvent) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setShow(false)}
    >
      <img src={src} alt="" className="w-10 h-10 object-cover rounded border border-gray-200 dark:border-gray-600" loading="lazy" />
      {show && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: pos.x + 16, top: Math.min(pos.y - 100, window.innerHeight - 340) }}
        >
          <img src={src} alt="" className="w-72 h-72 object-contain rounded-lg shadow-2xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" />
        </div>
      )}
    </div>
  );
}


function SSProductDetailModal({ product: p, storeUrl, onClose, onRankTrack }: {
  product: SmartStoreProduct; storeUrl: string; onClose: () => void;
  onRankTrack: (product: SmartStoreProduct) => void;
}) {
  const detailUrl = storeUrl && p.channel_product_no
    ? `https://smartstore.naver.com/${storeUrl}/products/${p.channel_product_no}`
    : null;

  // ── 카테고리키워드 ──
  const [showCatKw, setShowCatKw] = useState(false);
  const [catKwLoading, setCatKwLoading] = useState(false);
  const [catKwList, setCatKwList] = useState<{ rank: number; keyword: string }[]>([]);
  const [catKwFilter, setCatKwFilter] = useState('');
  const [catPath, setCatPath] = useState('');
  const [catKwChecked, setCatKwChecked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // ── Enrich 데이터 ──
  const [enrichData, setEnrichData] = useState<Record<string, naverApi.EnrichData>>({});
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState({ done: 0, total: 0 });

  // ── 자동체크 ──
  const [autoChecking, setAutoChecking] = useState(false);
  const [autoCheckCount, setAutoCheckCount] = useState<number | null>(null);

  const catCids = (p.category_id || '').split('>').filter(Boolean);
  const deepestCid = catCids[catCids.length - 1] || '';

  const loadCatKeywords = async () => {
    if (!deepestCid) return;
    setShowCatKw(true);
    setCatKwLoading(true);
    setCatKwList([]);
    setCatKwChecked(new Set());
    setEnrichData({});
    setAutoCheckCount(null);
    try {
      const names = await naverApi.getCategoryNames(catCids);
      setCatPath(catCids.map(c => names[c] || c).join(' > '));
      const now = new Date();
      const end = now.toISOString().split('T')[0];
      const start = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
      const data = await naverApi.getCategoryKeywordRank({ cid: deepestCid, startDate: start, endDate: end });
      const ranks = data.ranks || [];
      setCatKwList(ranks);
      // enrich 자동 시작
      if (ranks.length > 0) {
        setEnriching(true);
        setEnrichProgress({ done: 0, total: ranks.length });
        const allKws = ranks.map(r => r.keyword);
        const batchSize = 50;
        const merged: Record<string, naverApi.EnrichData> = {};
        for (let i = 0; i < allKws.length; i += batchSize) {
          const batch = allKws.slice(i, i + batchSize);
          try {
            const res = await naverApi.enrichKeywords(batch);
            Object.assign(merged, res.data);
          } catch { /* skip batch */ }
          setEnrichData({ ...merged });
          setEnrichProgress({ done: Math.min(i + batchSize, allKws.length), total: allKws.length });
        }
        setEnriching(false);
      }
    } catch { /* ignore */ }
    setCatKwLoading(false);
  };

  const filteredCatKw = catKwFilter ? catKwList.filter(r => r.keyword.includes(catKwFilter)) : catKwList;

  const handleCopyCatKw = () => {
    const selected = catKwList.filter(r => catKwChecked.has(r.keyword)).map(r => r.keyword);
    if (!selected.length) return;
    const text = selected.join('\n');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text);
    else { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };

  const handleAutoCheck = async () => {
    if (catKwList.length === 0) return;
    setAutoChecking(true);
    setAutoCheckCount(null);
    try {
      const res = await naverApi.autoMatchKeywords(p.name, catKwList.map(r => r.keyword));
      const matches = new Set(res.matches || []);
      setCatKwChecked(matches);
      setAutoCheckCount(matches.size);
    } catch { /* ignore */ }
    setAutoChecking(false);
  };

  const compColor = (idx?: string) => {
    if (!idx) return 'text-gray-400';
    if (idx === '높음') return 'text-red-500 dark:text-red-400';
    if (idx === '중간') return 'text-yellow-500 dark:text-yellow-400';
    if (idx === '낮음') return 'text-green-500 dark:text-green-400';
    return 'text-gray-500 dark:text-gray-400';
  };

  const MASTER_STATUS: Record<number, string> = { 1: '판매중', 2: '품절/중지', 3: '판매종료' };
  const CHANGE_LABELS: Record<string, string> = { price: '가격', shipping: '배송', product_name: '상품명', detail: '상세', image: '이미지', option: '옵션', info: '정보', compliance: '인증', notice: '공지' };

  const fields: { label: string; value: string | number | null; highlight?: string }[] = [
    { label: '상품번호', value: p.origin_product_no },
    { label: '채널상품번호', value: p.channel_product_no },
    { label: '상품명', value: p.name },
    { label: '판매가', value: p.sale_price?.toLocaleString() + '원' },
    { label: '재고', value: p.stock_quantity?.toLocaleString() },
    { label: '판매상태', value: STATUS_LABELS[p.status_type || ''] || p.status_type || '-' },
    { label: '노출상태', value: p.channel_product_display_status_type || '-' },
    { label: '관리코드', value: p.seller_management_code || '-' },
    { label: '카테고리', value: catPath || p.category_id || '-' },
    ...(p.master_price != null ? [
      { label: '마스터 가격', value: p.master_price.toLocaleString() + '원', highlight: p.price_diff ? (p.price_diff > 0 ? 'text-red-500' : 'text-blue-500') : undefined },
      { label: '마스터 상태', value: MASTER_STATUS[p.master_sale_status || 0] || '-', highlight: p.status_mismatch ? 'text-red-500 font-bold' : undefined },
    ] : []),
    ...(p.has_pending_changes ? [
      { label: '변경사항', value: (p.pending_change_groups || '').split(',').map(g => CHANGE_LABELS[g] || g).join(', ') + ` (${p.pending_change_count}건)`, highlight: 'text-orange-500 font-bold' },
    ] : []),
    { label: '동기화일시', value: p.synced_at ? new Date(p.synced_at).toLocaleString('ko-KR') : '-' },
    { label: '등록일', value: p.created_at ? new Date(p.created_at).toLocaleString('ko-KR') : '-' },
    { label: '수정일', value: p.updated_at ? new Date(p.updated_at).toLocaleString('ko-KR') : '-' },
  ];

  const inputCls = 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl mx-4 max-h-[90vh] flex flex-col transition-all ${showCatKw ? 'w-full max-w-7xl' : 'w-full max-w-lg'}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold">#{p.origin_product_no}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
              STATUS_COLORS[p.status_type || ''] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {STATUS_LABELS[p.status_type || ''] || p.status_type || '-'}
            </span>
          </div>
          <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
        </div>

        <div className={`overflow-y-auto flex-1 ${showCatKw ? 'flex gap-0' : ''}`}>
          {/* 왼쪽: 상품 정보 */}
          <div className={`px-4 py-3 ${showCatKw ? 'w-[35%] border-r border-gray-200 dark:border-gray-700 overflow-y-auto' : ''}`}>
            {p.product_image_url && (
              <div className="flex justify-center mb-4">
                <img src={p.product_image_url} alt="" className="w-48 h-48 object-contain rounded-lg border border-gray-200 dark:border-gray-600" />
              </div>
            )}

            {/* 버튼 */}
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                onClick={() => onRankTrack(p)}
                className="flex-1 px-4 py-2.5 text-sm font-medium bg-[#03c75a] text-white rounded-lg hover:bg-[#02b351] transition-colors"
              >
                순위추적에 추가
              </button>
              {deepestCid && (
                <button
                  onClick={loadCatKeywords}
                  disabled={catKwLoading}
                  className="flex-1 px-4 py-2.5 text-sm font-medium bg-[#e879f9] text-white rounded-lg hover:bg-[#d946ef] transition-colors disabled:opacity-50"
                >
                  {catKwLoading ? '로딩...' : '카테고리키워드'}
                </button>
              )}
              {detailUrl && (
                <a
                  href={detailUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2.5 text-sm font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  상세페이지
                </a>
              )}
              <a
                href={`#product-edit?opno=${p.origin_product_no}&store_id=${p.store_id}`}
                className="px-4 py-2.5 text-sm font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                상품 편집
              </a>
            </div>

            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {fields.map(f => (
                  <tr key={f.label}>
                    <td className="px-2 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 w-28">{f.label}</td>
                    <td className={`px-2 py-2 text-xs break-all ${f.highlight || ''}`}>{f.value ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 오른쪽: 카테고리키워드 패널 */}
          {showCatKw && (
            <div className="w-[65%] flex flex-col overflow-hidden">
              <div className="px-3 py-2 bg-[#e879f9]/10 dark:bg-[#e879f9]/5 border-b border-gray-200 dark:border-gray-700 shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold text-[#e879f9] truncate">{catPath}</div>
                    <div className="text-[10px] text-gray-400">TOP {catKwList.length}개 키워드</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {catKwList.length > 0 && !catKwLoading && (
                      <button
                        onClick={handleAutoCheck}
                        disabled={autoChecking}
                        className="text-[10px] font-bold px-2.5 py-1 rounded transition-colors bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
                      >
                        {autoChecking ? '분석중...' : autoCheckCount !== null ? `자동체크 (${autoCheckCount}개)` : '자동체크'}
                      </button>
                    )}
                    {catKwChecked.size > 0 && (
                      <button
                        onClick={handleCopyCatKw}
                        className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
                          copied ? 'bg-green-500 text-white' : 'bg-[#e879f9] text-white hover:bg-[#d946ef]'
                        }`}
                      >
                        {copied ? '복사됨!' : `${catKwChecked.size}개 복사`}
                      </button>
                    )}
                    <button onClick={() => setShowCatKw(false)} className="text-gray-400 hover:text-gray-600 text-sm">&times;</button>
                  </div>
                </div>
                {/* enrich 프로그레스 바 */}
                {enriching && (
                  <div className="mt-1.5">
                    <div className="flex items-center gap-2 text-[10px] text-gray-400">
                      <span>검색량 로딩중... {enrichProgress.done}/{enrichProgress.total}</span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1 mt-0.5">
                      <div
                        className="bg-[#e879f9] h-1 rounded-full transition-all"
                        style={{ width: enrichProgress.total > 0 ? `${(enrichProgress.done / enrichProgress.total) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                )}
                <input
                  className={`w-full mt-1.5 rounded border px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-[#e879f9]/50 ${inputCls}`}
                  placeholder="키워드 필터"
                  value={catKwFilter}
                  onChange={e => setCatKwFilter(e.target.value)}
                />
              </div>
              <div className="flex-1 overflow-y-auto">
                {catKwLoading ? (
                  <div className="text-center py-8 text-[11px] text-gray-400 animate-pulse">카테고리 키워드 로딩중...</div>
                ) : filteredCatKw.length === 0 ? (
                  <div className="text-center py-8 text-[11px] text-gray-400">결과 없음</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 sticky top-0">
                        <th className="px-1.5 py-1.5 text-center w-7">
                          <input
                            type="checkbox"
                            checked={filteredCatKw.length > 0 && filteredCatKw.every(r => catKwChecked.has(r.keyword))}
                            onChange={() => {
                              const allChecked = filteredCatKw.every(r => catKwChecked.has(r.keyword));
                              if (allChecked) setCatKwChecked(new Set());
                              else setCatKwChecked(new Set(filteredCatKw.map(r => r.keyword)));
                            }}
                            className="accent-[#e879f9] w-3 h-3"
                          />
                        </th>
                        <th className="px-1.5 py-1.5 text-center w-10">순위</th>
                        <th className="px-1.5 py-1.5 text-left">키워드</th>
                        <th className="px-1.5 py-1.5 text-right w-16">총검색수</th>
                        <th className="px-1.5 py-1.5 text-right w-14">상품수</th>
                        <th className="px-1.5 py-1.5 text-center w-14">경쟁강도</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCatKw.map(r => {
                        const ed = enrichData[r.keyword];
                        const totalSearch = ed ? ((ed.monthlyPcQcCnt || 0) + (ed.monthlyMobileQcCnt || 0)) : null;
                        return (
                          <tr
                            key={r.keyword}
                            className={`border-b border-gray-100 dark:border-gray-700/50 cursor-pointer transition-colors
                              ${catKwChecked.has(r.keyword)
                                ? 'bg-[#e879f9]/10 dark:bg-[#e879f9]/5'
                                : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                              }`}
                            onClick={() => setCatKwChecked(prev => {
                              const n = new Set(prev);
                              if (n.has(r.keyword)) n.delete(r.keyword); else n.add(r.keyword);
                              return n;
                            })}
                          >
                            <td className="px-1.5 py-1 text-center">
                              <input type="checkbox" checked={catKwChecked.has(r.keyword)} readOnly className="accent-[#e879f9] w-3 h-3 pointer-events-none" />
                            </td>
                            <td className={`px-1.5 py-1 text-center tabular-nums font-medium ${
                              r.rank <= 10 ? 'text-[#e879f9]' : r.rank <= 50 ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'
                            }`}>{r.rank}</td>
                            <td className="px-1.5 py-1 text-gray-900 dark:text-white">{r.keyword}</td>
                            <td className="px-1.5 py-1 text-right tabular-nums text-gray-700 dark:text-gray-300">
                              {ed ? (totalSearch !== null ? totalSearch.toLocaleString() : '-') : (enriching ? <span className="text-gray-400">...</span> : '-')}
                            </td>
                            <td className="px-1.5 py-1 text-right tabular-nums text-gray-700 dark:text-gray-300">
                              {ed ? (ed.productCount?.toLocaleString() ?? '-') : (enriching ? <span className="text-gray-400">...</span> : '-')}
                            </td>
                            <td className={`px-1.5 py-1 text-center font-medium ${ed ? compColor(ed.compIdx) : 'text-gray-400'}`}>
                              {ed ? (ed.compIdx || '-') : (enriching ? '...' : '-')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function RankTrackingModal({ product: p, stores, onClose }: {
  product: SmartStoreProduct; stores: SmartStore[]; onClose: () => void;
}) {
  // 상품명을 공백 split → 1글자 이하 제거, 중복 제거
  const initialKeywords = [...new Set(
    p.name.split(/\s+/).filter(w => w.length > 1)
  )];

  const [keywords, setKeywords] = useState(initialKeywords.join('\n'));
  const [targetType, setTargetType] = useState('store');
  const [targetValue, setTargetValue] = useState(p.store_name || '');
  const [tracking, setTracking] = useState(false);
  const [results, setResults] = useState<{ keyword: string; rank: number | null; product_name?: string; error?: string }[] | null>(null);
  const [step, setStep] = useState<string>('');

  // ── 카테고리키워드 패널 ──
  const [showCatKw, setShowCatKw] = useState(false);
  const [catKwLoading, setCatKwLoading] = useState(false);
  const [catKwList, setCatKwList] = useState<{ rank: number; keyword: string }[]>([]);
  const [catKwFilter, setCatKwFilter] = useState('');
  const [catPath, setCatPath] = useState('');
  const [catKwChecked, setCatKwChecked] = useState<Set<string>>(new Set());

  // category_id: "50000008>50000158>50001044>50003597"
  const catCids = (p.category_id || '').split('>').filter(Boolean);
  const deepestCid = catCids[catCids.length - 1] || '';

  const loadCatKeywords = async () => {
    if (!deepestCid) return;
    setShowCatKw(true);
    setCatKwLoading(true);
    setCatKwList([]);
    setCatKwChecked(new Set());
    try {
      // 카테고리 이름 조회
      const names = await naverApi.getCategoryNames(catCids);
      setCatPath(catCids.map(c => names[c] || c).join(' > '));
      // TOP 500 키워드 조회
      const now = new Date();
      const end = now.toISOString().split('T')[0];
      const start = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
      const data = await naverApi.getCategoryKeywordRank({ cid: deepestCid, startDate: start, endDate: end });
      setCatKwList(data.ranks || []);
    } catch { /* ignore */ }
    setCatKwLoading(false);
  };

  const filteredCatKw = catKwFilter
    ? catKwList.filter(r => r.keyword.includes(catKwFilter))
    : catKwList;

  const addCatKwToKeywords = () => {
    const selected = catKwList.filter(r => catKwChecked.has(r.keyword)).map(r => r.keyword);
    if (!selected.length) return;
    const existing = new Set(keywords.split('\n').map(k => k.trim()).filter(Boolean));
    const toAdd = selected.filter(kw => !existing.has(kw));
    if (toAdd.length > 0) {
      setKeywords(prev => (prev.trim() ? prev.trim() + '\n' : '') + toAdd.join('\n'));
    }
    setCatKwChecked(new Set());
  };

  const handleTrack = async () => {
    const kwList = keywords.split('\n').map(k => k.trim()).filter(Boolean);
    if (!kwList.length || !targetValue) return;

    setTracking(true);
    setResults(null);

    try {
      // 1. 각 키워드별로 rank target 추가
      const targetIds: number[] = [];
      setStep(`타겟 등록 중... (0/${kwList.length})`);

      for (let i = 0; i < kwList.length; i++) {
        setStep(`타겟 등록 중... (${i + 1}/${kwList.length})`);
        const res = await naverApi.addRankTarget({
          keyword: kwList[i],
          target_type: targetType,
          target_value: targetValue,
          display_name: targetValue,
          source_product_id: p.id,
          source_product_name: p.name,
        });
        if (res?.id) targetIds.push(res.id);
      }

      // 2. 등록된 타겟들로 순위 조회
      setStep(`순위 조회 중... (${targetIds.length}개 키워드)`);
      const trackResult = await naverApi.runRankTracking(targetIds);

      // 3. 결과 매핑
      const resultList = kwList.map(kw => {
        const r = trackResult.results?.find((t: any) => t.keyword === kw && t.target_value === targetValue);
        return {
          keyword: kw,
          rank: r?.rank ?? null,
          product_name: r?.product_name || '',
          error: r?.error || '',
        };
      });
      setResults(resultList);
      setStep('');
    } catch (e: any) {
      setResults([{ keyword: '오류', rank: null, error: e.message || '순위추적 실패' }]);
      setStep('');
    } finally {
      setTracking(false);
    }
  };

  const inputCls = 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white';
  const selectCls = 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !tracking && onClose()}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <h3 className="font-bold text-sm text-gray-900 dark:text-white">순위추적 추가</h3>
          {!tracking && (
            <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
          )}
        </div>

        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">
          {/* 상품 정보 */}
          <div className="flex items-start gap-3">
            {p.product_image_url && (
              <img src={p.product_image_url} alt="" className="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-600 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-bold text-gray-900 dark:text-white line-clamp-2 leading-relaxed">{p.name}</div>
              <div className="text-[10px] text-gray-400 mt-1">
                {p.store_name && <span className="text-[#03c75a] font-medium">{p.store_name}</span>}
                {p.sale_price > 0 && <span className="ml-2">{p.sale_price.toLocaleString()}원</span>}
              </div>
            </div>
          </div>

          {/* 키워드 textarea */}
          <div>
            <label className="text-[11px] font-bold text-gray-500 dark:text-gray-400 block mb-1.5">
              검색 키워드 (줄 단위로 편집)
            </label>
            <textarea
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              rows={Math.min(Math.max(initialKeywords.length, 3), 8)}
              className={`w-full rounded-lg border px-3 py-2 text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${inputCls}`}
              placeholder="키워드를 줄 단위로 입력"
              disabled={tracking}
            />
            <div className="flex items-center justify-between mt-1">
              <div className="text-[10px] text-gray-400">
                {keywords.split('\n').filter(k => k.trim()).length}개 키워드
              </div>
              {deepestCid && (
                <button
                  onClick={loadCatKeywords}
                  disabled={catKwLoading}
                  className="text-[10px] font-bold text-[#e879f9] hover:text-[#d946ef] transition-colors disabled:opacity-50"
                >
                  {catKwLoading ? '로딩중...' : showCatKw ? '카테고리키워드 새로고침' : '카테고리키워드 보기'}
                </button>
              )}
            </div>
          </div>

          {/* 카테고리키워드 패널 */}
          {showCatKw && (
            <div className="border border-[#e879f9]/30 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-[#e879f9]/10 dark:bg-[#e879f9]/5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold text-[#e879f9] truncate">{catPath || '카테고리'}</div>
                  <div className="text-[9px] text-gray-400">{catKwList.length}개 키워드</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {catKwChecked.size > 0 && (
                    <button
                      onClick={addCatKwToKeywords}
                      className="text-[10px] font-bold px-2 py-1 bg-[#e879f9] text-white rounded hover:bg-[#d946ef] transition-colors"
                    >
                      {catKwChecked.size}개 추가
                    </button>
                  )}
                  <button onClick={() => setShowCatKw(false)} className="text-gray-400 hover:text-gray-600 text-sm">&times;</button>
                </div>
              </div>
              <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
                <input
                  className={`w-full rounded border px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-[#e879f9]/50 ${inputCls}`}
                  placeholder="키워드 필터"
                  value={catKwFilter}
                  onChange={e => setCatKwFilter(e.target.value)}
                />
              </div>
              <div className="max-h-[200px] overflow-y-auto">
                {catKwLoading ? (
                  <div className="text-center py-4 text-[11px] text-gray-400 animate-pulse">로딩중...</div>
                ) : filteredCatKw.length === 0 ? (
                  <div className="text-center py-4 text-[11px] text-gray-400">결과 없음</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400 sticky top-0">
                        <th className="px-2 py-1 text-center w-8">
                          <input
                            type="checkbox"
                            checked={filteredCatKw.length > 0 && filteredCatKw.every(r => catKwChecked.has(r.keyword))}
                            onChange={() => {
                              const allChecked = filteredCatKw.every(r => catKwChecked.has(r.keyword));
                              if (allChecked) setCatKwChecked(new Set());
                              else setCatKwChecked(new Set(filteredCatKw.map(r => r.keyword)));
                            }}
                            className="accent-[#e879f9] w-3 h-3"
                          />
                        </th>
                        <th className="px-2 py-1 text-center w-10">순위</th>
                        <th className="px-2 py-1 text-left">키워드</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCatKw.map(r => (
                        <tr
                          key={r.keyword}
                          className={`border-b border-gray-100 dark:border-gray-700/50 cursor-pointer transition-colors
                            ${catKwChecked.has(r.keyword)
                              ? 'bg-[#e879f9]/10 dark:bg-[#e879f9]/5'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                            }`}
                          onClick={() => setCatKwChecked(prev => {
                            const n = new Set(prev);
                            if (n.has(r.keyword)) n.delete(r.keyword); else n.add(r.keyword);
                            return n;
                          })}
                        >
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" checked={catKwChecked.has(r.keyword)} readOnly className="accent-[#e879f9] w-3 h-3 pointer-events-none" />
                          </td>
                          <td className={`px-2 py-1 text-center tabular-nums font-medium ${
                            r.rank <= 10 ? 'text-[#e879f9]' : r.rank <= 50 ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'
                          }`}>{r.rank}</td>
                          <td className="px-2 py-1 text-gray-900 dark:text-white">{r.keyword}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* 대상 설정 */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[11px] font-bold text-gray-500 dark:text-gray-400 block mb-1.5">대상유형</label>
              <select
                value={targetType}
                onChange={e => setTargetType(e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${selectCls}`}
                disabled={tracking}
              >
                <option value="store">스토어명</option>
                <option value="product_id">상품ID (nvMid)</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[11px] font-bold text-gray-500 dark:text-gray-400 block mb-1.5">대상값</label>
              {targetType === 'store' && stores.length > 0 ? (
                <select
                  value={targetValue}
                  onChange={e => setTargetValue(e.target.value)}
                  className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${selectCls}`}
                  disabled={tracking}
                >
                  <option value="">스토어 선택</option>
                  {stores.map(s => (
                    <option key={s.id} value={s.store_name}>{s.store_name}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={targetValue}
                  onChange={e => setTargetValue(e.target.value)}
                  className={`w-full rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${inputCls}`}
                  placeholder={targetType === 'store' ? '스토어명' : 'nvMid'}
                  disabled={tracking}
                />
              )}
            </div>
          </div>

          {/* 버튼 */}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={tracking}
              className="flex-1 px-4 py-2.5 text-sm font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              onClick={handleTrack}
              disabled={tracking || !targetValue || !keywords.trim()}
              className="flex-1 px-4 py-2.5 text-sm font-medium bg-[#03c75a] text-white rounded-lg hover:bg-[#02b351] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {tracking ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {step || '처리 중...'}
                </>
              ) : (
                '순위추적 시작'
              )}
            </button>
          </div>

          {/* 결과 */}
          {results && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 mb-2">조회 결과</div>
              <div className="space-y-1.5">
                {results.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-bold text-gray-900 dark:text-white min-w-[100px]">{r.keyword}</span>
                    <span className="text-gray-400">→</span>
                    <span className="text-gray-500 dark:text-gray-400">{targetValue}</span>
                    {r.error ? (
                      <span className="ml-auto text-red-500 font-medium">{r.error}</span>
                    ) : r.rank ? (
                      <span className={`ml-auto font-extrabold ${r.rank <= 10 ? 'text-[#03c75a]' : 'text-gray-900 dark:text-white'}`}>
                        {r.rank}위
                      </span>
                    ) : (
                      <span className="ml-auto text-red-400 font-medium">미발견</span>
                    )}
                  </div>
                ))}
              </div>
              {results.some(r => r.product_name) && (
                <div className="mt-2 text-[10px] text-gray-400">
                  {results.filter(r => r.product_name).map((r, i) => (
                    <div key={i} className="truncate">
                      [{r.keyword}] {r.product_name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── 구매키워드 모달 ──
function BuyKeywordModal({ productCode, productName, onClose }: {
  productCode: string;
  productName: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<naverApi.BuyKeywordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    naverApi.getBuyKeywords(productCode)
      .then(res => {
        if (res.success) setItems(res.results);
        else setError('데이터를 불러올 수 없습니다');
      })
      .catch(() => setError('서버 연결 실패'))
      .finally(() => setLoading(false));
  }, [productCode]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-[#1c1c2e] border border-gray-200 dark:border-[#2a2a40] rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-[#2a2a40] shrink-0">
          <div>
            <h3 className="text-[14px] font-extrabold text-gray-900 dark:text-gray-100">
              구매키워드 <span className="text-[#03c75a]">#{productCode}</span>
            </h3>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate max-w-[400px]">{productName}</p>
          </div>
          <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
        </div>

        {/* 본문 */}
        <div className="overflow-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <div className="w-5 h-5 border-2 border-[#03c75a] border-t-transparent rounded-full animate-spin mr-2" />
              로딩중...
            </div>
          ) : error ? (
            <div className="text-center py-20 text-red-400">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-center py-20 text-gray-400 dark:text-gray-500">
              <p className="text-[14px]">구매키워드 데이터가 없습니다</p>
              <p className="text-[11px] mt-1">order 시스템에 해당 상품의 채널상품 데이터가 등록되지 않았습니다</p>
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#f0f3f7] dark:bg-[#1a2332]">
                  <th className="px-4 py-2.5 text-left font-bold text-gray-500 dark:text-gray-400">키워드</th>
                  <th className="px-4 py-2.5 text-left font-bold text-gray-500 dark:text-gray-400">채널그룹</th>
                  <th className="px-4 py-2.5 text-left font-bold text-gray-500 dark:text-gray-400">채널명</th>
                  <th className="px-4 py-2.5 text-right font-bold text-gray-500 dark:text-gray-400">결제수</th>
                  <th className="px-4 py-2.5 text-right font-bold text-gray-500 dark:text-gray-400">결제금액</th>
                  <th className="px-4 py-2.5 text-left font-bold text-gray-500 dark:text-gray-400">판매자</th>
                  <th className="px-4 py-2.5 text-left font-bold text-gray-500 dark:text-gray-400">업로드일</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-[#2a2a40] hover:bg-gray-50 dark:hover:bg-[#222240] transition-colors">
                    <td className="px-4 py-2 font-bold text-gray-900 dark:text-gray-100">{item.keyword}</td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{item.channel_group}</td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{item.channel_name}</td>
                    <td className="px-4 py-2 text-right font-bold text-[#03c75a]">{item.order_count.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-medium text-gray-900 dark:text-gray-100">{item.order_amount.toLocaleString()}원</td>
                    <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{item.naver_shop_name}</td>
                    <td className="px-4 py-2 text-[11px] text-gray-400 dark:text-gray-500">
                      {item.uploaded_at ? new Date(item.uploaded_at).toLocaleDateString('ko-KR') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 하단 요약 */}
        {items.length > 0 && (
          <div className="px-5 py-2.5 border-t border-gray-200 dark:border-[#2a2a40] flex items-center gap-4 text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
            <span>총 <strong className="text-gray-900 dark:text-gray-100">{items.length}</strong>개 키워드</span>
            <span>총 결제수 <strong className="text-[#03c75a]">{items.reduce((s, i) => s + i.order_count, 0).toLocaleString()}</strong></span>
            <span>총 결제금액 <strong className="text-gray-900 dark:text-gray-100">{items.reduce((s, i) => s + i.order_amount, 0).toLocaleString()}원</strong></span>
          </div>
        )}
      </div>
    </div>
  );
}
