import { useState, useEffect, useCallback } from 'react';
import { useTheme } from './hooks/useTheme';
import TopNav from './components/TopNav';
import StoreSettingsModal from './components/smartstore/StoreSettingsModal';
import PowerControlModal from './components/PowerControlModal';
import GpuMonitorModal from './components/GpuMonitorModal';
import BrandPolicyModal from './components/BrandPolicyModal';
import NaverTermsPage from './pages/NaverTermsPage';
import NaverResultsPage from './pages/NaverResultsPage';
import NaverRankPage from './pages/NaverRankPage';
import NaverExtDownloadPage from './pages/NaverExtDownloadPage';
import SmartStoreProductsPage from './pages/SmartStoreProductsPage';
import OwnerClanProductsPage from './pages/OwnerClanProductsPage';
import SmartStoreAnalyticsPage from './pages/SmartStoreAnalyticsPage';
import NaverKeywordPage from './pages/NaverKeywordPage';
import NaverCategoryKeywordPage from './pages/NaverCategoryKeywordPage';
import NaverSynonymPage from './pages/NaverSynonymPage';
import NaverAutocompletePage from './pages/NaverAutocompletePage';
import ReportsPage from './pages/ReportsPage';
import RankCunningPage from './pages/RankCunningPage';
import PurchaseTrackingPage from './pages/PurchaseTrackingPage';
import StoreCollectPage from './pages/StoreCollectPage';
import ProductEditPage from './pages/ProductEditPage';
import AttrAnalyticsPage from './pages/AttrAnalyticsPage';
import MissingAttrsPage from './pages/MissingAttrsPage';
import AttrRegisterPage from './pages/AttrRegisterPage';
import WorkersPage from './pages/WorkersPage';
import NaverMyProductsPage from './pages/NaverMyProductsPage';
import NaverDupPage from './pages/NaverDupPage';

const PAGE_KEY = 'nt-page';

const HASH_MAP: Record<string, string> = {
  '#terms': 'terms',
  '#synonyms': 'synonyms',
  '#autocomplete': 'autocomplete',
  '#results': 'results',
  '#rank': 'rank',
  '#products': 'products',
  '#extension': 'extension',
  '#ownerclan': 'ownerclan',
  '#keywords': 'keywords',
  '#catkeywords': 'catkeywords',
  '#analytics': 'analytics',
  '#cunning': 'cunning',
  '#purchase': 'purchase',
  '#reports': 'reports',
  '#store-collect': 'store-collect',
  '#attr-analytics': 'attr-analytics',
  '#missing-attrs': 'missing-attrs',
  '#attr-register': 'attr-register',
  '#workers': 'workers',
  '#naver-products': 'naver-products',
  '#naver-dup': 'naver-dup',
};

export default function App() {
  const { dark, toggle } = useTheme();
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash && HASH_MAP[hash]) return HASH_MAP[hash];
    try { return localStorage.getItem(PAGE_KEY) || 'products'; } catch { return 'products'; }
  });
  const [showStoreSettings, setShowStoreSettings] = useState(false);
  const [showPowerControl, setShowPowerControl] = useState(false);
  const [showGpuMonitor, setShowGpuMonitor] = useState(false);
  const [showBrandPolicy, setShowBrandPolicy] = useState(false);

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
      if (h && ['terms', 'synonyms', 'autocomplete', 'results', 'rank', 'products', 'extension', 'ownerclan', 'analytics', 'keywords', 'catkeywords', 'cunning', 'purchase', 'reports', 'store-collect', 'attr-analytics', 'missing-attrs', 'attr-register', 'workers', 'naver-products', 'naver-dup'].includes(h)) {
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
          onPowerControl={() => setShowPowerControl(true)}
          onGpuMonitor={() => setShowGpuMonitor(true)}
          onBrandPolicy={() => setShowBrandPolicy(true)}
          dark={dark}
          onToggleTheme={toggle}
        />
        <main className="min-h-[calc(100vh-42px)]">
          {page === 'terms' && <NaverTermsPage />}
          {page === 'synonyms' && <NaverSynonymPage />}
          {page === 'autocomplete' && <NaverAutocompletePage />}
          {page === 'results' && <NaverResultsPage />}
          {page === 'rank' && <NaverRankPage />}
          {page === 'products' && <SmartStoreProductsPage />}
          {page === 'extension' && <NaverExtDownloadPage />}
          {page === 'keywords' && <NaverKeywordPage />}
          {page === 'catkeywords' && <NaverCategoryKeywordPage />}
          {page === 'ownerclan' && <OwnerClanProductsPage />}
          {page === 'analytics' && <SmartStoreAnalyticsPage />}
          {page === 'cunning' && <RankCunningPage />}
          {page === 'purchase' && <PurchaseTrackingPage />}
          {page === 'reports' && <ReportsPage />}
          {page === 'store-collect' && <StoreCollectPage />}
          {page === 'product-edit' && <ProductEditPage />}
          {page === 'attr-analytics' && <AttrAnalyticsPage />}
          {page === 'missing-attrs' && <MissingAttrsPage />}
          {page === 'attr-register' && <AttrRegisterPage />}
          {page === 'workers' && <WorkersPage />}
          {page === 'naver-products' && <NaverMyProductsPage />}
          {page === 'naver-dup' && <NaverDupPage />}
        </main>
      </div>
      {showStoreSettings && (
        <StoreSettingsModal onClose={() => setShowStoreSettings(false)} />
      )}
      {showPowerControl && (
        <PowerControlModal onClose={() => setShowPowerControl(false)} />
      )}
      {showGpuMonitor && (
        <GpuMonitorModal open={true} onClose={() => setShowGpuMonitor(false)} />
      )}
      {showBrandPolicy && (
        <BrandPolicyModal dark={dark} onClose={() => setShowBrandPolicy(false)} />
      )}
    </div>
  );
}
