import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';
import * as naverApi from '../../api/naverApi';
import { NaverShoppingIcon } from './NaverIcon';

interface Props {
  keywordId: number;
  keyword: string;
  terms: string[];
  onClose: () => void;
}

interface Product {
  productName: string; mallName: string;
  category1Name?: string; category2Name?: string; category3Name?: string; category4Name?: string;
  attributeValue?: string; characterValue?: string; manuTag?: string;
  brand?: string; maker?: string; reviewCount?: number; openDate?: string; imageUrl?: string;
}

const TAB_MAP: Record<string, string> = { total: '전체', model: '가격비교', checkout: '네이버페이' };

export default function ProductPopup({ keywordId, keyword, terms, onClose }: Props) {
  const { dark } = useTheme();
  const [products, setProducts] = useState<Product[]>([]);
  const [tabTotals, setTabTotals] = useState<Record<string, number>>({});
  const [currentTab, setCurrentTab] = useState('total');
  const [filter, setFilter] = useState<{ termA: string; termB: string } | null>(null);

  const loadTab = useCallback(async (tab: string) => {
    try {
      const data = await naverApi.getProducts(keywordId, tab);
      setProducts(data.products || []);
      setTabTotals(prev => ({ ...prev, [tab]: data.total || 0 }));
    } catch (e) { console.error(e); }
  }, [keywordId]);

  useEffect(() => {
    ['total', 'model', 'checkout'].forEach(async tab => {
      try { const d = await naverApi.getProducts(keywordId, tab); setTabTotals(prev => ({ ...prev, [tab]: d.total || 0 })); } catch {}
    });
    loadTab('total');
  }, [keywordId, loadTab]);

  const handleTabClick = (tab: string) => { setCurrentTab(tab); setFilter(null); loadTab(tab); };

  const getCategory = (p: Product) => [p.category1Name, p.category2Name, p.category3Name, p.category4Name].filter(Boolean).join(' > ');

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const highlightName = (name: string) => {
    if (!terms.length) return name;
    let html = name;
    const primary = filter ? [filter.termA, filter.termB] : [];
    const secondary = terms.filter(t => t && !primary.includes(t));
    for (const t of [...primary].filter(Boolean).sort((a, b) => b.length - a.length))
      html = html.replace(new RegExp(`(${esc(t)})`, 'g'), '<span style="color:#03c75a;font-weight:700">$1</span>');
    for (const t of secondary.sort((a, b) => b.length - a.length))
      html = html.replace(new RegExp(`(?<!">)(${esc(t)})(?!</span>)`, 'g'), '<span style="color:#ff6b6b;font-weight:700">$1</span>');
    return html;
  };

  const displayed = filter
    ? products.slice(0, 10).filter(p => { const n = (p.productName || '').toLowerCase(); return n.includes(filter.termA.toLowerCase()) && n.includes(filter.termB.toLowerCase()); })
    : products;

  const handleSaveTags = async () => {
    try {
      const stats = await naverApi.getTagStats(keywordId);
      const csv = '\uFEFF태그,중복수\n' + stats.map((s: any) => `${s.tag},${s.count}`).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${keyword}_태그통계.csv`; a.click();
    } catch (e) { console.error(e); }
  };

  // 스타일
  const overlay = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  const panel = dark ? 'bg-[#141422] border-[#2a2a40]' : 'bg-white border-gray-200';
  const head = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const txt = dark ? 'text-white' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#1c1c30]' : 'border-gray-100 hover:bg-gray-50';

  return (
    <div className={overlay} onClick={onClose} style={{ fontFamily: "'NanumSquare', sans-serif" }}>
      <div className={`bg-black/60 absolute inset-0`} />
      <div className={`relative rounded-2xl border shadow-2xl w-full max-w-[1500px] max-h-[88vh] flex flex-col ${panel}`} onClick={e => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={`flex items-center gap-3 px-5 py-4 border-b ${head}`}>
          <NaverShoppingIcon size={22} />
          <h3 className={`text-[15px] font-extrabold ${txt}`}>{keyword}</h3>
          <span className={`text-[12px] ${txtSub}`}>상품 목록</span>
          <button onClick={onClose} className={`ml-auto w-8 h-8 flex items-center justify-center rounded-full transition ${dark ? 'hover:bg-[#333] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        {/* 탭 */}
        <div className={`flex items-center gap-2 px-5 py-3 border-b ${head}`}>
          {Object.entries(TAB_MAP).map(([key, label]) => (
            <button key={key} onClick={() => handleTabClick(key)}
              className={`px-4 py-2 rounded-lg text-[12px] font-bold transition ${
                currentTab === key
                  ? 'bg-[#03c75a] text-white shadow-md shadow-[#03c75a]/20'
                  : (dark ? 'bg-[#1c1c2e] text-gray-400 hover:text-white hover:bg-[#2a2a40]' : 'bg-gray-100 text-gray-500 hover:text-gray-700 hover:bg-gray-200')
              }`}>
              {label} <span className="ml-1 opacity-80">{(tabTotals[key] || 0).toLocaleString()}</span>
            </button>
          ))}
        </div>

        {/* 필터 */}
        <div className={`flex items-center gap-2 px-5 py-2.5 border-b flex-wrap ${head}`}>
          {terms.map((t, i) => {
            if (i >= terms.length - 1 || !t || !terms[i + 1]) return null;
            return (
              <button key={i} onClick={() => setFilter({ termA: t, termB: terms[i + 1] })}
                className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${
                  filter?.termA === t && filter?.termB === terms[i + 1]
                    ? 'bg-[#03c75a] text-white' : (dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')
                }`}>
                {t}+{terms[i + 1]}
              </button>
            );
          })}
          <button onClick={() => setFilter(null)}
            className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${
              !filter ? 'bg-[#03c75a] text-white' : (dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')
            }`}>
            전체보기
          </button>
          <div className="ml-auto flex gap-2">
            <button onClick={() => naverApi.downloadTermsExcel()}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${dark ? 'bg-[#1a3a5c] text-blue-300 hover:bg-[#1f4570]' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
              엑셀저장
            </button>
            <button onClick={handleSaveTags}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${dark ? 'bg-[#3a1a5c] text-purple-300 hover:bg-[#451f70]' : 'bg-purple-50 text-purple-600 hover:bg-purple-100'}`}>
              태그저장
            </button>
          </div>
        </div>

        {/* 테이블 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`sticky top-0 z-10 ${tHead}`}>
              <tr className={txtSub}>
                <th className="px-3 py-2.5 text-left font-bold w-8">#</th>
                <th className="px-3 py-2.5 text-left font-bold min-w-[350px]">상품명</th>
                <th className="px-3 py-2.5 text-left font-bold">스토어</th>
                <th className="px-3 py-2.5 text-left font-bold">카테고리</th>
                <th className="px-3 py-2.5 text-left font-bold">속성</th>
                <th className="px-3 py-2.5 text-left font-bold">속성값</th>
                <th className="px-3 py-2.5 text-left font-bold">태그</th>
                <th className="px-3 py-2.5 text-left font-bold">브랜드</th>
                <th className="px-3 py-2.5 text-left font-bold">제조사</th>
                <th className="px-3 py-2.5 text-right font-bold">리뷰</th>
                <th className="px-3 py-2.5 text-left font-bold">등록일</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((p, idx) => (
                <tr key={idx} className={`border-t transition-colors ${tRow}`}>
                  <td className={`px-3 py-2 ${txtSub}`}>{idx + 1}</td>
                  <td className="px-3 py-2"><span className={txt} dangerouslySetInnerHTML={{ __html: highlightName(p.productName || '') }} /></td>
                  <td className={`px-3 py-2 font-medium ${txt}`}>{p.mallName}</td>
                  <td className={`px-3 py-2 text-[10px] ${txtSub}`}>{getCategory(p)}</td>
                  <td className={`px-3 py-2 ${txtSub}`}>{p.attributeValue}</td>
                  <td className={`px-3 py-2 ${txtSub}`}>{p.characterValue}</td>
                  <td className={`px-3 py-2 text-[10px] ${txtSub}`}>{p.manuTag}</td>
                  <td className={`px-3 py-2 ${txt}`}>{p.brand}</td>
                  <td className={`px-3 py-2 ${txt}`}>{p.maker}</td>
                  <td className={`px-3 py-2 text-right font-medium ${txt}`}>{p.reviewCount?.toLocaleString()}</td>
                  <td className={`px-3 py-2 ${txtSub}`}>{p.openDate}</td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <tr><td colSpan={11} className={`text-center py-16 ${txtSub}`}>상품 데이터가 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
