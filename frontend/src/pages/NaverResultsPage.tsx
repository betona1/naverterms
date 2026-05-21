import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTheme } from '../hooks/useTheme';
import { getResultsKeywords, toggleFavorite, type ResultKeyword } from '../api/naverApi';

const TAB_LABEL: Record<string, string> = { total: '전체', model: '가격비교', checkout: '네이버페이' };
const TAB_ORDER = ['total', 'model', 'checkout'] as const;

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

type GroupKey = 'fav' | 'data' | 'empty';

export default function NaverResultsPage() {
  const { dark } = useTheme();
  const [keywords, setKeywords] = useState<ResultKeyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<GroupKey, boolean>>({
    fav: true,
    data: true,
    empty: false, // 데이터 없음은 기본 접힘
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getResultsKeywords();
      setKeywords(r.keywords);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onFav = useCallback(async (id: number, current: boolean) => {
    // Optimistic
    setKeywords(prev => prev.map(k => k.id === id ? { ...k, is_favorite: !current } : k));
    try {
      await toggleFavorite(id, !current);
    } catch (e) {
      setKeywords(prev => prev.map(k => k.id === id ? { ...k, is_favorite: current } : k));
    }
  }, []);

  const groups = useMemo(() => {
    const fav: ResultKeyword[] = [];
    const data: ResultKeyword[] = [];
    const empty: ResultKeyword[] = [];
    for (const k of keywords) {
      if (k.is_favorite) fav.push(k);
      else if (k.has_data) data.push(k);
      else empty.push(k);
    }
    return { fav, data, empty };
  }, [keywords]);

  // ── 스타일 ──
  const bg = dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]';
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const txt = dark ? 'text-gray-100' : 'text-gray-900';
  const sub = dark ? 'text-gray-400' : 'text-gray-500';
  const divide = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  const kwCard = dark
    ? 'bg-[#16162a] hover:bg-[#1e1e36] border-[#2a2a40]'
    : 'bg-white hover:bg-gray-50 border-gray-200';

  const toggleGroup = (g: GroupKey) =>
    setOpenGroups(prev => ({ ...prev, [g]: !prev[g] }));

  return (
    <div className={`min-h-screen ${bg} ${txt}`}>
      <div className="max-w-[1100px] mx-auto px-4 py-6">
        {/* 헤더 */}
        <div className={`flex items-center justify-between pb-3 mb-4 border-b ${divide}`}>
          <div>
            <h1 className="text-[20px] font-extrabold">결과보기</h1>
            <p className={`text-[12px] mt-1 ${sub}`}>
              최근 업데이트 순 · 총 {keywords.length}개 키워드
              {' · '}
              <span className="text-[#ef4444]">⭐ {groups.fav.length}</span>
              {' · '}
              <span className="text-[#03c75a]">📦 {groups.data.length}</span>
              {' · '}
              <span>∅ {groups.empty.length}</span>
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className={`px-4 py-2 text-[12px] font-bold rounded-lg transition-colors ${
              dark ? 'bg-[#2a2a40] hover:bg-[#333355] text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
            } disabled:opacity-50`}
          >
            {loading ? '로딩중...' : '🔄 새로고침'}
          </button>
        </div>

        {loading && keywords.length === 0 && (
          <div className={`text-center py-16 ${sub}`}>로딩 중...</div>
        )}

        {!loading && keywords.length === 0 && (
          <div className={`text-center py-16 ${sub}`}>수집된 키워드가 없습니다.</div>
        )}

        {/* 즐겨찾기 그룹 */}
        {groups.fav.length > 0 && (
          <Section
            title="⭐ 즐겨찾기"
            count={groups.fav.length}
            open={openGroups.fav}
            onToggle={() => toggleGroup('fav')}
            accent="#ef4444"
            dark={dark}
          >
            <KeywordList items={groups.fav} onFav={onFav} cardCls={kwCard} subCls={sub} txtCls={txt} />
          </Section>
        )}

        {/* 수집 완료 */}
        {groups.data.length > 0 && (
          <Section
            title="📦 수집 완료"
            count={groups.data.length}
            open={openGroups.data}
            onToggle={() => toggleGroup('data')}
            accent="#03c75a"
            dark={dark}
          >
            <KeywordList items={groups.data} onFav={onFav} cardCls={kwCard} subCls={sub} txtCls={txt} />
          </Section>
        )}

        {/* 데이터 없음 */}
        {groups.empty.length > 0 && (
          <Section
            title="∅ 데이터 없음"
            count={groups.empty.length}
            open={openGroups.empty}
            onToggle={() => toggleGroup('empty')}
            accent="#6b7280"
            dark={dark}
            card={card}
          >
            <KeywordList items={groups.empty} onFav={onFav} cardCls={kwCard} subCls={sub} txtCls={txt} />
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title, count, open, onToggle, accent, dark, children,
}: {
  title: string; count: number; open: boolean; onToggle: () => void;
  accent: string; dark: boolean; card?: string; children: React.ReactNode;
}) {
  const hdr = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const hover = dark ? 'hover:bg-[#22223a]' : 'hover:bg-gray-50';
  return (
    <div className="mb-4">
      <button
        onClick={onToggle}
        className={`w-full rounded-t-lg border px-4 py-3 flex items-center gap-3 ${hdr} ${hover} transition-colors ${
          !open ? 'rounded-b-lg' : ''
        }`}
        style={{ borderLeftWidth: 4, borderLeftColor: accent }}
      >
        <span className={`text-[11px] font-mono ${open ? 'rotate-90' : ''} transition-transform`}>▶</span>
        <span className="font-extrabold text-[14px]" style={{ color: accent }}>{title}</span>
        <span className={`text-[11px] ${dark ? 'text-gray-400' : 'text-gray-500'}`}>({count})</span>
        <span className={`ml-auto text-[10px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
          {open ? '접기' : '펼치기'}
        </span>
      </button>
      {open && (
        <div className={`border border-t-0 rounded-b-lg overflow-hidden ${hdr}`}>
          {children}
        </div>
      )}
    </div>
  );
}

function KeywordList({
  items, onFav, cardCls, subCls, txtCls,
}: {
  items: ResultKeyword[];
  onFav: (id: number, current: boolean) => void;
  cardCls: string; subCls: string; txtCls: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="divide-y divide-gray-200 dark:divide-[#2a2a40]">
      {items.map(k => (
        <KeywordRow
          key={k.id}
          k={k}
          onFav={onFav}
          cardCls={cardCls}
          subCls={subCls}
          txtCls={txtCls}
        />
      ))}
    </div>
  );
}

function KeywordRow({
  k, onFav, subCls, txtCls,
}: {
  k: ResultKeyword;
  onFav: (id: number, current: boolean) => void;
  cardCls: string; subCls: string; txtCls: string;
}) {
  const dlUrl = `/api/naver/export/products/${k.id}/`;
  return (
    <div className={`px-4 py-3 flex items-center gap-3 transition-colors hover:bg-black/5 dark:hover:bg-white/5`}>
      {/* 하트 */}
      <button
        onClick={() => onFav(k.id, k.is_favorite)}
        className="shrink-0 text-[20px] leading-none transition-transform hover:scale-110"
        title={k.is_favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
      >
        {k.is_favorite ? '❤️' : '🤍'}
      </button>

      {/* 키워드 + 정보 */}
      <div className="flex-1 min-w-0">
        <div className={`font-bold text-[14px] truncate ${txtCls}`}>"{k.keyword}"</div>
        <div className={`text-[11px] ${subCls} mt-0.5 flex items-center gap-2 flex-wrap`}>
          <span>📅 {formatAgo(k.last_searched_at || k.created_at)}</span>
          <span>·</span>
          <span>전체 {k.total_count.toLocaleString()}개</span>
          {k.term_count > 0 && (
            <>
              <span>·</span>
              <span>Terms {k.term_count}</span>
            </>
          )}
          {k.terms && k.terms.length > 0 && (
            <span className="truncate max-w-[260px] text-[#60a5fa]">{k.terms.slice(0, 4).join(' · ')}</span>
          )}
        </div>
      </div>

      {/* 탭별 배지 */}
      <div className="flex gap-1 shrink-0">
        {TAB_ORDER.map(tab => {
          const c = k.collected[tab];
          const has = c && c.count > 0;
          return (
            <span
              key={tab}
              className={`px-2 py-1 text-[10px] font-bold rounded ${
                has
                  ? 'bg-[#03c75a]/15 text-[#03c75a]'
                  : 'bg-gray-200 dark:bg-[#2a2a40] text-gray-400'
              }`}
              title={has ? `${TAB_LABEL[tab]}: ${c.count}개 수집 (${c.total.toLocaleString()}개 중)` : `${TAB_LABEL[tab]}: 미수집`}
            >
              {TAB_LABEL[tab]}{has ? ` ${c.count}` : ''}
            </span>
          );
        })}
      </div>

      {/* 액션 */}
      <div className="flex gap-1 shrink-0">
        {k.has_data && (
          <a
            href={dlUrl}
            className="px-3 py-1.5 text-[11px] font-bold rounded bg-[#03c75a] hover:bg-[#02a04a] text-white"
            title="3시트 xlsx 다운로드"
            download
          >
            📗 Excel
          </a>
        )}
        <a
          href={`#terms?kw=${k.id}`}
          className="px-3 py-1.5 text-[11px] font-bold rounded bg-[#60a5fa] hover:bg-[#3b82f6] text-white"
          title="상세 분석 페이지"
        >
          분석 →
        </a>
      </div>
    </div>
  );
}
