import { useTheme } from '../hooks/useTheme';

const VERSION = '3.0.0';
const ZIP_FILE = `/downloads/naver-term-analyzer-v${VERSION}.zip`;

const STEPS = [
  { n: 1, title: 'ZIP 다운로드', desc: '아래 버튼을 클릭하여 확장프로그램 ZIP 파일을 다운로드합니다.' },
  { n: 2, title: '압축 해제', desc: '다운로드한 ZIP 파일을 원하는 폴더에 압축 해제합니다.' },
  { n: 3, title: '확장프로그램 페이지 열기', desc: 'Chrome 주소창에 chrome://extensions 입력 후 이동합니다.' },
  { n: 4, title: '개발자 모드 활성화', desc: '우측 상단의 "개발자 모드" 토글을 켭니다.' },
  { n: 5, title: '압축해제된 확장 프로그램을 로드합니다', desc: '좌측 상단 "압축해제된 확장 프로그램을 로드합니다" 버튼 클릭 후, 압축 해제한 폴더를 선택합니다.' },
];

export default function NaverExtDownloadPage() {
  const { dark } = useTheme();

  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const stepBg = dark ? 'bg-[#161625]' : 'bg-[#f0f3f7]';

  return (
    <div className={`min-h-screen ${bg} ${txt}`}>
      <div className="max-w-[800px] mx-auto px-4 py-8">

        {/* 헤더 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#03c75a]/10 text-[#03c75a] text-[11px] font-bold mb-3">
            v{VERSION}
          </div>
          <h1 className="text-[24px] font-extrabold mb-2">Term 수집기</h1>
          <p className={`text-[13px] ${sub}`}>
            Chrome 확장프로그램 — 네이버쇼핑 검색 키워드의 term 구조 분석 및 순위추적
            <br />
            <span className="text-[#03c75a] font-bold">내부용</span> (Django DB 저장) / <span className="text-[#60a5fa] font-bold">외부용</span> (로컬 저장 + CSV)
          </p>
        </div>

        {/* 다운로드 카드 */}
        <div className={`rounded-xl border p-6 mb-6 text-center ${card}`}>
          <div className="text-[40px] mb-3">&#128230;</div>
          <h2 className="text-[16px] font-bold mb-1">Chrome 확장프로그램 다운로드</h2>
          <p className={`text-[12px] ${sub} mb-4`}>
            naver-term-analyzer-v{VERSION}.zip ({`~36KB`})
          </p>
          <a
            href={ZIP_FILE}
            download
            className="inline-block px-8 py-3 bg-[#03c75a] hover:bg-[#02a34a] text-white text-[14px] font-bold rounded-lg transition-colors"
          >
            다운로드
          </a>
        </div>

        {/* 설치 방법 */}
        <div className={`rounded-xl border p-6 mb-6 ${card}`}>
          <h2 className="text-[15px] font-bold mb-4">설치 방법</h2>
          <div className="space-y-3">
            {STEPS.map(s => (
              <div key={s.n} className={`flex gap-3 items-start p-3 rounded-lg ${stepBg}`}>
                <div className="shrink-0 w-6 h-6 rounded-full bg-[#03c75a] text-white text-[12px] font-bold flex items-center justify-center">
                  {s.n}
                </div>
                <div>
                  <div className="text-[13px] font-bold">{s.title}</div>
                  <div className={`text-[12px] ${sub}`}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 주요 기능 */}
        <div className={`rounded-xl border p-6 ${card}`}>
          <h2 className="text-[15px] font-bold mb-4">주요 기능</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { t: '내부/외부 모드', d: '내부: Django DB 저장 / 외부: 로컬 저장 + CSV 내보내기' },
              { t: 'Term 구조 분석', d: '네이버쇼핑 키워드의 term 분해 결과 추출' },
              { t: '탭별 상품 수집', d: '전체/가격비교/네이버페이 탭 자동 순회' },
              { t: '순위추적', d: '특정 스토어/상품의 검색 순위 자동 모니터링' },
              { t: 'CAPTCHA 강화', d: '캡차/차단 감지 시 자동 일시정지, 수동 해결 후 재개' },
              { t: 'CSV 내보내기', d: '수집 결과를 Excel 호환 CSV로 다운로드 (외부 모드)' },
            ].map(f => (
              <div key={f.t} className={`p-3 rounded-lg ${stepBg}`}>
                <div className="text-[12px] font-bold mb-0.5">{f.t}</div>
                <div className={`text-[11px] ${sub}`}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
