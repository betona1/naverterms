import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

const api = axios.create({ baseURL: '/api/naver' });

interface Product {
  id: number;
  name: string;
  url: string;
  is_active: boolean;
  created_at: string;
  latest_purchase: number | null;
  latest_date: string | null;
}

interface Record {
  id: number;
  product_id: number;
  product_name: string;
  product_url: string;
  today_purchase: number;
  record_date: string;
}

export default function ItemScoutPage() {
  const { dark } = useTheme();
  const [products, setProducts] = useState<Product[]>([]);
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null);
  const [days, setDays] = useState(30);

  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = dark
    ? 'bg-[#252540] border-[#3a3a55] text-white placeholder-gray-500 focus:border-[#03c75a]'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-[#03c75a]';

  const loadProducts = useCallback(async () => {
    const res = await api.get('/itemscout/products/');
    setProducts(res.data);
  }, []);

  const loadRecords = useCallback(async () => {
    const params: Record<string, string | number> = { days };
    if (selectedProduct) params.product_id = selectedProduct;
    const res = await api.get('/itemscout/records/', { params });
    setRecords(res.data);
  }, [selectedProduct, days]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  const addProduct = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    setLoading(true);
    try {
      await api.post('/itemscout/products/', { name: newName.trim(), url: newUrl.trim() });
      setNewName(''); setNewUrl(''); setShowAdd(false);
      loadProducts();
    } finally { setLoading(false); }
  };

  const deleteProduct = async (id: number) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api.delete(`/itemscout/products/${id}/`);
    if (selectedProduct === id) setSelectedProduct(null);
    loadProducts();
  };

  // 차트 데이터 구성
  const chartData = (() => {
    const filtered = selectedProduct
      ? records.filter(r => r.product_id === selectedProduct)
      : records;

    const dateMap: Record<string, Record<string, number>> = {};
    for (const r of filtered) {
      if (!dateMap[r.record_date]) dateMap[r.record_date] = {};
      dateMap[r.record_date][r.product_name] = r.today_purchase;
    }
    return Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date: date.slice(5), ...vals }));
  })();

  const productColors = ['#03c75a', '#0078d7', '#f59e0b', '#e879f9', '#fb923c', '#06b6d4'];
  const productNames = [...new Set(records.map(r => r.product_name))];

  // 최근 날짜 기준 테이블 데이터
  const latestDate = records.length ? records.reduce((a, b) => a.record_date > b.record_date ? a : b).record_date : null;
  const todayRecords = latestDate ? records.filter(r => r.record_date === latestDate) : [];

  return (
    <div className="p-4 space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className={`text-lg font-bold ${text}`}>아이템스카우트 판매량 추적</h1>
          <p className={`text-xs mt-0.5 ${sub}`}>매일 11시 50분 자동 수집 · 오늘 구매수 기록</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-3 py-1.5 rounded text-sm font-medium text-white"
          style={{ background: '#03c75a' }}>
          + 상품 추가
        </button>
      </div>

      {/* 상품 추가 폼 */}
      {showAdd && (
        <div className={`border rounded-lg p-4 space-y-3 ${card}`}>
          <p className={`text-sm font-medium ${text}`}>새 상품 추가</p>
          <input
            className={`w-full border rounded px-3 py-2 text-sm outline-none transition-colors ${inputCls}`}
            placeholder="상품명 (예: 신지몰 에어프라이어)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <input
            className={`w-full border rounded px-3 py-2 text-sm outline-none transition-colors ${inputCls}`}
            placeholder="스마트스토어 상품 URL"
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={addProduct}
              disabled={loading}
              className="px-4 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50"
              style={{ background: '#03c75a' }}>
              저장
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className={`px-4 py-1.5 rounded text-sm ${sub} ${dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-100'}`}>
              취소
            </button>
          </div>
        </div>
      )}

      {/* 상품 카드 목록 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {products.map((p, i) => {
          const isSelected = selectedProduct === p.id;
          return (
            <div
              key={p.id}
              onClick={() => setSelectedProduct(isSelected ? null : p.id)}
              className={`border rounded-lg p-4 cursor-pointer transition-all ${card} ${
                isSelected ? 'ring-2 ring-[#03c75a]' : 'hover:border-[#03c75a]/50'
              }`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: productColors[i % productColors.length] }}
                    />
                    <p className={`text-sm font-medium truncate ${text}`}>{p.name}</p>
                  </div>
                  <p className={`text-xs truncate ${sub}`}>{p.url}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); deleteProduct(p.id); }}
                  className={`shrink-0 p-1 rounded hover:bg-red-500/10 text-red-400 hover:text-red-500`}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className={`text-xs ${sub}`}>최근 오늘 구매수</p>
                  <p className="text-2xl font-bold mt-0.5" style={{ color: '#03c75a' }}>
                    {p.latest_purchase !== null ? p.latest_purchase.toLocaleString() : '—'}
                  </p>
                </div>
                {p.latest_date && (
                  <p className={`text-xs ${sub}`}>{p.latest_date}</p>
                )}
              </div>
            </div>
          );
        })}
        {products.length === 0 && (
          <div className={`col-span-3 border rounded-lg p-8 text-center ${card}`}>
            <p className={`text-sm ${sub}`}>추적 중인 상품이 없습니다. 상품을 추가해주세요.</p>
          </div>
        )}
      </div>

      {/* 차트 */}
      {chartData.length > 0 && (
        <div className={`border rounded-lg p-4 ${card}`}>
          <div className="flex items-center justify-between mb-4">
            <p className={`text-sm font-medium ${text}`}>
              {selectedProduct
                ? `${products.find(p => p.id === selectedProduct)?.name} 추이`
                : '전체 상품 추이'}
            </p>
            <select
              value={days}
              onChange={e => setDays(Number(e.target.value))}
              className={`text-xs border rounded px-2 py-1 outline-none ${inputCls}`}>
              <option value={7}>최근 7일</option>
              <option value={14}>최근 14일</option>
              <option value={30}>최근 30일</option>
              <option value={90}>최근 90일</option>
            </select>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={dark ? '#2a2a40' : '#e5e7eb'} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: dark ? '#9ca3af' : '#6b7280' }} />
              <YAxis tick={{ fontSize: 11, fill: dark ? '#9ca3af' : '#6b7280' }} />
              <Tooltip
                contentStyle={{
                  background: dark ? '#1c1c2e' : '#fff',
                  border: `1px solid ${dark ? '#2a2a40' : '#e5e7eb'}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {productNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={productColors[i % productColors.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 기록 테이블 */}
      {records.length > 0 && (
        <div className={`border rounded-lg overflow-hidden ${card}`}>
          <div className={`px-4 py-3 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} flex items-center justify-between`}>
            <p className={`text-sm font-medium ${text}`}>
              수집 기록
              {latestDate && <span className={`ml-2 text-xs font-normal ${sub}`}>최근: {latestDate}</span>}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={dark ? 'bg-[#151526]' : 'bg-gray-50'}>
                  <th className={`text-left px-4 py-2.5 text-xs font-medium ${sub}`}>날짜</th>
                  <th className={`text-left px-4 py-2.5 text-xs font-medium ${sub}`}>상품명</th>
                  <th className={`text-right px-4 py-2.5 text-xs font-medium ${sub}`}>오늘 구매수</th>
                </tr>
              </thead>
              <tbody>
                {records
                  .slice()
                  .sort((a, b) => b.record_date.localeCompare(a.record_date) || a.product_name.localeCompare(b.product_name))
                  .slice(0, 100)
                  .map(r => (
                    <tr key={r.id} className={`border-t ${dark ? 'border-[#2a2a40] hover:bg-[#252540]' : 'border-gray-100 hover:bg-gray-50'}`}>
                      <td className={`px-4 py-2.5 ${sub} text-xs`}>{r.record_date}</td>
                      <td className={`px-4 py-2.5 ${text} text-xs`}>
                        <a href={r.product_url} target="_blank" rel="noopener noreferrer"
                           className="hover:underline" style={{ color: '#03c75a' }}>
                          {r.product_name}
                        </a>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium ${text}`}>
                        {r.today_purchase.toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Windows 스크립트 안내 */}
      <div className={`border rounded-lg p-4 ${card}`}>
        <p className={`text-sm font-medium mb-2 ${text}`}>Windows 자동수집 설정</p>
        <p className={`text-xs mb-3 ${sub}`}>
          Windows PC에서 <code className="px-1 rounded text-xs" style={{ background: dark ? '#252540' : '#f3f4f6' }}>itemscout_crawler.py</code>를
          실행하면 매일 11시 50분에 자동으로 수집됩니다.
        </p>
        <div className={`text-xs rounded p-3 font-mono ${dark ? 'bg-[#0f0f1a] text-gray-300' : 'bg-gray-50 text-gray-700'}`}>
          <p>서버 주소: <span style={{ color: '#03c75a' }}>http://172.30.1.93:8900</span></p>
          <p className="mt-1">스크립트 위치: <span style={{ color: '#03c75a' }}>C:\itemscout\itemscout_crawler.py</span></p>
        </div>
      </div>
    </div>
  );
}
