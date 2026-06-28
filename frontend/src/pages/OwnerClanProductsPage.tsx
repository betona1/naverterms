import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import WcodeBlacklistPanel from '../components/WcodeBlacklistPanel';
import {
  fetchProducts,
  fetchProductDetail,
  fetchStats,
  fetchChangedFieldCounts,
  downloadProductExcel,
  fetchWCodes,
  uploadExcel,
  fetchUploadTask,
  uploadCsv,
  uploadSoldoutTxt,
  syncProducts,
  activateSuspended,
  downloadSampleExcel,
  fetchSyncStatusPreview,
  executeSyncStatus,
  fetchChangeLogSummary,
  fetchChangeLogDates,
  fetchProductChangeLog,
  type OwnerClanProductItem,
  type ProductDetail,
  type ProductStats,
  type UploadTaskStatus,
  type SyncStatusPreview,
  type ChangeLogSummary,
  type ChangeLogItem,
  type ChangeLogDateEntry,
} from '../api/ownerclanProductApi';

const SALE_STATUS_LABELS: Record<number, string> = { 1: '판매중', 2: '품절', 3: '단종' };
const SALE_STATUS_COLORS: Record<number, string> = {
  1: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  2: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  3: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

const FIELD_LABELS: Record<string, string> = {
  seller_code1: '판매자관리코드1', seller_code2: '판매자관리코드2',
  category_code: '카테고리코드', category_name: '카테고리명', market_category: '마켓카테고리',
  product_name: '원본상품명', market_product_name: '마켓상품명',
  ownerclan_price: '오너클랜판매가', consumer_price: '소비자준수가', market_price: '마켓실제판매가',
  shipping_fee: '배송비', shipping_type: '배송유형', min_qty: '최소구매수량', max_qty: '최대구매수량',
  company_notice: '업체공지', special_notice: '특별공지', return_fee: '반품배송비',
  option1_name: '옵션1명', option1_values: '옵션1값', option2_name: '옵션2명', option2_values: '옵션2값',
  combined_option: '조합형옵션', independent_option: '독립형', combined_option_detail: '조합형',
  product_attribute: '상품속성', product_grade: '상품등급', tax_type: '과세',
  compliance: '준수여부', age_restriction: '19세미만판매금지', return_possible: '단순변심반품가능',
  image_large: '이미지대', image_medium: '이미지중', image_small: '이미지소',
  manufacturer: '제작/수입사', brand: '브랜드', model_name: '모델명', origin: '원산지',
  keywords: '키워드', registered_at: '등록일', modified_at: '최종수정일',
  header_text: '상단문구', detail_html: '본문상세설명',
  notice_code: '정보고시코드', notice_category: '정보고시카테고리',
  notice_info: '정보고시항목정보', notice_html: '정보고시html',
  market_gmarket: '지마켓', market_auction: '옥션', market_11st: '11번가',
  market_coupang: '쿠팡', market_smartstore: '스마트스토어',
  market_promo: '마켓홍보문구', market_gift: '사은품',
  certification_type: '인증구분', certification_info: '인증정보',
};

export default function OwnerClanProductsPage() {
  const { dark } = useTheme();
  const [blacklistOpen, setBlacklistOpen] = useState(false);
  const [products, setProducts] = useState<OwnerClanProductItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [perPage] = useState(50);
  const [saleStatus, setSaleStatus] = useState<string>('');
  const [syncFilter, setSyncFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [changedField, setChangedField] = useState<string>('');
  const [changedFieldCounts, setChangedFieldCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadMsg, setUploadMsg] = useState('');
  const [uploadTask, setUploadTask] = useState<UploadTaskStatus | null>(null);
  const uploadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const excelRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const soldoutTxtRef = useRef<HTMLInputElement>(null);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const [activatePrompt, setActivatePrompt] = useState<{ taskId: number; count: number } | null>(null);
  const [activating, setActivating] = useState(false);

  const [exportProgress, setExportProgress] = useState<{ pct: number; status: 'loading' | 'done' | 'error'; label: string } | null>(null);
  const [wCodes, setWCodes] = useState('');
  const [statusSyncing, setStatusSyncing] = useState(false);
  const [statusSyncResult, setStatusSyncResult] = useState<{ success: number; fail: number; skipped: number } | null>(null);
  const [syncPreview, setSyncPreview] = useState<SyncStatusPreview | null>(null);
  const [syncPreviewExpanded, setSyncPreviewExpanded] = useState(false);
  const [syncPreviewLoading, setSyncPreviewLoading] = useState(false);
  const [changeLog, setChangeLog] = useState<ChangeLogSummary | null>(null);
  const [changeLogExpanded, setChangeLogExpanded] = useState(false);
  const [changeLogDate, setChangeLogDate] = useState<string>('');
  const [changeLogPage, setChangeLogPage] = useState(1);
  const [changeLogDates, setChangeLogDates] = useState<ChangeLogDateEntry[]>([]);
  const [detailChangeLog, setDetailChangeLog] = useState<ChangeLogItem[]>([]);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchProducts(
        page, perPage,
        saleStatus ? (saleStatus.includes(',') ? saleStatus : Number(saleStatus)) : undefined,
        syncFilter !== '' ? Number(syncFilter) : undefined,
        search || undefined,
        changedField || undefined,
      );
      setProducts(res.items);
      setTotal(res.total);
      setTotalPages(res.total_pages);
    } finally {
      setLoading(false);
    }
  }, [page, perPage, saleStatus, syncFilter, search, changedField]);

  const loadStats = useCallback(async () => {
    const s = await fetchStats();
    setStats(s);
  }, []);

  const loadChangedFields = useCallback(async () => {
    const counts = await fetchChangedFieldCounts();
    setChangedFieldCounts(counts);
  }, []);


  const loadChangeLog = useCallback(async () => {
    try {
      const cl = await fetchChangeLogSummary(changeLogDate || undefined, changeLogPage, 50);
      setChangeLog(cl);
    } catch { /* ignore */ }
  }, [changeLogDate, changeLogPage]);

  const loadChangeLogDates = useCallback(async () => {
    try {
      const res = await fetchChangeLogDates();
      setChangeLogDates(res.dates);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadChangedFields(); }, [loadChangedFields]);
  useEffect(() => { loadChangeLog(); }, [loadChangeLog]);
  useEffect(() => { loadChangeLogDates(); }, [loadChangeLogDates]);

  useEffect(() => {
    return () => {
      if (uploadPollRef.current) clearInterval(uploadPollRef.current);
    };
  }, []);

  const startPolling = useCallback((taskId: number) => {
    if (uploadPollRef.current) clearInterval(uploadPollRef.current);
    uploadPollRef.current = setInterval(async () => {
      try {
        const t = await fetchUploadTask(taskId);
        setUploadTask(t);
        if (t.status === 'done') {
          if (uploadPollRef.current) clearInterval(uploadPollRef.current);
          uploadPollRef.current = null;
          const rd = t.result_data;
          setUploadTask(null);
          loadProducts();
          loadStats();
          loadChangedFields();
          // 판매중지 상품이 있으면 활성화 확인 모달 표시
          if (rd.suspended_count && rd.suspended_count > 0) {
            setActivatePrompt({ taskId: t.task_id, count: rd.suspended_count });
          }
          // 엑셀 업로드 후 자동 품절해제 동기화
          try {
            const preview = await fetchSyncStatusPreview();
            if (preview.to_activate_total > 0) {
              const result = await executeSyncStatus('activate');
              setUploadMsg(`신규 ${rd.inserted ?? 0}건, 변경 ${rd.updated ?? 0}건, 스킵 ${rd.skipped ?? 0}건 (총 ${rd.total ?? 0}건) · 품절해제 ${result.success}건 자동동기화`);
            } else {
              setUploadMsg(`신규 ${rd.inserted ?? 0}건, 변경 ${rd.updated ?? 0}건, 스킵 ${rd.skipped ?? 0}건 (총 ${rd.total ?? 0}건)`);
            }
          } catch {
            setUploadMsg(`신규 ${rd.inserted ?? 0}건, 변경 ${rd.updated ?? 0}건, 스킵 ${rd.skipped ?? 0}건 (총 ${rd.total ?? 0}건)`);
          }
        } else if (t.status === 'error') {
          if (uploadPollRef.current) clearInterval(uploadPollRef.current);
          uploadPollRef.current = null;
          setUploadMsg(`업로드 처리 실패: ${t.result_data?.error?.slice(0, 200) || '알 수 없는 오류'}`);
          setUploadTask(null);
        }
      } catch {
        // polling 실패 시 무시
      }
    }, 3000);
  }, [loadProducts, loadStats, loadChangedFields]);

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress(0);
    setUploadMsg('');
    setUploadTask(null);
    try {
      const res = await uploadExcel(file, (pct) => setUploadProgress(pct));
      setUploadProgress(null);
      setUploadTask({ task_id: res.task_id, status: 'pending', result_data: {} });
      startPolling(res.task_id);
    } catch (err: unknown) {
      setUploadProgress(null);
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUploadMsg(msg || '엑셀 업로드 실패');
    } finally {
      if (excelRef.current) excelRef.current.value = '';
    }
  };

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress(0);
    setUploadMsg('');
    try {
      const res = await uploadCsv(file, (pct) => setUploadProgress(pct));
      setUploadMsg(`상태 업데이트 ${res.updated}건`);
      loadProducts();
      loadStats();
      loadChangedFields();
    } catch {
      setUploadMsg('CSV 업로드 실패');
    } finally {
      setUploadProgress(null);
      if (csvRef.current) csvRef.current.value = '';
    }
  };

  const handleSoldoutTxtUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress(0);
    setUploadMsg('');
    try {
      const res = await uploadSoldoutTxt(file, (pct) => setUploadProgress(pct));
      setUploadMsg(`TXT 총 ${res.total_codes.toLocaleString()}개, 오너클랜 매칭 ${res.ownerclan_matched.toLocaleString()}개, 업데이트 ${res.ownerclan_updated.toLocaleString()}개, 스마트스토어 ${res.smartstore_updated.toLocaleString()}개`);
      loadProducts();
      loadStats();
      loadChangedFields();
    } catch {
      setUploadMsg('품절TXT 업로드 실패');
    } finally {
      setUploadProgress(null);
      if (soldoutTxtRef.current) soldoutTxtRef.current.value = '';
    }
  };

  const handleSampleDownload = async () => {
    try {
      await downloadSampleExcel();
    } catch {
      alert('샘플 다운로드 실패');
    }
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await syncProducts();
      setSyncMsg(`${res.synced}건 동기화 완료`);
      loadProducts();
      loadStats();
      loadChangedFields();
    } catch {
      setSyncMsg('동기화 실패');
    } finally {
      setSyncing(false);
    }
  };

  const openDetail = async (id: number) => {
    setDetailId(id);
    setDetailLoading(true);
    setDetailChangeLog([]);
    try {
      const [d, cl] = await Promise.all([
        fetchProductDetail(id),
        fetchProductChangeLog(id).catch(() => [] as ChangeLogItem[]),
      ]);
      setDetail(d);
      setDetailChangeLog(cl);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSyncSingle = async (id: number) => {
    await syncProducts([id]);
    if (detailId === id) {
      const d = await fetchProductDetail(id);
      setDetail(d);
    }
    loadProducts();
    loadStats();
    loadChangedFields();
  };

  const handleSearch = () => { setSearch(searchInput); setPage(1); };

  const currentExportParams = () => ({
    saleStatus: saleStatus ? Number(saleStatus) : undefined,
    isSynced: syncFilter !== '' ? Number(syncFilter) : undefined,
    search: search || undefined,
    changedField: changedField || undefined,
  });

  const handleExcelExport = async () => {
    setExportProgress({ pct: 0, status: 'loading', label: '엑셀 다운로드' });
    try {
      await downloadProductExcel(
        currentExportParams(),
        (pct) => setExportProgress({ pct, status: 'loading', label: '엑셀 다운로드' }),
      );
      setExportProgress({ pct: 100, status: 'done', label: '엑셀 다운로드' });
      setTimeout(() => setExportProgress(null), 2000);
    } catch {
      setExportProgress({ pct: 100, status: 'error', label: '엑셀 다운로드' });
      setTimeout(() => setExportProgress(null), 3000);
    }
  };

  const handleWCodeExtract = async () => {
    setExportProgress({ pct: 0, status: 'loading', label: 'W코드 추출' });
    setWCodes('');
    try {
      const codes = await fetchWCodes(
        currentExportParams(),
        (pct) => setExportProgress({ pct, status: 'loading', label: 'W코드 추출' }),
      );
      setWCodes(codes.join('\n'));
      setExportProgress({ pct: 100, status: 'done', label: 'W코드 추출' });
      setTimeout(() => setExportProgress(null), 2000);
    } catch {
      setWCodes('W코드 추출 실패');
      setExportProgress({ pct: 100, status: 'error', label: 'W코드 추출' });
      setTimeout(() => setExportProgress(null), 3000);
    }
  };

  return (
    <div className="text-gray-800 dark:text-gray-200">
      {/* Header */}
      <div className="sticky top-[42px] z-10 bg-white dark:bg-[#1e1e2e] border-b border-gray-200 dark:border-[#333] px-4 py-2.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">오너클랜 상품대장</span>
            <button
              className="px-3 py-1 text-xs bg-rose-600 text-white rounded hover:bg-rose-700 font-bold shadow"
              onClick={() => setBlacklistOpen(true)}
              title="W코드 블랙리스트 — 등록/매칭/일괄 삭제"
            >🚫 블랙리스트 상품</button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="px-3 py-1.5 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 font-medium"
              onClick={handleSampleDownload}
            >샘플받기</button>
            <input ref={excelRef} type="file" accept=".xlsx,.zip" className="hidden" onChange={handleExcelUpload} />
            <button
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
              onClick={() => excelRef.current?.click()}
            >엑셀/ZIP 업로드</button>
            <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
            <button
              className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 font-medium"
              onClick={() => csvRef.current?.click()}
            >CSV 상태업로드</button>
            <input ref={soldoutTxtRef} type="file" accept=".txt" className="hidden" onChange={handleSoldoutTxtUpload} />
            <button
              className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 font-medium"
              onClick={() => soldoutTxtRef.current?.click()}
            >품절TXT올리기</button>
            <button
              className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 font-medium disabled:opacity-50"
              onClick={handleSyncAll}
              disabled={syncing}
            >{syncing ? '동기화 중...' : '전체 동기화'}</button>
            <span className="w-px h-5 bg-gray-300 dark:bg-gray-600" />
            <button
              className="px-3 py-1.5 text-xs bg-teal-600 text-white rounded hover:bg-teal-700 font-medium disabled:opacity-50"
              onClick={handleExcelExport}
              disabled={!!exportProgress}
            >엑셀받기</button>
            <button
              className="px-3 py-1.5 text-xs bg-orange-500 text-white rounded hover:bg-orange-600 font-medium disabled:opacity-50"
              onClick={handleWCodeExtract}
              disabled={!!exportProgress}
            >W코드추출</button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* Upload progress (file upload) */}
        {uploadProgress !== null && (
          <div className="bg-white dark:bg-[#1e1e2e] rounded border border-gray-200 dark:border-[#333] p-3 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-600 dark:text-gray-300 font-medium">파일 업로드 중...</span>
              <span className="text-gray-400">{uploadProgress}%</span>
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
          </div>
        )}

        {/* Upload task processing progress */}
        {uploadTask && (
          <div className="bg-white dark:bg-[#1e1e2e] rounded border border-blue-200 dark:border-blue-700 p-3 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-blue-600 dark:text-blue-400 font-medium">
                DB 처리 중...
                {uploadTask.result_data?.total_rows
                  ? ` (${(uploadTask.result_data.inserted ?? 0) + (uploadTask.result_data.updated ?? 0) + (uploadTask.result_data.skipped ?? 0)}/${uploadTask.result_data.total_rows.toLocaleString()}건)`
                  : ''}
              </span>
              <span className="text-gray-400">
                {uploadTask.result_data?.progress ?? 0}%
                {uploadTask.result_data?.inserted != null && (
                  <span className="ml-2 text-gray-500">
                    추가 {uploadTask.result_data.inserted} / 수정 {uploadTask.result_data.updated ?? 0} / 스킵 {uploadTask.result_data.skipped ?? 0}
                  </span>
                )}
              </span>
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${uploadTask.result_data?.progress ?? 0}%` }} />
            </div>
          </div>
        )}

        {/* Messages */}
        {uploadMsg && (
          <div className={`text-sm px-3 py-2 rounded ${uploadMsg.includes('실패') ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
            {uploadMsg}
            <button className="ml-2 text-xs underline opacity-60" onClick={() => setUploadMsg('')}>닫기</button>
          </div>
        )}
        {syncMsg && (
          <div className={`text-sm px-3 py-2 rounded ${syncMsg.includes('실패') ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'}`}>
            {syncMsg}
            <button className="ml-2 text-xs underline opacity-60" onClick={() => setSyncMsg('')}>닫기</button>
          </div>
        )}

        {/* Stats */}
        {stats && (<>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <StatCard label="전체" value={stats.total}
              active={!saleStatus && !syncFilter && !changedField}
              onClick={() => { setSaleStatus(''); setSyncFilter(''); setChangedField(''); setPage(1); }} />
            <StatCard label="판매중" value={stats.selling} color="text-green-600 dark:text-green-400"
              active={saleStatus === '1'}
              onClick={() => { setSaleStatus('1'); setSyncFilter(''); setChangedField(''); setPage(1); }} />
            <StatCard label="품절" value={stats.soldout} color="text-yellow-600 dark:text-yellow-400"
              active={saleStatus === '2'}
              onClick={() => { setSaleStatus('2'); setSyncFilter(''); setChangedField(''); setPage(1); }} />
            <StatCard label="단종" value={stats.discontinued} color="text-red-600 dark:text-red-400"
              active={saleStatus === '3'}
              onClick={() => { setSaleStatus('3'); setSyncFilter(''); setChangedField(''); setPage(1); }} />
            <StatCard label="수정사항" value={stats.changed} color="text-orange-600 dark:text-orange-400"
              active={changedField === '__any__'}
              onClick={() => { setChangedField('__any__'); setSaleStatus(''); setSyncFilter(''); setPage(1); }} />
          </div>
          {/* 스마트스토어 동기화 */}
          <div className="flex items-center gap-2">
            <button
              disabled={statusSyncing || syncPreviewLoading}
              className={`px-4 py-2 text-xs font-bold rounded transition-colors ${
                statusSyncing || syncPreviewLoading
                  ? 'bg-gray-400 text-white cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
              onClick={async () => {
                setSyncPreviewLoading(true);
                setStatusSyncResult(null);
                try {
                  const p = await fetchSyncStatusPreview();
                  setSyncPreview(p);
                  setSyncPreviewExpanded(false);
                  if (p.total_sync === 0) return;
                  if (!confirm(`스마트스토어 ${p.total_sync.toLocaleString()}개 상품 상태를 동기화하시겠습니까?\n\n품절해제→SALE: ${p.to_activate_total.toLocaleString()}\nSALE→품절: ${p.to_soldout.toLocaleString()}\nSALE→단종: ${p.to_discontinued.toLocaleString()}`)) return;
                  setStatusSyncing(true);
                  const result = await executeSyncStatus();
                  setStatusSyncResult({ success: result.success, fail: result.fail, skipped: result.skipped ?? 0 });
                  loadStats();
                  loadProducts();
                } catch (e: any) {
                  alert('동기화 오류: ' + (e.message || e));
                } finally {
                  setSyncPreviewLoading(false);
                  setStatusSyncing(false);
                }
              }}
            >
              {syncPreviewLoading || statusSyncing ? '동기화 진행중...' : '스마트스토어 동기화'}
            </button>
            {statusSyncResult && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                성공 {statusSyncResult.success.toLocaleString()} / 실패 {statusSyncResult.fail.toLocaleString()}
                {statusSyncResult.skipped > 0 && ` / 제외 ${statusSyncResult.skipped.toLocaleString()}`}
              </span>
            )}
          </div>
          {/* 동기화 결과/미리보기 패널 */}
          {syncPreview && (
            <div className="bg-white dark:bg-[#1e1e2e] rounded border border-blue-200 dark:border-blue-800 p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-blue-600 dark:text-blue-400">
                  {statusSyncResult ? '스마트스토어 동기화 완료' : '스마트스토어 동기화 현황'}
                </span>
                <div className="flex items-center gap-3">
                  <span className="text-gray-400">상태변경 {syncPreview.total_sync.toLocaleString()}개 · 가격변동 {syncPreview.price_changed.toLocaleString()}개 제외</span>
                  <button className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" onClick={() => setSyncPreview(null)}>✕</button>
                </div>
              </div>
              {/* 간략 표시 — 스마트스토어 기준 */}
              <div className="flex flex-wrap gap-4 text-gray-700 dark:text-gray-300">
                {syncPreview.to_activate_total > 0 && (
                  <span>품절해제→SALE <b className="text-green-600 dark:text-green-400">{syncPreview.to_activate_total.toLocaleString()}</b>
                    <span className="text-gray-400 ml-1">(중지 {syncPreview.to_activate_suspension.toLocaleString()} + 품절 {syncPreview.to_activate_outofstock.toLocaleString()})</span>
                  </span>
                )}
                {syncPreview.to_soldout > 0 && <span>SALE→품절처리 <b className="text-yellow-600 dark:text-yellow-400">{syncPreview.to_soldout.toLocaleString()}</b></span>}
                {syncPreview.to_discontinued > 0 && <span>SALE→단종처리 <b className="text-red-600 dark:text-red-400">{syncPreview.to_discontinued.toLocaleString()}</b></span>}
                {syncPreview.total_sync === 0 && <span className="text-gray-400">동기화할 상태 변경 사항이 없습니다</span>}
              </div>
              {/* 펼치기 - 필드별 변경사항 */}
              {Object.keys(syncPreview.field_changes).length > 0 && (
                <>
                  <button
                    className="text-blue-500 hover:underline text-xs"
                    onClick={() => setSyncPreviewExpanded(!syncPreviewExpanded)}
                  >{syncPreviewExpanded ? '▲ 접기' : '▼ 필드별 변경사항 보기'}</button>
                  {syncPreviewExpanded && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-gray-600 dark:text-gray-400 pl-2 border-l-2 border-blue-200 dark:border-blue-800">
                      {syncPreview.field_changes.price != null && <span>가격변동 <b>{syncPreview.field_changes.price}</b></span>}
                      {syncPreview.field_changes.product_name != null && <span>상품명 <b>{syncPreview.field_changes.product_name}</b></span>}
                      {syncPreview.field_changes.detail_html != null && <span>상세페이지 <b>{syncPreview.field_changes.detail_html}</b></span>}
                      {syncPreview.field_changes.image != null && <span>대표이미지 <b>{syncPreview.field_changes.image}</b></span>}
                      {syncPreview.field_changes.shipping_fee != null && <span>배송비 <b>{syncPreview.field_changes.shipping_fee}</b></span>}
                      {syncPreview.field_changes.return_fee != null && <span>반품비 <b>{syncPreview.field_changes.return_fee}</b></span>}
                      {syncPreview.field_changes.combined_option != null && <span>옵션 <b>{syncPreview.field_changes.combined_option}</b></span>}
                      {syncPreview.field_changes.manufacturer != null && <span>제조사 <b>{syncPreview.field_changes.manufacturer}</b></span>}
                      {syncPreview.field_changes.origin != null && <span>원산지 <b>{syncPreview.field_changes.origin}</b></span>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>)}

        {/* 통합 변경사항 리포트 */}
        <ChangeLogReport
          changeLog={changeLog}
          expanded={changeLogExpanded}
          onToggle={() => setChangeLogExpanded(!changeLogExpanded)}
          dates={changeLogDates}
          selectedDate={changeLogDate}
          onDateChange={(d) => { setChangeLogDate(d); setChangeLogPage(1); }}
          logPage={changeLogPage}
          onPageChange={setChangeLogPage}
        />

        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <select className="text-xs border border-gray-300 dark:border-[#444] rounded px-2 py-1.5 bg-white dark:bg-[#2d2d2d]"
            value={saleStatus} onChange={e => { setSaleStatus(e.target.value); setPage(1); }}>
            <option value="">전체 상태</option>
            <option value="1">판매중</option>
            <option value="2">품절</option>
            <option value="3">단종</option>
          </select>
          <select className="text-xs border border-gray-300 dark:border-[#444] rounded px-2 py-1.5 bg-white dark:bg-[#2d2d2d]"
            value={changedField}
            onChange={e => {
              const v = e.target.value;
              setChangedField(v);
              if (v) setSyncFilter('');
              setPage(1);
            }}
          >
            <option value="">변경항목 전체</option>
            {Object.entries(changedFieldCounts).map(([field, cnt]) => (
              <option key={field} value={field}>
                {FIELD_LABELS[field] || field} ({cnt})
              </option>
            ))}
          </select>
          <div className="flex">
            <input className="text-xs border border-gray-300 dark:border-[#444] rounded-l px-2 py-1.5 bg-white dark:bg-[#2d2d2d] w-48"
              placeholder="W코드 / 상품명 검색"
              value={searchInput} onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()} />
            <button className="text-xs px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-r hover:bg-gray-300 dark:hover:bg-gray-600 border border-l-0 border-gray-300 dark:border-[#444]"
              onClick={handleSearch}>검색</button>
          </div>
          <div className="ml-auto text-xs text-gray-400 self-center">총 {total.toLocaleString()}개</div>
        </div>

        {/* Export progress */}
        {exportProgress && (
          <ExportProgressBar pct={exportProgress.pct} label={exportProgress.label} status={exportProgress.status} />
        )}

        {/* W코드 결과 */}
        {wCodes && !exportProgress && (
          <div className="bg-white dark:bg-[#1e1e2e] rounded border border-gray-200 dark:border-[#333] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500 font-medium">{wCodes.split('\n').filter(Boolean).length.toLocaleString()}개 W코드</span>
              <div className="flex gap-2">
                <button className="text-xs text-blue-500 hover:underline"
                  onClick={() => navigator.clipboard.writeText(wCodes)}>복사</button>
                <button className="text-xs text-gray-400 hover:underline"
                  onClick={() => setWCodes('')}>닫기</button>
              </div>
            </div>
            <textarea
              className="w-full h-32 text-xs border border-gray-300 dark:border-[#444] rounded p-2 bg-gray-50 dark:bg-[#0f0f1a] font-mono"
              readOnly value={wCodes}
            />
          </div>
        )}

        {/* Table */}
        <div className="bg-white dark:bg-[#1e1e2e] rounded border border-gray-200 dark:border-[#333] overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50 dark:bg-[#2d2d2d]">
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                <th className="px-3 py-2 w-16">이미지</th>
                <th className="px-3 py-2 w-24">W코드</th>
                <th className="px-3 py-2">상품명</th>
                <th className="px-3 py-2 w-24 text-right">판매가</th>
                <th className="px-3 py-2 w-24 text-right">마켓가</th>
                <th className="px-3 py-2 w-20 text-right">배송비</th>
                <th className="px-3 py-2 w-20 text-center">상태</th>
                <th className="px-3 py-2 w-20 text-center">동기화</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {loading ? (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">로딩 중...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-gray-400">
                  {total === 0 ? '엑셀/ZIP 파일을 업로드해 주세요.' : '검색 결과가 없습니다.'}
                </td></tr>
              ) : products.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-[#2a2a3e]">
                  <td className="px-3 py-2">
                    <HoverImage src={p.image_large || p.image_small} thumb={p.image_small} />
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    <a
                      href={`https://ownerclan.com/V2/product/view.php?selfcode=${p.product_code}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:underline"
                    >{p.product_code}</a>
                  </td>
                  <td className="px-3 py-2">
                    <div
                      className="line-clamp-2 text-xs leading-relaxed cursor-pointer text-blue-600 dark:text-blue-400 hover:underline"
                      onClick={() => openDetail(p.id)}
                    >{p.product_name}</div>
                    {p.product_name !== p.orig_product_name && (
                      <div className="text-[10px] text-orange-500 mt-0.5 line-through">{p.orig_product_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    <span className={p.ownerclan_price !== p.orig_ownerclan_price ? 'text-orange-500 font-bold' : ''}>
                      {p.ownerclan_price.toLocaleString()}
                    </span>
                    {p.ownerclan_price !== p.orig_ownerclan_price && (
                      <div className="text-[10px] text-gray-400 line-through">{p.orig_ownerclan_price.toLocaleString()}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    <span className={p.market_price !== p.orig_market_price ? 'text-orange-500 font-bold' : ''}>
                      {p.market_price.toLocaleString()}
                    </span>
                    {p.market_price !== p.orig_market_price && (
                      <div className="text-[10px] text-gray-400 line-through">{p.orig_market_price.toLocaleString()}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    <span className={p.shipping_fee !== p.orig_shipping_fee ? 'text-orange-500 font-bold' : ''}>
                      {p.shipping_fee.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${SALE_STATUS_COLORS[p.sale_status] || ''}`}>
                      {SALE_STATUS_LABELS[p.sale_status] || '?'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {p.has_changes ? (
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">수정사항</span>
                    ) : (
                      <span className="text-[10px] text-gray-400">일치</span>
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
            <button className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-[#444] disabled:opacity-30"
              disabled={page <= 1} onClick={() => setPage(page - 1)}>&lt;</button>
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
              let p: number;
              if (totalPages <= 10) p = i + 1;
              else if (page <= 5) p = i + 1;
              else if (page >= totalPages - 4) p = totalPages - 9 + i;
              else p = page - 4 + i;
              return (
                <button key={p}
                  className={`px-2.5 py-1 text-xs rounded border ${p === page ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-[#444] hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                  onClick={() => setPage(p)}>{p}</button>
              );
            })}
            <button className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-[#444] disabled:opacity-30"
              disabled={page >= totalPages} onClick={() => setPage(page + 1)}>&gt;</button>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {detailId !== null && (
        <DetailModal
          detail={detail}
          loading={detailLoading}
          changeLog={detailChangeLog}
          onClose={() => { setDetailId(null); setDetail(null); setDetailChangeLog([]); }}
          onSync={(id) => handleSyncSingle(id)}
        />
      )}

      {/* 판매중지 → 판매중 활성화 확인 모달 */}
      {activatePrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="bg-white dark:bg-[#1e1e2e] rounded-lg shadow-2xl border border-gray-200 dark:border-[#444] p-6 max-w-md w-full mx-4">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
              </div>
              <h3 className="text-lg font-bold mb-2">판매중지 상품 발견</h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                업로드된 상품 중 <span className="font-bold text-orange-500">{activatePrompt.count}개</span>의 상품이
                현재 판매중지 상태입니다.<br/>
                해당 상품을 <span className="font-bold text-green-500">판매중</span>으로 변경하시겠습니까?
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  className="px-5 py-2 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 font-medium"
                  disabled={activating}
                  onClick={() => setActivatePrompt(null)}
                >상품 업데이트만</button>
                <button
                  className="px-5 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium disabled:opacity-50"
                  disabled={activating}
                  onClick={async () => {
                    setActivating(true);
                    try {
                      const res = await activateSuspended(activatePrompt.taskId);
                      setUploadMsg(prev => prev + ` / 판매중 전환 ${res.activated}건`);
                      loadProducts();
                      loadStats();
                    } catch {
                      setUploadMsg(prev => prev + ' / 판매중 전환 실패');
                    } finally {
                      setActivating(false);
                      setActivatePrompt(null);
                    }
                  }}
                >{activating ? '처리중...' : '판매중으로 변경'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* W코드 블랙리스트 사이드 패널 */}
      <WcodeBlacklistPanel open={blacklistOpen} onClose={() => setBlacklistOpen(false)} dark={dark} />
    </div>
  );
}

function ChangeLogReport({ changeLog, expanded, onToggle, dates, selectedDate, onDateChange, logPage, onPageChange }: {
  changeLog: ChangeLogSummary | null;
  expanded: boolean;
  onToggle: () => void;
  dates: ChangeLogDateEntry[];
  selectedDate: string;
  onDateChange: (d: string) => void;
  logPage: number;
  onPageChange: (p: number) => void;
}) {
  if (!changeLog) return null;

  const fc = changeLog.field_changes;
  const ss = changeLog.soldout_sync;
  const hasAnyData = fc.total > 0 || (ss && ss.status_changes > 0);

  if (!hasAnyData && !selectedDate) return null;

  const GROUP_COLORS: Record<string, string> = {
    price: 'bg-red-500', shipping: 'bg-orange-500', product_name: 'bg-yellow-500',
    detail: 'bg-blue-500', image: 'bg-purple-500', option: 'bg-pink-500',
    info: 'bg-teal-500', compliance: 'bg-indigo-500', notice: 'bg-gray-500',
  };
  const GROUP_BADGE: Record<string, string> = {
    price: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    shipping: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    product_name: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    detail: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    image: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    option: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    info: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
    compliance: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    notice: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
  };

  const pagination = changeLog.pagination;

  return (
    <div className="bg-white dark:bg-[#1e1e2e] rounded border border-orange-200 dark:border-orange-800 p-3 text-xs space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-orange-600 dark:text-orange-400">변경사항 리포트</span>
          <select
            className="text-[11px] border border-gray-300 dark:border-[#444] rounded px-1.5 py-0.5 bg-white dark:bg-[#2d2d2d] text-gray-700 dark:text-gray-300"
            value={selectedDate}
            onChange={e => onDateChange(e.target.value)}
          >
            <option value="">현재 미반영</option>
            {dates.map(d => (
              <option key={d.date} value={d.date}>
                {d.date} ({d.field_changes > 0 ? `필드${d.field_changes}` : ''}{d.field_changes > 0 && d.soldout_changes > 0 ? '+' : ''}{d.soldout_changes > 0 ? `품절${d.soldout_changes.toLocaleString()}` : ''})
              </option>
            ))}
          </select>
        </div>
        <button
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-[#333]"
          onClick={onToggle}
        >{expanded ? '▲ 접기' : '▼ 펴기'}</button>
      </div>

      {/* Summary badges */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* 필드 변경 그룹 */}
        {fc.groups.map(g => (
          <span key={g.group} className="inline-flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded-full ${GROUP_COLORS[g.group] || 'bg-gray-500'}`} />
            <span>{g.label}</span>
            <span className="font-bold">{g.count.toLocaleString()}</span>
          </span>
        ))}
        {fc.total === 0 && <span className="text-gray-400">(필드변경 없음)</span>}

        {/* 구분선 */}
        {ss && <span className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1" />}

        {/* 품절동기화 */}
        {ss && (
          <>
            {ss.status_changes > 0 ? (
              Object.entries(ss.transitions).map(([key, cnt]) => {
                const isToSoldout = key.includes('→품절') || key.includes('→단종');
                const isToSelling = key.includes('→판매중');
                const colorCls = isToSoldout
                  ? 'text-red-600 dark:text-red-400'
                  : isToSelling
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-gray-600 dark:text-gray-300';
                return (
                  <span key={key} className={`font-medium ${colorCls}`}>
                    {key} <b>{cnt.toLocaleString()}</b>
                  </span>
                );
              })
            ) : (
              <span className="text-gray-400">(품절변동 없음)</span>
            )}
          </>
        )}
        {!ss && <span className="text-gray-400 ml-1">(품절동기화 기록 없음)</span>}
      </div>

      {/* Expanded Detail */}
      {expanded && (
        <div className="mt-2 border-t border-orange-100 dark:border-orange-900 pt-2 space-y-3">
          {/* 필드 변경 테이블 */}
          {fc.total > 0 && (
            <div>
              <div className="text-gray-500 dark:text-gray-400 mb-1 font-bold">
                필드 변경 ({fc.total.toLocaleString()}건)
              </div>
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-1 px-1">W코드</th>
                    <th className="py-1 px-1">그룹</th>
                    <th className="py-1 px-1">필드</th>
                    <th className="py-1 px-1">변경 전</th>
                    <th className="py-1 px-1">변경 후</th>
                    <th className="py-1 px-1">감지일시</th>
                  </tr>
                </thead>
                <tbody>
                  {fc.items.map(item => (
                    <tr key={item.id} className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-[#252540]">
                      <td className="py-1 px-1 font-mono">{item.product_code}</td>
                      <td className="py-1 px-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${GROUP_BADGE[item.change_group] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'}`}>
                          {item.group_label}
                        </span>
                      </td>
                      <td className="py-1 px-1 text-gray-600 dark:text-gray-400">{FIELD_LABELS[item.field_name] || item.field_name}</td>
                      <td className="py-1 px-1 text-red-500 max-w-[150px] truncate" title={item.old_value}>{item.old_value || '-'}</td>
                      <td className="py-1 px-1 text-green-600 dark:text-green-400 max-w-[150px] truncate" title={item.new_value}>{item.new_value || '-'}</td>
                      <td className="py-1 px-1 text-gray-400">{item.detected_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* 페이지네이션 */}
              {pagination.total_pages > 1 && (
                <div className="flex items-center justify-center gap-1 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                  <button
                    className="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-[#333] disabled:opacity-30"
                    disabled={logPage <= 1}
                    onClick={() => onPageChange(logPage - 1)}
                  >&lt;</button>
                  {Array.from({ length: Math.min(pagination.total_pages, 7) }, (_, i) => {
                    let p: number;
                    if (pagination.total_pages <= 7) {
                      p = i + 1;
                    } else if (logPage <= 4) {
                      p = i + 1;
                    } else if (logPage >= pagination.total_pages - 3) {
                      p = pagination.total_pages - 6 + i;
                    } else {
                      p = logPage - 3 + i;
                    }
                    return (
                      <button
                        key={p}
                        className={`px-2 py-0.5 rounded text-[11px] ${p === logPage ? 'bg-orange-500 text-white' : 'bg-gray-100 dark:bg-[#333] hover:bg-gray-200 dark:hover:bg-[#444]'}`}
                        onClick={() => onPageChange(p)}
                      >{p}</button>
                    );
                  })}
                  <button
                    className="px-2 py-0.5 rounded text-[11px] bg-gray-100 dark:bg-[#333] disabled:opacity-30"
                    disabled={logPage >= pagination.total_pages}
                    onClick={() => onPageChange(logPage + 1)}
                  >&gt;</button>
                </div>
              )}
            </div>
          )}

          {/* 품절동기화 상세 */}
          {ss && (
            <div className="border-t border-orange-100 dark:border-orange-900 pt-2">
              <div className="text-gray-500 dark:text-gray-400 mb-1 font-bold">품절 동기화</div>
              <div className="flex flex-wrap gap-4 text-[11px] text-gray-500 dark:text-gray-400">
                <span>날짜: {ss.sync_date}</span>
                <span>총변동: {ss.total_changes.toLocaleString()}건</span>
                {ss.db_result && (
                  <>
                    <span>DB갱신: {ss.db_result.ownerclan_updated}건</span>
                    <span>품절마킹: {ss.db_result.smartstore_soldout}건</span>
                    <span>품절해제: {ss.db_result.smartstore_cleared}건</span>
                    {(ss.db_result.reactivated ?? 0) > 0 && <span>재활성화: {ss.db_result.reactivated}건</span>}
                  </>
                )}
                <span>소요: {ss.elapsed}초</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, onClick, active }: { label: string; value: number; color?: string; onClick?: () => void; active?: boolean }) {
  return (
    <div className={`bg-white dark:bg-[#1e1e2e] rounded border px-3 py-2 transition-colors
      ${active ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 dark:border-[#333]'}
      ${onClick ? 'cursor-pointer hover:border-blue-400' : ''}`}
      onClick={onClick}>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${color || ''}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function DetailModal({ detail, loading, changeLog, onClose, onSync }: {
  detail: ProductDetail | null;
  loading: boolean;
  changeLog: ChangeLogItem[];
  onClose: () => void;
  onSync: (id: number) => void;
}) {
  const [tab, setTab] = useState<'changes' | 'all' | 'history'>('changes');

  if (loading || !detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-white dark:bg-[#1e1e2e] rounded-lg p-8 text-center" onClick={e => e.stopPropagation()}>
          로딩 중...
        </div>
      </div>
    );
  }

  const changed = detail.changed_fields || [];
  const allFields = Object.keys(FIELD_LABELS);
  const displayFields = tab === 'changes' ? allFields.filter(f => changed.includes(f)) : allFields;

  const isImage = (f: string) => f.startsWith('image_');
  const isHtml = (f: string) => f === 'detail_html' || f === 'notice_html';
  const isLongText = (f: string) =>
    ['market_category', 'notice_info', 'combined_option', 'keywords',
     'option1_values', 'option2_values', 'independent_option', 'combined_option_detail',
     'market_gmarket', 'market_auction', 'market_11st', 'market_coupang', 'market_smartstore',
    ].includes(f);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-[#1e1e2e] rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-[#333] shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-bold">{detail.product_code}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${SALE_STATUS_COLORS[detail.sale_status as number] || ''}`}>
              {SALE_STATUS_LABELS[detail.sale_status as number] || '?'}
            </span>
            {detail.is_synced === 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                {changed.length}개 항목 수정됨
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {detail.is_synced === 0 && (
              <button className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                onClick={() => onSync(detail.id)}>동기화</button>
            )}
            <button className="text-gray-400 hover:text-gray-600 text-lg" onClick={onClose}>&times;</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-[#333] px-4 shrink-0">
          <button className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'changes' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            onClick={() => setTab('changes')}>변경사항 ({changed.length})</button>
          <button className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'all' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            onClick={() => setTab('all')}>전체보기</button>
          <button className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'history' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            onClick={() => setTab('history')}>변경이력 ({changeLog.length})</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-4 py-3">
          {tab === 'history' ? (
            changeLog.length === 0 ? (
              <div className="text-center text-gray-400 py-8">변경 이력이 없습니다.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 dark:text-gray-400 text-left border-b border-gray-200 dark:border-gray-700">
                    <th className="px-2 py-1.5">그룹</th>
                    <th className="px-2 py-1.5">필드</th>
                    <th className="px-2 py-1.5">변경 전</th>
                    <th className="px-2 py-1.5">변경 후</th>
                    <th className="px-2 py-1.5">상태</th>
                    <th className="px-2 py-1.5">감지일시</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                  {changeLog.map(item => (
                    <tr key={item.id} className={item.is_applied ? 'opacity-50' : ''}>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          item.change_group === 'price' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                          item.change_group === 'shipping' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                          item.change_group === 'product_name' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                          item.change_group === 'detail' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                          'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                        }`}>{item.group_label}</span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400">{FIELD_LABELS[item.field_name] || item.field_name}</td>
                      <td className="px-2 py-1.5 text-red-500 max-w-[180px] truncate" title={item.old_value}>{item.old_value || '-'}</td>
                      <td className="px-2 py-1.5 text-green-600 dark:text-green-400 max-w-[180px] truncate" title={item.new_value}>{item.new_value || '-'}</td>
                      <td className="px-2 py-1.5">
                        {item.is_applied ? (
                          <span className="text-green-500">반영됨</span>
                        ) : (
                          <span className="text-orange-500 font-bold">미반영</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-400">{item.detected_at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : displayFields.length === 0 ? (
            <div className="text-center text-gray-400 py-8">변경된 항목이 없습니다.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 dark:text-gray-400 text-left">
                  <th className="px-2 py-1.5 w-32">항목</th>
                  <th className="px-2 py-1.5">원본값</th>
                  <th className="px-2 py-1.5">현재값</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {displayFields.map(f => {
                  const origVal = detail[`orig_${f}`];
                  const curVal = detail[f];
                  const isChanged = changed.includes(f);
                  return (
                    <tr key={f} className={isChanged ? 'bg-orange-50 dark:bg-orange-900/10' : ''}>
                      <td className="px-2 py-1.5 font-medium text-gray-600 dark:text-gray-300 align-top">
                        {FIELD_LABELS[f] || f}
                        {isChanged && <span className="ml-1 text-orange-500">*</span>}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <FieldValue value={origVal} field={f} isImage={isImage(f)} isHtml={isHtml(f)} isLong={isLongText(f)} />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <FieldValue value={curVal} field={f} isImage={isImage(f)} isHtml={isHtml(f)} isLong={isLongText(f)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportProgressBar({ pct, label, status }: { pct: number; label: string; status: 'loading' | 'done' | 'error' }) {
  const isIndeterminate = pct < 0;
  const barColor = status === 'error' ? 'bg-red-500' : status === 'done' ? 'bg-green-500' : 'bg-blue-500';
  return (
    <div className="bg-white dark:bg-[#1e1e2e] rounded border border-gray-200 dark:border-[#333] p-3 space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-300 font-medium">{label}</span>
        <span className="text-gray-400">
          {status === 'done' ? '완료' : status === 'error' ? '실패' : isIndeterminate ? '처리 중...' : `${pct}%`}
        </span>
      </div>
      <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        {isIndeterminate && status === 'loading' ? (
          <div className={`h-full ${barColor} rounded-full`}
            style={{ width: '40%', animation: 'exportIndeterminate 1.5s ease-in-out infinite' }} />
        ) : (
          <div className={`h-full ${barColor} rounded-full transition-all duration-300 ease-out`}
            style={{ width: `${Math.min(pct, 100)}%` }} />
        )}
      </div>
      <style>{`
        @keyframes exportIndeterminate {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}

function FieldValue({ value, isImage, isHtml, isLong }: {
  value: unknown; field: string; isImage: boolean; isHtml: boolean; isLong: boolean;
}) {
  const s = value == null ? '' : String(value);
  if (!s) return <span className="text-gray-300">-</span>;

  if (isImage) {
    return (
      <div>
        <img src={s} alt="" className="w-16 h-16 object-cover rounded border border-gray-200 dark:border-gray-600" loading="lazy" />
        <div className="text-[9px] text-gray-400 mt-0.5 break-all max-w-[200px]">{s.slice(0, 60)}...</div>
      </div>
    );
  }

  if (isHtml) {
    return (
      <details className="cursor-pointer">
        <summary className="text-blue-500 text-[10px]">HTML ({s.length.toLocaleString()}자) 펼치기</summary>
        <div className="mt-1 max-h-40 overflow-auto bg-gray-50 dark:bg-[#0f0f1a] rounded p-1 text-[10px] break-all whitespace-pre-wrap">
          {s.slice(0, 2000)}{s.length > 2000 ? '...' : ''}
        </div>
      </details>
    );
  }

  if (isLong || s.length > 100) {
    return (
      <div className="max-h-20 overflow-auto whitespace-pre-wrap break-all text-[11px]">{s}</div>
    );
  }

  if (typeof value === 'number') {
    return <span>{(value as number).toLocaleString()}</span>;
  }

  return <span className="break-all">{s}</span>;
}

function HoverImage({ src, thumb }: { src: string; thumb: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (!thumb) {
    return (
      <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded flex items-center justify-center text-gray-400 text-[10px]">N/A</div>
    );
  }

  return (
    <div
      className="relative inline-block"
      onMouseEnter={(e) => { setPos({ x: e.clientX, y: e.clientY }); setShow(true); }}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setShow(false)}
    >
      <img src={thumb} alt="" className="w-10 h-10 object-cover rounded border border-gray-200 dark:border-gray-600" loading="lazy" />
      {show && src && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: pos.x + 16, top: Math.min(pos.y - 100, window.innerHeight - 340) }}
        >
          <img src={src} alt="" className="w-72 h-72 object-contain rounded-lg shadow-2xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#1e1e2e]" />
        </div>
      )}
    </div>
  );
}
