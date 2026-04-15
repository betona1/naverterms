interface Props {
  dark: boolean;
  connected: boolean;
  version?: string;
  progress?: {
    keyword?: string; current?: number; total?: number;
    tabLabel?: string; tabProgress?: string;
    nextTabLabel?: string; type?: string;
  } | null;
  captcha?: { active: boolean; type?: string; message?: string };
  onInstallClick?: () => void;
}

export default function ExtensionStatus({ dark, connected, version, progress, captcha, onInstallClick }: Props) {
  if (captcha?.active) {
    return (
      <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium border ${
        dark ? 'bg-yellow-900/30 border-yellow-700/60 text-yellow-300' : 'bg-yellow-50 border-yellow-300 text-yellow-700'
      }`}>
        <span className="w-2.5 h-2.5 bg-yellow-400 rounded-full animate-pulse shrink-0" />
        <span className="font-bold">CAPTCHA 발생</span>
        <span className={dark ? 'text-yellow-400/80' : 'text-yellow-600'}>{captcha.message || 'Chrome 탭에서 해결해주세요'}</span>
      </div>
    );
  }

  if (progress) {
    const isTabComplete = progress.type === 'NAVER_TAB_COMPLETE';
    return (
      <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-medium border ${
        dark ? 'bg-[#03c75a]/10 border-[#03c75a]/30 text-[#03c75a]' : 'bg-green-50 border-green-300 text-green-700'
      }`}>
        <span className="w-2.5 h-2.5 bg-[#03c75a] rounded-full animate-pulse shrink-0" />
        <span>
          {isTabComplete ? (
            <>
              <strong>{progress.keyword}</strong> — {progress.tabLabel} 완료
              {progress.nextTabLabel && <> → {progress.nextTabLabel} 수집 중</>}
            </>
          ) : (
            <>
              검색 중: <strong>{progress.keyword}</strong>
              {progress.tabLabel && <> [{progress.tabLabel}]</>}
              {progress.tabProgress && <> ({progress.tabProgress})</>}
            </>
          )}
          {progress.current !== undefined && progress.total ? (
            <span className="opacity-70"> — {progress.current}/{progress.total}건</span>
          ) : ''}
        </span>
      </div>
    );
  }

  // 미연결 상태 → 클릭 가능한 버튼
  if (!connected) {
    return (
      <button
        onClick={onInstallClick}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold transition cursor-pointer ${
          dark
            ? 'bg-red-900/20 text-red-400 hover:bg-red-900/40 border border-red-900/40'
            : 'bg-red-50 text-red-500 border border-red-200 hover:bg-red-100'
        }`}
        title="클릭하면 확장프로그램 설치 안내가 열립니다"
      >
        <span className="w-2 h-2 rounded-full shrink-0 bg-red-400 animate-pulse" />
        <span>확장프로그램: 미연결</span>
        <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${
          dark ? 'bg-red-500/30 text-red-200' : 'bg-red-500 text-white'
        }`}>
          설치
        </span>
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold ${
      dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600 border border-green-200'
    }`}>
      <span className="w-2 h-2 rounded-full shrink-0 bg-[#03c75a]" />
      확장프로그램: 연결됨{version ? ` v${version}` : ''}
    </div>
  );
}
