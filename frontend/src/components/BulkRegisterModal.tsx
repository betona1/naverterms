import { useEffect, useMemo, useState } from 'react';
import {
  fetchRegisterSets, fetchRegisterSet, saveRegisterSet,
  previewBulk, generateBulk,
  type FolderSet, type RegisterSet, type PreviewResult,
} from '../api/bulkRegisterApi';

interface Props {
  open: boolean;
  onClose: () => void;
  dark: boolean;
  initialFolderId?: number | null;
}

const BULKADD_URL = 'https://sell.smartstore.naver.com/#/products/bulkadd';
const FEE_TYPES = ['무료', '조건부 무료', '유료'];
const COURIERS = [
  ['CJGLS', 'CJ대한통운'], ['HANJIN', '한진택배'], ['HYUNDAI', '롯데택배'],
  ['KGB', '로젠택배'], ['EPOST', '우체국택배'],
];

const DEFAULT_SET: RegisterSet = {
  name: '기본세트',
  margin_rate: 1.5, fee_rate: 0.07, set_ship_fee: 3000, free_shipping: 1,
  discount_rate: 0, review_point_text: 0, review_point_photo: 0,
  delivery_company_code: 'CJGLS', delivery_fee_type: '무료', base_ship_fee: 0,
  free_cond_amount: null, return_fee: 5000, exchange_fee: 10000,
  default_stock: 999, vat_type: '과세상품', product_state: '신상품',
  origin_code: '03', as_phone: null, as_guide: null,
};

function round10(v: number) { return Math.round(v / 10) * 10; }

// 백엔드 compute_price 미러 (라이브 계산용)
function compute(set: RegisterSet, cost: number, B: number) {
  const m = +set.margin_rate || 0, f = +set.fee_rate || 0, S = +set.set_ship_fee || 0;
  const free = +set.free_shipping === 1, d = +set.discount_rate || 0;
  const rp = (+set.review_point_text || 0) + (+set.review_point_photo || 0);
  const margin = cost * m, fee = cost * f;
  const ship = (B - S) + (free ? S : 0);
  const target = margin + fee + ship + rp;
  const list = round10(target * (1 + d));
  const targetR = round10(target);
  return {
    margin: Math.round(margin), fee: Math.round(fee), ship: Math.round(ship), review: rp,
    target: targetR, list, discount: Math.max(0, list - targetR),
    net: Math.round(target - cost - fee - (free ? B : 0)),
  };
}

