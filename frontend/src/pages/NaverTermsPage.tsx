import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import { useNaverExtension } from '../components/naver/useNaverExtension';
import ExtensionStatus from '../components/naver/ExtensionStatus';
import ExtensionInstallGuide from '../components/naver/ExtensionInstallGuide';
import { NaverLogo, NaverShoppingIcon } from '../components/naver/NaverIcon';
import ProductPopup from '../components/naver/ProductPopup';

interface Keyword {
  id: number;
  keyword: string;
  terms: string[];
  term_count: number;
  total_count: number;
  naverpay_count: number;
  price_compare_count: number;
  last_searched_at: string | null;
}

interface Analysis {
  term1: string; term2: string; term3: string; term4: string;
  order_weight: any; position_weight: any; name_weight: any;
  part_weight: any; category_priority: any;
}

interface RowData {
  keyword: Keyword;
  analysis: Analysis | null;
  productCount: number;
}

interface CrawlLog {
  time: string;
  type: 'info' | 'success' | 'error' | 'progress' | 'tab';
  message: string;
}

interface CrawlState {
  active: boolean;
  mode: 'chrome' | 'uc';
  keywords: string[];
  currentKeyword: string;
  currentKeywordIdx: number;
  currentTab: string;
  completedSteps: number;
  totalSteps: number;
  tabs: { key: string; label: string; done: boolean; count?: number }[];
  logs: CrawlLog[];
  lastLogIdx: number;
}

const _TAB_LABELS: Record<string, string> = { total: '전체', model: '가격비교', checkout: '네이버페이' };
void _TAB_LABELS;
const TABS_ORDER = [
  { key: 'model', label: '가격비교' },
  { key: 'checkout', label: '네이버페이' },
  { key: 'total', label: '전체' },
];

function timestamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function logType(msg: string): CrawlLog['type'] {
  if (msg.includes('★') || msg.includes('저장OK') || msg.includes('완료') || msg.includes('성공') || msg.includes('연결 OK')) return 'success';
  if (msg.includes('실패') || msg.includes('오류') || msg.includes('에러') || msg.includes('연결실패')) return 'error';
  if (msg.includes('시작') || msg.includes('──') || msg.includes('새 탭') || msg.includes('클릭')) return 'progress';
  if (msg.includes('타임아웃') || msg.includes('스킵') || msg.includes('취소') || msg.includes('CAPTCHA')) return 'error';
  if (msg.includes('상품') || msg.includes('데이터 수신')) return 'tab';
  return 'info';
}

