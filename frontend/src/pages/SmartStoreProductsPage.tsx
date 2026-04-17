import { useState, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import {
  fetchProducts,
  syncProducts,
  fetchProductStats,
  downloadProductExcel,
  fetchWCodes,
  previewSuspend,
  suspendProducts as apiSuspendProducts,
  toggleFocus,
  type SmartStoreProduct,
  type ProductStats,
  type SuspendPreviewResult,
} from '../api/smartstoreProductApi';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import * as naverApi from '../api/naverApi';
import ProductOrdersModal from '../components/smartstore/ProductOrdersModal';

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
  const [products, setProducts] = useState<SmartStoreProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [perPage] = useState(50);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [soldoutFilter, setSoldoutFilter] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'focus' | 'premium' | 'sold'>('all');
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
  // 정렬
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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

  // 상품 목록 조회
  const loadProducts = useCallback(async () => {
    if (storeId < 0) return;
    setLoading(true);
    try {
      const res = await fetchProducts(storeId, page, perPage, status || undefined, search || undefined, soldoutFilter ? 1 : undefined, filterMode === 'focus' ? 1 : undefined, filterMode === 'sold' ? 1 : undefined, sortBy || undefined, sortBy ? sortDir : undefined, filterMode === 'premium' ? 500000 : undefined);
      setProducts(res.items);
      setTotal(res.total);
      setTotalPages(res.total_pages);
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

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadStats(); }, [loadStats]);

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

  const colSpan = isAllStores ? 12 : 11;
  const getStoreUrlById = (sid: number) => apiStores.find(st => st.id === sid)?.store_url || '';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
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
            <span className="text-gray-400 text-sm">상품관리</span>
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
            {!isAllStores && (
              <button
                className="px-4 py-1.5 text-sm bg-[#03c75a] text-white rounded hover:bg-[#02b351] disabled:opacity-50 font-medium"
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing ? '동기화 중...' : '동기화'}
              </button>
            )}
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

        {/* Stats bar */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
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
            {/* 마지막 동기화 */}
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-gray-400">마지막 동기화</div>
              <div className="text-sm font-medium truncate" title={stats.last_synced_at || ''}>
                {stats.last_synced_at ? new Date(stats.last_synced_at).toLocaleString('ko-KR') : '-'}
              </div>
            </div>
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
          </div>
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

        {/* Product table */}
        <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
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
                <th
                  className={`px-3 py-2 w-20 text-right cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${sortBy === 'stock' ? 'text-blue-600 dark:text-blue-400' : ''}`}
                  onClick={() => toggleSort('stock')}
                  title="재고순 정렬"
                >재고{sortIcon('stock')}</th>
                <th className="px-3 py-2 w-20 text-center">상태</th>
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
                    <div
                      className="line-clamp-2 text-xs leading-relaxed cursor-pointer text-blue-600 dark:text-blue-400 hover:underline"
                      onClick={() => setDetailProduct(p)}
                    >{p.name}</div>
                    {(() => {
                      const pStoreUrl = isAllStores ? getStoreUrlById(p.store_id) : storeUrl;
                      return p.channel_product_no ? (
                        pStoreUrl ? (
                          <a
                            href={`https://smartstore.naver.com/${pStoreUrl}/products/${p.channel_product_no}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-blue-500 dark:text-blue-400 hover:underline mt-0.5 inline-block"
                          >{p.channel_product_no}</a>
                        ) : (
                          <div className="text-[10px] text-gray-400 mt-0.5">{p.channel_product_no}</div>
                        )
                      ) : (
                        <div className="text-[10px] text-gray-400 mt-0.5">#{p.origin_product_no}</div>
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
        </div>

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

  // Progress states
  const [excelProgress, setExcelProgress] = useState<{ pct: number; status: 'loading' | 'done' | 'error' } | null>(null);
  const [wProgress, setWProgress] = useState<{ pct: number; status: 'loading' | 'done' | 'error' } | null>(null);

  const isBusy = (excelProgress?.status === 'loading') || (wProgress?.status === 'loading');

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

  const fields: { label: string; value: string | number | null }[] = [
    { label: '상품번호', value: p.origin_product_no },
    { label: '채널상품번호', value: p.channel_product_no },
    { label: '상품명', value: p.name },
    { label: '판매가', value: p.sale_price?.toLocaleString() + '원' },
    { label: '재고', value: p.stock_quantity?.toLocaleString() },
    { label: '판매상태', value: STATUS_LABELS[p.status_type || ''] || p.status_type || '-' },
    { label: '노출상태', value: p.channel_product_display_status_type || '-' },
    { label: '관리코드', value: p.seller_management_code || '-' },
    { label: '카테고리', value: catPath || p.category_id || '-' },
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
            </div>

            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {fields.map(f => (
                  <tr key={f.label}>
                    <td className="px-2 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 w-28">{f.label}</td>
                    <td className="px-2 py-2 text-xs break-all">{f.value ?? '-'}</td>
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
