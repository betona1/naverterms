import { useState, useEffect, useCallback } from 'react';
import { useTheme } from './hooks/useTheme';
import TopNav from './components/TopNav';
import StoreSettingsModal from './components/smartstore/StoreSettingsModal';
import NaverTermsPage from './pages/NaverTermsPage';
import NaverRankPage from './pages/NaverRankPage';
import NaverExtDownloadPage from './pages/NaverExtDownloadPage';
import SmartStoreProductsPage from './pages/SmartStoreProductsPage';
import OwnerClanProductsPage from './pages/OwnerClanProductsPage';
import SmartStoreAnalyticsPage from './pages/SmartStoreAnalyticsPage';
import NaverKeywordPage from './pages/NaverKeywordPage';
import NaverCategoryKeywordPage from './pages/NaverCategoryKeywordPage';
import ReportsPage from './pages/ReportsPage';
import RankCunningPage from './pages/RankCunningPage';
import StoreCollectPage from './pages/StoreCollectPage';
import ProductEditPage from './pages/ProductEditPage';

const PAGE_KEY = 'nt-page';

const HASH_MAP: Record<string, string> = {
  '#terms': 'terms',
  '#rank': 'rank',
  '#products': 'products',
  '#extension': 'extension',
  '#ownerclan': 'ownerclan',
  '#keywords': 'keywords',
  '#catkeywords': 'catkeywords',
  '#analytics': 'analytics',
  '#cunning': 'cunning',
  '#reports': 'reports',
  '#store-collect': 'store-collect',
};

export default function App() {
  const { dark, toggle } = useTheme();
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash && HASH_MAP[hash]) return HASH_MAP[hash];
    try { return localStorage.getItem(PAGE_KEY) || 'products'; } catch { return 'products'; }
  });
  const [showStoreSettings, setShowStoreSettings] = useState(false);

  const changePage = useCallback((p: string) => {
    setPage(p);
    window.location.hash = p;
    try { localStorage.setItem(PAGE_KEY, p); } catch { /* */ }
  }, []);

  useEffect(() => {
    const onHash = () => {
      const raw = window.location.hash.replace('#', '');
      const h = raw.split('?')[0];
      if (h === 'product-edit') {
        setPage('product-edit');
        return;
      }
      if (h && ['terms', 'rank', 'products', 'extension', 'ownerclan', 'analytics', 'keywords', 'catkeywords', 'cunning', 'reports', 'store-collect'].includes(h)) {
        setPage(h);
        try { localStorage.setItem(PAGE_KEY, h); } catch { /* */ }
      }
    };
    window.addEventListener('hashchange', onHash);
    // 초기 해시가 product-edit인 경우
    const initHash = window.location.hash.replace('#', '').split('?')[0];
    if (initHash === 'product-edit') setPage('product-edit');
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pageBg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';

  return (
    <div className={dark ? 'dark' : ''}>
      <div className={`min-h-screen ${pageBg}`}>
        <TopNav
          page={page}
          onPageChange={changePage}
          onStoreSettings={() => setShowStoreSettings(true)}
          dark={dark}
          onToggleTheme={toggle}
        />
        <main className="min-h-[calc(100vh-42px)]">
          {page === 'terms' && <NaverTermsPage />}
          {page === 'rank' && <NaverRankPage />}
          {page === 'products' && <SmartStoreProductsPage />}
          {page === 'extension' && <NaverExtDownloadPage />}
          {page === 'keywords' && <NaverKeywordPage />}
          {page === 'catkeywords' && <NaverCategoryKeywordPage />}
          {page === 'ownerclan' && <OwnerClanProductsPage />}
          {page === 'analytics' && <SmartStoreAnalyticsPage />}
          {page === 'cunning' && <RankCunningPage />}
          {page === 'reports' && <ReportsPage />}
          {page === 'store-collect' && <StoreCollectPage />}
          {page === 'product-edit' && <ProductEditPage />}
        </main>
      </div>
      {showStoreSettings && (
        <StoreSettingsModal onClose={() => setShowStoreSettings(false)} />
      )}
    </div>
  );
}
