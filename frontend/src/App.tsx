import { useState, useEffect, useCallback } from 'react';
import { useTheme } from './hooks/useTheme';
import Sidebar from './components/Sidebar';
import StoreSettingsModal from './components/smartstore/StoreSettingsModal';
import NaverTermsPage from './pages/NaverTermsPage';
import NaverRankPage from './pages/NaverRankPage';
import NaverExtDownloadPage from './pages/NaverExtDownloadPage';
import SmartStoreProductsPage from './pages/SmartStoreProductsPage';

const PAGE_KEY = 'nt-page';

const HASH_MAP: Record<string, string> = {
  '#terms': 'terms',
  '#rank': 'rank',
  '#products': 'products',
  '#extension': 'extension',
};

export default function App() {
  const { dark, toggle } = useTheme();
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash && HASH_MAP[hash]) return HASH_MAP[hash];
    try { return localStorage.getItem(PAGE_KEY) || 'terms'; } catch { return 'terms'; }
  });
  const [showStoreSettings, setShowStoreSettings] = useState(false);

  const changePage = useCallback((p: string) => {
    setPage(p);
    window.location.hash = p;
    try { localStorage.setItem(PAGE_KEY, p); } catch { /* */ }
  }, []);

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace('#', '');
      if (h && ['terms', 'rank', 'products', 'extension'].includes(h)) {
        setPage(h);
        try { localStorage.setItem(PAGE_KEY, h); } catch { /* */ }
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pageBg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';

  return (
    <div className={dark ? 'dark' : ''}>
      <div className={`min-h-screen ${pageBg}`}>
        <Sidebar
          page={page}
          onPageChange={changePage}
          onStoreSettings={() => setShowStoreSettings(true)}
          dark={dark}
          onToggleTheme={toggle}
        />
        <main className="ml-[220px] min-h-screen">
          {page === 'terms' && <NaverTermsPage />}
          {page === 'rank' && <NaverRankPage />}
          {page === 'products' && <SmartStoreProductsPage />}
          {page === 'extension' && <NaverExtDownloadPage />}
        </main>
      </div>
      {showStoreSettings && (
        <StoreSettingsModal onClose={() => setShowStoreSettings(false)} />
      )}
    </div>
  );
}
