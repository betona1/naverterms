import { useState } from 'react';

interface Props {
  dark: boolean;
  open: boolean;
  onClose: () => void;
}

// 다운로드 경로 (vite public/에 배포됨)
const ZIP_URL = '/naver-extension-latest.zip';

export default function ExtensionInstallGuide({ dark, open, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  if (!open) return null;

  const bgOverlay = 'bg-black/60';
  const card = dark ? 'bg-[#141422] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const stepBox = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-[#f7f8fa] border-gray-200';
  const codeBox = dark ? 'bg-[#0d0d18] border-[#2a2a40] text-[#03c75a]' : 'bg-gray-900 border-gray-700 text-[#03c75a]';
  const badge = dark ? 'bg-[#03c75a]/15 text-[#03c75a]' : 'bg-green-50 text-green-600 border border-green-200';
  const warnBox = dark ? 'bg-yellow-900/20 border-yellow-700/40 text-yellow-300' : 'bg-yellow-50 border-yellow-300 text-yellow-800';
  const dangerBox = dark ? 'bg-red-900/25 border-red-700/60 text-red-200' : 'bg-red-50 border-red-400 text-red-800';

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const chromeCmd = 'chrome://extensions';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ fontFamily: "'NanumSquare', 'Malgun Gothic', sans-serif" }}>
      <div className={`absolute inset-0 ${bgOverlay}`} onClick={onClose} />

      <div className={`relative rounded-2xl border shadow-2xl w-full max-w-[640px] max-h-[90vh] flex flex-col overflow-hidden ${card}`}>
        {/* 헤더 */}
        <div className={`flex items-center gap-3 px-5 py-4 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <div className="w-9 h-9 rounded-xl bg-[#03c75a] flex items-center justify-center shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
              <path d="M12 2L4 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-8-3z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className={`text-[15px] font-extrabold ${txt}`}>확장프로그램 설치</h3>
            <p className={`text-[11px] mt-0.5 ${txtSub}`}>네이버 탐지 우회를 위해 수동 설치가 필요합니다</p>
          </div>
          <button onClick={onClose}
            className={`w-8 h-8 flex items-center justify-center rounded-full transition ${dark ? 'hover:bg-[#2a2a40] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        {/* 본문 (스크롤 가능) */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* ★ 최상단 경고 배너 ★ */}
          <div className={`rounded-xl border-2 p-4 mb-4 ${dangerBox}`}>
            <div className="flex items-start gap-3">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 mt-0.5">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              <div className="text-[12px] leading-relaxed">
                <div className="font-extrabold text-[13px] mb-1">절대로 zip 파일을 Chrome에 드래그&amp;드롭 하지 마세요</div>
                <div>
                  zip을 직접 드롭하면 Chrome이 zip 내용 해시로 <b>고정 ID</b>를 만들어서
                  네이버의 차단을 피할 수 없습니다. <br />
                  <b>반드시 파일관리자에서 먼저 압축 해제 → 그 폴더를 "압축해제된 확장 프로그램을 로드"로 선택</b>해야 합니다.
                </div>
              </div>
            </div>
          </div>

          {/* 1단계: 다운로드 */}
          <div className={`rounded-xl border p-4 mb-3 ${stepBox}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge}`}>STEP 1</span>
              <span className={`text-[13px] font-bold ${txt}`}>확장프로그램 다운로드</span>
            </div>
            <a href={ZIP_URL} download
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#03c75a] hover:bg-[#02b350] active:scale-[0.97] text-white text-[12px] font-bold rounded-lg transition">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
              </svg>
              naver-extension-latest.zip 다운로드
            </a>
            <p className={`mt-2 text-[11px] ${txtMuted}`}>버전은 manifest.json의 version 필드와 자동 동기화됩니다.</p>
          </div>

          {/* 2단계: 압축 해제 */}
          <div className={`rounded-xl border p-4 mb-3 ${stepBox}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge}`}>STEP 2</span>
              <span className={`text-[13px] font-bold ${txt}`}>임의의 폴더에 압축 해제</span>
            </div>
            <p className={`text-[12px] leading-relaxed mb-2 ${txtSub}`}>
              zip을 <b className={txt}>원하는 위치</b>에 압축 해제하세요. 예시:
            </p>
            <div className={`rounded-lg border font-mono text-[11px] px-3 py-2 mb-2 ${codeBox}`}>
              ~/naver-ext/
            </div>
            <div className={`rounded-lg border p-3 ${warnBox}`}>
              <div className="flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 mt-0.5">
                  <path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/>
                </svg>
                <div className="text-[11px] leading-relaxed">
                  <b>중요</b>: 폴더 경로가 바뀌면 확장 ID도 함께 바뀝니다.<br />
                  네이버가 특정 ID를 차단하면 <b>다른 경로로 옮겨</b> 다시 등록하면 새 ID가 발급됩니다.
                </div>
              </div>
            </div>
          </div>

          {/* 3단계: Chrome에 로드 */}
          <div className={`rounded-xl border p-4 mb-3 ${stepBox}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge}`}>STEP 3</span>
              <span className={`text-[13px] font-bold ${txt}`}>Chrome 확장 페이지 열기</span>
            </div>
            <p className={`text-[12px] leading-relaxed mb-2 ${txtSub}`}>
              Chrome 주소창에 아래 주소를 복사해서 붙여넣으세요:
            </p>
            <div className="flex gap-2 mb-2">
              <div className={`flex-1 rounded-lg border font-mono text-[12px] px-3 py-2 ${codeBox}`}>
                {chromeCmd}
              </div>
              <button onClick={() => handleCopy(chromeCmd, 'cmd')}
                className={`px-3 py-2 text-[11px] font-bold rounded-lg transition shrink-0 ${
                  copied === 'cmd'
                    ? 'bg-[#03c75a] text-white'
                    : (dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333355]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
                }`}>
                {copied === 'cmd' ? '복사됨' : '복사'}
              </button>
            </div>
            <p className={`text-[11px] ${txtMuted}`}>
              ※ 크롬 정책상 이 버튼에서 직접 chrome:// 주소로 이동할 수 없습니다.
            </p>
          </div>

          {/* 4단계: 개발자 모드 + 로드 */}
          <div className={`rounded-xl border p-4 mb-3 ${stepBox}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge}`}>STEP 4</span>
              <span className={`text-[13px] font-bold ${txt}`}>압축해제된 확장 로드</span>
            </div>
            <ol className={`text-[12px] leading-7 ${txtSub} list-decimal list-inside space-y-0.5`}>
              <li>우측 상단 <b className={txt}>개발자 모드</b> 토글 켜기</li>
              <li>좌측 상단 <b className={txt}>압축해제된 확장 프로그램을 로드합니다</b> 클릭</li>
              <li>STEP 2에서 압축 해제한 폴더 선택 <span className={txtMuted}>(예: <code className={dark ? 'text-[#03c75a]' : 'text-green-600'}>~/naver-ext/naver-extension-v2.0.0</code>)</span></li>
              <li>확장 목록에 <b className={txt}>쇼핑 통합 도우미</b> 카드가 나타나면 성공</li>
            </ol>
          </div>

          {/* 5단계: 페이지 새로고침 */}
          <div className={`rounded-xl border p-4 ${stepBox}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${badge}`}>STEP 5</span>
              <span className={`text-[13px] font-bold ${txt}`}>이 페이지 새로고침</span>
            </div>
            <p className={`text-[12px] leading-relaxed mb-3 ${txtSub}`}>
              로드가 완료되면 이 페이지를 새로고침 하세요. 우측 상단의 확장 상태가 <b className="text-[#03c75a]">연결됨</b>으로 바뀝니다.
            </p>
            <button onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#3b82f6] hover:bg-[#2563eb] active:scale-[0.97] text-white text-[12px] font-bold rounded-lg transition">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4a8 8 0 108 8h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z"/>
              </svg>
              새로고침
            </button>
          </div>

        </div>

        {/* 푸터 */}
        <div className={`flex items-center justify-between px-5 py-3 border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <span className={`text-[10px] ${txtMuted}`}>
            문제가 계속되면 확장 폴더를 다른 경로로 옮겨 재등록하세요.
          </span>
          <button onClick={onClose}
            className={`px-4 py-1.5 text-[11px] font-bold rounded-lg transition ${
              dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333355]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
