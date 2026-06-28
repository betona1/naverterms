interface Props {
  page: string;
  onPageChange: (page: string) => void;
  onStoreSettings: () => void;
  onPowerControl: () => void;
  onGpuMonitor: () => void;
  onBrandPolicy: () => void;
  dark: boolean;
  onToggleTheme: () => void;
}

interface SubItem {
  key: string;
  label: string;
}

interface GroupItem {
  key: string;
  label: string;
  color: string;
  page?: string;          // 단일 페이지 그룹 (children 없음)
  children?: SubItem[];   // sub-tab 그룹 (메인 클릭 시 첫 child 로 이동)
}

const NAV_GROUPS: GroupItem[] = [
  { key: 'products',       label: '스마트스토어상품', color: '#03c75a', page: 'products' },
  { key: 'naver-products', label: 'My상품',          color: '#22c55e', children: [
    { key: 'naver-products', label: '상품목록' },
    { key: 'naver-dup',      label: '중복진단' },
  ]},
  { key: 'analytics',      label: '스토어분석',      color: '#10b981', page: 'analytics' },
  { key: 'attr',           label: '상품속성',        color: '#14b8a6', children: [
    { key: 'attr-analytics', label: '상품속성분석' },
    { key: 'missing-attrs',  label: '빈속성검토' },
    { key: 'attr-register',  label: '속성별등록' },
  ]},
  { key: 'ownerclan',      label: '오너클랜상품',    color: '#ff6b35', page: 'ownerclan' },
  { key: 'reports',        label: '보고서',          color: '#ef4444', page: 'reports' },
  { key: 'tools',          label: '도구',            color: '#0078d7', children: [
    { key: 'terms',        label: 'Term 분석' },
    { key: 'synonyms',     label: '동의어' },
    { key: 'autocomplete', label: '자동완성' },
    { key: 'results',      label: '결과보기' },
    { key: 'rank',         label: '순위추적' },
    { key: 'cunning',      label: '순위컨닝' },
    { key: 'purchase',     label: '구매추적' },
    { key: 'keywords',     label: '연관키워드' },
    { key: 'catkeywords',  label: '카테고리키워드' },
    { key: 'competitor',   label: '타사상품분석' },
    { key: 'itemscout',    label: '판매량추적' },
    { key: 'apisettings',  label: 'API설정' },
    { key: 'extension',    label: '도우미프로그램' },
  ]},
];

// page → 속한 그룹 찾기
function findGroup(page: string): GroupItem | undefined {
  for (const g of NAV_GROUPS) {
    if (g.page === page) return g;
    if (g.children?.some(c => c.key === page)) return g;
  }
  return undefined;
}

export default function TopNav({ page, onPageChange, onStoreSettings, onPowerControl, onGpuMonitor, onBrandPolicy, dark, onToggleTheme }: Props) {
  const activeGroup = findGroup(page);
  const subItems = activeGroup?.children;

  const headerBg = dark ? 'bg-[#1a1a2e]' : 'bg-white border-b border-gray-200';
  const subBg = dark ? 'bg-[#13131f] border-t border-[#2a2a40]' : 'bg-gray-50 border-t border-gray-200';

  return (
    <header className={`sticky top-0 z-50 ${headerBg}`}>
      {/* ── 1단: 메인 그룹 ── */}
      <div className="h-[42px] flex items-center px-4 gap-1">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-4 shrink-0">
          <div className="w-6 h-6 rounded flex items-center justify-center text-white font-bold text-[11px]"
               style={{ background: '#03c75a' }}>N</div>
          <span className={`font-bold text-[13px] ${dark ? 'text-white' : 'text-gray-900'}`}>
            스스상품관리
          </span>
        </div>

        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
          {NAV_GROUPS.map(g => {
            const isActive = activeGroup?.key === g.key;
            const hasChildren = !!g.children?.length;
            return (
              <button key={g.key}
                      onClick={() => {
                        if (g.page) onPageChange(g.page);
                        else if (g.children?.length) onPageChange(g.children[0].key);
                      }}
                      className={`relative px-3 pb-[10px] pt-[11px] text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors
                        ${isActive
                          ? `${dark ? 'text-white' : 'text-gray-900'}`
                          : `border-transparent ${dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`
                        }`}
                      style={isActive ? { borderBottomColor: g.color } : undefined}>
                {g.label}
                {hasChildren && (
                  <span className={`ml-1 text-[9px] ${isActive ? 'opacity-80' : 'opacity-50'}`}>▾</span>
                )}
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
          <button onClick={onBrandPolicy}
                  title="브랜드/제조사 화이트·블랙리스트"
                  className={`p-1.5 rounded transition-all
                    ${dark ? 'text-amber-400 hover:text-amber-200 hover:bg-amber-900/30' : 'text-amber-600 hover:text-amber-700 hover:bg-amber-50'}`}>
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5a2 2 0 0 1 1.414.586l7 7a2 2 0 0 1 0 2.828l-7 7a2 2 0 0 1-2.828 0l-7-7A2 2 0 0 1 3 12V7a4 4 0 0 1 4-4z" />
            </svg>
          </button>
          <button onClick={onGpuMonitor}
                  title="워커 모니터링 (GPU + 일반 크롤링)"
                  className={`p-1.5 rounded transition-all
                    ${dark ? 'text-emerald-400 hover:text-emerald-200 hover:bg-emerald-900/30' : 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50'}`}>
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
              <rect x="3" y="6" width="18" height="12" rx="1.5" strokeLinejoin="round" />
              <path strokeLinecap="round" d="M7 10v4M11 10v4M15 10v4" />
            </svg>
          </button>
          <button onClick={onPowerControl}
                  title="원격 전원 관리 (Wake-on-LAN / Shutdown)"
                  className={`p-1.5 rounded transition-all
                    ${dark ? 'text-violet-400 hover:text-violet-200 hover:bg-violet-900/30' : 'text-violet-600 hover:text-violet-700 hover:bg-violet-50'}`}>
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v9" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.36 6.64a9 9 0 11-12.73 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── 2단: sub-tab (활성 그룹 children) ── */}
      {subItems && subItems.length > 0 && (
        <div className={`h-[36px] flex items-center px-4 gap-0.5 ${subBg}`}>
          <span className={`text-[11px] font-bold mr-3 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            ◀ {activeGroup?.label}
          </span>
          <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide">
            {subItems.map(s => {
              const active = page === s.key;
              return (
                <button key={s.key}
                        onClick={() => onPageChange(s.key)}
                        className={`px-2.5 py-1 text-[12px] rounded whitespace-nowrap transition-colors
                          ${active
                            ? `${dark ? 'bg-[#252540] text-white' : 'bg-white shadow text-gray-900 border border-gray-200'}`
                            : `${dark ? 'text-gray-400 hover:text-gray-200 hover:bg-[#1e1e30]' : 'text-gray-600 hover:text-gray-900 hover:bg-white/60'}`
                          }`}
                        style={active ? { boxShadow: `inset 0 -2px 0 ${activeGroup?.color}` } : undefined}>
                  {s.label}
                </button>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