export default function BulkRegisterModal({ open, onClose, dark, initialFolderId }: Props) {
  const [folders, setFolders] = useState<FolderSet[]>([]);
  const [folderId, setFolderId] = useState<number | null>(initialFolderId ?? null);
  const [set, setSet] = useState<RegisterSet>(DEFAULT_SET);
  const [calcCost, setCalcCost] = useState(10000);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const C = dark ? {
    overlay: 'bg-black/60', panel: 'bg-[#15151f] border-[#2a2a40] text-white',
    sub: 'text-gray-400', input: 'bg-[#252540] border-[#2a2a40] text-white',
    card: 'bg-[#1c1c2e] border-[#2a2a40]', head: 'bg-[#252540] text-gray-300',
    row: 'border-[#2a2a40]',
  } : {
    overlay: 'bg-black/40', panel: 'bg-white border-gray-200 text-gray-900',
    sub: 'text-gray-500', input: 'bg-white border-gray-300 text-gray-900',
    card: 'bg-gray-50 border-gray-200', head: 'bg-gray-100 text-gray-700',
    row: 'border-gray-200',
  };

  const selectedFolder = folders.find(f => f.folder_id === folderId);

  useEffect(() => {
    if (!open) return;
    fetchRegisterSets().then(r => {
      setFolders(r.folders);
      if (folderId == null && r.folders.length) {
        const first = r.folders.find(f => f.product_count > 0) || r.folders[0];
        setFolderId(first.folder_id);
      }
    });
  }, [open]);

  // 폴더 바뀌면 세트 로드
  useEffect(() => {
    if (!open || folderId == null) return;
    setPreview(null); setMsg('');
    const f = folders.find(x => x.folder_id === folderId);
    fetchRegisterSet(folderId, f?.name).then(r => setSet({ ...DEFAULT_SET, ...r.set }));
  }, [folderId, open]);

  const live = useMemo(() => compute(set, calcCost, 0), [set, calcCost]);

  function upd<K extends keyof RegisterSet>(k: K, v: RegisterSet[K]) {
    setSet(s => ({ ...s, [k]: v }));
  }

  async function onSave() {
    if (folderId == null) return;
    setLoading(true); setMsg('');
    try {
      await saveRegisterSet(folderId, set);
      setMsg('✅ 세트 저장 완료');
    } catch (e: any) { setMsg('❌ 저장 실패: ' + (e?.message || e)); }
    finally { setLoading(false); }
  }

  async function onPreview() {
    if (folderId == null) return;
    setLoading(true); setMsg('');
    try {
      const r = await previewBulk(folderId, set, 10);
      setPreview(r);
    } catch (e: any) { setMsg('❌ 미리보기 실패: ' + (e?.message || e)); }
    finally { setLoading(false); }
  }

  async function onGenerate() {
    if (folderId == null) return;
    setLoading(true); setMsg('');
    try {
      await saveRegisterSet(folderId, set);   // 최신 세트로 생성
      const r = await generateBulk(folderId, selectedFolder?.name || '');
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
      setMsg(`✅ ${r.total.toLocaleString()}건 / ${r.files}개 파일 생성 완료 — ZIP 다운로드됨`);
    } catch (e: any) {
      const detail = e?.response?.data ? '' : (e?.message || e);
      setMsg('❌ 생성 실패: ' + detail);
    }
    finally { setLoading(false); }
  }

  if (!open) return null;

  const numCls = `${C.input} border rounded px-2 py-1 text-xs w-full`;
  const lblCls = `text-[11px] ${C.sub} mb-0.5 block`;
  const pct = (v: number) => Math.round(v * 1000) / 10;  // 0.07 → 7

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.overlay}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1080px] max-w-[97vw] max-h-[94vh] overflow-auto shadow-2xl`}
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 py-3 border-b ${C.row} sticky top-0 ${C.panel} z-10`}>
          <span className="text-lg">📦</span>
          <h2 className="font-bold text-sm">네이버 상품 일괄등록</h2>
          <a href={BULKADD_URL} target="_blank" rel="noreferrer"
             className="text-[11px] px-2 py-0.5 rounded bg-[#03c75a] text-white font-bold hover:opacity-90">
            업로드 페이지 열기 ▶
          </a>
          <div className="flex-1" />
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub} hover:opacity-80`}>닫기 ✕</button>
        </div>

        <div className="p-4 space-y-3">
          {/* ① 스토어 선택 */}
          <div className={`${C.card} border rounded-lg p-3 flex items-center gap-3 flex-wrap`}>
            <span className="text-xs font-bold">① 스토어(폴더)</span>
            <select value={folderId ?? ''} onChange={e => setFolderId(Number(e.target.value))}
                    className={`${C.input} border rounded px-2 py-1 text-xs min-w-[220px]`}>
              {folders.map(f => (
                <option key={f.folder_id} value={f.folder_id}>
                  {f.name} ({f.product_count.toLocaleString()}개){f.has_set ? ' ·세트✓' : ''}
                </option>
              ))}
            </select>
            {selectedFolder && (
              <span className={`text-[11px] ${C.sub}`}>
                폴더 상품 <b>{selectedFolder.product_count.toLocaleString()}</b>건
                {preview && <> · 확정상품 <b className="text-[#03c75a]">{preview.total_confirmed.toLocaleString()}</b>건 · 파일 {preview.file_count}개</>}
              </span>
            )}
          </div>

          {/* ② 세트 + 라이브 계산기 */}
          <div className="grid grid-cols-2 gap-3">
            {/* 세트 편집 */}
            <div className={`${C.card} border rounded-lg p-3`}>
              <div className="text-xs font-bold mb-2">② 등록 세트 — 가격</div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className={lblCls}>마진율 (×)</label>
                  <input type="number" step="0.05" value={set.margin_rate} className={numCls}
                         onChange={e => upd('margin_rate', +e.target.value)} /></div>
                <div><label className={lblCls}>수수료율 (%)</label>
                  <input type="number" step="0.5" value={pct(set.fee_rate)} className={numCls}
                         onChange={e => upd('fee_rate', +e.target.value / 100)} /></div>
                <div><label className={lblCls}>세트 배송비 (원)</label>
                  <input type="number" step="100" value={set.set_ship_fee} className={numCls}
                         onChange={e => upd('set_ship_fee', +e.target.value)} /></div>
                <div><label className={lblCls}>할인율 (%) — 정가↑</label>
                  <input type="number" step="1" value={pct(set.discount_rate)} className={numCls}
                         onChange={e => upd('discount_rate', +e.target.value / 100)} /></div>
                <div><label className={lblCls}>리뷰포인트 텍스트</label>
                  <input type="number" step="10" value={set.review_point_text} className={numCls}
                         onChange={e => upd('review_point_text', +e.target.value)} /></div>
                <div><label className={lblCls}>리뷰포인트 포토</label>
                  <input type="number" step="10" value={set.review_point_photo} className={numCls}
                         onChange={e => upd('review_point_photo', +e.target.value)} /></div>
                <label className="flex items-center gap-1 text-xs col-span-2 cursor-pointer">
                  <input type="checkbox" checked={set.free_shipping === 1}
                         onChange={e => upd('free_shipping', e.target.checked ? 1 : 0)} />
                  무료배송 (배송비를 판매가에 흡수)
                </label>
              </div>

              <div className="text-xs font-bold mt-3 mb-2">배송 / 반품</div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className={lblCls}>택배사</label>
                  <select value={set.delivery_company_code} className={numCls}
                          onChange={e => upd('delivery_company_code', e.target.value)}>
                    {COURIERS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </select></div>
                <div><label className={lblCls}>배송비유형</label>
                  <select value={set.delivery_fee_type} className={numCls}
                          onChange={e => upd('delivery_fee_type', e.target.value)}>
                    {FEE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select></div>
                {set.delivery_fee_type !== '무료' && (
                  <div><label className={lblCls}>기본배송비 (원)</label>
                    <input type="number" step="100" value={set.base_ship_fee} className={numCls}
                           onChange={e => upd('base_ship_fee', +e.target.value)} /></div>
                )}
                {set.delivery_fee_type === '조건부 무료' && (
                  <div><label className={lblCls}>무료조건 합계 (원)</label>
                    <input type="number" step="1000" value={set.free_cond_amount ?? 0} className={numCls}
                           onChange={e => upd('free_cond_amount', +e.target.value)} /></div>
                )}
                <div><label className={lblCls}>반품배송비</label>
                  <input type="number" step="500" value={set.return_fee} className={numCls}
                         onChange={e => upd('return_fee', +e.target.value)} /></div>
                <div><label className={lblCls}>교환배송비</label>
                  <input type="number" step="500" value={set.exchange_fee} className={numCls}
                         onChange={e => upd('exchange_fee', +e.target.value)} /></div>
                <div><label className={lblCls}>기본 재고수량</label>
                  <input type="number" step="1" value={set.default_stock} className={numCls}
                         onChange={e => upd('default_stock', +e.target.value)} /></div>
                <div><label className={lblCls}>원산지코드</label>
                  <input value={set.origin_code} className={numCls}
                         onChange={e => upd('origin_code', e.target.value)} /></div>
                <div><label className={lblCls}>A/S 전화</label>
                  <input value={set.as_phone ?? ''} className={numCls} placeholder="02-000-0000"
                         onChange={e => upd('as_phone', e.target.value)} /></div>
                <div><label className={lblCls}>A/S 안내</label>
                  <input value={set.as_guide ?? ''} className={numCls}
                         onChange={e => upd('as_guide', e.target.value)} /></div>
              </div>
            </div>

            {/* 라이브 마진 계산기 */}
            <div className={`${C.card} border rounded-lg p-3`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-bold">📊 라이브 마진 계산기</span>
                <span className={`text-[11px] ${C.sub}`}>원가 기준</span>
                <input type="number" step="1000" value={calcCost} className={`${C.input} border rounded px-2 py-0.5 text-xs w-24`}
                       onChange={e => setCalcCost(+e.target.value)} />
                <span className={`text-[11px] ${C.sub}`}>원</span>
              </div>

              {/* 마진율 슬라이더 */}
              <label className={lblCls}>마진율 {set.margin_rate.toFixed(2)}× · 할인율 {pct(set.discount_rate)}%</label>
              <input type="range" min={1} max={3} step={0.05} value={set.margin_rate}
                     onChange={e => upd('margin_rate', +e.target.value)} className="w-full accent-[#03c75a]" />
              <input type="range" min={0} max={50} step={1} value={pct(set.discount_rate)}
                     onChange={e => upd('discount_rate', +e.target.value / 100)} className="w-full accent-rose-500 mb-2" />

              <table className="w-full text-xs">
                <tbody>
                  {[
                    ['원가', calcCost, C.sub],
                    [`마진 (×${set.margin_rate})`, live.margin, ''],
                    [`수수료 (${pct(set.fee_rate)}%)`, live.fee, ''],
                    ['배송비 반영', live.ship, ''],
                    ['리뷰포인트', live.review, ''],
                  ].map(([k, v, cls], i) => (
                    <tr key={i} className={`border-b ${C.row}`}>
                      <td className={`py-1 ${cls}`}>{k as string}</td>
                      <td className="py-1 text-right tabular-nums">{(v as number).toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className={`border-b ${C.row}`}>
                    <td className="py-1.5 font-bold text-[#03c75a]">목표가 (고객 결제)</td>
                    <td className="py-1.5 text-right font-bold tabular-nums text-[#03c75a]">{live.target.toLocaleString()}원</td>
                  </tr>
                  <tr className={`border-b ${C.row}`}>
                    <td className="py-1.5 font-bold">정가 (등록 판매가)</td>
                    <td className="py-1.5 text-right font-bold tabular-nums">{live.list.toLocaleString()}원</td>
                  </tr>
                  <tr className={`border-b ${C.row}`}>
                    <td className="py-1 text-rose-500">즉시할인 (정액)</td>
                    <td className="py-1 text-right tabular-nums text-rose-500">-{live.discount.toLocaleString()}원</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 font-bold">예상 순마진</td>
                    <td className={`py-1.5 text-right font-bold tabular-nums ${live.net >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {live.net.toLocaleString()}원 ({calcCost > 0 ? Math.round(live.net / calcCost * 100) : 0}%)
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className={`text-[10px] ${C.sub} mt-2 leading-relaxed`}>
                정가 = round10(목표가 × (1+할인율)) · 할인율 10%면 11,000 올려 10,000 판매.
                무료배송 시 원본배송비가 판매가에 흡수됩니다.
              </p>
            </div>
          </div>

          {/* 액션 */}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={onSave} disabled={loading || folderId == null}
                    className="px-3 py-1.5 text-xs font-bold rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40">
              💾 세트 저장
            </button>
            <button onClick={onPreview} disabled={loading || folderId == null}
                    className="px-3 py-1.5 text-xs font-bold rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40">
              👁 미리보기 (상위 10건)
            </button>
            <button onClick={onGenerate} disabled={loading || folderId == null}
                    className="px-3 py-1.5 text-xs font-bold rounded bg-[#03c75a] hover:opacity-90 text-white disabled:opacity-40 shadow">
              ⬇ 엑셀 생성 (500개 단위 ZIP)
            </button>
            {loading && <span className={`text-xs ${C.sub} animate-pulse`}>처리 중…</span>}
            {msg && <span className="text-xs">{msg}</span>}
          </div>

          {/* 경고 */}
          {preview?.warnings?.length ? (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 text-[11px] rounded p-2 space-y-0.5">
              {preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          ) : null}

          {/* 미리보기 테이블 */}
          {preview && (
            <div className={`${C.card} border rounded-lg overflow-hidden`}>
              <table className="w-full text-[11px]">
                <thead className={C.head}>
                  <tr>
                    {['이미지', 'W코드', '상품명', '카테고리', '원가', '정가', '할인', '순마진', '상세'].map(h => (
                      <th key={h} className="px-2 py-1.5 text-left font-bold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((it, i) => (
                    <tr key={i} className={`border-t ${C.row}`}>
                      <td className="px-2 py-1">
                        <div className="relative w-8 h-8">
                          {it.image ? <img src={it.image} className="w-8 h-8 object-cover rounded" /> : <span>—</span>}
                          {it.img_upscaled && (
                            <span className="absolute -top-1 -right-1 text-[8px] bg-[#03c75a] text-white rounded-full px-0.5" title="업스케일 호스팅 이미지">↑</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1 font-mono">{it.product_code}</td>
                      <td className="px-2 py-1 max-w-[260px] truncate" title={it.name}>{it.name}</td>
                      <td className={`px-2 py-1 ${it.category_ok ? '' : 'text-rose-500'}`}>{it.category_code || '없음'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{it.cost.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-bold">{it.list_price.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-rose-500">{it.discount_amount ? `-${it.discount_amount.toLocaleString()}` : '—'}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${it.net_margin >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{it.net_margin.toLocaleString()}</td>
                      <td className="px-2 py-1">{it.has_detail ? '✓' : '⚠'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.items.length === 0 && <div className={`p-3 text-xs ${C.sub}`}>확정상품이 없습니다.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
