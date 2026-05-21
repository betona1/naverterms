import { useState, useEffect, useCallback, Fragment } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  fetchAttrStats, fetchAttrProducts, fetchAttrProductDetail,
  fetchTopTags, fetchQualityIssues, fetchCategorySummary,
  fetchTopAttributes, fetchAttributeValues,
  type AttrStats, type AttrProduct, type AttrProductDetail,
  type TopTag, type QualityIssue, type CategorySummary,
  type TopAttribute, type AttrValueRow, type AttrGroup,
} from '../api/attrAnalyticsApi';

type Tab = 'products' | 'attrs' | 'tags' | 'quality' | 'categories';

const SECTION_OPTIONS = ['상품속성', '검색설정', '검색정보', '상품주요정보', '인증정보'] as const;

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined) return '-';
  return n.toLocaleString();
}

export default function AttrAnalyticsPage() {
  const { dark } = useTheme();

  const [tab, setTab] = useState<Tab>('products');
  const [stats, setStats] = useState<AttrStats | null>(null);

  // filters
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [hasQualityOnly, setHasQualityOnly] = useState(false);

  // products
  const [products, setProducts] = useState<AttrProduct[]>([]);
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loadingList, setLoadingList] = useState(false);

  // tabs data
  const [topTags, setTopTags] = useState<TopTag[]>([]);
  const [tagSort, setTagSort] = useState<'count' | 'volume'>('count');
  const [qualityIssues, setQualityIssues] = useState<QualityIssue[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);

  // attrs tab
  const [attrs, setAttrs] = useState<TopAttribute[]>([]);
  const [attrSection, setAttrSection] = useState<string>('상품속성');
  const [loadingAttrs, setLoadingAttrs] = useState(false);
  const [expandedAttr, setExpandedAttr] = useState<string | null>(null);
  const [attrValues, setAttrValues] = useState<AttrValueRow[]>([]);
  const [loadingAttrValues, setLoadingAttrValues] = useState(false);

  // detail modal
  const [detail, setDetail] = useState<AttrProductDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // theme tokens
  const card = dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const inputCls = dark
    ? 'bg-[#252540] border-[#2a2a40] text-white placeholder-gray-500'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400';
  const tableHeader = dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-50 text-gray-600';
  const rowHover = dark ? 'hover:bg-[#252540]' : 'hover:bg-gray-50';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  const loadStats = useCallback(() => {
    fetchAttrStats().then(setStats).catch(() => {});
  }, []);

  const loadProducts = useCallback(() => {
    setLoadingList(true);
    fetchAttrProducts({
      page, per_page: perPage, search,
      needs_review: needsReviewOnly ? 1 : undefined,
      has_quality: hasQualityOnly ? 1 : undefined,
    })
      .then(r => {
        setProducts(r.items);
        setTotal(r.total);
        setTotalPages(r.total_pages);
      })
      .catch(() => { setProducts([]); setTotal(0); setTotalPages(0); })
      .finally(() => setLoadingList(false));
  }, [page, perPage, search, needsReviewOnly, hasQualityOnly]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => {
    if (tab === 'products') loadProducts();
  }, [tab, loadProducts]);

  useEffect(() => {
    if (tab !== 'tags') return;
    fetchTopTags({ limit: 50, by: tagSort })
      .then(r => setTopTags(r.items))
      .catch(() => setTopTags([]));
  }, [tab, tagSort]);

  useEffect(() => {
    if (tab !== 'quality') return;
    fetchQualityIssues(300)
      .then(r => setQualityIssues(r.items))
      .catch(() => setQualityIssues([]));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'categories') return;
    fetchCategorySummary(100)
      .then(r => setCategories(r.items))
      .catch(() => setCategories([]));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'attrs') return;
    setLoadingAttrs(true);
    setExpandedAttr(null);
    fetchTopAttributes({ limit: 200, section: attrSection })
      .then(r => setAttrs(r.items))
      .catch(() => setAttrs([]))
      .finally(() => setLoadingAttrs(false));
  }, [tab, attrSection]);

  const toggleAttrExpand = useCallback((attr: TopAttribute) => {
    if (expandedAttr === attr.attr_label) {
      setExpandedAttr(null);
      setAttrValues([]);
      return;
    }
    setExpandedAttr(attr.attr_label);
    setLoadingAttrValues(true);
    fetchAttributeValues({ attr_label: attr.attr_label, section: attr.section, limit: 50 })
      .then(r => setAttrValues(r.items))
      .catch(() => setAttrValues([]))
      .finally(() => setLoadingAttrValues(false));
  }, [expandedAttr]);

  const openDetail = useCallback((p: AttrProduct) => {
    setDetail(null);
    setLoadingDetail(true);
    fetchAttrProductDetail(p.seller_management_code, p.store_id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false));
  }, []);

  const onSearchSubmit = () => {
    setSearch(searchInput.trim());
    setPage(1);
  };

  return (
    <div className={`min-h-[calc(100vh-42px)] ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'} p-6`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className={`text-xl font-bold ${text}`}>상품속성 분석</h1>
          <p className={`text-[12px] mt-0.5 ${textSub}`}>
            크롤링한 상품 태그 / 속성값 / 검색품질 데이터를 한눈에
          </p>
        </div>
        <button
          onClick={() => { loadStats(); if (tab === 'products') loadProducts(); }}
          className={`px-3 py-1.5 rounded text-[12px] border ${dark ? 'border-[#2a2a40] hover:bg-[#252540] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}>
          새로고침
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard dark={dark} label="속성수집 SKU" value={fmt(stats?.attr_skus)} sub={`raw ${fmt(stats?.attr_crawl_rows)}건`} accent="#03c75a" />
        <StatCard dark={dark} label="태그 (표준+자유)" value={fmt(stats?.tag_rows)} sub={`표준 ${fmt(stats?.tag_standard)} · 자유 ${fmt(stats?.tag_freeform)}`} accent="#0078d7" />
        <StatCard dark={dark} label="속성값" value={fmt(stats?.attr_value_rows)} sub={`카테고리 ${fmt(stats?.categories)} · 스키마 ${fmt(stats?.schema_rows)}`} accent="#f59e0b" />
        <StatCard dark={dark} label="품질점검 SKU" value={fmt(stats?.quality_skus)} sub={`점검필요 ${fmt(stats?.quality_review)} / row ${fmt(stats?.quality_rows)}`} accent="#ef4444" />
      </div>

      {/* Tab Bar */}
      <div className={`flex gap-1 mb-3 border-b ${border}`}>
        {([
          { k: 'products', l: '상품 목록' },
          { k: 'attrs', l: '속성' },
          { k: 'tags', l: '인기 태그' },
          { k: 'quality', l: '품질 점검필요' },
          { k: 'categories', l: '카테고리' },
        ] as { k: Tab; l: string }[]).map(t => (
          <button key={t.k}
                  onClick={() => setTab(t.k)}
                  className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors -mb-px
                    ${tab === t.k
                      ? `${dark ? 'text-white' : 'text-gray-900'} border-[#03c75a]`
                      : `border-transparent ${textSub} hover:${dark ? 'text-gray-200' : 'text-gray-700'}`}`}>
            {t.l}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'products' && (
        <div className={`rounded-lg border ${card}`}>
          {/* filters */}
          <div className={`flex items-center gap-2 px-4 py-3 border-b ${border}`}>
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onSearchSubmit()}
              placeholder="W코드 / 카테고리 검색"
              className={`px-3 py-1.5 rounded text-[13px] border w-72 ${inputCls} focus:outline-none focus:border-[#03c75a]`} />
            <button onClick={onSearchSubmit}
                    className="px-3 py-1.5 rounded text-[13px] bg-[#03c75a] text-white hover:bg-[#02b150]">검색</button>
            {search && (
              <button onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
                      className={`px-2 py-1.5 rounded text-[12px] ${textSub} hover:${dark ? 'bg-[#252540]' : 'bg-gray-100'}`}>
                초기화
              </button>
            )}
            <label className={`flex items-center gap-1.5 ml-3 text-[12px] cursor-pointer ${textSub}`}>
              <input type="checkbox" checked={hasQualityOnly}
                     onChange={e => { setHasQualityOnly(e.target.checked); setPage(1); }} />
              품질데이터 있음
            </label>
            <label className={`flex items-center gap-1.5 text-[12px] cursor-pointer ${textSub}`}>
              <input type="checkbox" checked={needsReviewOnly}
                     onChange={e => { setNeedsReviewOnly(e.target.checked); setPage(1); }} />
              점검필요만
            </label>
            <div className="ml-auto text-[12px] text-gray-500">
              총 <span className={text}>{fmt(total)}</span>건
            </div>
          </div>

          {/* table */}
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className={tableHeader}>
                <tr className="text-left">
                  <th className="px-4 py-2 w-[110px]">W코드</th>
                  <th className="px-4 py-2">상품명</th>
                  <th className="px-4 py-2 w-[120px]">스토어</th>
                  <th className="px-4 py-2 w-[180px]">카테고리</th>
                  <th className="px-4 py-2 w-[80px] text-right">가격</th>
                  <th className="px-4 py-2 w-[60px] text-right">태그</th>
                  <th className="px-4 py-2 w-[60px] text-right">속성</th>
                  <th className="px-4 py-2 w-[80px] text-center">품질</th>
                </tr>
              </thead>
              <tbody className={text}>
                {loadingList ? (
                  <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>불러오는 중…</td></tr>
                ) : products.length === 0 ? (
                  <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>데이터 없음</td></tr>
                ) : products.map((p, i) => (
                  <tr key={`${p.seller_management_code}-${p.store_id}-${i}`}
                      onClick={() => openDetail(p)}
                      className={`border-t ${border} cursor-pointer ${rowHover}`}>
                    <td className="px-4 py-2 font-mono text-[11px]">{p.seller_management_code}</td>
                    <td className="px-4 py-2">
                      <div className="truncate max-w-[420px]" title={p.name || ''}>{p.name || '(이름 없음)'}</div>
                    </td>
                    <td className="px-4 py-2 truncate max-w-[120px]">{p.store_name || `#${p.store_id}`}</td>
                    <td className="px-4 py-2 truncate max-w-[180px]" title={p.category_text || ''}>
                      {p.category_text || '-'}
                    </td>
                    <td className="px-4 py-2 text-right">{p.sale_price ? fmt(p.sale_price) : '-'}</td>
                    <td className="px-4 py-2 text-right">{p.tag_count}</td>
                    <td className="px-4 py-2 text-right">{p.attr_count}</td>
                    <td className="px-4 py-2 text-center">
                      {p.quality_done > 0 ? (
                        p.review_count && p.review_count > 0 ? (
                          <span className="inline-block px-2 py-0.5 rounded text-[11px] bg-red-500/20 text-red-400">
                            점검 {p.review_count}
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded text-[11px] bg-green-500/20 text-green-400">정상</span>
                        )
                      ) : (
                        <span className={textSub}>-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* pagination */}
          <div className={`flex items-center justify-between px-4 py-3 border-t ${border}`}>
            <div className={`text-[12px] ${textSub}`}>
              {page} / {totalPages || 1} 페이지
            </div>
            <div className="flex gap-1">
              <button disabled={page <= 1}
                      onClick={() => setPage(1)}
                      className={`px-2 py-1 rounded text-[12px] ${dark ? 'border-[#2a2a40] text-gray-300' : 'border-gray-300 text-gray-600'} border disabled:opacity-40`}>
                ◀◀
              </button>
              <button disabled={page <= 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      className={`px-2 py-1 rounded text-[12px] ${dark ? 'border-[#2a2a40] text-gray-300' : 'border-gray-300 text-gray-600'} border disabled:opacity-40`}>
                ◀
              </button>
              <button disabled={page >= totalPages}
                      onClick={() => setPage(p => p + 1)}
                      className={`px-2 py-1 rounded text-[12px] ${dark ? 'border-[#2a2a40] text-gray-300' : 'border-gray-300 text-gray-600'} border disabled:opacity-40`}>
                ▶
              </button>
              <button disabled={page >= totalPages}
                      onClick={() => setPage(totalPages)}
                      className={`px-2 py-1 rounded text-[12px] ${dark ? 'border-[#2a2a40] text-gray-300' : 'border-gray-300 text-gray-600'} border disabled:opacity-40`}>
                ▶▶
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'attrs' && (
        <div className={`rounded-lg border ${card}`}>
          <div className={`flex items-center gap-2 px-4 py-3 border-b ${border}`}>
            <span className={`text-[13px] ${textSub}`}>섹션</span>
            {SECTION_OPTIONS.map(s => (
              <button key={s}
                      onClick={() => setAttrSection(s)}
                      className={`px-3 py-1 rounded text-[12px] ${attrSection === s ? 'bg-[#03c75a] text-white' : `${dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-100 text-gray-600'}`}`}>
                {s}
              </button>
            ))}
            <div className={`ml-auto text-[12px] ${textSub}`}>총 <span className={text}>{attrs.length}</span>건</div>
          </div>

          {attrSection === '상품속성' && (
            <div className={`px-4 py-2.5 text-[12px] border-b ${border}
              ${dark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
              ⚠ 상품속성 라벨이 <code>attr#NNNN</code> 형식 — 카테고리 스키마의 attributeSeq → 한글 매핑이 미완 (Stage B 미수행).
              현재 ID/옵션ID 그대로 표시됩니다.
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className={tableHeader}>
                <tr className="text-left">
                  <th className="px-4 py-2"></th>
                  <th className="px-4 py-2">속성 라벨</th>
                  <th className="px-4 py-2 w-[100px]">타입</th>
                  <th className="px-4 py-2 w-[80px] text-right">SKU</th>
                  <th className="px-4 py-2 w-[80px] text-right">사용</th>
                  <th className="px-4 py-2 w-[80px] text-right">고유값</th>
                  <th className="px-4 py-2 w-[80px] text-right">추천</th>
                  <th className="px-4 py-2 w-[100px] text-right">참/거짓</th>
                </tr>
              </thead>
              <tbody className={text}>
                {loadingAttrs ? (
                  <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>불러오는 중…</td></tr>
                ) : attrs.length === 0 ? (
                  <tr><td colSpan={8} className={`text-center py-10 ${textSub}`}>데이터 없음</td></tr>
                ) : attrs.map((a, i) => {
                  const expanded = expandedAttr === a.attr_label;
                  return (
                    <Fragment key={`${a.section}-${a.attr_label}-${i}`}>
                      <tr onClick={() => toggleAttrExpand(a)}
                          className={`border-t ${border} cursor-pointer ${rowHover}`}>
                        <td className="px-4 py-2 w-[24px]">{expanded ? '▼' : '▶'}</td>
                        <td className="px-4 py-2">
                          {a.resolved_label ? (
                            <div>
                              <div className="font-medium">{a.resolved_label}</div>
                              <div className={`text-[10px] font-mono ${textSub}`}>{a.attr_label}</div>
                            </div>
                          ) : (
                            <span className="font-mono text-[11px]" title={a.attr_label}>{a.attr_label}</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded ${dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>{a.attr_type}</span>
                        </td>
                        <td className="px-4 py-2 text-right">{fmt(a.sku_count)}</td>
                        <td className="px-4 py-2 text-right">{fmt(a.use_count)}</td>
                        <td className="px-4 py-2 text-right">{fmt(a.distinct_values)}</td>
                        <td className="px-4 py-2 text-right">{a.recommended_count ? fmt(a.recommended_count) : '-'}</td>
                        <td className="px-4 py-2 text-right">
                          {(a.true_count || a.false_count) ? (
                            <span><span className="text-[#03c75a]">{a.true_count}</span>/<span className={textSub}>{a.false_count}</span></span>
                          ) : '-'}
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={8} className={`px-6 py-3 ${dark ? 'bg-[#0f0f1a]' : 'bg-gray-50'}`}>
                            {loadingAttrValues ? (
                              <div className={textSub}>값 불러오는 중…</div>
                            ) : attrValues.length === 0 ? (
                              <div className={textSub}>값 없음</div>
                            ) : (
                              <div className="flex flex-wrap gap-2">
                                {attrValues.map((v, j) => (
                                  <div key={j}
                                       className={`px-2.5 py-1 rounded-full text-[11px] flex items-center gap-2 border
                                         ${dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200'}`}>
                                    {v.resolved_value ? (
                                      <span className={text}>
                                        {v.resolved_value}
                                        <span className={`ml-1 font-mono text-[10px] ${textSub}`}>#{v.value}</span>
                                      </span>
                                    ) : (
                                      <span className={text}>{v.value || '(빈값)'}</span>
                                    )}
                                    <span className={textSub}>×{v.cnt}</span>
                                    {v.recommended_count ? <span className="text-[#03c75a]">★{v.recommended_count}</span> : null}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'tags' && (
        <div className={`rounded-lg border ${card} p-4`}>
          <div className="flex items-center gap-2 mb-3">
            <span className={`text-[13px] ${textSub}`}>정렬</span>
            <button onClick={() => setTagSort('count')}
                    className={`px-3 py-1 rounded text-[12px] ${tagSort === 'count' ? 'bg-[#03c75a] text-white' : `${dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-100 text-gray-600'}`}`}>
              빈도
            </button>
            <button onClick={() => setTagSort('volume')}
                    className={`px-3 py-1 rounded text-[12px] ${tagSort === 'volume' ? 'bg-[#03c75a] text-white' : `${dark ? 'bg-[#252540] text-gray-300' : 'bg-gray-100 text-gray-600'}`}`}>
              검색량
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {topTags.length === 0 ? (
              <div className={textSub}>데이터 없음</div>
            ) : topTags.map((t, i) => (
              <div key={i}
                   className={`px-3 py-1.5 rounded-full text-[12px] flex items-center gap-2 border
                     ${dark ? 'bg-[#252540] border-[#2a2a40]' : 'bg-gray-50 border-gray-200'}`}>
                <span className={text}>{t.tag}</span>
                <span className={textSub}>×{t.cnt}</span>
                {t.sv !== null && (
                  <span className="text-[#03c75a]">{fmt(t.sv)}</span>
                )}
                {t.std === 1 && <span className="text-[10px] text-blue-400">표준</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'quality' && (
        <div className={`rounded-lg border ${card}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className={tableHeader}>
                <tr className="text-left">
                  <th className="px-4 py-2 w-[110px]">W코드</th>
                  <th className="px-4 py-2 w-[120px]">스토어</th>
                  <th className="px-4 py-2">상품명</th>
                  <th className="px-4 py-2 w-[120px]">카테고리</th>
                  <th className="px-4 py-2">점검 항목</th>
                  <th className="px-4 py-2 w-[80px] text-right">개수</th>
                </tr>
              </thead>
              <tbody className={text}>
                {qualityIssues.length === 0 ? (
                  <tr><td colSpan={6} className={`text-center py-10 ${textSub}`}>점검필요 데이터 없음</td></tr>
                ) : qualityIssues.map((q, i) => (
                  <tr key={`${q.seller_management_code}-${q.store_id}-${i}`}
                      onClick={() => openDetail({
                        seller_management_code: q.seller_management_code,
                        store_id: q.store_id,
                      } as AttrProduct)}
                      className={`border-t ${border} cursor-pointer ${rowHover}`}>
                    <td className="px-4 py-2 font-mono text-[11px]">{q.seller_management_code}</td>
                    <td className="px-4 py-2 truncate max-w-[120px]">{q.store_name || `#${q.store_id}`}</td>
                    <td className="px-4 py-2 truncate max-w-[420px]">{q.product_name || '-'}</td>
                    <td className="px-4 py-2 font-mono text-[11px]">{q.category_id || '-'}</td>
                    <td className="px-4 py-2">
                      {q.issues.split(',').map((it, j) => (
                        <span key={j} className="inline-block px-1.5 py-0.5 rounded mr-1 text-[10px] bg-red-500/20 text-red-400">{it}</span>
                      ))}
                    </td>
                    <td className="px-4 py-2 text-right text-red-400 font-bold">{q.issue_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'categories' && (
        <div className={`rounded-lg border ${card}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className={tableHeader}>
                <tr className="text-left">
                  <th className="px-4 py-2 w-[110px]">카테고리ID</th>
                  <th className="px-4 py-2">카테고리명</th>
                  <th className="px-4 py-2 w-[100px] text-right">SKU</th>
                  <th className="px-4 py-2 w-[120px] text-right">속성정의</th>
                </tr>
              </thead>
              <tbody className={text}>
                {categories.length === 0 ? (
                  <tr><td colSpan={4} className={`text-center py-10 ${textSub}`}>데이터 없음</td></tr>
                ) : categories.map((c, i) => (
                  <tr key={i} className={`border-t ${border}`}>
                    <td className="px-4 py-2 font-mono text-[11px]">{c.category_id}</td>
                    <td className="px-4 py-2">{c.category_text || '-'}</td>
                    <td className="px-4 py-2 text-right">{fmt(c.sku_count)}</td>
                    <td className="px-4 py-2 text-right">
                      {c.attr_def_count > 0
                        ? <span className="text-[#03c75a]">{c.attr_def_count}</span>
                        : <span className={textSub}>0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {(detail || loadingDetail) && (
        <DetailModal
          dark={dark}
          detail={detail}
          loading={loadingDetail}
          onClose={() => { setDetail(null); setLoadingDetail(false); }} />
      )}
    </div>
  );
}

function StatCard({ dark, label, value, sub, accent }:
  { dark: boolean; label: string; value: string; sub: string; accent: string }) {
  return (
    <div className={`rounded-lg border p-4 ${dark ? 'bg-[#1c1c2e] border-[#2a2a40]' : 'bg-white border-gray-200'}`}>
      <div className={`text-[12px] mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
      <div className="text-[22px] font-bold flex items-baseline gap-2" style={{ color: accent }}>
        {value}
      </div>
      <div className={`text-[11px] mt-1 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</div>
    </div>
  );
}

function DetailModal({ dark, detail, loading, onClose }:
  { dark: boolean; detail: AttrProductDetail | null; loading: boolean; onClose: () => void }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className={`w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-lg ${dark ? 'bg-[#1a1a2e]' : 'bg-white'} shadow-2xl`}>
        {/* header */}
        <div className={`sticky top-0 flex items-center justify-between px-5 py-3 border-b ${border} ${dark ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
          <h3 className={`text-[15px] font-bold ${text}`}>
            {loading ? '불러오는 중…' : detail?.info.name || '(상품 상세)'}
          </h3>
          <button onClick={onClose}
                  className={`text-[20px] ${textSub} hover:${text}`}>×</button>
        </div>

        {loading ? (
          <div className={`p-10 text-center ${textSub}`}>불러오는 중…</div>
        ) : detail ? (
          <div className="p-5 space-y-5">
            {/* Info row */}
            <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]`}>
              <InfoCell dark={dark} label="W코드" value={detail.info.seller_management_code} mono />
              <InfoCell dark={dark} label="원상품번호" value={detail.info.origin_product_no?.toString() || '-'} mono />
              <InfoCell dark={dark} label="채널상품번호" value={detail.info.channel_product_no?.toString() || '-'} mono />
              <InfoCell dark={dark} label="스토어" value={detail.info.store_name || `#${detail.info.store_id}`} />
              <InfoCell dark={dark} label="카테고리ID" value={detail.info.category_id || '-'} mono />
              <InfoCell dark={dark} label="카테고리" value={detail.info.category_text || '-'} colSpan={2} />
              <InfoCell dark={dark} label="크롤시각" value={detail.info.crawled_at || '-'} mono />
              <InfoCell dark={dark} label="가격" value={detail.info.sale_price ? fmt(detail.info.sale_price) + '원' : '-'} />
              <InfoCell dark={dark} label="재고" value={detail.info.stock_quantity?.toString() || '-'} />
            </div>

            {/* Tags */}
            <Section dark={dark} title={`태그 (${detail.tags.length})`}>
              {detail.tags.length === 0 ? <span className={textSub}>없음</span> : (
                <div className="flex flex-wrap gap-2">
                  {detail.tags.map((t, i) => (
                    <span key={i}
                          className={`px-2.5 py-1 rounded-full text-[12px] flex items-center gap-1.5 border
                            ${t.is_standard
                              ? 'bg-blue-500/15 border-blue-500/40 text-blue-400'
                              : `${dark ? 'bg-[#252540] border-[#2a2a40] text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-700'}`}`}>
                      <span className="text-[10px] opacity-70">#{t.position}</span>
                      <span>{t.tag}</span>
                      <span className="opacity-70">
                        ({t.search_volume_label || (t.search_volume === null ? '숫자없음' : fmt(t.search_volume))})
                      </span>
                      {t.is_standard === 1 && <span className="text-[10px]">[표준]</span>}
                    </span>
                  ))}
                </div>
              )}
            </Section>

            {/* Quality */}
            {detail.quality.length > 0 && (
              <Section dark={dark} title={`검색품질 (${detail.quality.length})`}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {detail.quality.map((q, i) => (
                    <div key={i}
                         className={`rounded border p-2.5 text-[12px] flex items-start gap-3
                           ${q.needs_review === 1
                             ? 'bg-red-500/10 border-red-500/30'
                             : `${dark ? 'bg-[#252540] border-[#2a2a40]' : 'bg-gray-50 border-gray-200'}`}`}>
                      <div className={`px-2 py-0.5 rounded text-[11px] shrink-0
                        ${q.needs_review === 1 ? 'bg-red-500 text-white' : 'bg-green-500/30 text-green-400'}`}>
                        {q.needs_review === 1 ? '점검필요' : '정상'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`font-bold ${text}`}>{q.item_name}</div>
                        <div className={`${textSub} truncate`} title={q.result_text || ''}>{q.result_text || '-'}</div>
                        {(q.input_count !== null || q.applied_count !== null) && (
                          <div className={`text-[11px] ${textSub}`}>
                            {q.input_count !== null && `입력 ${q.input_count}`}
                            {q.input_count !== null && q.applied_count !== null && ' · '}
                            {q.applied_count !== null && `반영 ${q.applied_count}`}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 상품속성 (SS 어드민 표 스타일) */}
            {detail.attribute_groups && detail.attribute_groups.length > 0 && (
              <Section dark={dark} title={`상품속성 (${detail.attribute_groups.length}개 항목, ${detail.attribute_groups.reduce((s,g)=>s+g.values.filter(v=>v.selected).length,0)}개 선택)`}>
                <SsAdminAttributeTable dark={dark} groups={detail.attribute_groups} />
              </Section>
            )}

            {/* 기타 섹션 (검색설정/검색정보/상품주요정보 등) — 상품속성 제외 */}
            {Object.entries(detail.attrs_by_section)
              .filter(([sec]) => sec !== '상품속성')
              .map(([sec, list]) => (
              <Section key={sec} dark={dark} title={`${sec} (${list.length})`}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[12px]">
                  {list.map((a, i) => (
                    <div key={i}
                         className={`flex items-center gap-2 px-2.5 py-1.5 rounded
                           ${dark ? 'bg-[#252540]' : 'bg-gray-50'}`}>
                      <span className={`shrink-0 w-32 ${textSub} truncate`} title={a.attr_label}>{a.attr_label}</span>
                      <span className={text}>
                        {a.attr_type === 'bool'
                          ? (a.value_bool === 1 ? '✓' : (a.value_bool === 0 ? '–' : '?'))
                          : (a.value_text || (a.value_number !== null ? fmt(a.value_number) : '-'))}
                      </span>
                      {a.is_recommended === 1 && (
                        <span className="text-[10px] text-[#03c75a] ml-auto">추천</span>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InfoCell({ dark, label, value, mono = false, colSpan = 1 }:
  { dark: boolean; label: string; value: string; mono?: boolean; colSpan?: number }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const styleSpan = colSpan === 2 ? 'md:col-span-2' : '';
  return (
    <div className={styleSpan}>
      <div className={`${textSub}`}>{label}</div>
      <div className={`${text} ${mono ? 'font-mono text-[12px]' : ''} truncate`} title={value}>{value}</div>
    </div>
  );
}

function Section({ dark, title, children }:
  { dark: boolean; title: string; children: React.ReactNode }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-200';
  return (
    <div className={`border-t pt-4 ${border}`}>
      <h4 className={`text-[13px] font-bold mb-2 ${text}`}>{title}</h4>
      {children}
    </div>
  );
}

const CLASSIFICATION_LABEL: Record<string, string> = {
  'MULTI_SELECT': '복수선택',
  'SINGLE_SELECT': '단일선택',
  'INPUT': '직접입력',
  'NUMERIC': '숫자',
};

function SsAdminAttributeTable({ dark, groups }: { dark: boolean; groups: AttrGroup[] }) {
  // attribute_type 별로 그룹화 (PRIMARY → 주요속성, 그 외 → 기타속성)
  const buckets: Record<string, AttrGroup[]> = {};
  for (const g of groups) {
    const k = g.attribute_type === 'PRIMARY' ? '주요속성' : '기타속성';
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(g);
  }
  const order = ['주요속성', '기타속성'];

  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-600';
  const border = dark ? 'border-[#2a2a40]' : 'border-gray-300';
  const headBg = dark ? 'bg-[#0f0f1a]' : 'bg-gray-100';
  const groupBg = dark ? 'bg-[#252540]' : 'bg-gray-50';
  const cellBg = dark ? 'bg-[#1c1c2e]' : 'bg-white';

  return (
    <div className={`rounded overflow-hidden border ${border}`}>
      <table className="w-full text-[12px]" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 170 }} />
          <col />
        </colgroup>
        {order.filter(k => buckets[k] && buckets[k].length > 0).map(group => (
          <tbody key={group}>
            <tr>
              <th colSpan={2}
                  className={`text-left px-3 py-2 text-[12px] font-bold ${groupBg} ${text} border-b ${border}`}>
                {group}
              </th>
            </tr>
            {buckets[group].map(attr => (
              <tr key={attr.attribute_seq} className={`border-b ${border}`}>
                <th scope="row"
                    className={`text-left align-top px-3 py-2.5 font-medium ${headBg} ${text} border-r ${border}`}>
                  <div className="flex items-start gap-1">
                    <span className={attr.attribute_name.startsWith('attr#') ? 'font-mono text-[11px]' : ''}>
                      {attr.attribute_name}
                    </span>
                    {attr.classification_type === 'MULTI_SELECT' && (
                      <span className={`text-[10px] ${textSub}`}>(복수)</span>
                    )}
                  </div>
                  {attr.values.filter(v => v.selected).length > 0 && (
                    <div className="text-[10px] text-[#03c75a] mt-0.5">
                      {attr.values.filter(v => v.selected).length}개 선택
                    </div>
                  )}
                </th>
                <td className={`align-top px-3 py-2.5 ${cellBg}`}>
                  {attr.values.length === 0 ? (
                    <span className={`${textSub} italic`}>옵션 없음</span>
                  ) : (
                    <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                      {attr.values.map(v => (
                        <SsCheckbox key={v.seq} dark={dark} value={v} />
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function SsCheckbox({ dark, value }: { dark: boolean; value: AttrGroup['values'][0] }) {
  const text = dark ? 'text-white' : 'text-gray-900';
  const textSub = dark ? 'text-gray-400' : 'text-gray-500';
  const sel = value.selected;
  // SS 어드민의 체크박스 스타일 모방
  return (
    <label className="inline-flex items-center gap-1.5 cursor-default select-none">
      <span className={`relative w-4 h-4 inline-flex items-center justify-center rounded border-2 shrink-0 transition-colors
        ${sel
          ? 'bg-[#03c75a] border-[#03c75a]'
          : `${dark ? 'bg-[#0f0f1a] border-[#3a3a55]' : 'bg-white border-gray-400'}`}`}>
        {sel && (
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </span>
      {value.color && (
        <span className="w-3 h-3 rounded-full border border-gray-400 inline-block shrink-0"
              style={{ background: value.color }} />
      )}
      <span className={`${sel ? `${text} font-medium` : textSub}`}>
        {value.text || `#${value.seq}`}
      </span>
    </label>
  );
}
