import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../../hooks/useTheme';
import * as naverApi from '../../api/naverApi';
import { NaverShoppingIcon } from './NaverIcon';
import { useNaverExtension } from './useNaverExtension';

interface Props {
  keywordId: number;
  keyword: string;
  terms: string[];
  initialTab?: string;
  onClose: () => void;
}

interface Product {
  productName: string; mallName: string;
  category1Name?: string; category2Name?: string; category3Name?: string; category4Name?: string;
  attributeValue?: string; characterValue?: string; manuTag?: string;
  brand?: string; maker?: string; reviewCount?: number; openDate?: string; imageUrl?: string;
  lowPrice?: string | number;
  nvMid?: string; id?: string;
  additionalImageCount?: number;
  smryReview?: string;
  keepCnt?: number;
  mallCount?: number;
  dlvryPrice?: string | number; dlvryLowPrice?: string | number;
}

const TAB_MAP: Record<string, string> = { total: '전체', model: '가격비교', checkout: '네이버페이' };

export default function ProductPopup({ keywordId, keyword, terms, initialTab, onClose }: Props) {
  const { dark } = useTheme();
  const [products, setProducts] = useState<Product[]>([]);
  const [tabTotals, setTabTotals] = useState<Record<string, number>>({});
  const [currentTab, setCurrentTab] = useState(initialTab || 'total');
  const [filter, setFilter] = useState<{ termA: string; termB: string } | null>(null);
  const [hoverImg, setHoverImg] = useState<{ url: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [purchaseChecked, setPurchaseChecked] = useState<Set<number>>(new Set());
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const { extStatus, startTermSearch } = useNaverExtension();

  // ── 다시수집 — 확장프로그램 배치 모드로 3탭 모두 재수집 ──
  const handleReCollect = useCallback(() => {
    if (!extStatus.connected) {
      if (confirm('확장프로그램이 연결되지 않았습니다. 설치 안내 페이지로 이동하시겠습니까?')) {
        window.location.hash = 'extension';
      }
      return;
    }
    if (!confirm(`"${keyword}" 키워드를 다시수집합니다.\n전체/가격비교/네이버페이 3개 탭 모두 재수집됩니다.\n\n진행하시겠습니까?`)) return;
    startTermSearch([keyword], ['model', 'total', 'checkout']);
    onClose();
  }, [extStatus.connected, keyword, startTermSearch, onClose]);

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
    loadTab(initialTab || 'total');
  }, [keywordId, initialTab, loadTab]);

  const handleTabClick = (tab: string) => { setCurrentTab(tab); setFilter(null); loadTab(tab); };

  const getCategory = (p: Product) => [p.category1Name, p.category2Name, p.category3Name, p.category4Name].filter(Boolean).join(' > ');
  const getPid = (p: Product) => p.nvMid || p.id || '';
  const getDlvry = (p: Product) => { const v = p.dlvryPrice ?? p.dlvryLowPrice; return v != null ? Number(v) : ''; };

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

  // 이미지 hover
  const onImgEnter = (url: string, e: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverImg({ url, x: rect.right + 8, y: rect.top });
  };
  const onImgLeave = () => {
    hoverTimer.current = setTimeout(() => setHoverImg(null), 150);
  };

  // 엑셀저장 — backend 호출 (3시트, 이미지 없음 — 빠름)
  const handleExportExcel = async () => {
    const url = `/api/naver/export/products/${keywordId}/`;
    window.open(url, '_blank');
  };

  // 엑셀+이미지저장 — backend 가 PIL 로 fetch+리사이즈+임베드 (~3-10초)
  const handleExportExcelWithImages = async () => {
    if (!confirm(`📊🖼 Excel + 이미지 다운로드\n\n40개 상품 이미지를 fetch + 리사이즈해 셀에 임베드합니다.\n수 초~수십 초 소요될 수 있습니다.\n\n진행하시겠습니까?`)) return;
    const url = `/api/naver/export/products/${keywordId}/?images=true`;
    window.open(url, '_blank');
  };

  const handleSaveTags = async () => {
    try {
      const XLSX = await import('xlsx');
      const stats = await naverApi.getTagStats(keywordId);
      const headers = ['태그', '중복수'];
      const data = stats.map((s: any) => [s.tag, s.count]);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '태그통계');
      XLSX.writeFile(wb, `${keyword}_태그통계.xlsx`);
    } catch (e) { console.error(e); }
  };

  // 구매추적 등록
  const handlePurchaseRegister = async () => {
    const indices = [...purchaseChecked].sort();
    if (!indices.length) return;
    setPurchaseBusy(true);
    let count = 0;
    for (const idx of indices) {
      const p = displayed[idx];
      if (!p) continue;
      const pid = getPid(p);
      if (!pid) continue;
      try {
        await naverApi.addPurchaseTarget({
          nv_mid: pid,
          product_name: p.productName || '',
          store_name: p.mallName || '',
          image_url: p.imageUrl || '',
          category: getCategory(p),
          source_keyword: keyword,
          source_rank: idx + 1,
        });
        count++;
      } catch {}
    }
    setPurchaseBusy(false);
    setPurchaseChecked(new Set());
    alert(`${count}개 상품이 구매추적에 등록되었습니다`);
  };

  const togglePurchaseCheck = (idx: number) => {
    setPurchaseChecked(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
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
      <div className={`relative rounded-2xl border shadow-2xl w-full max-w-[1800px] max-h-[88vh] flex flex-col ${panel}`} onClick={e => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={`flex items-center gap-3 px-5 py-4 border-b ${head}`}>
          <NaverShoppingIcon size={22} />
          <h3 className={`text-[15px] font-extrabold ${txt}`}>{keyword}</h3>
          <span className={`text-[12px] ${txtSub}`}>상품 목록 — {TAB_MAP[currentTab]}</span>
          <span className={`text-[12px] font-bold text-[#03c75a]`}>{displayed.length}개</span>
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
            <button onClick={handleExportExcel}
              title="Excel 다운로드 (이미지 없음 — 빠름)"
              className={`px-2.5 py-1.5 rounded-md text-[12px] font-bold transition ${dark ? 'bg-[#1a3a5c] text-blue-300 hover:bg-[#1f4570]' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
              📊 xls
            </button>
            <button onClick={handleExportExcelWithImages}
              title="Excel + 40개 상품 이미지 임베드 (~10초)"
              className={`px-2.5 py-1.5 rounded-md text-[12px] font-bold transition ${dark ? 'bg-[#3a1a5c] text-purple-300 hover:bg-[#451f70]' : 'bg-purple-50 text-purple-600 hover:bg-purple-100'}`}>
              📊🖼 xls+이미지
            </button>
            <button onClick={handleReCollect}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${dark ? 'bg-[#1a5c3a] text-green-300 hover:bg-[#1f7045]' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}
              title={extStatus.connected ? '확장프로그램으로 3탭 재수집' : '확장프로그램 미연결'}>
              🔄 다시수집
            </button>
            <button onClick={handleSaveTags}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition ${dark ? 'bg-[#3a1a5c] text-purple-300 hover:bg-[#451f70]' : 'bg-purple-50 text-purple-600 hover:bg-purple-100'}`}>
              태그저장
            </button>
            <button onClick={handlePurchaseRegister} disabled={purchaseBusy || !purchaseChecked.size}
              className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition disabled:opacity-40 ${dark ? 'bg-[#5c3a1a] text-orange-300 hover:bg-[#704520]' : 'bg-orange-50 text-orange-600 hover:bg-orange-100'}`}>
              구매추적 ({purchaseChecked.size})
            </button>
          </div>
        </div>

        {/* 테이블 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className={`sticky top-0 z-10 ${tHead}`}>
              <tr className={txtSub}>
                <th className="px-1 py-2.5 text-center font-bold w-6">
                  <input type="checkbox" className="accent-[#f97316]"
                    checked={purchaseChecked.size > 0 && purchaseChecked.size === displayed.length}
                    onChange={e => {
                      if (e.target.checked) setPurchaseChecked(new Set(displayed.map((_, i) => i)));
                      else setPurchaseChecked(new Set());
                    }} />
                </th>
                <th className="px-3 py-2.5 text-left font-bold w-8">#</th>
                <th className="px-2 py-2.5 text-center font-bold w-12">IMG</th>
                <th className="px-3 py-2.5 text-left font-bold">상품ID</th>
                <th className="px-3 py-2.5 text-left font-bold min-w-[260px]">상품명</th>
                <th className="px-3 py-2.5 text-left font-bold">스토어</th>
                <th className="px-3 py-2.5 text-left font-bold">카테고리</th>
                <th className="px-3 py-2.5 text-left font-bold">속성</th>
                <th className="px-3 py-2.5 text-left font-bold">속성값</th>
                <th className="px-3 py-2.5 text-left font-bold">태그</th>
                <th className="px-3 py-2.5 text-left font-bold">브랜드</th>
                <th className="px-3 py-2.5 text-left font-bold">제조사</th>
                <th className="px-3 py-2.5 text-right font-bold">리뷰</th>
                <th className="px-3 py-2.5 text-left font-bold">리뷰요약</th>
                <th className="px-3 py-2.5 text-right font-bold">찜수</th>
                <th className="px-3 py-2.5 text-left font-bold">등록일</th>
                <th className="px-3 py-2.5 text-right font-bold">가격</th>
                <th className="px-3 py-2.5 text-right font-bold">배송비</th>
                <th className="px-3 py-2.5 text-right font-bold">추가IMG</th>
                <th className="px-3 py-2.5 text-right font-bold">쇼핑몰수</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((p, idx) => (
                <tr key={idx} className={`border-t transition-colors ${tRow}`}>
                  <td className="px-1 py-1.5 text-center">
                    <input type="checkbox" className="accent-[#f97316]"
                      checked={purchaseChecked.has(idx)}
                      onChange={() => togglePurchaseCheck(idx)} />
                  </td>
                  <td className={`px-3 py-1.5 ${txtSub}`}>{idx + 1}</td>
                  <td className="px-2 py-1.5 text-center">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="w-10 h-10 object-cover rounded-md cursor-pointer border border-transparent hover:border-[#03c75a] transition"
                        loading="lazy"
                        onMouseEnter={e => onImgEnter(p.imageUrl!, e)}
                        onMouseLeave={onImgLeave}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <span className={`inline-flex w-10 h-10 items-center justify-center rounded-md text-[9px] ${dark ? 'bg-[#2a2a40] text-gray-600' : 'bg-gray-100 text-gray-300'}`}>N/A</span>
                    )}
                  </td>
                  <td className={`px-3 py-1.5 text-[10px] font-mono ${txtSub}`}>{getPid(p)}</td>
                  <td className="px-3 py-1.5"><span className={txt} dangerouslySetInnerHTML={{ __html: highlightName(p.productName || '') }} /></td>
                  <td className={`px-3 py-1.5 font-medium ${txt}`}>{p.mallName}</td>
                  <td className={`px-3 py-1.5 text-[10px] ${txtSub}`}>{getCategory(p)}</td>
                  <td className={`px-3 py-1.5 ${txtSub}`}>{p.attributeValue}</td>
                  <td className={`px-3 py-1.5 ${txtSub}`}>{p.characterValue}</td>
                  <td className={`px-3 py-1.5 text-[10px] ${txtSub}`}>{p.manuTag}</td>
                  <td className={`px-3 py-1.5 ${txt}`}>{p.brand}</td>
                  <td className={`px-3 py-1.5 ${txt}`}>{p.maker}</td>
                  <td className={`px-3 py-1.5 text-right font-medium ${txt}`}>{p.reviewCount?.toLocaleString()}</td>
                  <td className={`px-3 py-1.5 text-[10px] ${txtSub}`}>{p.smryReview}</td>
                  <td className={`px-3 py-1.5 text-right ${txt}`}>{p.keepCnt?.toLocaleString()}</td>
                  <td className={`px-3 py-1.5 ${txtSub}`}>{p.openDate}</td>
                  <td className={`px-3 py-1.5 text-right font-medium ${txt}`}>{p.lowPrice ? Number(p.lowPrice).toLocaleString() : ''}</td>
                  <td className={`px-3 py-1.5 text-right ${txtSub}`}>{getDlvry(p) !== '' ? Number(getDlvry(p)).toLocaleString() : ''}</td>
                  <td className={`px-3 py-1.5 text-right ${txtSub}`}>{p.additionalImageCount}</td>
                  <td className={`px-3 py-1.5 text-right ${txtSub}`}>{p.mallCount}</td>
                </tr>
              ))}
              {displayed.length === 0 && (
                <tr><td colSpan={21} className={`text-center py-16 ${txtSub}`}>상품 데이터가 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 이미지 확대 모달 */}
      {hoverImg && (
        <div
          className="fixed z-[60] pointer-events-none"
          style={{
            left: Math.min(hoverImg.x, window.innerWidth - 320),
            top: Math.max(8, Math.min(hoverImg.y, window.innerHeight - 320)),
          }}
        >
          <div className={`rounded-xl shadow-2xl border overflow-hidden ${dark ? 'border-[#2a2a40] bg-[#141422]' : 'border-gray-300 bg-white'}`}>
            <img
              src={hoverImg.url}
              alt=""
              className="w-[300px] h-[300px] object-contain"
              onError={e => { (e.target as HTMLImageElement).src = ''; setHoverImg(null); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
