interface Props {
  page: string;
  onPageChange: (page: string) => void;
  onStoreSettings: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

const NAV_ITEMS = [
  { key: 'products', label: '스마트스토어상품', color: '#03c75a' },
  { key: 'analytics', label: '스토어분석', color: '#10b981' },
  { key: 'terms', label: 'Term 분석', color: '#0078d7' },
  { key: 'rank', label: '순위추적', color: '#f59e0b' },
  { key: 'keywords', label: '연관키워드', color: '#06b6d4' },
  { key: 'ownerclan', label: '오너클랜상품', color: '#ff6b35' },
  { key: 'extension', label: '도우미프로그램', color: '#8b5cf6' },
] as const;

export default function TopNav({ page, onPageChange, onStoreSettings, dark, onToggleTheme }: Props) {
  return (
    <header className={`sticky top-0 z-50 ${dark ? 'bg-[#1a1a2e]' : 'bg-white border-b border-gray-200'}`}>
      <div className="h-[42px] flex items-center px-4 gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-4 shrink-0">
          <div className="w-6 h-6 rounded flex items-center justify-center text-white font-bold text-[11px]"
               style={{ background: '#03c75a' }}>N</div>
          <span className={`font-bold text-[13px] ${dark ? 'text-white' : 'text-gray-900'}`}>
            Term 분석기
          </span>
        </div>

        {/* Tab Buttons */}
        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
          {NAV_ITEMS.map(item => {
            const active = page === item.key;
            return (
              <button key={item.key}
                      onClick={() => onPageChange(item.key)}
                      className={`px-3 pb-[10px] pt-[11px] text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors
                        ${active
                          ? `${dark ? 'text-white' : 'text-gray-900'}`
                          : `border-transparent ${dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`
                        }`}
                      style={active ? { borderBottomColor: item.color } : undefined}>
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Right Side */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button onClick={onStoreSettings}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] transition-colors
                    ${dark ? 'text-gray-400 hover:text-gray-200 hover:bg-[#252540]' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            상점설정
          </button>
          <button onClick={onToggleTheme}
                  className={`p-1.5 rounded transition-colors
                    ${dark ? 'text-gray-500 hover:text-gray-300 hover:bg-[#252540]' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}>
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
          </button>
        </div>
      </div>
    </header>
  );
}
