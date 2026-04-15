import { useState, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import {
  fetchProducts,
  syncProducts,
  fetchProductStats,
  downloadProductExcel,
  fetchWCodes,
  previewSuspend,
  suspendProducts as apiSuspendProducts,
  type SmartStoreProduct,
  type ProductStats,
  type SuspendPreviewResult,
} from '../api/smartstoreProductApi';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';

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
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [excelOpen, setExcelOpen] = useState(false);
  const [detailProduct, setDetailProduct] = useState<SmartStoreProduct | null>(null);
  // 체크박스 + 품절처리
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [suspendPreview, setSuspendPreview] = useState<SuspendPreviewResult | null>(null);
  const [suspendLoading, setSuspendLoading] = useState(false);
  const [suspendExecuting, setSuspendExecuting] = useState(false);
  const [suspendResult, setSuspendResult] = useState<{ success: number; fail: number } | null>(null);

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
      const res = await fetchProducts(storeId, page, perPage, status || undefined, search || undefined, soldoutFilter ? 1 : undefined);
      setProducts(res.items);
      setTotal(res.total);
      setTotalPages(res.total_pages);
    } finally {
      setLoading(false);
    }
  }, [storeId, page, perPage, status, search, soldoutFilter]);

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

  // storeId는 항상 0 이상 (0=전체, n=개별상점)

  const colSpan = isAllStores ? 10 : 9;
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
            <button
              className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 font-medium"
              onClick={handleSuspendClick}
              disabled={!hasSelection || suspendLoading}
            >
              {suspendLoading ? '조회 중...' : '품절처리'}
            </button>
            <button
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
              onClick={() => setExcelOpen(true)}
            >
              엑셀받기
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
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-gray-400">전체</div>
              <div className="text-lg font-bold">{stats.total.toLocaleString()}</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-green-500">판매중</div>
              <div className="text-lg font-bold text-green-600">{(stats.by_status['SALE'] || 0).toLocaleString()}</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-yellow-500">판매중지</div>
              <div className="text-lg font-bold text-yellow-600">{(stats.by_status['SUSPENSION'] || 0).toLocaleString()}</div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 px-3 py-2">
              <div className="text-xs text-gray-400">기타</div>
              <div className="text-lg font-bold">{
                (stats.total - (stats.by_status['SALE'] || 0) - (stats.by_status['SUSPENSION'] || 0)).toLocaleString()
              }</div>
            </div>
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
              placeholder="상품명 / 관리코드 검색"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button
              className="text-sm px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-r hover:bg-gray-300 dark:hover:bg-gray-600 border border-l-0 border-gray-300 dark:border-gray-600"
              onClick={handleSearch}
            >
              검색
            </button>
          </div>
          <div className="ml-auto text-sm text-gray-400 self-center">
            총 {total.toLocaleString()}개
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
                {isAllStores && <th className="px-3 py-2 w-24">상점</th>}
                <th className="px-3 py-2 w-16">이미지</th>
                <th className="px-3 py-2">상품명</th>
                <th className="px-3 py-2 w-28">관리코드</th>
                <th className="px-3 py-2 w-24 text-right">판매가</th>
                <th className="px-3 py-2 w-20 text-right">재고</th>
                <th className="px-3 py-2 w-24 text-center">상태</th>
                <th className="px-3 py-2 w-20 text-center">노출</th>
                <th
                  className={`px-3 py-2 w-24 text-center cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors ${soldoutFilter ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : ''}`}
                  onClick={() => { setSoldoutFilter(!soldoutFilter); setPage(1); }}
                  title="클릭하면 품절 상품만 필터"
                >오너클랜품절{soldoutFilter ? ' ✕' : ''}</th>
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
                  <td className="px-3 py-2 text-xs truncate max-w-[120px]" title={p.seller_management_code || ''}>
                    {p.seller_management_code?.startsWith('W') ? (
                      <a
                        href={`https://ownerclan.com/V2/product/view.php?selfcode=${p.seller_management_code}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-orange-600 dark:text-orange-400 hover:underline"
                      >{p.seller_management_code}</a>
                    ) : (
                      <span className="text-gray-500">{p.seller_management_code || '-'}</span>
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
                  <td className="px-3 py-2 text-center text-xs">
                    {p.channel_product_display_status_type === 'ON' ? (
                      <span className="text-green-500 font-medium">ON</span>
                    ) : (
                      <span className="text-gray-400">{p.channel_product_display_status_type || '-'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {p.ownerclan_soldout === 1 ? (
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">상품품절</span>
                    ) : (
                      <span className="text-gray-400 text-xs">-</span>
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
        <ExcelModal stores={apiStores} onClose={() => setExcelOpen(false)} />
      )}

      {/* Product Detail Modal */}
      {detailProduct && (
        <SSProductDetailModal
          product={detailProduct}
          storeUrl={isAllStores ? getStoreUrlById(detailProduct.store_id) : storeUrl}
          onClose={() => setDetailProduct(null)}
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

function ExcelModal({ stores, onClose }: { stores: SmartStore[]; onClose: () => void }) {
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
        { storeIds: getStoreIds(), statuses: getStatuses(), wOnly },
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


function SSProductDetailModal({ product: p, storeUrl, onClose }: { product: SmartStoreProduct; storeUrl: string; onClose: () => void }) {
  const detailUrl = storeUrl && p.channel_product_no
    ? `https://smartstore.naver.com/${storeUrl}/products/${p.channel_product_no}`
    : null;

  const fields: { label: string; value: string | number | null }[] = [
    { label: '상품번호', value: p.origin_product_no },
    { label: '채널상품번호', value: p.channel_product_no },
    { label: '상품명', value: p.name },
    { label: '판매가', value: p.sale_price?.toLocaleString() + '원' },
    { label: '재고', value: p.stock_quantity?.toLocaleString() },
    { label: '판매상태', value: STATUS_LABELS[p.status_type || ''] || p.status_type || '-' },
    { label: '노출상태', value: p.channel_product_display_status_type || '-' },
    { label: '관리코드', value: p.seller_management_code || '-' },
    { label: '카테고리ID', value: p.category_id || '-' },
    { label: '동기화일시', value: p.synced_at ? new Date(p.synced_at).toLocaleString('ko-KR') : '-' },
    { label: '등록일', value: p.created_at ? new Date(p.created_at).toLocaleString('ko-KR') : '-' },
    { label: '수정일', value: p.updated_at ? new Date(p.updated_at).toLocaleString('ko-KR') : '-' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col"
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

        <div className="overflow-y-auto flex-1 px-4 py-3">
          {p.product_image_url && (
            <div className="flex justify-center mb-4">
              <img src={p.product_image_url} alt="" className="w-48 h-48 object-contain rounded-lg border border-gray-200 dark:border-gray-600" />
            </div>
          )}

          {/* 상세페이지 버튼 */}
          {detailUrl && (
            <div className="mb-4">
              <a
                href={detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center px-4 py-2.5 text-sm font-medium bg-[#03c75a] text-white rounded-lg hover:bg-[#02b351] transition-colors"
              >
                상세페이지 보기
              </a>
            </div>
          )}

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
      </div>
    </div>
  );
}
