import { useState, useEffect } from 'react';
import { productAttrs, productContext, type ProductAttrItem, type ProductContext } from '../api/missingAttrsApi';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: '미처리', cls: 'bg-gray-400/20 text-gray-400' },
  classified: { label: '추론완료', cls: 'bg-indigo-500/20 text-indigo-400' },
  registered: { label: '적용완료', cls: 'bg-[#03c75a]/20 text-[#03c75a]' },
  needs_manual: { label: '수동', cls: 'bg-amber-500/20 text-amber-500' },
  fail: { label: '실패', cls: 'bg-red-500/20 text-red-400' },
};

/** 상품 속성 추론/적용 현황 + 실물(상품명/대표썸네일/상세페이지) 대조 모달.
 * 좌측: 상품명·카테고리·대표썸네일·상세이미지·상세텍스트 / 우측: 속성표. */
export function ProductAttrModal({ sellerCode, storeId, onClose }: { sellerCode: string; storeId: number; onClose: () => void }) {
  const [attrs, setAttrs] = useState<ProductAttrItem[] | null>(null);
  const [ctx, setCtx] = useState<ProductContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    setLoading(true); setCtxLoading(true);
    setAttrs(null); setCtx(null); setShowText(false);
    productAttrs(sellerCode, storeId || undefined)
      .then(d => setAttrs(d.attributes || []))
      .catch(() => setAttrs([]))
      .finally(() => setLoading(false));
    productContext(sellerCode, storeId || undefined)
      .then(d => setCtx(d))
      .catch(() => setCtx({ ok: false, seller_code: sellerCode, store_id: storeId, error: '조회 실패' }))
      .finally(() => setCtxLoading(false));
  }, [sellerCode, storeId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-6xl max-h-[90vh] flex flex-col rounded-xl bg-white dark:bg-[#1c1c2e] border border-gray-200 dark:border-[#2a2a40] shadow-2xl"
           onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="px-5 py-3 flex items-center gap-2 border-b border-gray-200 dark:border-[#2a2a40] shrink-0">
          <span className="text-[14px] font-bold text-gray-800 dark:text-gray-100">🔧 상품 속성 검증</span>
          <span className="font-mono text-[12px] text-indigo-500 dark:text-indigo-400">{sellerCode}</span>
          <button onClick={onClose} className="ml-auto text-[22px] leading-none text-gray-500 hover:text-gray-900 dark:hover:text-white">×</button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 좌측: 실물(상품명/썸네일/상세) */}
          <div className="w-[45%] overflow-auto border-r border-gray-200 dark:border-[#2a2a40] p-4 space-y-3">
            {ctxLoading && <div className="py-8 text-center text-[12px] text-gray-400">상품 조회중…</div>}
            {!ctxLoading && ctx && !ctx.ok && (
              <div className="py-8 text-center text-[12px] text-red-400">상품 정보를 불러올 수 없습니다.<br />{ctx.error}</div>
            )}
            {!ctxLoading && ctx && ctx.ok && (
              <>
                <div className="text-[14px] font-bold text-gray-900 dark:text-gray-100 leading-snug break-words">{ctx.name || '—'}</div>
                {ctx.category_name && <div className="text-[11px] text-gray-500 dark:text-gray-400">{ctx.category_name}</div>}
                {ctx.representative_image && (
                  <a href={ctx.representative_image} target="_blank" rel="noreferrer" className="block">
                    <img src={ctx.representative_image} alt="대표 썸네일" loading="lazy"
                         className="mx-auto max-h-72 object-contain rounded-lg border border-gray-200 dark:border-[#2a2a40] bg-white" />
                  </a>
                )}
                {!!(ctx.detail_images && ctx.detail_images.length) && (
                  <div className="space-y-2">
                    <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-300 pt-1">상세페이지 ({ctx.detail_images.length})</div>
                    {ctx.detail_images.map((u, i) => (
                      <img key={i} src={u} alt={`상세 ${i + 1}`} loading="lazy"
                           className="w-full rounded border border-gray-100 dark:border-gray-800 bg-white" />
                    ))}
                  </div>
                )}
                {ctx.detail_text && (
                  <div className="pt-1">
                    <button onClick={() => setShowText(s => !s)}
                            className="text-[12px] text-indigo-500 dark:text-indigo-400 hover:underline">
                      {showText ? '▲ 상세 텍스트 숨기기' : '▼ 상세 텍스트 보기'}
                    </button>
                    {showText && (
                      <div className="mt-1.5 text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap break-words max-h-60 overflow-auto rounded bg-gray-50 dark:bg-[#252540] p-2 border border-gray-100 dark:border-gray-800">
                        {ctx.detail_text}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 우측: 속성표 */}
          <div className="flex-1 overflow-auto min-w-0">
            {loading && <div className="px-4 py-8 text-center text-[12px] text-gray-400">조회중…</div>}
            {!loading && attrs && (
              <table className="w-full text-[12px]">
                <thead className="text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-[#1c1c2e]">
                  <tr className="text-left border-b border-gray-200 dark:border-[#2a2a40]">
                    <th className="px-4 py-2 w-[34%]">속성</th>
                    <th className="px-4 py-2 w-[90px]">상태</th>
                    <th className="px-4 py-2">추론값 / 적용값</th>
                    <th className="px-4 py-2 w-[70px] text-right">후보수</th>
                  </tr>
                </thead>
                <tbody>
                  {attrs.map((a, i) => {
                    const b = STATUS_BADGE[a.status] || { label: a.status, cls: 'bg-gray-400/20 text-gray-400' };
                    const val = a.registered_value_text || a.recommended_value_text;
                    return (
                      <tr key={i} className="border-t border-gray-100 dark:border-gray-800 text-gray-800 dark:text-gray-100">
                        <td className="px-4 py-1.5">{a.attribute_name}
                          <span className="ml-1 text-[10px] text-gray-400">{a.classification_type === 'MULTI_SELECT' ? '多' : ''}</span>
                        </td>
                        <td className="px-4 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${b.cls}`}>{b.label}</span></td>
                        <td className="px-4 py-1.5">{val ? <span className="font-semibold">{val}</span> : <span className="text-gray-400">—</span>}</td>
                        <td className="px-4 py-1.5 text-right text-gray-400">{a.candidate_values.length || '—'}</td>
                      </tr>
                    );
                  })}
                  {!attrs.length && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">빈 속성 없음</td></tr>}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
