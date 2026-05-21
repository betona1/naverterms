import { useTheme } from '../hooks/useTheme';

const VERSION = '3.0.26';
const ZIP_INTERNAL = `/downloads/naver-term-analyzer-v${VERSION}-internal.zip`;
const ZIP_EXTERNAL = `/downloads/naver-term-analyzer-v${VERSION}-external.zip`;

const STEPS = [
  { n: 1, title: '아래 모드 중 하나를 선택 → ZIP 다운로드', desc: '사무실 내부망이면 내부용, 외부(다른 PC/외부망)이면 외부용을 받으세요.' },
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
  const modeCardInt = dark
    ? 'bg-[#0d2a1a] border-[#03c75a]/40'
    : 'bg-[#e8f5e9] border-[#03c75a]/40';
  const modeCardExt = dark
    ? 'bg-[#0d1c33] border-[#60a5fa]/40'
    : 'bg-[#e6f0ff] border-[#60a5fa]/40';

  return (
    <div className={`min-h-screen ${bg} ${txt}`}>
      <div className="max-w-[900px] mx-auto px-4 py-8">

        {/* 헤더 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#03c75a]/10 text-[#03c75a] text-[11px] font-bold mb-3">
            v{VERSION}
          </div>
          <h1 className="text-[24px] font-extrabold mb-2">Term 수집기</h1>
          <p className={`text-[13px] ${sub}`}>
            Chrome 확장프로그램 — 네이버쇼핑 검색 키워드의 term 구조 분석 및 순위추적
          </p>
        </div>

        {/* 다운로드 — 두 모드 병렬 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {/* 내부용 */}
          <div className={`rounded-xl border p-6 text-center ${modeCardInt}`}>
            <div className="text-[36px] mb-2">&#127970;</div>
            <h2 className="text-[16px] font-extrabold mb-1 text-[#03c75a]">내부용</h2>
            <p className={`text-[12px] ${sub} mb-1`}>
              Django DB 저장 (사무실 내부망 전용)
            </p>
            <p className={`text-[11px] ${sub} mb-4`}>
              <code className="text-[#03c75a]">192.168.219.100:8901</code> 연동
            </p>
            <a
              href={ZIP_INTERNAL}
              download
              className="inline-block w-full px-6 py-3 bg-[#03c75a] hover:bg-[#02a34a] text-white text-[14px] font-bold rounded-lg transition-colors"
            >
              📥 내부용 다운로드
            </a>
            <div className={`text-[10px] ${sub} mt-3`}>
              naver-term-analyzer-v{VERSION}-internal.zip
            </div>
          </div>

          {/* 외부용 */}
          <div className={`rounded-xl border p-6 text-center ${modeCardExt}`}>
            <div className="text-[36px] mb-2">&#128230;</div>
            <h2 className="text-[16px] font-extrabold mb-1 text-[#60a5fa]">외부용</h2>
            <p className={`text-[12px] ${sub} mb-1`}>
              로컬 저장 + Excel/CSV 내보내기
            </p>
            <p className={`text-[11px] ${sub} mb-4`}>
              Django 서버 없이 브라우저에서 단독 사용
            </p>
            <a
              href={ZIP_EXTERNAL}
              download
              className="inline-block w-full px-6 py-3 bg-[#60a5fa] hover:bg-[#3b82f6] text-white text-[14px] font-bold rounded-lg transition-colors"
            >
              📥 외부용 다운로드
            </a>
            <div className={`text-[10px] ${sub} mt-3`}>
              naver-term-analyzer-v{VERSION}-external.zip
            </div>
          </div>
        </div>

        <div className={`text-[11px] ${sub} text-center mb-6`}>
          * 두 버전은 <b>기본 저장 모드</b>만 다릅니다. 설치 후 팝업 상단 토글로 언제든 바꿀 수 있습니다.
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
              { t: '내부/외부 모드', d: '내부: Django DB 저장 / 외부: 로컬 저장 + Excel/CSV' },
              { t: 'Term 구조 분석', d: '네이버쇼핑 키워드의 term 분해 결과 추출' },
              { t: '탭별 상품 수집', d: '전체/가격비교/네이버페이 탭 자동 순회' },
              { t: '속성/태그/브랜드 수집', d: '속성항목, 속성값, 태그, 브랜드, 제조사, 리뷰수, 등록일, 이미지' },
              { t: 'Excel 3시트 내보내기', d: '전체/가격비교/네이버페이 시트 분리된 xlsx 호환 파일' },
              { t: '순위추적', d: '특정 스토어/상품의 검색 순위 자동 모니터링' },
              { t: 'CAPTCHA / 영수증풀이 감지', d: '캡차/차단/영수증풀이 감지 시 자동 일시정지, 수동 해결 후 재개' },
              { t: '네이버플러스 위장 UI', d: '수집 중 상단 바가 네이버플러스 스토어처럼 표시' },
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
