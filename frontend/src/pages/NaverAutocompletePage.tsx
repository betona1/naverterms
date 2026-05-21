import { useState, useRef, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import type { AutocompleteMarket, AutocompleteResult } from '../api/naverApi';

interface MarketDef {
  key: AutocompleteMarket;
  label: string;
  color: string;
  hint: string;
}

const MARKETS: MarketDef[] = [
  { key: 'naver', label: '네이버쇼핑', color: '#03c75a', hint: 'ac.shopping.naver.com' },
  { key: 'coupang', label: '쿠팡', color: '#ff5b30', hint: 'coupang.com/np/search/autoComplete' },
];

interface QueryResult {
  query: string;
  results: AutocompleteResult['results'];
  ts: number;
}

export default function NaverAutocompletePage() {
  const { dark } = useTheme();
  const [bulkInput, setBulkInput] = useState('');
  const [enabled, setEnabled] = useState<Record<AutocompleteMarket, boolean>>({ naver: true, coupang: true });
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<QueryResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'err' } | null>(null);
  const abortRef = useRef(false);

  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const subText = dark ? 'text-gray-400' : 'text-gray-500';
  const titleText = dark ? 'text-white' : 'text-gray-900';
  const inputCls = dark
    ? 'bg-[#0f0f1a] border-[#2a2a40] text-white placeholder-gray-500'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400';

  const showToast = (msg: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2400);
  };

  const selectedMarkets = (Object.keys(enabled) as AutocompleteMarket[]).filter(m => enabled[m]);

  const parseQueries = (raw: string): string[] => {
    const tokens = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    return Array.from(new Set(tokens));
  };

  const handleRun = useCallback(async () => {
    const queries = parseQueries(bulkInput);
    if (queries.length === 0) {
      showToast('검색어를 입력하세요', 'err');
      return;
    }
    if (selectedMarkets.length === 0) {
      showToast('마켓을 1개 이상 선택하세요', 'err');
      return;
    }

    abortRef.current = false;
    setBusy(true);
    setProgress({ done: 0, total: queries.length });
    setHistory([]);

    const newHistory: QueryResult[] = [];
    for (let i = 0; i < queries.length; i++) {
      if (abortRef.current) break;
      try {
        const r = await naverApi.fetchAutocomplete(queries[i], selectedMarkets);
        newHistory.push({ query: r.query, results: r.results, ts: Date.now() });
        setHistory([...newHistory]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '실패';
        const errResults: AutocompleteResult['results'] = {};
        selectedMarkets.forEach(m => { errResults[m] = { keywords: [], error: msg }; });
        newHistory.push({ query: queries[i], results: errResults, ts: Date.now() });
        setHistory([...newHistory]);
      }
      setProgress({ done: i + 1, total: queries.length });
    }
    setBusy(false);
    if (!abortRef.current) showToast(`${queries.length}개 키워드 조회 완료`);
  }, [bulkInput, selectedMarkets]);

  const handleStop = () => {
    abortRef.current = true;
    setBusy(false);
  };

  const copyAll = (market: AutocompleteMarket) => {
    const all: string[] = [];
    history.forEach(h => {
      const r = h.results[market];
      if (r && r.keywords.length) all.push(...r.keywords);
    });
    const unique = Array.from(new Set(all));
    if (unique.length === 0) {
      showToast('복사할 결과가 없습니다', 'err');
      return;
    }
    const text = unique.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      showToast(`${MARKETS.find(m => m.key === market)?.label} 결과 ${unique.length}개 복사됨`);
    }).catch(() => showToast('복사 실패', 'err'));
  };

  const downloadCsv = () => {
    if (history.length === 0) {
      showToast('내려받을 결과가 없습니다', 'err');
      return;
    }
    const cols = ['검색어', ...selectedMarkets.map(m => MARKETS.find(x => x.key === m)?.label || m)];
    const rows: string[] = [cols.join(',')];
    history.forEach(h => {
      const cells = [
        `"${h.query.replace(/"/g, '""')}"`,
        ...selectedMarkets.map(m => {
          const r = h.results[m];
          if (!r) return '""';
          if (r.error) return `"ERROR: ${r.error.replace(/"/g, '""')}"`;
          return `"${r.keywords.join(' | ').replace(/"/g, '""')}"`;
        }),
      ];
      rows.push(cells.join(','));
    });
    const csv = '﻿' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `자동완성_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalKeywords = (market: AutocompleteMarket): number => {
    return history.reduce((acc, h) => acc + (h.results[market]?.keywords.length || 0), 0);
  };

  return (
    <div className="p-5 space-y-3">
      {/* 헤더 + 입력 */}
      <div className={`${card} border rounded-lg p-4 space-y-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <div className={`text-[15px] font-bold ${titleText}`}>마켓 자동완성</div>
          <span className={`text-[12px] ${subText}`}>각 마켓의 자동완성 단어를 일괄 조회합니다.</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <textarea
            value={bulkInput}
            onChange={e => setBulkInput(e.target.value)}
            placeholder="검색어를 줄바꿈/콤마로 구분 (예: 강아지\n고양이 사료)"
            rows={4}
            className={`px-3 py-2 text-[13px] rounded border ${inputCls} font-mono resize-none`}
          />
          <div className="flex flex-col gap-2 min-w-[220px]">
            <div className={`text-[11.5px] font-bold ${titleText}`}>마켓 선택</div>
            {MARKETS.map(m => (
              <label key={m.key} className={`flex items-center gap-2 px-2.5 py-1.5 rounded border cursor-pointer ${
                enabled[m.key]
                  ? `border-[${m.color}]/50 ${dark ? 'bg-[#252540]' : 'bg-gray-50'}`
                  : dark ? 'border-[#2a2a40]' : 'border-gray-200'
              }`} style={enabled[m.key] ? { borderColor: m.color + '80' } : undefined}>
                <input
                  type="checkbox"
                  checked={enabled[m.key]}
                  onChange={e => setEnabled(prev => ({ ...prev, [m.key]: e.target.checked }))}
                  style={{ accentColor: m.color }}
                />
                <div className="flex-1">
                  <div className={`text-[12.5px] font-medium ${titleText}`} style={{ color: enabled[m.key] ? m.color : undefined }}>
                    {m.label}
                  </div>
                  <div className={`text-[10.5px] ${subText}`}>{m.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!busy ? (
            <button
              onClick={handleRun}
              className="px-4 py-1.5 text-[13px] rounded font-medium text-white bg-[#03c75a] hover:bg-[#02b350]"
            >
              조회
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="px-4 py-1.5 text-[13px] rounded font-medium text-white bg-rose-600 hover:bg-rose-700"
            >
              중지
            </button>
          )}
          <button
            onClick={downloadCsv}
            disabled={history.length === 0}
            className={`px-3 py-1.5 text-[12px] rounded border font-medium ${
              dark ? 'border-[#2a2a40] text-gray-200 hover:bg-[#252540]' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            } disabled:opacity-50`}
          >
            CSV 내보내기
          </button>
          <div className={`text-[12px] ${subText} ml-2`}>
            {busy && progress.total > 0 && `${progress.done} / ${progress.total} 진행중…`}
            {!busy && history.length > 0 && `${history.length}개 검색어 조회 완료`}
          </div>
        </div>
      </div>

      {/* 결과 */}
      {history.length > 0 && (
        <div className={`${card} border rounded-lg overflow-hidden`}>
          <div className={`px-4 py-2 border-b flex items-center gap-3 ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
            <div className={`text-[13px] font-bold ${titleText}`}>결과</div>
            <div className="flex-1" />
            {selectedMarkets.map(m => {
              const def = MARKETS.find(x => x.key === m);
              return (
                <button
                  key={m}
                  onClick={() => copyAll(m)}
                  className={`px-2.5 py-1 text-[11px] rounded border font-medium ${
                    dark ? 'border-[#2a2a40] text-gray-200 hover:bg-[#252540]' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                  style={{ color: def?.color }}
                >
                  {def?.label} 전체복사 ({totalKeywords(m)})
                </button>
              );
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className={`sticky top-0 ${dark ? 'bg-[#1c1c2e]' : 'bg-gray-50'} ${subText}`}>
                <tr className={`border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
                  <th className="text-left py-1.5 px-3 w-[180px]">검색어</th>
                  {selectedMarkets.map(m => {
                    const def = MARKETS.find(x => x.key === m);
                    return (
                      <th key={m} className="text-left px-3" style={{ color: def?.color }}>
                        {def?.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {history.map((h, idx) => (
                  <tr key={idx} className={`border-b align-top ${dark ? 'border-[#2a2a40]' : 'border-gray-100'}`}>
                    <td className={`py-2 px-3 font-bold ${titleText}`}>{h.query}</td>
                    {selectedMarkets.map(m => {
                      const r = h.results[m];
                      if (!r) return <td key={m} className="px-3 py-2"></td>;
                      if (r.error) {
                        return <td key={m} className="px-3 py-2 text-rose-500 text-[11px]">에러: {r.error}</td>;
                      }
                      if (r.keywords.length === 0) {
                        return <td key={m} className={`px-3 py-2 ${subText}`}>(결과 없음)</td>;
                      }
                      return (
                        <td key={m} className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.keywords.map((kw, i) => (
                              <span
                                key={i}
                                className={`inline-block px-1.5 py-0.5 rounded text-[11.5px] cursor-pointer ${
                                  dark ? 'bg-[#252540] text-gray-200 hover:bg-[#303054]' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                                }`}
                                onClick={() => {
                                  navigator.clipboard.writeText(kw).then(() => showToast(`"${kw}" 복사됨`));
                                }}
                                title="클릭하여 복사"
                              >
                                {kw}
                              </span>
                            ))}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-lg shadow-lg text-[13px] font-medium z-50 ${
          toast.tone === 'ok' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
