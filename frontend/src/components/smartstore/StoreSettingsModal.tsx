import { useState, useEffect, useCallback, useRef } from 'react';
import type { SmartStore } from '../../api/smartstoreApi';
import { fetchStores, createStore, updateStore, deleteStore, getStoreSampleExcelUrl, uploadStoresExcel } from '../../api/smartstoreApi';
import { fetchAllStoresStats, syncProducts, type ProductStats } from '../../api/smartstoreProductApi';

interface Props {
  onClose: () => void;
}

const EMPTY_FORM = {
  store_id: '',
  store_pw: '',
  store_name: '',
  store_url: '',
  commerce_api_key: '',
  commerce_secret_key: '',
  memo: '',
};

export default function StoreSettingsModal({ onClose }: Props) {
  const [stores, setStores] = useState<SmartStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [allStats, setAllStats] = useState<Record<number, ProductStats>>({});
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchStores(true);
      setStores(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const stats = await fetchAllStoresStats();
      setAllStats(stats);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); loadStats(); }, [load, loadStats]);

  const handleSubmit = async () => {
    setError('');
    if (!form.store_id || !form.store_name || (!editId && !form.store_pw)) {
      setError(editId ? '스토어 ID, 상점명은 필수입니다.' : '스토어 ID, 비밀번호, 상점명은 필수입니다.');
      return;
    }
    try {
      if (editId) {
        const payload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(form)) {
          if (k === 'store_pw' && !v) continue;
          payload[k] = v || null;
        }
        if (form.store_id) payload.store_id = form.store_id;
        if (form.store_name) payload.store_name = form.store_name;
        if (form.store_pw) payload.store_pw = form.store_pw;
        await updateStore(editId, payload);
      } else {
        await createStore({
          store_id: form.store_id,
          store_pw: form.store_pw,
          store_name: form.store_name,
          store_url: form.store_url || undefined,
          commerce_api_key: form.commerce_api_key || undefined,
          commerce_secret_key: form.commerce_secret_key || undefined,
          memo: form.memo || undefined,
        });
      }
      setShowForm(false);
      setEditId(null);
      setForm(EMPTY_FORM);
      load();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err.response?.data?.error || '저장 실패');
    }
  };

  const handleEdit = (s: SmartStore) => {
    setForm({
      store_id: s.store_id,
      store_pw: '',
      store_name: s.store_name,
      store_url: s.store_url || '',
      commerce_api_key: s.commerce_api_key || '',
      commerce_secret_key: s.commerce_secret_key || '',
      memo: s.memo || '',
    });
    setEditId(s.id);
    setShowForm(true);
    setError('');
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteStore(deleteConfirm.id);
    setDeleteConfirm(null);
    load();
  };

  const handleSync = async (storeId: number) => {
    setSyncingId(storeId);
    try {
      await syncProducts(storeId);
      loadStats();
    } catch { /* ignore */ }
    setSyncingId(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    setUploadResult(null);
    try {
      const result = await uploadStoresExcel(file);
      setUploadResult(result);
      if (result.created > 0 || result.updated > 0) load();
    } catch (err: unknown) {
      const ex = err as { response?: { data?: { error?: string } } };
      setUploadResult({ created: 0, updated: 0, skipped: 0, errors: [ex.response?.data?.error || '업로드 실패'] });
    } finally {
      setUploading(false);
    }
  };

  const handleGoToProducts = (storeId: number) => {
    window.location.hash = `#smartstore-products?store_id=${storeId}`;
    window.location.reload();
  };

  // API키가 있는 활성 상점만 셀렉트에 표시
  const apiStores = stores.filter(s => s.is_active && s.commerce_api_key);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-200">
            스마트스토어 상점 관리
          </h2>
          <button
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* 상점 바로가기 셀렉트 */}
          {apiStores.length > 0 && (
            <div className="mb-3 flex items-center gap-2">
              <label className="text-xs text-gray-500 whitespace-nowrap">상품관리 이동:</label>
              <select
                className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) handleGoToProducts(Number(e.target.value));
                }}
              >
                <option value="">상점 선택...</option>
                {apiStores.map(s => {
                  const st = allStats[s.id];
                  const label = st
                    ? `${s.store_name} (${st.total.toLocaleString()}개)`
                    : s.store_name;
                  return <option key={s.id} value={s.id}>{label}</option>;
                })}
              </select>
            </div>
          )}

          {/* Add / Upload buttons */}
          <div className="flex justify-end gap-2 mb-3">
            <button
              className="text-xs px-3 py-1.5 bg-[#03c75a] text-white rounded hover:bg-[#02b351] font-medium"
              onClick={() => {
                setShowForm(!showForm);
                setEditId(null);
                setForm(EMPTY_FORM);
                setError('');
                setUploadResult(null);
              }}
            >
              + 상점 추가
            </button>
            <button
              className="text-xs px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 font-medium"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? '업로드 중...' : '엑셀로 올리기'}
            </button>
            <a
              href={getStoreSampleExcelUrl()}
              download
              className="text-xs px-3 py-1.5 bg-gray-500 text-white rounded hover:bg-gray-600 font-medium inline-flex items-center"
            >
              엑셀 내보내기
            </a>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>

          {/* Upload result */}
          {uploadResult && (
            <div className={`mb-3 p-2.5 rounded border text-xs ${
              uploadResult.errors.length > 0
                ? 'bg-yellow-50 border-yellow-300 dark:bg-yellow-900/20 dark:border-yellow-700'
                : 'bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-700'
            }`}>
              <div className="font-medium">
                {uploadResult.created}건 추가
                {uploadResult.updated > 0 && `, ${uploadResult.updated}건 업데이트`}
                {uploadResult.skipped > 0 && `, ${uploadResult.skipped}건 중복 건너뜀`}
              </div>
              {uploadResult.errors.length > 0 && (
                <ul className="mt-1 text-red-600 dark:text-red-400 space-y-0.5">
                  {uploadResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              <button
                className="mt-1 text-gray-500 hover:text-gray-700 underline"
                onClick={() => setUploadResult(null)}
              >
                닫기
              </button>
            </div>
          )}

          {/* Form */}
          {showForm && (
            <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 text-xs space-y-2">
              {error && (
                <div className="text-red-500 text-xs font-medium">{error}</div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder="스토어 ID *"
                  value={form.store_id}
                  onChange={(e) => setForm({ ...form, store_id: e.target.value })}
                />
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder={editId ? '비밀번호 (변경시 입력)' : '비밀번호 *'}
                  type="password"
                  value={form.store_pw}
                  onChange={(e) => setForm({ ...form, store_pw: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder="상점명 *"
                  value={form.store_name}
                  onChange={(e) => setForm({ ...form, store_name: e.target.value })}
                />
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder="스토어 주소 (예: joysping1)"
                  value={form.store_url}
                  onChange={(e) => setForm({ ...form, store_url: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder="애플리케이션 ID"
                  value={form.commerce_api_key}
                  onChange={(e) => setForm({ ...form, commerce_api_key: e.target.value })}
                />
                <input
                  className="px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                  placeholder="애플리케이션 시크릿"
                  value={form.commerce_secret_key}
                  onChange={(e) => setForm({ ...form, commerce_secret_key: e.target.value })}
                />
              </div>
              <input
                className="w-full px-2 py-1.5 border rounded dark:bg-gray-700 dark:border-gray-600"
                placeholder="메모"
                value={form.memo}
                onChange={(e) => setForm({ ...form, memo: e.target.value })}
              />
              <div className="flex gap-2 pt-1">
                <button
                  className="px-3 py-1.5 bg-[#03c75a] text-white rounded hover:bg-[#02b351] font-medium"
                  onClick={handleSubmit}
                >
                  {editId ? '수정' : '저장'}
                </button>
                <button
                  className="px-3 py-1.5 bg-gray-400 text-white rounded hover:bg-gray-500"
                  onClick={() => { setShowForm(false); setEditId(null); setError(''); }}
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {/* Store list */}
          {loading ? (
            <div className="text-center text-sm text-gray-400 py-8">로딩 중...</div>
          ) : stores.length === 0 ? (
            <div className="text-center text-sm text-gray-400 py-8">등록된 상점이 없습니다.</div>
          ) : (
            <div className="space-y-1.5">
              {stores.map((s) => {
                const st = allStats[s.id];
                const isSyncing = syncingId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`px-3 py-2 rounded border text-xs ${
                      s.is_active
                        ? 'border-gray-200 dark:border-gray-700'
                        : 'border-gray-200 bg-gray-100 dark:bg-gray-800 dark:border-gray-700 opacity-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`font-bold text-[13px] ${s.commerce_api_key ? 'cursor-pointer hover:text-[#03c75a]' : ''}`}
                            onClick={() => s.commerce_api_key && handleGoToProducts(s.id)}
                          >
                            {s.store_name}
                          </span>
                          <span className="text-gray-500">{s.store_id}</span>
                          {s.store_url && <span className="text-green-600 dark:text-green-400 text-[10px]">/{s.store_url}</span>}
                          {!s.is_active && (
                            <span className="text-red-400 text-[10px] font-bold">비활성</span>
                          )}
                        </div>
                        {/* 상품 통계 */}
                        {s.commerce_api_key && st && (
                          <div className="flex items-center gap-2 mt-1 text-[10px] flex-wrap">
                            <span className="text-gray-500">전체 <b className="text-gray-700 dark:text-gray-300">{st.total.toLocaleString()}</b></span>
                            <span className="text-green-600">판매중 <b>{(st.by_status['SALE'] || 0).toLocaleString()}</b></span>
                            <span className="text-yellow-600">중지 <b>{(st.by_status['SUSPENSION'] || 0).toLocaleString()}</b></span>
                            <span className="text-gray-400">기타 <b>{(st.total - (st.by_status['SALE'] || 0) - (st.by_status['SUSPENSION'] || 0)).toLocaleString()}</b></span>
                            {st.last_synced_at && (
                              <span className="text-gray-400" title={st.last_synced_at}>
                                {new Date(st.last_synced_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                        )}
                        {s.commerce_api_key && !st && (
                          <div className="text-[10px] text-gray-400 mt-1">미동기화</div>
                        )}
                        {!s.commerce_api_key && (
                          <div className="text-[10px] text-gray-400 mt-0.5 truncate">
                            앱ID 미등록
                            {s.memo && <span className="ml-2">| {s.memo}</span>}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 ml-2 shrink-0">
                        {s.commerce_api_key && (
                          <button
                            className={`w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 hover:text-[#03c75a] ${isSyncing ? 'animate-spin' : ''}`}
                            onClick={() => !isSyncing && handleSync(s.id)}
                            disabled={isSyncing}
                            title="동기화"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 2v6h-6"/>
                              <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                              <path d="M3 22v-6h6"/>
                              <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                            </svg>
                          </button>
                        )}
                        {s.commerce_api_key && (
                          <button
                            className="text-[10px] px-2 py-0.5 bg-[#03c75a] text-white rounded hover:bg-[#02b351] font-medium"
                            onClick={() => handleGoToProducts(s.id)}
                            title="상품관리"
                          >
                            상품
                          </button>
                        )}
                        <button
                          className="text-blue-500 hover:text-blue-700"
                          onClick={() => handleEdit(s)}
                          title="수정"
                        >
                          &#9998;
                        </button>
                        <button
                          className="text-red-400 hover:text-red-600"
                          onClick={() => setDeleteConfirm({ id: s.id, name: s.store_name })}
                          title="삭제"
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm dialog */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-bold text-red-600 mb-2">삭제 확인</div>
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
              <strong>{deleteConfirm.name}</strong> 상점을{' '}
              {stores.find(s => s.id === deleteConfirm.id)?.is_active
                ? '비활성화하시겠습니까?'
                : '완전히 삭제하시겠습니까? (복구 불가)'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
                onClick={() => setDeleteConfirm(null)}
              >
                취소
              </button>
              <button
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                onClick={handleDelete}
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
