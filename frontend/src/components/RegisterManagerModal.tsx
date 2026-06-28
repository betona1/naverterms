import { useEffect, useState } from 'react';
import {
  fetchStoreStages, setStage, selectIds, markRegistered,
  verifyRegistration, generateQueueExcel, generateAllQueueExcel, fetchRegProducts, analyzeFailures, syncInspect,
  type RegStore, type RegProduct, type Stage, type FailureAnalysis, type SyncInspect,
} from '../api/bulkRegisterApi';
import BulkRegisterModal from './BulkRegisterModal';

interface Props {
  open: boolean;
  onClose: () => void;
  dark: boolean;
  initialStoreFolderId?: number | null;
}

const TARGET = 970;
const LIMIT = 1000;
const SORTS = [
  ['id_desc', '기본'], ['sales', '매출순'], ['recommend', 'AI추천순'],
  ['category', '카테고리순'], ['updated', '최신순'],
];
type Tab = 'all' | 'candidate' | 'queue';
const TABS: [Tab, string][] = [['all', '📦 전체상품'], ['candidate', '🗂 등록후보'], ['queue', '⏳ 작업대기']];

export default function RegisterManagerModal({ open, onClose, dark, initialStoreFolderId }: Props) {
  const [stores, setStores] = useState<RegStore[]>([]);
  const [fid, setFid] = useState<number | null>(initialStoreFolderId ?? null);
  const [tab, setTab] = useState<Tab>('all');
  const [products, setProducts] = useState<RegProduct[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState('id_desc');
  const [catFilter, setCatFilter] = useState('');
  const [regFilter, setRegFilter] = useState('');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [failPanel, setFailPanel] = useState<FailureAnalysis | null>(null);
  const [inspectPanel, setInspectPanel] = useState<SyncInspect | null>(null);
  const [setEditOpen, setSetEditOpen] = useState(false);

  const C = dark ? {
    ov: 'bg-black/60', panel: 'bg-[#15151f] border-[#2a2a40] text-white',
    sub: 'text-gray-400', input: 'bg-[#252540] border-[#2a2a40] text-white',
    card: 'bg-[#1c1c2e] border-[#2a2a40]', head: 'bg-[#252540] text-gray-300',
    row: 'border-[#2a2a40]', hover: 'hover:bg-[#252540]',
    activeF: 'bg-[#03c75a]/20 border-[#03c75a] text-white', idleF: 'border-[#2a2a40] hover:bg-[#252540]',
  } : {
    ov: 'bg-black/40', panel: 'bg-white border-gray-200 text-gray-900',
    sub: 'text-gray-500', input: 'bg-white border-gray-300 text-gray-900',
    card: 'bg-gray-50 border-gray-200', head: 'bg-gray-100 text-gray-700',
    row: 'border-gray-200', hover: 'hover:bg-gray-50',
    activeF: 'bg-[#03c75a]/15 border-[#03c75a] text-gray-900', idleF: 'border-gray-200 hover:bg-gray-50',
  };

  const store = stores.find(s => s.id === fid);
  const staged = store?.staged_pending || 0;     // 새로 등록될 건수 (단계+미등록)
  const naverCnt = store?.naver_count || 0;
  const projected = naverCnt + staged;           // 등록 후 예상 총 상품수
  const stageParam = tab === 'all' ? undefined : tab;

  async function loadStores() {
    const r = await fetchStoreStages();
    setStores(r.stores.filter(s => s.store_id != null));
    return r.stores;
  }

  useEffect(() => {
    if (!open) return;
    loadStores().then(ss => {
      if (fid == null) {
        const real = ss.filter(s => s.store_id != null);
        setFid((real.find(s => s.total > 0) || real[0])?.id ?? null);
      }
    });
  }, [open]);

  useEffect(() => { if (open) { setTab('all'); setPage(1); setChecked(new Set()); } }, [fid, open]);

  async function loadProducts() {
    if (fid == null) return;
    setLoading(true);
    try {
      const r = await fetchRegProducts({
        folder_id: fid, page, per_page: 60, sort,
        register_stage: stageParam,
        category_code: catFilter || undefined,
        registered: regFilter || undefined,
        search: search || undefined,
      });
      setProducts(r.items); setTotalPages(r.total_pages || 1); setTotal(r.total);
    } finally { setLoading(false); }
  }
  useEffect(() => { if (open && fid != null) loadProducts(); }, [fid, tab, page, sort, open]);

  function toggle(id: number) {
    setChecked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function pageSelect() {
    setChecked(s => s.size === products.length ? new Set() : new Set(products.map(p => p.id)));
  }
  async function selectAll(opts: { recommend?: boolean; unregisteredOnly?: boolean } = {}) {
    if (fid == null) return;
    setLoading(true); setMsg('');
    try {
      const r = await selectIds({
        folder_id: fid, stage: stageParam,
        registered: opts.unregisteredOnly ? '0' : (regFilter || undefined),
        category_code: catFilter || undefined, search: search || undefined,
        recommend: opts.recommend ? '1' : undefined, limit: 2000,
      });
      setChecked(new Set(r.ids));
      setMsg(opts.recommend ? `🤖 AI추천 ${r.count}건 체크 (내매출·카테고리·good이미지 종합${r.excluded_bad ? ` · 위험 ${r.excluded_bad}건 제외` : ''})`
        : opts.unregisteredOnly ? `미등록 ${r.count}건 체크됨` : `전체 ${r.count}건 체크됨`);
    } finally { setLoading(false); }
  }

  async function refresh() { await loadStores(); await loadProducts(); setChecked(new Set()); }

  async function doStage(stage: Stage, label: string) {
    if (checked.size === 0) return;
    setLoading(true); setMsg('');
    try {
      const r = await setStage([...checked], stage);
      setMsg(`✅ ${r.updated}건 → ${label}`);
      await refresh();
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  async function doMark(val: boolean) {
    if (checked.size === 0) return;
    setLoading(true); setMsg('');
    try { const r = await markRegistered([...checked], val); setMsg(`✅ ${r.updated}건 등록완료 ${val ? '표기' : '해제'}`); await refresh(); }
    catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  async function doVerify(sync: boolean) {
    if (fid == null) return;
    setLoading(true); setMsg(sync ? '동기화+검증 중… (수십초)' : '검증 중…');
    try {
      const r = await verifyRegistration(fid, sync);
      if (!r.ok) { setMsg('❌ ' + (r.error || '검증실패')); return; }
      setMsg(`🔍 작업대기 ${r.queue_count}건 중 등록확인 ${r.verified} / 미확인 ${r.missing}${r.synced ? ' (동기화함)' : ''}`);
      await refresh();
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  async function doSyncInspect() {
    if (fid == null) return;
    setLoading(true); setMsg('전체 동기화+점검 중… (수십초~분)'); setInspectPanel(null);
    try {
      const r = await syncInspect(fid, true);
      if (!r.ok) { setMsg('❌ ' + (r.error || '점검실패')); return; }
      setInspectPanel(r);
      const c = r.counts;
      setMsg(`✅ 동기화+점검 — 등록확인 ${c.found} / 미발견 ${c.missing} / 품절 ${c.soldout} / 판매중지 ${c.stopped} / 가격불일치 ${c.price_diff}`);
      await refresh();
    } catch (e: any) { setMsg('❌ ' + (e?.message || e)); } finally { setLoading(false); }
  }
  async function doAnalyzeFailures(file: File) {
    if (fid == null) return;
    setLoading(true); setMsg('실패 엑셀 분석 중…'); setFailPanel(null);
    try {
      const r = await analyzeFailures(fid, file, true);
      setFailPanel(r);
      setMsg(`📊 실패 ${r.failed_count}건 · 성공 ${r.applied.success_marked}건 등록완료 표기 · 실패분 작업대기 유지`);
      await refresh();
    } catch (e: any) { setMsg('❌ 분석 실패: ' + (e?.message || e)); } finally { setLoading(false); }
  }

  async function doQueueExcel() {
    if (fid == null) return;
    setLoading(true); setMsg('');
    try {
      const r = await generateQueueExcel(fid, store?.name || '');
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
      setMsg(`✅ 작업대기 ${r.total}건 → ${r.files}개 파일(500단위) ZIP`);
    } catch { setMsg('❌ 엑셀 생성 실패 (작업대기 상품 확인)'); } finally { setLoading(false); }
  }
  async function doAllQueueExcel() {
    setLoading(true); setMsg('전체 스토어 작업대기 ZIP 생성 중… (다소 소요)');
    try {
      const r = await generateAllQueueExcel();
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
      setMsg(`✅ 전체 ${r.stores}개 스토어 / ${r.total.toLocaleString()}건 → ${r.files}개 파일 ZIP (스토어별 폴더)`);
    } catch { setMsg('❌ 전체 ZIP 생성 실패'); } finally { setLoading(false); }
  }

  const imgUrl = (p: RegProduct) =>
    p.upscaled_image_url ? `http://www.joacham.com/imghost/${p.product_code}_1.jpg` : (p.image_small || p.image_large || '');
  const pct = Math.min(100, Math.round(projected / TARGET * 100));
  if (!open) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${C.ov}`} onClick={onClose}>
      <div className={`${C.panel} border rounded-xl w-[1260px] max-w-[98vw] h-[93vh] flex flex-col shadow-2xl`} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-3 px-4 py-2.5 border-b ${C.row}`}>
          <span className="text-lg">📋</span><h2 className="font-bold text-sm">상품 등록관리</h2>
          <select value={fid ?? ''} onChange={e => setFid(Number(e.target.value))} className={`${C.input} border rounded px-2 py-1 text-xs min-w-[200px]`}>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name} ({s.total.toLocaleString()})</option>)}
          </select>
          <button onClick={() => setSetEditOpen(true)} disabled={fid == null}
            title="이 스토어의 등록 세트(마진/배송/할인/A.S) 편집 + 라이브 마진 계산기"
            className="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40">⚙ 세트편집</button>
          <div className="flex-1" />
          {msg && <span className="text-xs">{msg}</span>}
          {loading && <span className={`text-xs ${C.sub} animate-pulse`}>처리중…</span>}
          <button onClick={onClose} className={`text-xs px-2 py-1 rounded border ${C.row} ${C.sub}`}>닫기 ✕</button>
        </div>

        {/* 탭 + 970 카운터 */}
        <div className={`flex items-center gap-2 px-4 py-2 border-b ${C.row}`}>
          {TABS.map(([t, label]) => {
            const cnt = t === 'all' ? store?.total : t === 'candidate' ? store?.candidate_count : store?.queue_count;
            return (
              <button key={t} onClick={() => { setTab(t); setPage(1); setChecked(new Set()); }}
                className={`text-xs px-3 py-1.5 rounded border font-bold ${tab === t ? C.activeF : C.idleF}`}>
                {label} {(cnt ?? 0).toLocaleString()}
                {t === 'queue' && (store?.registered_count ?? 0) > 0 && <span className="text-[#03c75a]"> ·완료{store?.registered_count}</span>}
              </button>
            );
          })}
          <div className="flex-1" />
          <div className="flex items-center gap-2 min-w-[340px]">
            <span className={`text-[11px] ${C.sub} whitespace-nowrap`}>
              현재 {naverCnt}+대기 {staged}=<b className={projected > TARGET ? 'text-rose-500' : 'text-[#03c75a]'}>{projected}</b>/{TARGET}
            </span>
            <div className={`flex-1 h-2 rounded overflow-hidden ${dark ? 'bg-[#252540]' : 'bg-gray-200'}`}>
              <div className="h-full transition-all" style={{ width: `${pct}%`, background: projected > TARGET ? '#ef4444' : projected >= TARGET * 0.95 ? '#f59e0b' : '#03c75a' }} />
            </div>
            <span className={`text-[10px] ${projected > LIMIT ? 'text-rose-500' : C.sub} whitespace-nowrap`}>여유 {Math.max(0, LIMIT - projected)}</span>
          </div>
        </div>

        {/* 필터/검색 + 선택 버튼 */}
        <div className={`flex items-center gap-2 px-3 py-2 border-b ${C.row} flex-wrap`}>
          <button onClick={pageSelect} className={`text-xs px-2 py-1 rounded border ${C.idleF}`}>
            {checked.size === products.length && products.length > 0 ? '페이지해제' : '페이지선택'}
          </button>
          <button onClick={() => selectAll()} className={`text-xs px-2 py-1 rounded border ${C.idleF}`}>전체선택</button>
          <button onClick={() => selectAll({ unregisteredOnly: true })} className="text-xs px-2 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white">미등록만 체크</button>
          {tab === 'all' && (
            <button onClick={() => selectAll({ recommend: true })} className="text-xs px-2 py-1 rounded bg-amber-500 hover:bg-amber-600 text-white font-bold">🤖 AI추천 체크</button>
          )}
          <button onClick={() => setChecked(new Set())} className={`text-xs px-2 py-1 rounded border ${C.idleF}`}>해제</button>
          <span className={`text-xs ${C.sub}`}>선택 <b className="text-[#03c75a]">{checked.size}</b> / {total.toLocaleString()}</span>
          <div className="flex-1" />
          <select value={sort} onChange={e => { setSort(e.target.value); setPage(1); }} className={`${C.input} border rounded px-2 py-1 text-xs`}>
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={regFilter} onChange={e => { setRegFilter(e.target.value); setPage(1); setTimeout(loadProducts, 0); }} className={`${C.input} border rounded px-2 py-1 text-xs`}>
            <option value="">등록 전체</option><option value="0">미등록</option><option value="1">등록완료</option>
          </select>
          <input value={catFilter} onChange={e => setCatFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { setPage(1); loadProducts(); } }}
            placeholder="카테고리코드" className={`${C.input} border rounded px-2 py-1 text-xs w-28`} />
          <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { setPage(1); loadProducts(); } }}
            placeholder="W코드/상품명" className={`${C.input} border rounded px-2 py-1 text-xs w-36`} />
          <button onClick={() => { setPage(1); loadProducts(); }} className="text-xs px-3 py-1 rounded bg-gray-600 hover:bg-gray-700 text-white">검색</button>
        </div>

        {/* 액션바 */}
        <div className={`flex items-center gap-1.5 px-3 py-1.5 border-b ${C.row} flex-wrap`}>
          <button onClick={() => doStage('candidate', '등록후보')} disabled={!checked.size || loading} className="text-xs px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-30">→ 등록후보</button>
          <button onClick={() => doStage('queue', '작업대기')} disabled={!checked.size || loading} className="text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-30">→ 작업대기</button>
          <button onClick={() => doStage(null, '단계해제(되돌리기)')} disabled={!checked.size || loading || tab === 'all'} className={`text-xs px-2.5 py-1 rounded border ${C.idleF} disabled:opacity-30`}>← 되돌리기</button>
          <div className="w-px h-4 bg-gray-400/30 mx-1" />
          <button onClick={() => doMark(true)} disabled={!checked.size || loading} className="text-xs px-2.5 py-1 rounded bg-[#03c75a] hover:opacity-90 text-white disabled:opacity-30">✓ 등록완료</button>
          <button onClick={() => doMark(false)} disabled={!checked.size || loading} className={`text-xs px-2.5 py-1 rounded border ${C.idleF} disabled:opacity-30`}>완료해제</button>
          <div className="flex-1" />
          <label className="text-xs px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white cursor-pointer">
            📊 실패분석
            <input type="file" accept=".xlsx" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) doAnalyzeFailures(f); e.currentTarget.value = ''; }} />
          </label>
          <button onClick={() => doVerify(false)} disabled={loading} className={`text-xs px-2 py-1 rounded border ${C.idleF} disabled:opacity-40`}>🔍 검증</button>
          <button onClick={doSyncInspect} disabled={loading} className="text-xs px-2 py-1 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40">🔄 전체 동기화+점검</button>
          <button onClick={doQueueExcel} disabled={loading} className="text-xs px-2.5 py-1 rounded bg-[#03c75a] hover:opacity-90 text-white font-bold disabled:opacity-40">⬇ 작업대기 엑셀저장</button>
          <button onClick={doAllQueueExcel} disabled={loading} title="전 스토어 작업대기를 스토어별 폴더로 한 ZIP" className="text-xs px-2.5 py-1 rounded bg-teal-600 hover:bg-teal-700 text-white font-bold disabled:opacity-40">⬇⬇ 전체 ZIP</button>
        </div>

        {/* 동기화+점검 로그 패널 */}
        {inspectPanel && (
          <div className={`px-3 py-2 border-b ${C.row} ${dark ? 'bg-sky-900/15' : 'bg-sky-50'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold text-sky-600 dark:text-sky-400">🔄 동기화+점검</span>
              <span className={`text-[11px] ${C.sub}`}>
                작업대기 {inspectPanel.queue_count} | 등록확인 {inspectPanel.counts.found} · 미발견 {inspectPanel.counts.missing} · 품절 {inspectPanel.counts.soldout} · 판매중지 {inspectPanel.counts.stopped} · 가격불일치 {inspectPanel.counts.price_diff}
              </span>
              {inspectPanel.log_file && <span className={`text-[10px] ${C.sub}`}>로그: exports/{inspectPanel.log_file}</span>}
              <div className="flex-1" />
              <button onClick={() => setInspectPanel(null)} className={`text-[11px] ${C.sub}`}>닫기 ✕</button>
            </div>
            {inspectPanel.anomalies.length > 0 ? (
              <div className={`max-h-32 overflow-auto text-[11px] font-mono rounded p-2 ${dark ? 'bg-[#0f0f1a]' : 'bg-white'} border ${C.row}`}>
                {inspectPanel.anomalies.map((a, i) => (
                  <div key={i}>
                    <span className="text-rose-500">[{a.type}]</span> <b>{a.code}</b> {a.detail}
                    <span className={C.sub}> — {a.name.slice(0, 30)}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-[11px] text-[#03c75a]">특이사항 없음 ✓</div>}
          </div>
        )}

        {/* 실패분석 결과 패널 */}
        {failPanel && (
          <div className={`px-3 py-2 border-b ${C.row} ${dark ? 'bg-amber-900/15' : 'bg-amber-50'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold text-amber-600 dark:text-amber-400">📊 실패 {failPanel.failed_count}건 분석</span>
              <span className={`text-[11px] ${C.sub}`}>성공 {failPanel.applied.success_marked}건 등록완료 · 실패 {failPanel.applied.failed_kept}건 작업대기 유지</span>
              <div className="flex-1" />
              <button onClick={() => setFailPanel(null)} className={`text-[11px] ${C.sub}`}>닫기 ✕</button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {failPanel.reason_summary.map((s, i) => (
                <span key={i} className={`text-[11px] px-2 py-0.5 rounded border ${C.row} ${dark ? 'bg-[#1c1c2e]' : 'bg-white'}`}>
                  <b className="text-rose-500">{s.count}건</b> {s.reason}
                </span>
              ))}
            </div>
            <div className={`text-[10px] ${C.sub}`}>
              패치 적용됨 — 실패 사유 수정 후 <b>⬇ 작업대기 엑셀저장</b>으로 실패분만 재생성됩니다.
              ({failPanel.failed_codes.slice(0, 15).join(', ')}{failPanel.failed_codes.length > 15 ? ' …' : ''})
            </div>
          </div>
        )}

        {/* 목록 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`${C.head} sticky top-0`}>
              <tr>
                <th className="px-2 py-1.5"><input type="checkbox" checked={products.length > 0 && checked.size >= products.length} onChange={pageSelect} /></th>
                {['이미지', 'W코드', '상품명', '카테고리', '원가', '단계', '상태'].map(h => <th key={h} className="px-2 py-1.5 text-left whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className={`border-t ${C.row} ${C.hover} ${checked.has(p.id) ? 'bg-[#03c75a]/5' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} /></td>
                  <td className="px-2 py-1">{imgUrl(p) ? <img src={imgUrl(p)} className="w-9 h-9 object-cover rounded" loading="lazy" /> : '—'}</td>
                  <td className="px-2 py-1 font-mono">{p.product_code}</td>
                  <td className="px-2 py-1 max-w-[340px] truncate" title={p.naver_product_name || ''}>{p.naver_product_name}</td>
                  <td className="px-2 py-1 whitespace-nowrap" title={p.category_name || ''}>{p.category_code || '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{(p.ownerclan_price || 0).toLocaleString()}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {p.register_stage === 'candidate' ? <span className="text-violet-400">후보</span>
                      : p.register_stage === 'queue' ? <span className="text-emerald-400">대기</span> : <span className={C.sub}>—</span>}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">{p.registered ? <span className="text-[#03c75a] font-bold">✓{p.register_verified ? '검증' : '완료'}</span> : <span className={C.sub}>미등록</span>}</td>
                </tr>
              ))}
              {products.length === 0 && !loading && <tr><td colSpan={8} className={`p-6 text-center text-xs ${C.sub}`}>상품 없음</td></tr>}
            </tbody>
          </table>
        </div>

        {/* 페이지네이션 */}
        <div className={`flex items-center justify-center gap-2 px-3 py-2 border-t ${C.row}`}>
          <button disabled={page <= 1} onClick={() => setPage(1)} className={`text-xs px-2 py-0.5 rounded border ${C.idleF} disabled:opacity-30`}>«</button>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={`text-xs px-2 py-0.5 rounded border ${C.idleF} disabled:opacity-30`}>◀</button>
          <span className="text-xs">{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className={`text-xs px-2 py-0.5 rounded border ${C.idleF} disabled:opacity-30`}>▶</button>
          <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className={`text-xs px-2 py-0.5 rounded border ${C.idleF} disabled:opacity-30`}>»</button>
        </div>
      </div>

      {/* 세트편집 (라이브 마진 계산기) — 현재 스토어 */}
      <BulkRegisterModal
        open={setEditOpen}
        onClose={() => { setSetEditOpen(false); loadStores(); }}
        dark={dark}
        initialFolderId={fid}
      />
    </div>
  );
}