export default function NaverTermsPage() {
  const { dark } = useTheme();
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [rows, setRows] = useState<RowData[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [popup, setPopup] = useState<{ keywordId: number; keyword: string; terms: string[] } | null>(null);
  const [crawl, setCrawl] = useState<CrawlState | null>(null);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { extStatus, progress, captcha, startTermSearch, cancel, onProgress } = useNaverExtension();

  const loadKeywords = useCallback(async () => {
    try { setKeywords(await naverApi.getKeywords()); } catch (e) { console.error(e); }
  }, []);

  const loadRowData = useCallback(async () => {
    const rowData: RowData[] = [];
    for (const kw of keywords) {
      let analysis: Analysis | null = null;
      let productCount = 0;
      try {
        const analyses = await naverApi.getAnalysis(kw.id);
        if (analyses.length > 0) analysis = analyses[0];
        const products = await naverApi.getProducts(kw.id, 'total');
        productCount = products.products?.length || 0;
      } catch (e) {}
      rowData.push({ keyword: kw, analysis, productCount });
    }
    setRows(rowData);
  }, [keywords]);

  useEffect(() => { loadKeywords(); }, [loadKeywords]);
  useEffect(() => { if (keywords.length > 0) loadRowData(); }, [keywords, loadRowData]);

  // 로그 자동 스크롤
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [crawl?.logs.length]);

  // ── ★ 확장프로그램 상태 폴링 (크롤링 중) ──
  const _pollStatus = useCallback(() => {
    window.postMessage({ type: 'NAVER_GET_STATUS', logSince: crawl?.lastLogIdx || 0 }, '*');
  }, [crawl?.lastLogIdx]);
  void _pollStatus;

  // GET_STATUS 응답 처리
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'NAVER_GET_STATUS_RESPONSE') return;
      const resp = event.data.data;
      if (!resp || !crawl) return;

      setCrawl(prev => {
        if (!prev || prev.mode !== 'chrome') return prev;

        // 로그 동기화
        const newLogs = [...prev.logs];
        let newLastLogIdx = prev.lastLogIdx;
        if (resp.logs && resp.logs.length > 0) {
          for (const entry of resp.logs) {
            const t = new Date(entry.t).toLocaleTimeString('ko-KR', { hour12: false });
            newLogs.push({ time: t, type: logType(entry.msg), message: entry.msg });
            if (entry.i >= newLastLogIdx) newLastLogIdx = entry.i + 1;
          }
        }

        // 완료 체크 (getStatus 반환값: running, steps, totalSteps, keyword, kwIdx)
        const isComplete = resp.totalSteps > 0 && resp.steps >= resp.totalSteps && !resp.running;

        return {
          ...prev,
          active: !isComplete && resp.running,
          currentKeyword: resp.keyword || prev.currentKeyword,
          currentKeywordIdx: resp.kwIdx || prev.currentKeywordIdx,
          currentTab: prev.currentTab,
          completedSteps: resp.steps || 0,
          totalSteps: resp.totalSteps || prev.totalSteps,
          logs: newLogs,
          lastLogIdx: newLastLogIdx,
        };
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [crawl !== null]);

  // Chrome 모드 폴링 시작/중지 (UC 모드에서는 비활성)
  useEffect(() => {
    if (crawl?.active && crawl?.mode === 'chrome') {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => {
          window.postMessage({ type: 'NAVER_GET_STATUS', logSince: 0 }, '*');
        }, 1000);
      }
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (crawl && !crawl.active && crawl.mode === 'chrome') {
        setTimeout(() => {
          window.postMessage({ type: 'NAVER_GET_STATUS', logSince: 0 }, '*');
        }, 500);
      }
    }
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  }, [crawl?.active, crawl?.mode]);

  // 확장프로그램 이벤트 → 탭 카드 업데이트 (Chrome 모드 전용)
  useEffect(() => {
    return onProgress((e) => {
      if (e.type === 'NAVER_TAB_COMPLETE') {
        setCrawl(prev => {
          if (!prev || prev.mode !== 'chrome') return prev;
          return {
            ...prev,
            tabs: prev.tabs.map(t =>
              t.key === e.tabType ? { ...t, done: true, count: e.productCount } : t
            ),
          };
        });
      }

      if (e.type === 'NAVER_SEARCH_COMPLETE') {
        setCrawl(prev => {
          if (!prev) return prev;
          // 모든 탭 완료 표시 + 다음 키워드를 위해 탭 리셋
          return {
            ...prev,
            tabs: prev.tabs.map(t => ({ ...t, done: false })),
          };
        });
        loadKeywords();
      }

      if (e.type === 'NAVER_QUEUE_STATUS' && e.status === 'complete') {
        setCrawl(prev => prev ? { ...prev, active: false } : prev);
        loadKeywords();
      }

      if (e.type === 'NAVER_TRACKING_PROGRESS') {
        setCrawl(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            currentKeyword: e.keyword || prev.currentKeyword,
            currentTab: e.tab || prev.currentTab,
          };
        });
      }
    });
  }, [onProgress, loadKeywords]);

  const handleAddKeywords = async () => {
    const lines = inputText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setLoading(true);
    for (const kw of lines) await naverApi.addKeyword(kw);
    setInputText('');
    await loadKeywords();
    setLoading(false);
  };

  const handleClear = async () => {
    for (const kw of keywords) await naverApi.deleteKeyword(kw.id);
    setKeywords([]); setRows([]);
  };

  const getTargetKeywords = () => {
    return selectedRows.size > 0
      ? rows.filter((_, i) => selectedRows.has(i)).map(r => r.keyword.keyword)
      : rows.map(r => r.keyword.keyword);
  };

  const handleSearch = () => {
    const target = getTargetKeywords();
    if (!target.length) return;

    setCrawl({
      active: true,
      mode: 'chrome',
      keywords: target,
      currentKeyword: target[0],
      currentKeywordIdx: 0,
      currentTab: 'model',
      completedSteps: 0,
      totalSteps: target.length * 3,
      tabs: TABS_ORDER.map(t => ({ ...t, done: false })),
      logs: [{ time: timestamp(), type: 'info', message: `[Chrome] 크롤링 시작 — ${target.length}개 키워드: [${target.join(', ')}]` }],
      lastLogIdx: 0,
    });

    startTermSearch(target);
  };

  // ── UC 검색 ──
  const ucPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ucLogIdxRef = useRef(0);

  const stopUCPoll = useCallback(() => {
    if (ucPollRef.current) { clearInterval(ucPollRef.current); ucPollRef.current = null; }
  }, []);

  const pollUCStatus = useCallback(async () => {
    try {
      const d = await naverApi.ucStatus(ucLogIdxRef.current);
      setCrawl(prev => {
        if (!prev || prev.mode !== 'uc') return prev;
        const newLogs = [...prev.logs];
        if (d.logs?.length > 0) {
          for (const entry of d.logs) {
            const t = entry.t ? new Date(entry.t).toLocaleTimeString('ko-KR', { hour12: false }) : timestamp();
            newLogs.push({ time: t, type: logType(entry.msg), message: entry.msg });
          }
          ucLogIdxRef.current += d.logs.length;
        }
        const isComplete = !d.running && d.totalSteps > 0 && d.steps >= d.totalSteps;
        const isDone = !d.running && prev.active;
        if (isComplete || isDone) {
          stopUCPoll();
          loadKeywords();
        }
        return {
          ...prev,
          active: d.running,
          currentKeyword: d.keyword || prev.currentKeyword,
          currentKeywordIdx: d.kwIdx || prev.currentKeywordIdx,
          completedSteps: d.steps || prev.completedSteps,
          totalSteps: d.totalSteps || prev.totalSteps,
          logs: newLogs,
        };
      });
    } catch {
      // 네트워크 오류 무시
    }
  }, [stopUCPoll, loadKeywords]);

  const handleUCSearch = async () => {
    const target = getTargetKeywords();
    if (!target.length) return;

    ucLogIdxRef.current = 0;
    setCrawl({
      active: true,
      mode: 'uc',
      keywords: target,
      currentKeyword: target[0],
      currentKeywordIdx: 0,
      currentTab: '',
      completedSteps: 0,
      totalSteps: target.length * 3,
      tabs: TABS_ORDER.map(t => ({ ...t, done: false })),
      logs: [{ time: timestamp(), type: 'info', message: `[UC] 크롤링 시작 — ${target.length}개 키워드: [${target.join(', ')}]` }],
      lastLogIdx: 0,
    });

    try {
      const result = await naverApi.ucStart(target);
      if (!result.ok) {
        setCrawl(prev => prev ? {
          ...prev,
          active: false,
          logs: [...prev.logs, { time: timestamp(), type: 'error', message: `UC 시작 실패: ${result.message || 'unknown'}` }],
        } : null);
        return;
      }
      // 폴링 시작
      stopUCPoll();
      ucPollRef.current = setInterval(pollUCStatus, 1000);
      pollUCStatus();
    } catch (e: any) {
      setCrawl(prev => prev ? {
        ...prev,
        active: false,
        logs: [...prev.logs, { time: timestamp(), type: 'error', message: `UC 연결 실패: ${e.message}` }],
      } : null);
    }
  };

  // UC 폴링 정리
  useEffect(() => {
    return () => stopUCPoll();
  }, [stopUCPoll]);

  const handleCancelCrawl = async () => {
    if (crawl?.mode === 'uc') {
      try { await naverApi.ucStop(); } catch {}
      stopUCPoll();
    } else {
      cancel();
    }
    setCrawl(prev => prev ? {
      ...prev,
      active: false,
      logs: [...prev.logs, { time: timestamp(), type: 'error', message: '사용자에 의해 중단됨' }],
    } : null);
  };

  const handleAnalyze = async () => {
    const targets = selectedRows.size > 0 ? rows.filter((_, i) => selectedRows.has(i)) : rows;
    setLoading(true);
    for (const r of targets) { try { await naverApi.runAnalysis(r.keyword.id); } catch (e) {} }
    await loadKeywords();
    setLoading(false);
  };

  const toggleRow = (idx: number) => {
    setSelectedRows(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  };

  const formatWeight = (weight: any): string => {
    if (!weight || typeof weight !== 'object') return '-';
    return Object.entries(weight).map(([, v]: [string, any]) => v?.label || '').filter(Boolean).join('\n') || '-';
  };

  const formatCat = (cat: any): string => {
    if (!cat?.category) return '-';
    return `${cat.category}\n${cat.count}/${cat.total}`;
  };

  // 스타일
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200 shadow-sm';
  const tHead = dark ? 'bg-[#1a2332]' : 'bg-[#f0f3f7]';
  const tRow = dark ? 'border-[#2a2a40] hover:bg-[#222240]' : 'border-gray-100 hover:bg-[#f8fafb]';
  const tSelected = dark ? 'bg-[#1a2a3a]' : 'bg-green-50';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const txtSub = dark ? 'text-gray-400' : 'text-gray-500';
  const txtMuted = dark ? 'text-gray-500' : 'text-gray-400';
  const inputBg = dark ? 'bg-[#1c1c2e] border-[#333] text-white placeholder-gray-500' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400';

  // 프로그레스
  const progressPct = crawl && crawl.totalSteps > 0
    ? Math.round((crawl.completedSteps / crawl.totalSteps) * 100)
    : 0;

  return (
    <div className={`min-h-screen ${bg} transition-colors`} style={{ fontFamily: "'NanumSquare', 'Malgun Gothic', sans-serif" }}>
      <div className="max-w-[1800px] mx-auto px-4 py-5 md:px-6">

        {/* ── 헤더 ── */}
        <div className="flex items-center gap-3 mb-5">
          <NaverLogo size={32} />
          <div>
            <h1 className={`text-[18px] font-extrabold tracking-tight ${txt}`}>네이버쇼핑 Term 분석</h1>
            <p className={`text-[12px] ${txtSub}`}>키워드의 term 구조 분석 및 가중치 평가</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <ExtensionStatus
              dark={dark}
              connected={extStatus.connected}
              version={extStatus.version}
              progress={progress}
              captcha={captcha}
              onInstallClick={() => setInstallGuideOpen(true)}
            />
          </div>
        </div>

        {/* ── 키워드 입력 카드 ── */}
        <div className={`rounded-xl border p-4 mb-4 ${card}`}>
          <div className="flex gap-3">
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="키워드를 입력하세요 (엔터로 구분)"
              rows={2}
              className={`flex-1 rounded-lg border px-3 py-2.5 text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-[#03c75a]/50 transition ${inputBg}`}
            />
            <div className="flex flex-col gap-1.5 shrink-0">
              <button onClick={handleAddKeywords} disabled={loading}
                className="px-5 py-2 bg-[#03c75a] text-white text-[12px] font-bold rounded-lg hover:bg-[#02b350] active:scale-[0.97] transition disabled:opacity-50">
                <NaverShoppingIcon size={14} />&nbsp;검색어추가
              </button>
              <button onClick={handleClear}
                className={`px-5 py-2 text-[12px] font-bold rounded-lg transition ${dark ? 'bg-[#333] text-gray-300 hover:bg-[#444]' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}>
                CLEAR
              </button>
              <button onClick={() => naverApi.downloadTermsExcel()}
                className={`px-5 py-2 text-[12px] font-bold rounded-lg transition ${dark ? 'bg-[#1a3a5c] text-blue-300 hover:bg-[#1f4570]' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}>
                엑셀저장
              </button>
            </div>
          </div>
        </div>

        {/* ── 테이블 카드 ── */}
        <div className={`rounded-xl border overflow-hidden mb-4 ${card}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className={tHead}>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} w-10`}>#</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[130px]`}>키워드</th>
                  {['1term', '2term', '3term', '4term'].map(t => (
                    <th key={t} className={`px-3 py-3 text-left font-bold min-w-[60px]`}>
                      <span className="text-[#03c75a]">{t}</span>
                    </th>
                  ))}
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[140px]`}>순서고정</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[100px]`}>위치</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[140px]`}>상품명</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[100px]`}>파트</th>
                  <th className={`px-3 py-3 text-left font-bold ${txtSub} min-w-[130px]`}>카테고리</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>총검색수</th>
                  <th className={`px-3 py-3 text-right font-bold ${txtSub}`}>상품수</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const terms = row.keyword.terms || [];
                  const a = row.analysis;
                  const sel = selectedRows.has(idx);
                  return (
                    <tr key={row.keyword.id}
                      className={`border-t cursor-pointer transition-colors ${tRow} ${sel ? tSelected : ''}`}
                      onClick={() => toggleRow(idx)}
                      onDoubleClick={() => setPopup({ keywordId: row.keyword.id, keyword: row.keyword.keyword, terms })}>
                      <td className={`px-3 py-2.5 ${txtMuted}`}>{idx + 1}</td>
                      <td className={`px-3 py-2.5 font-bold ${txt}`}>{row.keyword.keyword}</td>
                      {[0, 1, 2, 3].map(i => (
                        <td key={i} className="px-3 py-2.5 text-[#03c75a] font-semibold">{terms[i] || ''}</td>
                      ))}
                      <td className={`px-3 py-2.5 whitespace-pre-line ${txtSub}`}>{a ? formatWeight(a.order_weight) : '-'}</td>
                      <td className={`px-3 py-2.5 whitespace-pre-line ${txtSub}`}>{a ? formatWeight(a.position_weight) : '-'}</td>
                      <td className={`px-3 py-2.5 whitespace-pre-line ${txtSub}`}>{a ? formatWeight(a.name_weight) : '-'}</td>
                      <td className={`px-3 py-2.5 whitespace-pre-line ${txtSub}`}>{a?.part_weight && Object.keys(a.part_weight).length ? JSON.stringify(a.part_weight) : '-'}</td>
                      <td className={`px-3 py-2.5 whitespace-pre-line ${txtSub}`}>{a ? formatCat(a.category_priority) : '-'}</td>
                      <td className={`px-3 py-2.5 text-right font-medium ${txt}`}>{row.keyword.total_count?.toLocaleString() || '-'}</td>
                      <td className={`px-3 py-2.5 text-right font-medium ${txt}`}>{row.productCount || '-'}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={13} className={`text-center py-16 ${txtMuted}`}>
                    <NaverShoppingIcon size={40} />
                    <p className="mt-3 text-[14px]">키워드를 추가하세요</p>
                    <p className="text-[12px] mt-1">상단 입력란에 키워드 입력 후 검색어추가 버튼 클릭</p>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 분석 버튼 바 ── */}
        <div className={`rounded-xl border p-3 flex flex-wrap gap-2 ${card}`}>
          <button onClick={handleSearch}
            className="px-5 py-2.5 bg-[#03c75a] text-white text-[12px] font-bold rounded-lg hover:bg-[#02b350] active:scale-[0.97] transition flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15.5 14H14.71L14.43 13.73C15.41 12.59 16 11.11 16 9.5C16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16C11.11 16 12.59 15.41 13.73 14.43L14 14.71V15.5L19 20.49L20.49 19L15.5 14ZM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z" fill="white"/></svg>
            term검색
          </button>
          <button onClick={handleUCSearch}
            className="px-5 py-2.5 bg-[#3b82f6] text-white text-[12px] font-bold rounded-lg hover:bg-[#2563eb] active:scale-[0.97] transition flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 18C21.1 18 21.99 17.1 21.99 16L22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" fill="white"/></svg>
            UC검색
          </button>
          {['순서고정', '위치가중치', '상품명가중치', '파트가중치', '카테고리'].map(label => (
            <button key={label} onClick={handleAnalyze}
              className={`px-4 py-2.5 text-[12px] font-bold rounded-lg transition ${
                dark ? 'bg-[#2a2a40] text-gray-300 hover:bg-[#333355]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
              {label}
            </button>
          ))}
          <button onClick={handleAnalyze} disabled={loading}
            className="px-5 py-2.5 bg-[#1a3a5c] text-blue-200 text-[12px] font-bold rounded-lg hover:bg-[#1f4570] active:scale-[0.97] transition disabled:opacity-50 ml-auto">
            {loading ? '분석 중...' : '전체분석'}
          </button>
        </div>
      </div>

      {/* ── 크롤링 모달 ── */}
      {crawl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ fontFamily: "'NanumSquare', sans-serif" }}>
          <div className="bg-black/60 absolute inset-0" onClick={() => !crawl.active && setCrawl(null)} />
          <div className={`relative rounded-2xl border shadow-2xl w-full max-w-[700px] flex flex-col overflow-hidden ${
            dark ? 'bg-[#141422] border-[#2a2a40]' : 'bg-white border-gray-200'
          }`}>

            {/* 모달 헤더 */}
            <div className={`flex items-center gap-3 px-5 py-4 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
              <NaverShoppingIcon size={22} />
              <div className="flex-1">
                <h3 className={`text-[15px] font-extrabold ${txt}`}>
                  Term 크롤링
                  {crawl.mode === 'uc' && <span className="ml-2 text-[11px] font-bold text-[#3b82f6] bg-[#3b82f6]/10 px-2 py-0.5 rounded-full">UC</span>}
                  {crawl.mode === 'chrome' && <span className="ml-2 text-[11px] font-bold text-[#03c75a] bg-[#03c75a]/10 px-2 py-0.5 rounded-full">Chrome</span>}
                </h3>
                <p className={`text-[11px] mt-0.5 ${txtSub}`}>
                  {crawl.active
                    ? `${crawl.currentKeywordIdx || 1} / ${crawl.keywords.length} 키워드 수집 중`
                    : progressPct >= 100
                      ? `${crawl.keywords.length}개 키워드 수집 완료`
                      : `${crawl.keywords.length}개 키워드 (중단됨)`
                  }
                </p>
              </div>
              {crawl.active ? (
                <button onClick={handleCancelCrawl}
                  className="px-4 py-1.5 bg-red-500 text-white text-[11px] font-bold rounded-lg hover:bg-red-600 transition">
                  중단
                </button>
              ) : (
                <button onClick={() => setCrawl(null)}
                  className={`w-8 h-8 flex items-center justify-center rounded-full transition ${dark ? 'hover:bg-[#333] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              )}
            </div>

            {/* 현재 키워드 + 탭 진행 */}
            <div className={`px-5 py-4 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
              {/* 현재 키워드 */}
              <div className="flex items-center gap-3 mb-3">
                <span className={`text-[11px] font-bold ${txtSub}`}>키워드</span>
                <span className={`text-[15px] font-extrabold text-[#03c75a]`}>{crawl.currentKeyword}</span>
                {crawl.active && <span className="w-2 h-2 bg-[#03c75a] rounded-full animate-pulse" />}
                {!crawl.active && progressPct >= 100 && <span className="text-[#03c75a] text-[13px]">&#x2714;</span>}
              </div>

              {/* 3탭 진행 카드 */}
              <div className="flex gap-2">
                {crawl.tabs.map(tab => {
                  const isCurrent = crawl.active && crawl.currentTab === tab.key && !tab.done;
                  return (
                    <div key={tab.key} className={`flex-1 rounded-xl px-3 py-2.5 border transition-all ${
                      tab.done
                        ? (dark ? 'bg-[#03c75a]/10 border-[#03c75a]/40' : 'bg-green-50 border-green-300')
                        : isCurrent
                          ? (dark ? 'bg-[#1a2a3a] border-[#03c75a]/60' : 'bg-blue-50 border-blue-300')
                          : (dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-gray-50 border-gray-200')
                    }`}>
                      <div className="flex items-center gap-1.5 mb-1">
                        {tab.done ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="#03c75a"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                        ) : isCurrent ? (
                          <span className="w-3 h-3 border-2 border-[#03c75a] border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <span className={`w-3 h-3 rounded-full ${dark ? 'bg-[#333]' : 'bg-gray-300'}`} />
                        )}
                        <span className={`text-[11px] font-bold ${
                          tab.done ? 'text-[#03c75a]' : isCurrent ? (dark ? 'text-white' : 'text-gray-900') : txtMuted
                        }`}>{tab.label}</span>
                      </div>
                      {tab.done && tab.count !== undefined && (
                        <p className={`text-[10px] ml-5 ${txtSub}`}>{tab.count}개 상품</p>
                      )}
                      {isCurrent && (
                        <div className="mt-1.5 ml-5">
                          <div className={`h-1 rounded-full overflow-hidden ${dark ? 'bg-[#333]' : 'bg-gray-200'}`}>
                            <div className="h-full bg-[#03c75a] rounded-full animate-pulse" style={{ width: '60%' }} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 전체 프로그래스바 */}
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-[10px] font-bold ${txtSub}`}>
                    {!crawl.active && progressPct >= 100 ? '수집 완료' : '전체 진행률'}
                  </span>
                  <span className={`text-[10px] font-bold ${!crawl.active && progressPct >= 100 ? 'text-[#03c75a]' : txt}`}>
                    {crawl.completedSteps}/{crawl.totalSteps} ({progressPct}%)
                  </span>
                </div>
                <div className={`h-2 rounded-full overflow-hidden ${dark ? 'bg-[#2a2a40]' : 'bg-gray-200'}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      !crawl.active && progressPct >= 100
                        ? 'bg-[#03c75a]'
                        : 'bg-gradient-to-r from-[#03c75a] to-[#02e065]'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            </div>

            {/* 로그 영역 */}
            <div className={`flex-1 max-h-[300px] overflow-y-auto px-5 py-3 ${dark ? 'bg-[#0d0d18]' : 'bg-[#fafbfc]'}`}>
              {crawl.logs.map((log, i) => (
                <div key={i} className={`flex items-start gap-2 py-1 text-[11px] leading-relaxed ${
                  i === crawl.logs.length - 1 ? '' : (dark ? 'border-b border-[#1a1a2a]' : 'border-b border-gray-100')
                }`}>
                  <span className={`shrink-0 font-mono ${txtMuted}`}>{log.time}</span>
                  <span className="shrink-0">
                    {log.type === 'success' && <span className="text-[#03c75a]">&#x2714;</span>}
                    {log.type === 'error' && <span className="text-red-400">&#x2718;</span>}
                    {log.type === 'progress' && <span className="text-blue-400">&#x25B6;</span>}
                    {log.type === 'tab' && <span className="text-yellow-400">&#x25CF;</span>}
                    {log.type === 'info' && <span className={txtSub}>&#x25CB;</span>}
                  </span>
                  <span className={
                    log.type === 'success' ? 'text-[#03c75a]'
                    : log.type === 'error' ? 'text-red-400'
                    : log.type === 'tab' ? (dark ? 'text-yellow-300' : 'text-yellow-600')
                    : (dark ? 'text-gray-300' : 'text-gray-700')
                  }>
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {/* 모달 푸터 */}
            <div className={`flex items-center justify-between px-5 py-3 border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
              <div className="flex items-center gap-4">
                <span className={`text-[10px] ${txtSub}`}>
                  스텝: <strong className={txt}>{crawl.completedSteps}/{crawl.totalSteps}</strong>
                </span>
                <span className={`text-[10px] ${txtSub}`}>
                  로그: <strong className={txt}>{crawl.logs.length}</strong>건
                </span>
              </div>
              {!crawl.active && (
                <button onClick={() => setCrawl(null)}
                  className="px-4 py-1.5 bg-[#03c75a] text-white text-[11px] font-bold rounded-lg hover:bg-[#02b350] transition">
                  닫기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {popup && (
        <ProductPopup
          keywordId={popup.keywordId}
          keyword={popup.keyword}
          terms={popup.terms}
          onClose={() => setPopup(null)}
        />
      )}

      <ExtensionInstallGuide
        dark={dark}
        open={installGuideOpen}
        onClose={() => setInstallGuideOpen(false)}
      />
    </div>
  );
}
