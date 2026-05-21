import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import type { ResultKeyword, CrawlLogEntry } from '../api/naverApi';
import { useNaverExtension } from '../components/naver/useNaverExtension';
import ProductPopup from '../components/naver/ProductPopup';

const TAB_LABEL: Record<string, string> = { total: '전체', model: '가격비교', checkout: '네이버페이' };
const TAB_ORDER = ['total', 'model', 'checkout'] as const;

type GroupKey = 'fav' | 'all' | 'collected' | 'empty';

function formatAgo(iso: string | null): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전`;
  return iso.slice(0, 10);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export default function NaverTermsPage() {
  const { dark } = useTheme();
  const [results, setResults] = useState<ResultKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingKws, setPendingKws] = useState<string[]>([]);
  const [inputText, setInputText] = useState('');
  const [logs, setLogs] = useState<CrawlLogEntry[]>([]);
  const [openSections, setOpenSections] = useState<Record<GroupKey, boolean>>({
    fav: true, all: false, collected: false, empty: false,
  });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [popup, setPopup] = useState<{ keywordId: number; keyword: string; terms: string[]; initialTab?: string } | null>(null);
  const lastLogIdRef = useRef<number>(0);
  const sessionIdRef = useRef<string>('');
  const { extStatus, startTermSearch, onProgress } = useNaverExtension();

  // ── 데이터 로딩 ──
  const loadResults = useCallback(async () => {
    try {
      const r = await naverApi.getResultsKeywords();
      setResults(r.keywords);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      if (lastLogIdRef.current === 0) {
        const r = await naverApi.getCrawlLogs({ limit: 100 });
        const sorted = [...r.logs].sort((a, b) => a.id - b.id);
        setLogs(sorted);
        if (sorted.length) lastLogIdRef.current = sorted[sorted.length - 1].id;
      } else {
        const r = await naverApi.getCrawlLogs({ since_id: lastLogIdRef.current });
        if (r.logs.length) {
          setLogs(prev => [...prev, ...r.logs].slice(-300));
          lastLogIdRef.current = r.logs[r.logs.length - 1].id;
        }
      }
    } catch (e) {}
  }, []);

  useEffect(() => { loadResults(); }, [loadResults]);
  useEffect(() => { loadLogs(); }, [loadLogs]);

  // 수집 중에는 1.5초마다 로그 폴링
  useEffect(() => {
    const t = setInterval(loadLogs, extStatus.connected ? 1500 : 5000);
    return () => clearInterval(t);
  }, [extStatus.connected, loadLogs]);

  // ── 확장프로그램 진행 메시지 → DB로 미러링 ──
  useEffect(() => {
    return onProgress(async (msg: any) => {
      const text = msg?.message || msg?.status || msg?.type || '';
      if (!text) return;
      // 중복 방지용 간단한 dedupe (같은 메시지 1.5초 내 무시)
      try {
        await naverApi.postCrawlLog({
          type: msg?.error ? 'error' : (msg?.type === 'NAVER_SEARCH_COMPLETE' ? 'success' : 'progress'),
          message: typeof text === 'string' ? text : JSON.stringify(text).slice(0, 500),
          keyword: msg?.keyword || '',
          session_id: sessionIdRef.current,
        });
      } catch (e) {}
      // 완료 이벤트 시 키워드 목록 새로고침
      if (msg?.type === 'NAVER_SEARCH_COMPLETE') {
        setTimeout(loadResults, 500);
      }
    });
  }, [onProgress, loadResults]);

  // ── 검색어 입력 / 추가 / 검색 ──
  const addKeyword = () => {
    const text = inputText.trim();
    if (!text) return;
    const lines = text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    setPendingKws(prev => Array.from(new Set([...prev, ...lines])));
    setInputText('');
  };

  const removePending = (kw: string) => {
    setPendingKws(prev => prev.filter(k => k !== kw));
  };

  const startSearch = async () => {
    if (!extStatus.connected) {
      // 확장프로그램 미설치 → 안내 페이지로
      window.location.hash = 'extension';
      return;
    }
    if (pendingKws.length === 0) return;
    sessionIdRef.current = String(Date.now());
    await naverApi.postCrawlLog({
      type: 'info',
      message: `── ${pendingKws.length}개 키워드 검색 시작 ──`,
      session_id: sessionIdRef.current,
    });
    startTermSearch(pendingKws);
    setPendingKws([]);
    loadLogs();
  };

  // ── 다시수집 — 확장프로그램 배치모드로 3탭 모두 재수집 ──
  const onReCollect = useCallback((kw: string) => {
    if (!extStatus.connected) {
      if (confirm('확장프로그램이 연결되지 않았습니다. 설치 안내 페이지로 이동하시겠습니까?')) {
        window.location.hash = 'extension';
      }
      return;
    }
    if (!confirm(`"${kw}" 키워드를 다시수집합니다.\n전체/가격비교/네이버페이 3개 탭 모두 재수집됩니다.\n\n진행하시겠습니까?`)) return;
    sessionIdRef.current = String(Date.now());
    naverApi.postCrawlLog({
      type: 'info',
      message: `🔄 "${kw}" 다시수집 시작`,
      keyword: kw,
      session_id: sessionIdRef.current,
    }).catch(() => {});
    startTermSearch([kw], ['model', 'total', 'checkout']);
  }, [extStatus.connected, startTermSearch]);

  // ── 즐겨찾기 토글 ──
  const onToggleFav = useCallback(async (id: number, current: boolean) => {
    setResults(prev => prev.map(k => k.id === id ? { ...k, is_favorite: !current } : k));
    try { await naverApi.toggleFavorite(id, !current); }
    catch (e) { setResults(prev => prev.map(k => k.id === id ? { ...k, is_favorite: current } : k)); }
  }, []);

  // ── 선택 체크박스 ──
  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const selectAll = (kws: ResultKeyword[]) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      const allSelected = kws.every(k => n.has(k.id));
      if (allSelected) kws.forEach(k => n.delete(k.id));
      else kws.forEach(k => n.add(k.id));
      return n;
    });
  };

  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`${selectedIds.size}개 키워드를 삭제합니다. 진행하시겠습니까?`)) return;
    for (const id of selectedIds) {
      try { await naverApi.deleteKeyword(id); } catch (e) {}
    }
    setSelectedIds(new Set());
    loadResults();
  };

  // ── 그룹 분류 (모두 최근업데이트순) ──
  const groups = useMemo(() => {
    const sorted = [...results]; // 백엔드가 이미 정렬
    const fav = sorted.filter(k => k.is_favorite);
    const all = sorted; // 즐겨찾기 포함 전체
    const collected = sorted.filter(k => k.has_data);
    const empty = sorted.filter(k => !k.has_data);
    return { fav, all, collected, empty };
  }, [results]);

  const clearLogs = async () => {
    if (!confirm('수집 로그를 모두 삭제합니다. 진행하시겠습니까?')) return;
    await naverApi.clearCrawlLogs();
    setLogs([]);
    lastLogIdRef.current = 0;
  };

  // ── 스타일 ──
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputBg = dark
    ? 'bg-[#16162a] border-[#2a2a40] text-gray-100'
    : 'bg-white border-gray-200 text-gray-900';

  return (
    <div className={`min-h-screen ${bg} ${txt}`}>
      <div className="max-w-[1100px] mx-auto px-4 py-6">

        {/* ── 상단: 검색어 입력 + 추가 + Terms 검색 ── */}
        <div className={`rounded-xl border p-4 mb-4 ${card}`}>
          <div className="flex items-center gap-2 mb-3">
            <h1 className="text-[18px] font-extrabold">Term 분석</h1>
            <span className={`text-[11px] ${sub}`}>키워드 검색대상 추가 → Terms 검색으로 확장프로그램 수집</span>
            <span className="ml-auto flex items-center gap-2 text-[11px]">
              <span className={`w-2 h-2 rounded-full ${extStatus.connected ? 'bg-[#03c75a]' : 'bg-gray-400'}`} />
              <span className={sub}>확장 {extStatus.connected ? `연결됨${extStatus.version ? ` v${extStatus.version}` : ''}` : '미연결'}</span>
            </span>
          </div>

          <div className="flex gap-2 mb-3">
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="키워드를 입력 (쉼표 또는 줄바꿈으로 여러개)"
              rows={2}
              className={`flex-1 px-3 py-2 text-[13px] rounded-lg border ${inputBg} resize-none`}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault(); addKeyword();
                }
              }}
            />
            <button
              onClick={addKeyword}
              disabled={!inputText.trim()}
              className="shrink-0 px-4 py-2 text-[13px] font-bold rounded-lg bg-[#0078d7] hover:bg-[#0066b3] disabled:opacity-40 text-white"
            >
              + 검색어 추가
            </button>
          </div>

          {/* 검색대상어 미리보기 + Terms 검색 */}
          <div className="flex items-start gap-2">
            <div className="flex-1 min-h-[40px]">
              {pendingKws.length === 0 ? (
                <div className={`text-[12px] ${sub} pt-2`}>
                  검색대상어가 없습니다. 위에서 키워드를 추가하세요.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <span className={`text-[11px] font-bold ${sub} self-center`}>
                    검색대상어 ({pendingKws.length})
                  </span>
                  {pendingKws.map(kw => (
                    <span
                      key={kw}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#0078d7]/15 text-[#0078d7] text-[11px] font-bold"
                    >
                      {kw}
                      <button
                        onClick={() => removePending(kw)}
                        className="hover:opacity-70 text-[14px] leading-none"
                        title="제거"
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={startSearch}
              disabled={pendingKws.length === 0}
              className={`shrink-0 px-5 py-2 text-[13px] font-bold rounded-lg text-white transition-colors ${
                pendingKws.length === 0
                  ? 'bg-gray-400 cursor-not-allowed'
                  : extStatus.connected
                    ? 'bg-[#03c75a] hover:bg-[#02a04a]'
                    : 'bg-[#f59e0b] hover:bg-[#d97706]'
              }`}
              title={extStatus.connected ? 'Terms 검색 시작' : '확장프로그램 미연결 — 설치 안내로 이동'}
            >
              {extStatus.connected ? '🔍 Terms 검색' : '⚠ 확장 설치 안내'}
            </button>
          </div>
        </div>

        {/* ── 수집 로그 ── */}
        <div className={`rounded-xl border p-4 mb-4 ${card}`}>
          <div className="flex items-center mb-2">
            <h2 className="text-[14px] font-bold">📜 수집 로그</h2>
            <span className={`ml-2 text-[11px] ${sub}`}>최근 {logs.length}개 (DB 저장)</span>
            <button
              onClick={clearLogs}
              className={`ml-auto text-[11px] px-2 py-1 rounded ${dark ? 'bg-[#2a2a40] hover:bg-[#333355]' : 'bg-gray-200 hover:bg-gray-300'}`}
            >
              로그 비우기
            </button>
          </div>
          <div
            className={`max-h-[200px] overflow-y-auto rounded p-2 text-[11px] font-mono ${
              dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'
            }`}
            ref={el => { if (el) el.scrollTop = el.scrollHeight; }}
          >
            {logs.length === 0 ? (
              <div className={sub}>로그 없음</div>
            ) : (
              logs.slice(-200).map(l => (
                <div key={l.id} className="flex gap-2">
                  <span className={sub}>[{formatTime(l.timestamp)}]</span>
                  <span className={
                    l.type === 'success' ? 'text-[#22c55e]' :
                    l.type === 'error' ? 'text-[#ef4444]' :
                    l.type === 'progress' ? 'text-[#60a5fa]' :
                    l.type === 'captcha' ? 'text-[#f59e0b]' :
                    txt
                  }>
                    {l.message}
                  </span>
                  {l.keyword && (
                    <span className={`ml-auto text-[10px] ${sub}`}>"{l.keyword}"</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── 4 섹션 ── */}
        {loading && results.length === 0 && (
          <div className={`text-center py-16 ${sub}`}>로딩 중...</div>
        )}

        {!loading && (
          <>
            <Section
              title="⭐ 즐겨찾기"
              accent="#ef4444"
              items={groups.fav}
              open={openSections.fav}
              onToggle={() => setOpenSections(p => ({ ...p, fav: !p.fav }))}
              onFav={onToggleFav}
              onOpen={(k, tab) => setPopup({ keywordId: k.id, keyword: k.keyword, terms: k.terms || [], initialTab: tab })}
              onReCollect={onReCollect}
              dark={dark}
            />
            <Section
              title="📋 모든키워드"
              accent="#0078d7"
              items={groups.all}
              open={openSections.all}
              onToggle={() => setOpenSections(p => ({ ...p, all: !p.all }))}
              onFav={onToggleFav}
              onOpen={(k, tab) => setPopup({ keywordId: k.id, keyword: k.keyword, terms: k.terms || [], initialTab: tab })}
              onReCollect={onReCollect}
              dark={dark}
              showCheckbox
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onSelectAll={() => selectAll(groups.all)}
              onDelete={deleteSelected}
            />
            <Section
              title="✅ 수집키워드"
              accent="#03c75a"
              items={groups.collected}
              open={openSections.collected}
              onToggle={() => setOpenSections(p => ({ ...p, collected: !p.collected }))}
              onFav={onToggleFav}
              onOpen={(k, tab) => setPopup({ keywordId: k.id, keyword: k.keyword, terms: k.terms || [], initialTab: tab })}
              onReCollect={onReCollect}
              dark={dark}
            />
            <Section
              title="∅ 미수집키워드"
              accent="#6b7280"
              items={groups.empty}
              open={openSections.empty}
              onToggle={() => setOpenSections(p => ({ ...p, empty: !p.empty }))}
              onFav={onToggleFav}
              onOpen={(k, tab) => setPopup({ keywordId: k.id, keyword: k.keyword, terms: k.terms || [], initialTab: tab })}
              onReCollect={onReCollect}
              dark={dark}
            />
          </>
        )}
      </div>

      {popup && (
        <ProductPopup
          keywordId={popup.keywordId}
          keyword={popup.keyword}
          terms={popup.terms}
          initialTab={popup.initialTab}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════
// Section: collapsible 그룹
// 접힘: "kw1, kw2, kw3, kw4, kw5 외 N개"
// 펼침: 전체 키워드 행
// ══════════════════════════════════════════
function Section({
  title, accent, items, open, onToggle, onFav, onOpen, onReCollect, dark,
  showCheckbox, selectedIds, onToggleSelect, onSelectAll, onDelete,
}: {
  title: string; accent: string; items: ResultKeyword[];
  open: boolean; onToggle: () => void;
  onFav: (id: number, current: boolean) => void;
  onOpen: (k: ResultKeyword, tab?: string) => void;
  onReCollect: (kw: string) => void;
  dark: boolean;
  showCheckbox?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  onSelectAll?: () => void;
  onDelete?: () => void;
}) {
  const hdr = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const hover = dark ? 'hover:bg-[#22223a]' : 'hover:bg-gray-50';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const previewKws = items.slice(0, 5).map(k => k.keyword);
  const restCount = Math.max(0, items.length - 5);
  const selectedCount = selectedIds && showCheckbox
    ? items.filter(k => selectedIds.has(k.id)).length
    : 0;

  return (
    <div className="mb-3">
      <button
        onClick={onToggle}
        className={`w-full rounded-t-lg border px-4 py-3 flex items-center gap-3 ${hdr} ${hover} transition-colors ${
          !open ? 'rounded-b-lg' : ''
        }`}
        style={{ borderLeftWidth: 4, borderLeftColor: accent }}
      >
        <span className={`text-[11px] font-mono ${open ? 'rotate-90' : ''} transition-transform inline-block w-2`}>▶</span>
        <span className="font-extrabold text-[14px]" style={{ color: accent }}>{title}</span>
        <span className={`text-[11px] ${sub}`}>({items.length})</span>
        {!open && items.length > 0 && (
          <span className={`text-[11px] ${sub} truncate flex-1 text-left ml-2`}>
            {previewKws.join(', ')}
            {restCount > 0 && ` 외 ${restCount}개`}
          </span>
        )}
        <span className={`ml-auto text-[10px] ${sub}`}>
          {open ? '접기' : '펼치기'}
        </span>
      </button>
      {open && (
        <div className={`border border-t-0 rounded-b-lg ${hdr}`}>
          {showCheckbox && items.length > 0 && (
            <div className={`flex items-center gap-2 px-4 py-2 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
              <input
                type="checkbox"
                checked={selectedCount > 0 && selectedCount === items.length}
                ref={el => { if (el) el.indeterminate = selectedCount > 0 && selectedCount < items.length; }}
                onChange={onSelectAll}
                className="cursor-pointer"
              />
              <span className={`text-[11px] ${sub}`}>
                {selectedCount > 0 ? `${selectedCount}개 선택됨` : '전체 선택'}
              </span>
              {selectedCount > 0 && (
                <button
                  onClick={onDelete}
                  className="ml-auto px-3 py-1 text-[11px] font-bold rounded bg-[#ef4444] hover:bg-[#dc2626] text-white"
                >
                  🗑️ 선택 삭제 ({selectedCount})
                </button>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <div className={`px-4 py-4 text-[12px] ${sub}`}>키워드 없음</div>
          ) : (
            items.map(k => (
              <KeywordRow
                key={k.id}
                k={k}
                onFav={onFav}
                onOpen={onOpen}
                onReCollect={onReCollect}
                dark={dark}
                showCheckbox={showCheckbox}
                checked={selectedIds?.has(k.id) ?? false}
                onToggleSelect={onToggleSelect}
                txt={txt}
                sub={sub}
                divider={dark ? 'border-[#2a2a40]' : 'border-gray-200'}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function KeywordRow({
  k, onFav, onOpen, onReCollect, dark, showCheckbox, checked, onToggleSelect, txt, sub, divider,
}: {
  k: ResultKeyword;
  onFav: (id: number, current: boolean) => void;
  onOpen: (k: ResultKeyword, tab?: string) => void;
  onReCollect: (kw: string) => void;
  dark: boolean;
  showCheckbox?: boolean;
  checked: boolean;
  onToggleSelect?: (id: number) => void;
  txt: string; sub: string; divider: string;
}) {
  return (
    <div className={`px-4 py-2.5 flex items-center gap-3 border-t ${divider} ${dark ? 'hover:bg-[#16162a]' : 'hover:bg-gray-50'}`}>
      {showCheckbox && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleSelect?.(k.id)}
          className="cursor-pointer shrink-0"
        />
      )}
      <button
        onClick={() => onFav(k.id, k.is_favorite)}
        className="shrink-0 text-[18px] leading-none transition-transform hover:scale-110"
        title={k.is_favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
      >
        {k.is_favorite ? '❤️' : '🤍'}
      </button>
      <button
        onClick={() => onOpen(k, 'total')}
        className="flex-1 min-w-0 text-left cursor-pointer group"
        title="상품정보 보기 (전체)"
      >
        <div className={`font-bold text-[13px] truncate ${txt} group-hover:text-[#0078d7] group-hover:underline`}>"{k.keyword}"</div>
        <div className={`text-[10px] ${sub} mt-0.5 flex gap-2 flex-wrap`}>
          <span>📅 {formatAgo(k.last_searched_at || k.created_at)}</span>
          <span>·</span>
          <span>전체 {k.total_count.toLocaleString()}개</span>
          {k.term_count > 0 && (<><span>·</span><span>Terms {k.term_count}</span></>)}
          {k.terms?.length > 0 && (
            <span className="truncate max-w-[200px] text-[#60a5fa]">{k.terms.slice(0, 4).join(' · ')}</span>
          )}
        </div>
      </button>
      <div className="flex gap-1 shrink-0">
        {TAB_ORDER.map(tab => {
          const c = k.collected[tab];
          const has = c && c.count > 0;
          return (
            <button
              key={tab}
              onClick={() => has && onOpen(k, tab)}
              disabled={!has}
              className={`px-2 py-0.5 text-[10px] font-bold rounded transition ${
                has
                  ? 'bg-[#03c75a]/15 text-[#03c75a] hover:bg-[#03c75a]/30 cursor-pointer'
                  : (dark ? 'bg-[#2a2a40] text-gray-500' : 'bg-gray-200 text-gray-400') + ' cursor-not-allowed'
              }`}
              title={has ? `${TAB_LABEL[tab]}: ${c.count}개 — 클릭해서 모달 보기` : `${TAB_LABEL[tab]}: 미수집`}
            >
              {TAB_LABEL[tab]}{has ? ` ${c.count}` : ''}
            </button>
          );
        })}
      </div>
      {k.has_data && (
        <a
          href={`/api/naver/export/products/${k.id}/`}
          download
          className="shrink-0 px-2.5 py-1 text-[10px] font-bold rounded bg-[#03c75a] hover:bg-[#02a04a] text-white"
          title="3시트 xlsx 다운로드"
        >
          📗
        </a>
      )}
      <button
        onClick={() => onReCollect(k.keyword)}
        className="shrink-0 px-2.5 py-1 text-[10px] font-bold rounded bg-[#0078d7] hover:bg-[#0066b3] text-white"
        title="확장프로그램으로 3탭 다시수집"
      >
        🔄
      </button>
    </div>
  );
}
