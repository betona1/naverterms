import { useState, useEffect, useCallback } from 'react';
import { fetchStores, type SmartStore } from '../api/smartstoreApi';
import {
  listByStatus, needsManualForSku, registerForSku, productContext,
  type StatusSkuItem, type ManualAttrItem, type ProductContext,
} from '../api/missingAttrsApi';

/** 수동검토(needs_manual) SKU 를 골라 속성값을 직접 선택→저장(네이버 등록)하는 모달.
 * 좌측: needs_manual SKU 목록(검색/스토어필터) · 우측: 선택 SKU 의 속성별 후보값 드롭다운. */
export function ManualReviewModal({ onClose, initialStoreId }: { onClose: () => void; initialStoreId?: number }) {
  const [stores, setStores] = useState<SmartStore[]>([]);
  const [storeId, setStoreId] = useState<number | undefined>(initialStoreId);
  const [search, setSearch] = useState('');
  const [list, setList] = useState<StatusSkuItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [sel, setSel] = useState<{ code: string; store: number } | null>(null);
  const [attrs, setAttrs] = useState<ManualAttrItem[] | null>(null);
  const [attrLoading, setAttrLoading] = useState(false);
  const [picks, setPicks] = useState<Record<number, number>>({}); // attribute_seq → value_seq (0=선택안함)
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ctx, setCtx] = useState<ProductContext | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => { fetchStores(true).then(setStores).catch(() => {}); }, []);

  const loadList = useCallback(() => {
    setListLoading(true);
    listByStatus('needs_manual', storeId, 200, search)
      .then(d => setList(d.items || []))
      .catch(() => setList([]))
      .finally(() => setListLoading(false));
  }, [storeId, search]);
  useEffect(() => { loadList(); }, [loadList]);

  const openSku = (code: string, store: number) => {
    setSel({ code, store }); setAttrs(null); setPicks({}); setFeedback(null); setAttrLoading(true);
    setCtx(null); setShowDetail(false);
    productContext(code, store).then(setCtx).catch(() => setCtx({ ok: false, seller_code: code, store_id: store, error: '조회 실패' }));
    needsManualForSku(code, store)
      .then(d => {
        setAttrs(d.attributes || []);
        // 추천값이 있으면 기본 선택
        const init: Record<number, number> = {};
        (d.attributes || []).forEach(a => { if (a.recommended_value_seq) init[a.attribute_seq] = a.recommended_value_seq; });
        setPicks(init);
      })
      .catch(() => setAttrs([]))
      .finally(() => setAttrLoading(false));
  };

  const save = () => {
    if (!sel || !attrs) return;
    const selections = attrs
      .filter(a => picks[a.attribute_seq])
      .map(a => {
        const vseq = picks[a.attribute_seq];
        const cv = a.candidate_values.find(c => c.seq === vseq);
        return { attribute_seq: a.attribute_seq, value_seq: vseq, value_text: cv?.text || a.recommended_value_text || '' };
      });
    if (!selections.length) { setFeedback({ ok: false, msg: '선택된 속성이 없습니다.' }); return; }
    setSaving(true); setFeedback(null);
    registerForSku({ seller_management_code: sel.code, store_id: sel.store, selections, dry_run: false })
      .then(r => {
        if (r.ok) {
          setFeedback({ ok: true, msg: `저장 완료 — ${r.attrs_set ?? selections.length}개 속성 등록` });
          loadList();          // 저장된 SKU 는 needs_manual 에서 빠짐
          setSel(null); setAttrs(null);
        } else {
          setFeedback({ ok: false, msg: r.error || '등록 실패 (판매중 상품만 등록 가능)' });
        }
      })
      .catch(e => setFeedback({ ok: false, msg: e?.response?.data?.error || e?.message || '등록 실패' }))
      .finally(() => setSaving(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-5xl h-[88vh] flex flex-col rounded-xl border bg-white dark:bg-[#1c1c2e] border-gray-200 dark:border-[#2a2a40] shadow-2xl"
           onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="px-5 py-3.5 flex items-center gap-2 border-b border-gray-200 dark:border-[#2a2a40]">
          <span className="text-[15px] font-bold text-amber-600 dark:text-amber-500">🖐 수동검토 — 속성값 선택·저장</span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">후보값을 골라 저장하면 네이버에 등록되고 수동검토에서 제외됩니다.</span>
          <button onClick={onClose} className="ml-auto text-[22px] leading-none text-gray-500 hover:text-gray-900 dark:hover:text-white">×</button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 좌측: SKU 목록 */}
          <div className="w-[42%] flex flex-col border-r border-gray-200 dark:border-[#2a2a40]">
            <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-200 dark:border-[#2a2a40]">
              <select value={storeId ?? ''} onChange={e => setStoreId(e.target.value ? Number(e.target.value) : undefined)}
                      className="px-2 py-1 rounded text-[12px] border bg-white dark:bg-[#252540] border-gray-300 dark:border-[#2a2a40] text-gray-900 dark:text-gray-100">
                <option value="">전체 스토어</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.store_name}</option>)}
              </select>
              <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadList()}
                     placeholder="W코드 / 상품명" className="flex-1 px-2 py-1 rounded text-[12px] border bg-white dark:bg-[#252540] border-gray-300 dark:border-[#2a2a40] text-gray-900 dark:text-gray-100" />
              <button onClick={loadList} className="px-2 py-1 rounded text-[12px] bg-violet-600 text-white hover:bg-violet-700">조회</button>
            </div>
            <div className="overflow-auto flex-1">
              {listLoading && <div className="px-3 py-6 text-center text-[12px] text-gray-400">조회중…</div>}
              {!listLoading && !list.length && <div className="px-3 py-6 text-center text-[12px] text-gray-400">수동검토 대상 없음</div>}
              <ul>
                {list.map(it => {
                  const active = sel?.code === it.seller_code && sel?.store === it.store_id;
                  return (
                    <li key={`${it.seller_code}-${it.store_id}`} onClick={() => openSku(it.seller_code, it.store_id)}
                        className={`px-3 py-2 cursor-pointer border-b border-gray-100 dark:border-gray-800 ${active ? 'bg-amber-50 dark:bg-amber-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-indigo-500 dark:text-indigo-400">{it.seller_code}</span>
                        <span className="text-[10px] text-gray-400">{it.store_name}</span>
                        {!it.is_sale && <span className="text-[10px] px-1 rounded bg-red-500/20 text-red-400">비판매</span>}
                        <span className="ml-auto text-[10px] text-amber-500">{it.attr_count}개</span>
                      </div>
                      <div className="text-[12px] text-gray-800 dark:text-gray-100 truncate">{it.name || '—'}</div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          {/* 우측: 속성 선택 */}
          <div className="flex-1 flex flex-col min-w-0">
            {!sel && <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400">왼쪽에서 상품을 선택하세요.</div>}
            {sel && (
              <>
                <div className="px-4 py-2.5 border-b border-gray-200 dark:border-[#2a2a40]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-indigo-500 dark:text-indigo-400">{sel.code}</span>
                    <span className="text-[11px] text-gray-400">store {sel.store}</span>
                  </div>
                  {/* 상품 실물 컨텍스트 — 값 고를 때 참고 */}
                  {ctx && ctx.ok && (
                    <div className="mt-2 flex gap-3">
                      {ctx.representative_image && (
                        <a href={ctx.representative_image} target="_blank" rel="noreferrer" className="shrink-0">
                          <img src={ctx.representative_image} alt="썸네일" loading="lazy"
                               className="w-20 h-20 object-contain rounded border border-gray-200 dark:border-[#2a2a40] bg-white" />
                        </a>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold text-gray-800 dark:text-gray-100 leading-snug break-words line-clamp-3">{ctx.name || '—'}</div>
                        {ctx.category_name && <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">{ctx.category_name}</div>}
                        {!!(ctx.detail_images && ctx.detail_images.length) && (
                          <button onClick={() => setShowDetail(s => !s)}
                                  className="mt-1 text-[11px] text-indigo-500 dark:text-indigo-400 hover:underline">
                            {showDetail ? '▲ 상세보기 닫기' : `▼ 상세보기 (${ctx.detail_images.length})`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {ctx && ctx.ok && showDetail && !!(ctx.detail_images && ctx.detail_images.length) && (
                    <div className="mt-2 max-h-72 overflow-auto space-y-2 rounded border border-gray-100 dark:border-gray-800 p-2">
                      {ctx.detail_images!.map((u, i) => (
                        <img key={i} src={u} alt={`상세 ${i + 1}`} loading="lazy" className="w-full rounded bg-white" />
                      ))}
                    </div>
                  )}
                </div>
                <div className="overflow-auto flex-1 px-4 py-3 space-y-3">
                  {attrLoading && <div className="text-center text-[12px] text-gray-400 py-6">조회중…</div>}
                  {!attrLoading && attrs && !attrs.length && <div className="text-center text-[12px] text-gray-400 py-6">수동검토 속성 없음 (이미 처리됨)</div>}
                  {!attrLoading && attrs && attrs.map(a => (
                    <div key={a.attribute_seq} className="rounded-lg border border-gray-200 dark:border-[#2a2a40] p-2.5">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{a.attribute_name}</span>
                        <span className="text-[10px] text-gray-400">{a.classification_type}</span>
                      </div>
                      {a.last_error && <div className="text-[10px] text-amber-600 dark:text-amber-500 mb-1.5">⚠ {a.last_error}</div>}
                      <select value={picks[a.attribute_seq] ?? 0}
                              onChange={e => setPicks(p => ({ ...p, [a.attribute_seq]: Number(e.target.value) }))}
                              className="w-full px-2 py-1.5 rounded text-[12px] border bg-white dark:bg-[#252540] border-gray-300 dark:border-[#2a2a40] text-gray-900 dark:text-gray-100">
                        <option value={0}>— 선택 안함 —</option>
                        {a.candidate_values.map(c => <option key={c.seq} value={c.seq}>{c.text}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 border-t border-gray-200 dark:border-[#2a2a40] flex items-center gap-3">
                  {feedback && (
                    <span className={`text-[12px] ${feedback.ok ? 'text-[#03c75a]' : 'text-red-500'}`}>{feedback.ok ? '✓ ' : '✕ '}{feedback.msg}</span>
                  )}
                  <button onClick={save} disabled={saving || !attrs?.length}
                          className="ml-auto px-4 py-1.5 rounded text-[13px] bg-[#03c75a] text-white hover:bg-[#02b150] disabled:opacity-50">
                    {saving ? '저장 중…' : '💾 저장(등록)'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
