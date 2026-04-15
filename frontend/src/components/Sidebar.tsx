interface Props {
  page: string;
  onPageChange: (page: string) => void;
  onStoreSettings: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

const NAV_ITEMS = [
  { key: 'terms', label: 'Term 분석', icon: 'M' },
  { key: 'rank', label: '순위추적', icon: 'R' },
  { key: 'products', label: '스마트스토어 상품', icon: 'S' },
  { key: 'extension', label: '확장프로그램', icon: 'E' },
] as const;

export default function Sidebar({ page, onPageChange, onStoreSettings, dark, onToggleTheme }: Props) {
  const bg = dark ? 'bg-[#0d0d1a] border-[#1e1e2e]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-300' : 'text-gray-700';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';

  return (
    <aside className={`fixed top-0 left-0 h-full w-[220px] border-r flex flex-col ${bg}`}
           style={{ zIndex: 40 }}>
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-4 border-b"
           style={{ borderColor: dark ? '#1e1e2e' : '#e5e7eb' }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-sm"
             style={{ background: '#03c75a' }}>N</div>
        <span className={`font-bold text-[13px] ${dark ? 'text-white' : 'text-gray-900'}`}>
          Term 분석기
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map(item => {
          const active = page === item.key;
          const activeBg = dark ? 'bg-[#1a1a2e]' : 'bg-gray-100';
          const activeTxt = dark ? 'text-white' : 'text-gray-900';
          const hoverBg = dark ? 'hover:bg-[#151525]' : 'hover:bg-gray-50';
          return (
            <button key={item.key}
                    onClick={() => onPageChange(item.key)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors
                      ${active ? `${activeBg} ${activeTxt} font-semibold` : `${txt} ${hoverBg}`}`}>
              <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                ${active ? 'bg-[#03c75a] text-white' : dark ? 'bg-[#1e1e2e] text-gray-400' : 'bg-gray-200 text-gray-500'}`}>
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-2 pb-3 space-y-1"
           style={{ borderTop: `1px solid ${dark ? '#1e1e2e' : '#e5e7eb'}` }}>
        <button onClick={onStoreSettings}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${txt} ${dark ? 'hover:bg-[#151525]' : 'hover:bg-gray-50'}`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
          상점설정
        </button>
        <button onClick={onToggleTheme}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${txtMuted} ${dark ? 'hover:bg-[#151525]' : 'hover:bg-gray-50'}`}>
          {dark ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
            </svg>
          )}
          {dark ? '라이트 모드' : '다크 모드'}
        </button>
      </div>
    </aside>
  );
}
