import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchProductFullDetail,
  updateProduct,
  uploadProductImage,
  type ProductFullDetail,
} from '../api/smartstoreProductApi';

const STATUS_LABELS: Record<string, string> = {
  SALE: '판매중', SUSPENSION: '판매중지', CLOSE: '판매종료',
  PROHIBITION: '판매금지', WAIT: '대기',
};
const STATUS_COLORS: Record<string, string> = {
  SALE: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  SUSPENSION: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  CLOSE: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  PROHIBITION: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};
const TAX_LABELS: Record<string, string> = { TAX: '과세', DUTYFREE: '면세', SMALL: '영세' };

type Tab = 'basic' | 'detail' | 'image';

/* ── HTML 포맷터: 태그별 줄바꿈 + 들여쓰기 ── */
const SELF_CLOSING = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

function formatHtml(raw: string): string {
  if (!raw || !raw.trim()) return raw;
  // 태그 사이 공백 정리 후 태그 단위로 줄바꿈
  let s = raw.replace(/>\s*</g, '>\n<');
  const lines = s.split('\n');
  let indent = 0;
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 닫는 태그로 시작
    const isClosing = /^<\//.test(trimmed);
    // 여는 태그인지 (self-closing 제외)
    const openMatch = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
    const tagName = openMatch ? openMatch[1].toLowerCase() : '';
    const isSelfClose = SELF_CLOSING.has(tagName) || /\/>$/.test(trimmed);

    if (isClosing) indent = Math.max(0, indent - 1);
    result.push('  '.repeat(indent) + trimmed);
    if (openMatch && !isClosing && !isSelfClose) indent++;
  }
  return result.join('\n');
}

/* ── 포맷된 HTML → 원본 복원 (불필요 공백 제거) ── */
function minifyHtml(formatted: string): string {
  // 편집된 포맷 HTML을 다시 한 줄로 합침 (태그 사이 줄바꿈만 제거)
  return formatted.replace(/\n\s*/g, '').replace(/>\s+</g, '><');
}

