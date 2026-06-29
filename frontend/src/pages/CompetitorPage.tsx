import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { competitorApi } from '../api/competitorApi';
import type { CompetitorProduct, CompetitorSnapshot } from '../api/competitorApi';

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString();
}

function fmtDate(s: string | null): string {
  if (!s) return '-';
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 상품 카드 ─────────────────────────────────────────────────────────────────

interface ProductCardProps {
  product: CompetitorProduct;
  dark: boolean;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onCrawl: () => void;
  onKeywordUpdate: (kw: string) => void;
}

function ProductCard({ product, dark, selected, onSelect, onDelete, onCrawl, onKeywordUpdate }: ProductCardProps) {
  const [editKw, setEditKw] = useState(false);
  const [kw, setKw] = useState(product.track_keyword);
  const snap = product.latest_snapshot;

  const cardBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const border = selected
    ? 'border-2 border-[#03c75a]'
    : dark ? 'border border-[#2a2a40]' : 'border border-gray-200';

  return (
    <div
      className={`rounded-xl p-4 cursor-pointer transition-all ${cardBg} ${border}`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-semibold truncate ${dark ? 'text-white' : 'text-gray-900'}`}>
            {product.product_name || '(이름 미수집)'}
          </p>
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-[#03c75a] hover:underline truncate block"
            onClick={e => e.stopPropagation()}
          >
            {product.url.length > 50 ? product.url.slice(0, 50) + '…' : product.url}
          </a>
        </div>
        <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={onCrawl}
            className="px-2 py-1 text-[11px] rounded bg-[#03c75a] text-white hover:opacity-80"
          >
            수집
          </button>
          <button
            onClick={onDelete}
            className={`px-2 py-1 text-[11px] rounded ${dark ? 'bg-[#2a2a40] text-gray-400 hover:text-red-400' : 'bg-gray-100 text-gray-500 hover:text-red-500'}`}
          >
            삭제
          </button>
        </div>
      </div>

      {/* 순위추적 키워드 */}
      <div className="mb-3" onClick={e => e.stopPropagation()}>
        {editKw ? (
          <div className="flex gap-1">
            <input
              autoFocus
              value={kw}
              onChange={e => setKw(e.target.value)}
              placeholder="순위추적 키워드"
              className={`flex-1 px-2 py-1 text-[12px] rounded border ${dark ? 'bg-[#0f0f1a] border-[#2a2a40] text-white' : 'bg-gray-50 border-gray-300 text-gray-900'}`}
            />
            <button
              onClick={() => { onKeywordUpdate(kw); setEditKw(false); }}
              className="px-2 py-1 text-[11px] rounded bg-[#03c75a] text-white"
            >
              저장
            </button>
            <button onClick={() => setEditKw(false)} className={`px-2 py-1 text-[11px] rounded ${dark ? 'bg-[#2a2a40] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
              취소
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditKw(true)}
            className={`text-[11px] ${product.track_keyword ? 'text-[#06b6d4]' : dark ? 'text-gray-500' : 'text-gray-400'} hover:underline`}
          >
            순위키워드: {product.track_keyword || '미설정 (클릭하여 설정)'}
          </button>
        )}
      </div>

      {/* 최신 스냅샷 요약 */}
      {snap ? (
        <div className={`rounded-lg p-2 ${dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'}`}>
          <div className="grid grid-cols-4 gap-2 text-center text-[11px] mb-2">
            <div>
              <p className={dark ? 'text-gray-500' : 'text-gray-400'}>가격</p>
              <p className={`font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>{snap.price ? fmt(snap.price) + '원' : '-'}</p>
            </div>
            <div>
              <p className={dark ? 'text-gray-500' : 'text-gray-400'}>순위</p>
              <p className={`font-bold ${snap.rank_position ? 'text-[#f59e0b]' : dark ? 'text-gray-500' : 'text-gray-400'}`}>
                {snap.rank_position ? `${snap.rank_position}위` : '-'}
              </p>
            </div>
            <div>
              <p className={dark ? 'text-gray-500' : 'text-gray-400'}>오늘구매</p>
              <p className={`font-bold ${snap.recent_purchase_count != null && snap.recent_purchase_count > 0 ? 'text-[#06b6d4]' : dark ? 'text-gray-500' : 'text-gray-400'}`}>
                {snap.recent_purchase_count != null ? fmt(snap.recent_purchase_count) : '-'}
              </p>
            </div>
            <div>
              <p className={dark ? 'text-gray-500' : 'text-gray-400'}>추정판매</p>
              <p className={`font-bold ${snap.estimated_sales > 0 ? 'text-[#03c75a]' : dark ? 'text-gray-500' : 'text-gray-400'}`}>
                {snap.estimated_sales > 0 ? `+${snap.estimated_sales}` : '-'}
              </p>
            </div>
          </div>
          {snap.purchase_count != null && (
            <div className={`flex items-center justify-between text-[10px] pt-1.5 border-t ${dark ? 'border-[#2a2a40] text-gray-500' : 'border-gray-200 text-gray-400'}`}>
              <span>누적 구매수</span>
              <span className={`font-medium ${dark ? 'text-gray-300' : 'text-gray-700'}`}>{fmt(snap.purchase_count)}건</span>
            </div>
          )}
        </div>
      ) : (
        <p className={`text-[11px] text-center py-2 ${dark ? 'text-gray-600' : 'text-gray-400'}`}>
          아직 수집된 데이터 없음
        </p>
      )}

      {snap && (
        <p className={`text-[10px] mt-1 text-right ${dark ? 'text-gray-600' : 'text-gray-400'}`}>
          최근 수집: {fmtDate(snap.crawled_at)}
        </p>
      )}
    </div>
  );
}

// ── 히스토리 패널 ─────────────────────────────────────────────────────────────

interface HistoryPanelProps {
  product: CompetitorProduct;
  dark: boolean;
}

function HistoryPanel({ product, dark }: HistoryPanelProps) {
  const [snaps, setSnaps] = useState<CompetitorSnapshot[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    competitorApi.snapshots(product.id, days)
      .then(r => setSnaps(r.data))
      .finally(() => setLoading(false));
  }, [product.id, days]);

  const cardBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const chartData = snaps.map(s => ({
    date: fmtDate(s.crawled_at),
    누적구매: s.purchase_count ?? 0,
    오늘구매: s.recent_purchase_count ?? 0,
    추정판매: s.estimated_sales,
    가격: s.price ?? 0,
    순위: s.rank_position ?? 0,
  }));

  return (
    <div className={`rounded-xl border p-4 ${cardBg} ${border}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className={`text-[14px] font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>
            {product.product_name || '상품 히스토리'}
          </h3>
          <p className={`text-[11px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            {product.store_alias} · {product.product_no}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className={`text-[12px] px-2 py-1 rounded border ${dark ? 'bg-[#0f0f1a] border-[#2a2a40] text-white' : 'bg-white border-gray-300 text-gray-900'}`}
          >
            <option value={7}>7일</option>
            <option value={14}>14일</option>
            <option value={30}>30일</option>
            <option value={60}>60일</option>
          </select>
          <button
            onClick={() => competitorApi.exportExcel(product.id)}
            className={`px-3 py-1.5 text-[12px] rounded font-medium ${dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#3a3a55]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            엑셀
          </button>
        </div>
      </div>

      {loading ? (
        <div className={`text-center py-8 text-[13px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>로딩 중...</div>
      ) : snaps.length === 0 ? (
        <div className={`text-center py-8 text-[13px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>수집된 데이터 없음</div>
      ) : (
        <>
          {/* 구매수 · 추정판매량 차트 */}
          <div className="mb-6">
            <p className={`text-[12px] font-medium mb-2 ${dark ? 'text-gray-400' : 'text-gray-600'}`}>일일 추정판매 · 오늘 구매수</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2a2a40' : '#e5e7eb'} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: dark ? '#9ca3af' : '#6b7280' }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: dark ? '#9ca3af' : '#6b7280' }} />
                <Tooltip contentStyle={{ background: dark ? '#1c1c2e' : '#fff', border: `1px solid ${dark ? '#2a2a40' : '#e5e7eb'}`, borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="추정판매" stroke="#03c75a" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="오늘구매" stroke="#06b6d4" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 가격/순위 차트 */}
          <div className="mb-6">
            <p className={`text-[12px] font-medium mb-2 ${dark ? 'text-gray-400' : 'text-gray-600'}`}>가격 · 순위</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2a2a40' : '#e5e7eb'} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: dark ? '#9ca3af' : '#6b7280' }} interval="preserveStartEnd" />
                <YAxis yAxisId="price" tick={{ fontSize: 10, fill: dark ? '#9ca3af' : '#6b7280' }} />
                <YAxis yAxisId="rank" orientation="right" tick={{ fontSize: 10, fill: dark ? '#9ca3af' : '#6b7280' }} reversed />
                <Tooltip contentStyle={{ background: dark ? '#1c1c2e' : '#fff', border: `1px solid ${dark ? '#2a2a40' : '#e5e7eb'}`, borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="price" type="monotone" dataKey="가격" stroke="#0078d7" strokeWidth={2} dot={false} />
                <Line yAxisId="rank" type="monotone" dataKey="순위" stroke="#e879f9" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 스냅샷 테이블 */}
          <div className={`rounded-lg overflow-hidden border ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
            <table className="w-full text-[12px]">
              <thead>
                <tr className={dark ? 'bg-[#0f0f1a] text-gray-400' : 'bg-gray-50 text-gray-600'}>
                  <th className="px-3 py-2 text-left">수집일시</th>
                  <th className="px-3 py-2 text-right">가격</th>
                  <th className="px-3 py-2 text-right">누적구매</th>
                  <th className="px-3 py-2 text-right">오늘구매</th>
                  <th className="px-3 py-2 text-right">순위</th>
                  <th className="px-3 py-2 text-right">추정판매</th>
                </tr>
              </thead>
              <tbody>
                {[...snaps].reverse().map(s => (
                  <tr key={s.id} className={`border-t ${dark ? 'border-[#2a2a40] text-gray-300 hover:bg-[#0f0f1a]' : 'border-gray-100 text-gray-700 hover:bg-gray-50'}`}>
                    <td className="px-3 py-2">{fmtDate(s.crawled_at)}</td>
                    <td className="px-3 py-2 text-right">{s.price ? fmt(s.price) + '원' : '-'}</td>
                    <td className="px-3 py-2 text-right">{s.purchase_count != null ? fmt(s.purchase_count) : '-'}</td>
                    <td className={`px-3 py-2 text-right ${s.recent_purchase_count != null && s.recent_purchase_count > 0 ? 'text-[#06b6d4] font-medium' : ''}`}>
                      {s.recent_purchase_count != null ? fmt(s.recent_purchase_count) : '-'}
                    </td>
                    <td className="px-3 py-2 text-right">{s.rank_position ? `${s.rank_position}위` : '-'}</td>
                    <td className={`px-3 py-2 text-right font-medium ${s.estimated_sales > 0 ? 'text-[#03c75a]' : ''}`}>
                      {s.estimated_sales > 0 ? `+${s.estimated_sales}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export default function CompetitorPage() {
  const { dark } = useTheme();
  const [products, setProducts] = useState<CompetitorProduct[]>([]);
  const [selected, setSelected] = useState<CompetitorProduct | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setCrawling] = useState<Record<number, boolean>>({});
  const [allCrawling, setAllCrawling] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [kwInput, setKwInput] = useState('');
  const [addError, setAddError] = useState('');

  const pageBg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const cardBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const load = useCallback(() => {
    setLoading(true);
    competitorApi.list()
      .then(r => setProducts(r.data))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setAddError('');
    try {
      await competitorApi.add(url, kwInput.trim());
      setUrlInput('');
      setKwInput('');
      load();
    } catch (e: any) {
      setAddError(e.response?.data?.error || '추가 실패');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await competitorApi.remove(id);
    if (selected?.id === id) setSelected(null);
    load();
  };

  const handleCrawlOne = async (id: number) => {
    setCrawling(prev => ({ ...prev, [id]: true }));
    try {
      await competitorApi.crawlOne(id);
      load();
    } finally {
      setCrawling(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleCrawlAll = async () => {
    setAllCrawling(true);
    try {
      await competitorApi.crawlAll();
      // 완료까지 폴링
      const poll = setInterval(async () => {
        const r = await competitorApi.crawlStatus();
        if (!r.data.running) {
          clearInterval(poll);
          setAllCrawling(false);
          load();
        }
      }, 3000);
    } catch {
      setAllCrawling(false);
    }
  };

  const handleKeywordUpdate = async (id: number, kw: string) => {
    await competitorApi.update(id, { track_keyword: kw });
    load();
  };

  return (
    <div className={`min-h-screen ${pageBg} p-4`}>
      <div className="max-w-7xl mx-auto">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className={`text-[18px] font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>타사 상품 분석</h1>
            <p className={`text-[12px] mt-0.5 ${dark ? 'text-gray-500' : 'text-gray-500'}`}>
              경쟁사 상품의 가격·재고·순위를 추적합니다 · 매일 11:00 / 23:50 자동수집
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => competitorApi.exportExcel()}
              className={`px-3 py-2 text-[12px] rounded-lg font-medium border ${dark ? 'border-[#2a2a40] bg-[#1c1c2e] text-gray-300 hover:bg-[#2a2a40]' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              전체 엑셀
            </button>
            <button
              onClick={handleCrawlAll}
              disabled={allCrawling}
              className={`px-3 py-2 text-[12px] rounded-lg font-medium text-white ${allCrawling ? 'bg-gray-400 cursor-not-allowed' : 'bg-[#03c75a] hover:opacity-90'}`}
            >
              {allCrawling ? '수집 중...' : '전체 수집'}
            </button>
          </div>
        </div>

        {/* URL 추가 폼 */}
        <div className={`rounded-xl border p-4 mb-5 ${cardBg} ${border}`}>
          <p className={`text-[13px] font-medium mb-3 ${dark ? 'text-gray-300' : 'text-gray-700'}`}>상품 추가</p>
          <div className="flex gap-2 flex-wrap">
            <input
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="스마트스토어 상품 URL (https://smartstore.naver.com/...)"
              className={`flex-1 min-w-[300px] px-3 py-2 text-[13px] rounded-lg border ${dark ? 'bg-[#0f0f1a] border-[#2a2a40] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400'}`}
            />
            <input
              value={kwInput}
              onChange={e => setKwInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="순위추적 키워드 (선택)"
              className={`w-52 px-3 py-2 text-[13px] rounded-lg border ${dark ? 'bg-[#0f0f1a] border-[#2a2a40] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400'}`}
            />
            <button
              onClick={handleAdd}
              className="px-4 py-2 text-[13px] font-medium rounded-lg bg-[#03c75a] text-white hover:opacity-90"
            >
              추가
            </button>
          </div>
          {addError && <p className="text-red-400 text-[12px] mt-2">{addError}</p>}
        </div>

        {/* 컨텐츠 영역 */}
        {loading ? (
          <div className={`text-center py-16 text-[14px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>로딩 중...</div>
        ) : products.length === 0 ? (
          <div className={`text-center py-16 rounded-xl border ${cardBg} ${border}`}>
            <p className={`text-[14px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>등록된 상품이 없습니다</p>
            <p className={`text-[12px] mt-1 ${dark ? 'text-gray-600' : 'text-gray-300'}`}>위에서 스마트스토어 상품 URL을 추가하세요</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-start">
            {/* 상품 목록 */}
            <div className="flex flex-col gap-3">
              {products.map(p => (
                <ProductCard
                  key={p.id}
                  product={p}
                  dark={dark}
                  selected={selected?.id === p.id}
                  onSelect={() => setSelected(p)}
                  onDelete={() => handleDelete(p.id)}
                  onCrawl={() => handleCrawlOne(p.id)}
                  onKeywordUpdate={kw => handleKeywordUpdate(p.id, kw)}
                />
              ))}
            </div>

            {/* 히스토리 패널 */}
            <div>
              {selected ? (
                <HistoryPanel
                  key={selected.id}
                  product={products.find(p => p.id === selected.id) || selected}
                  dark={dark}
                />
              ) : (
                <div className={`rounded-xl border p-12 text-center ${cardBg} ${border}`}>
                  <p className={`text-[14px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
                    왼쪽 상품을 클릭하면 히스토리를 볼 수 있습니다
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
