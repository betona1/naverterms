import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';

interface CunningProduct {
  id: number;
  origin_product_no: number;
  store_name: string;
  store_id: number;
  product_name: string;
  sale_price: number;
  category_id: string;
  product_image_url: string;
  seller_management_code: string;
  status: 'pending' | 'active' | 'done';
  created_at: string;
}

export default function RankCunningPage() {
  const { dark } = useTheme();
  const [products, setProducts] = useState<CunningProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-white' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const tHead = dark ? 'bg-[#151528]' : 'bg-[#f8fafb]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';

  const load = useCallback(async () => {
    try {
      const data = await naverApi.getRankCunningProducts();
      setProducts(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: number) => {
    await naverApi.deleteRankCunningProduct(id);
    setProducts(prev => prev.filter(p => p.id !== id));
  };

  const statusBadge = (s: string) => {
    if (s === 'active') return dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600';
    if (s === 'done') return dark ? 'bg-blue-500/15 text-blue-400' : 'bg-blue-50 text-blue-600';
    return dark ? 'bg-orange-500/15 text-orange-400' : 'bg-orange-50 text-orange-600';
  };
  const statusLabel = (s: string) => s === 'active' ? '진행중' : s === 'done' ? '완료' : '대기';

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-[13px]"
               style={{ background: '#ec4899' }}>C</div>
          <div>
            <h1 className={`text-[18px] font-extrabold ${txt}`}>순위컨닝</h1>
            <p className={`text-[12px] ${txtSub}`}>스마트스토어 상품을 선택하여 순위 컨닝 테스트</p>
          </div>
        </div>
        <span className={`text-[12px] ${txtSub}`}>{products.length}개 상품</span>
      </div>

      {/* 테이블 */}
      <div className={`rounded-xl border overflow-hidden ${card}`}>
        {loading ? (
          <div className={`text-center py-16 ${txtMuted}`}>로딩 중...</div>
        ) : products.length === 0 ? (
          <div className={`text-center py-16 ${txtMuted}`}>
            <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            <p className="text-[14px]">등록된 상품이 없습니다</p>
            <p className="text-[12px] mt-1">스마트스토어 상품 탭에서 상품을 체크 후 "순위컨닝" 버튼을 눌러주세요</p>
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className={tHead}>
                <th className={`px-3 py-2.5 text-left ${txtSub} w-10`}>#</th>
                <th className={`px-3 py-2.5 text-left ${txtSub}`}>상품</th>
                <th className={`px-3 py-2.5 text-left ${txtSub}`}>스토어</th>
                <th className={`px-3 py-2.5 text-right ${txtSub}`}>가격</th>
                <th className={`px-3 py-2.5 text-left ${txtSub}`}>W코드</th>
                <th className={`px-3 py-2.5 text-center ${txtSub}`}>상태</th>
                <th className={`px-3 py-2.5 text-right ${txtSub}`}>등록일</th>
                <th className={`px-3 py-2.5 text-center ${txtSub} w-10`}></th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, idx) => (
                <tr key={p.id} className={`border-t transition-colors ${tRow}`}>
                  <td className={`px-3 py-2.5 ${txtMuted}`}>{idx + 1}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      {p.product_image_url ? (
                        <img src={p.product_image_url} alt="" className="w-9 h-9 rounded object-cover shrink-0" />
                      ) : (
                        <div className={`w-9 h-9 rounded ${dark ? 'bg-[#2a2a40]' : 'bg-gray-100'} shrink-0`} />
                      )}
                      <span className={`font-bold ${txt} line-clamp-1`}>{p.product_name}</span>
                    </div>
                  </td>
                  <td className={`px-3 py-2.5 ${txtSub}`}>{p.store_name}</td>
                  <td className={`px-3 py-2.5 text-right font-bold ${txt}`}>{p.sale_price.toLocaleString()}원</td>
                  <td className={`px-3 py-2.5 font-mono text-[10px] ${txtMuted}`}>{p.seller_management_code}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${statusBadge(p.status)}`}>
                      {statusLabel(p.status)}
                    </span>
                  </td>
                  <td className={`px-3 py-2.5 text-right text-[11px] ${txtMuted}`}>
                    {p.created_at ? new Date(p.created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '-'}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <button
                      onClick={() => handleDelete(p.id)}
                      className={`w-6 h-6 rounded-full flex items-center justify-center transition ${
                        dark ? 'hover:bg-red-900/40 text-red-400' : 'hover:bg-red-50 text-red-400'
                      }`}
                      title="삭제"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