export default function ProductEditPage() {
  const { dark } = useTheme();

  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const opno = Number(params.get('opno'));
  const storeId = Number(params.get('store_id'));

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<ProductFullDetail | null>(null);

  // 편집 상태
  const [editName, setEditName] = useState('');
  const [editHtml, setEditHtml] = useState('');       // 포맷된 HTML (에디터용)
  const [origMinified, setOrigMinified] = useState(''); // 원본 minified (변경비교용)
  const [editImageUrl, setEditImageUrl] = useState('');
  const [newImageFile, setNewImageFile] = useState<File | null>(null);
  const [newImagePreview, setNewImagePreview] = useState('');

  const [activeTab, setActiveTab] = useState<Tab>('basic');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 로드
  useEffect(() => {
    if (!opno || !storeId) { setError('잘못된 접근입니다.'); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchProductFullDetail(opno, storeId);
        if (cancelled) return;
        setDetail(d);
        setEditName(d.name);
        const raw = d.detail_content || '';
        setOrigMinified(raw.replace(/\n\s*/g, '').replace(/>\s+</g, '><'));
        setEditHtml(formatHtml(raw));
        setEditImageUrl(d.representative_image?.url || '');
      } catch (e: any) {
        if (!cancelled) setError(e?.response?.data?.error || '상품 정보 로드 실패');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [opno, storeId]);

  // 변경 감지
  useEffect(() => {
    if (!detail) return;
    const nameChanged = editName !== detail.name;
    const htmlChanged = minifyHtml(editHtml) !== origMinified;
    const imgChanged = editImageUrl !== (detail.representative_image?.url || '');
    setHasChanges(nameChanged || htmlChanged || imgChanged);
  }, [editName, editHtml, editImageUrl, detail, origMinified]);

  // 미리보기용 HTML (포맷된 걸 다시 합침)
  const previewHtml = useMemo(() => {
    // 줄바꿈/들여쓰기 제거하면 원본과 동일하게 렌더링
    return editHtml.replace(/\n\s*/g, '');
  }, [editHtml]);

  // 저장
  const handleSave = useCallback(async () => {
    if (!detail || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const updates: Record<string, any> = {};
      if (editName !== detail.name) updates.name = editName;
      const currentMinified = minifyHtml(editHtml);
      if (currentMinified !== origMinified) updates.detailContent = currentMinified;
      if (editImageUrl !== (detail.representative_image?.url || ''))
        updates.representativeImage = { url: editImageUrl };
      if (Object.keys(updates).length === 0) {
        setSaveMsg({ ok: false, text: '변경사항이 없습니다.' });
        return;
      }
      await updateProduct(opno, storeId, updates);
      setSaveMsg({ ok: true, text: '저장 완료' });
      setHasChanges(false);
      setOrigMinified(currentMinified);
      setDetail(prev => prev ? {
        ...prev,
        name: editName,
        detail_content: currentMinified,
        representative_image: editImageUrl ? { url: editImageUrl } : prev.representative_image,
      } : prev);
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e?.response?.data?.error || '저장 실패' });
    } finally {
      setSaving(false);
    }
  }, [detail, editName, editHtml, editImageUrl, origMinified, opno, storeId, saving]);

  // 이미지 업로드
  const handleImageUpload = useCallback(async () => {
    if (!newImageFile || uploading) return;
    setUploading(true);
    setUploadPct(0);
    try {
      const res = await uploadProductImage(storeId, newImageFile, setUploadPct);
      setEditImageUrl(res.url);
      setNewImageFile(null);
      setNewImagePreview('');
    } catch (e: any) {
      alert(e?.response?.data?.error || '이미지 업로드 실패');
    } finally {
      setUploading(false);
    }
  }, [newImageFile, storeId, uploading]);

  const handleFileSelect = (file: File) => {
    if (file.size > 10 * 1024 * 1024) { alert('10MB 이하 이미지만 업로드 가능합니다.'); return; }
    setNewImageFile(file);
    setNewImagePreview(URL.createObjectURL(file));
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (hasChanges) e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasChanges]);

  const cardCls = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const borderCls = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const textCls = dark ? 'text-white' : 'text-gray-900';
  const subTextCls = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = `w-full px-3 py-2 rounded-lg border ${borderCls} ${cardCls} ${textCls} focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50`;

  if (loading) return (
    <div className={`min-h-screen flex items-center justify-center ${dark ? 'bg-[#0f0f1a] text-white' : 'bg-[#f7f8fa] text-gray-900'}`}>
      <div className="animate-pulse text-lg">상품 정보 로딩중...</div>
    </div>
  );
  if (error) return (
    <div className={`min-h-screen flex flex-col items-center justify-center gap-4 ${dark ? 'bg-[#0f0f1a] text-white' : 'bg-[#f7f8fa] text-gray-900'}`}>
      <div className="text-red-500 text-lg">{error}</div>
      <a href="#products" className="text-[#03c75a] hover:underline text-sm">상품 목록으로 돌아가기</a>
    </div>
  );
  if (!detail) return null;

  const di = detail.delivery_info || {};
  const fee = di.deliveryFee || {};
  const tabs: { key: Tab; label: string }[] = [
    { key: 'basic', label: '기본정보' },
    { key: 'detail', label: '상세페이지' },
    { key: 'image', label: '이미지' },
  ];

  // 상세페이지 탭은 전체화면
  const isFullWidth = activeTab === 'detail';

  return (
    <div className={`min-h-screen flex flex-col ${dark ? 'bg-[#0f0f1a] text-white' : 'bg-[#f7f8fa] text-gray-900'}`}>
      {/* ── 헤더: 한 줄, 상품정보 + 탭 + 저장 ── */}
      <div className={`sticky top-0 z-30 ${cardCls} border-b ${borderCls} shrink-0`}>
        <div className="flex items-center h-11 px-3 gap-2">
          {/* 좌: 뒤로 + 상품정보 */}
          <a href="#products" className={`${subTextCls} hover:${textCls} text-xs shrink-0`}>&larr; 목록</a>
          <span className="font-mono text-xs font-bold shrink-0">#{opno}</span>
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0 ${STATUS_COLORS[detail.status_type] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
            {STATUS_LABELS[detail.status_type] || detail.status_type}
          </span>
          <span className={`text-[11px] ${subTextCls} shrink-0`}>{detail.store_name}</span>
          <span className={`text-[11px] truncate max-w-[200px] ${subTextCls}`} title={editName}>{editName}</span>
          <span className={`text-[11px] ${subTextCls} shrink-0`}>{detail.sale_price?.toLocaleString()}원</span>

          {/* 구분선 */}
          <div className={`w-px h-5 ${dark ? 'bg-[#2a2a40]' : 'bg-gray-200'} mx-1 shrink-0`} />

          {/* 탭 */}
          <div className="flex gap-0.5 shrink-0">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  activeTab === t.key
                    ? 'bg-[#03c75a] text-white'
                    : `${subTextCls} hover:${dark ? 'bg-[#2a2a40]' : 'bg-gray-100'}`
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 우측 spacer + 상태 + 저장 */}
          <div className="flex-1" />
          {hasChanges && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 font-medium shrink-0">
              수정됨
            </span>
          )}
          {saveMsg && (
            <span className={`text-[11px] font-medium shrink-0 ${saveMsg.ok ? 'text-green-500' : 'text-red-500'}`}>
              {saveMsg.text}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="px-4 py-1.5 text-xs font-medium bg-[#03c75a] text-white rounded hover:bg-[#02b351] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {saving ? '저장중...' : '저장'}
          </button>
        </div>
      </div>

      {/* ── 탭 콘텐츠 ── */}
      <div className={`flex-1 flex flex-col min-h-0 ${isFullWidth ? '' : 'max-w-5xl mx-auto w-full px-4 py-4'}`}>

        {/* ── 기본정보 탭 ── */}
        {activeTab === 'basic' && (
          <div className={`${cardCls} rounded-xl border ${borderCls} p-5`}>
            <div className="space-y-4">
              <div>
                <label className={`block text-xs font-medium ${subTextCls} mb-1`}>상품명</label>
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className={inputCls}
                  maxLength={500}
                />
                <div className={`text-[10px] ${subTextCls} mt-0.5 text-right`}>{editName.length}/500</div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <InfoRow label="카테고리 ID" value={detail.leaf_category_id || '-'} />
                <InfoRow label="판매유형" value={detail.sale_type || '-'} />
                <InfoRow label="과세유형" value={TAX_LABELS[detail.tax_type] || detail.tax_type || '-'} />
                <InfoRow label="원산지" value={detail.origin_area?.content || '-'} sub={detail.origin_area?.originAreaCode} />
                <InfoRow label="A/S 전화번호" value={detail.after_service?.tel || '-'} />
                <InfoRow label="A/S 안내" value={detail.after_service?.guide || '-'} />
                <InfoRow label="배송유형" value={di.deliveryAttributeType || di.deliveryType || '-'} />
                <InfoRow label="배송비" value={fee.baseFee != null ? `${fee.baseFee?.toLocaleString()}원 (${fee.deliveryFeeType || ''})` : '-'} />
              </div>
              {detail.seller_tags && detail.seller_tags.length > 0 && (
                <div>
                  <label className={`block text-xs font-medium ${subTextCls} mb-1`}>판매자 태그</label>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.seller_tags.map((t, i) => (
                      <span key={i} className={`px-2 py-0.5 rounded-full text-[11px] border ${borderCls} ${subTextCls}`}>
                        {t.text || String(t)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detail.option_info?.optionCombinations && detail.option_info.optionCombinations.length > 0 && (
                <div>
                  <label className={`block text-xs font-medium ${subTextCls} mb-1`}>
                    옵션 ({detail.option_info.optionCombinations.length}개)
                  </label>
                  <div className={`max-h-48 overflow-y-auto rounded-lg border ${borderCls} text-xs`}>
                    <table className="w-full">
                      <thead>
                        <tr className={`${dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'} ${subTextCls} sticky top-0`}>
                          <th className="text-left px-2 py-1.5">옵션명</th>
                          <th className="text-right px-2 py-1.5">추가금</th>
                          <th className="text-right px-2 py-1.5">재고</th>
                        </tr>
                      </thead>
                      <tbody className={`divide-y ${dark ? 'divide-[#2a2a40]' : 'divide-gray-100'}`}>
                        {detail.option_info.optionCombinations.map((opt: any, i: number) => (
                          <tr key={i}>
                            <td className="px-2 py-1.5">{opt.optionName1}{opt.optionName2 ? ` / ${opt.optionName2}` : ''}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{opt.price?.toLocaleString()}</td>
                            <td className="text-right px-2 py-1.5 tabular-nums">{opt.stockQuantity?.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 상세페이지 탭: 전체화면 좌우 분할 ── */}
        {activeTab === 'detail' && (
          <div className="flex-1 flex min-h-0">
            {/* 좌: HTML 코드 에디터 */}
            <div className="w-1/2 flex flex-col min-h-0 border-r border-gray-200 dark:border-[#2a2a40]">
              <div className={`flex items-center justify-between px-3 py-1.5 ${dark ? 'bg-[#161625]' : 'bg-gray-50'} border-b ${borderCls} shrink-0`}>
                <span className={`text-[11px] font-medium ${subTextCls}`}>HTML 코드</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditHtml(formatHtml(editHtml))}
                    className={`text-[10px] px-2 py-0.5 rounded ${dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#3a3a50]' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'} transition-colors`}
                    title="코드 정리"
                  >
                    정리
                  </button>
                  <span className={`text-[10px] tabular-nums ${subTextCls}`}>{editHtml.length.toLocaleString()}자</span>
                </div>
              </div>
              <textarea
                value={editHtml}
                onChange={e => setEditHtml(e.target.value)}
                className={`flex-1 font-mono text-[12px] leading-5 p-3 ${cardCls} ${textCls} resize-none focus:outline-none min-h-0`}
                spellCheck={false}
                wrap="off"
              />
            </div>
            {/* 우: 미리보기 */}
            <div className="w-1/2 flex flex-col min-h-0">
              <div className={`flex items-center px-3 py-1.5 ${dark ? 'bg-[#161625]' : 'bg-gray-50'} border-b ${borderCls} shrink-0`}>
                <span className={`text-[11px] font-medium ${subTextCls}`}>미리보기</span>
              </div>
              <iframe
                srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:8px;font-family:-apple-system,sans-serif;font-size:14px}img{max-width:100%;height:auto}</style></head><body>${previewHtml}</body></html>`}
                className="flex-1 bg-white min-h-0"
                sandbox="allow-same-origin"
                title="상세페이지 미리보기"
              />
            </div>
          </div>
        )}

        {/* ── 이미지 탭 ── */}
        {activeTab === 'image' && (
          <div className={`${cardCls} rounded-xl border ${borderCls} p-5`}>
            <div className="space-y-5">
              <div>
                <label className={`block text-xs font-medium ${subTextCls} mb-2`}>현재 대표이미지</label>
                {editImageUrl ? (
                  <img src={editImageUrl} alt="" className="max-h-72 rounded-lg border border-gray-200 dark:border-gray-600" />
                ) : (
                  <div className={`text-sm ${subTextCls}`}>이미지 없음</div>
                )}
              </div>
              <div>
                <label className={`block text-xs font-medium ${subTextCls} mb-2`}>새 이미지 업로드</label>
                <div
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
                  onDragOver={e => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${borderCls} hover:border-[#03c75a]`}
                >
                  {newImagePreview ? (
                    <img src={newImagePreview} alt="미리보기" className="max-h-48 mx-auto rounded-lg" />
                  ) : (
                    <div className={subTextCls}>
                      <div className="text-2xl mb-2">+</div>
                      <div className="text-sm">이미지를 드래그하거나 클릭하여 선택</div>
                      <div className="text-[10px] mt-1">JPG, PNG (최대 10MB)</div>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
                />
                {newImageFile && (
                  <div className="mt-3 flex items-center gap-3">
                    <span className={`text-xs ${subTextCls}`}>{newImageFile.name} ({(newImageFile.size / 1024).toFixed(0)}KB)</span>
                    <button
                      onClick={handleImageUpload}
                      disabled={uploading}
                      className="px-4 py-2 text-sm font-medium bg-[#03c75a] text-white rounded-lg hover:bg-[#02b351] disabled:opacity-50 transition-colors"
                    >
                      {uploading ? `업로드 중... ${uploadPct}%` : 'CDN에 업로드'}
                    </button>
                    <button
                      onClick={() => { setNewImageFile(null); setNewImagePreview(''); }}
                      className={`text-xs ${subTextCls} hover:text-red-500`}
                    >
                      취소
                    </button>
                  </div>
                )}
              </div>
              {detail.optional_images && detail.optional_images.length > 0 && (
                <div>
                  <label className={`block text-xs font-medium ${subTextCls} mb-2`}>
                    추가 이미지 ({detail.optional_images.length}개)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {detail.optional_images.map((img, i) => (
                      <img key={i} src={img.url} alt="" className="w-24 h-24 object-contain rounded-lg border border-gray-200 dark:border-gray-600" />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5">{label}</div>
      <div className="text-xs">{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
