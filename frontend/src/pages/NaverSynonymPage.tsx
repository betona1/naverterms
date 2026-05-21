import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTheme } from '../hooks/useTheme';
import * as naverApi from '../api/naverApi';
import type { NaverSynonym, SynonymVerification } from '../api/naverApi';

const SOURCE_LABEL: Record<string, string> = {
  naver_dict: '네이버사전',
  autocomplete: '자동완성',
  manual: '직접입력',
};

const SOURCE_BADGE: Record<string, string> = {
  naver_dict: 'bg-purple-500',
  autocomplete: 'bg-cyan-500',
  manual: 'bg-gray-500',
};

const VERDICT_LABEL: Record<string, string> = {
  likely_synonym: '동의어 가능성 높음',
  maybe_synonym: '동의어 가능성 보통',
  unlikely_synonym: '동의어 아닐 가능성',
  no_data: '데이터 부족',
  same_word: '동일 단어',
};

const VERDICT_COLOR: Record<string, string> = {
  likely_synonym: 'bg-emerald-600 text-white',
  maybe_synonym: 'bg-amber-500 text-white',
  unlikely_synonym: 'bg-rose-600 text-white',
  no_data: 'bg-gray-500 text-white',
  same_word: 'bg-gray-400 text-white',
};

interface KeywordOpt {
  id: number;
  keyword: string;
}

export default function NaverSynonymPage() {
  const { dark } = useTheme();

  const [keywords, setKeywords] = useState<KeywordOpt[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [synonyms, setSynonyms] = useState<NaverSynonym[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending' | 'confirmed' | 'rejected'>('all');
  const [manualWord, setManualWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyVerifyId, setBusyVerifyId] = useState<number | null>(null);
  const [activeVerification, setActiveVerification] = useState<{ word: string; data: SynonymVerification } | null>(null);
  const [includeAutocomplete, setIncludeAutocomplete] = useState(true);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'err' } | null>(null);

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

  const loadKeywords = useCallback(async () => {
    const list = await naverApi.getKeywords();
    setKeywords(list);
    if (list.length && selectedId == null) setSelectedId(list[0].id);
  }, [selectedId]);

  const loadSynonyms = useCallback(async (id: number) => {
    const data = await naverApi.getSynonyms(id);
    setSynonyms(data);
  }, []);

  useEffect(() => { loadKeywords(); }, [loadKeywords]);
  useEffect(() => { if (selectedId) loadSynonyms(selectedId); }, [selectedId, loadSynonyms]);

  const selectedKeyword = useMemo(
    () => keywords.find(k => k.id === selectedId) || null,
    [keywords, selectedId],
  );

  const handleLookup = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await naverApi.lookupSynonyms(selectedId, includeAutocomplete);
      setSynonyms(r.synonyms);
      showToast(`후보 ${r.candidates_count}개 (신규 추가 ${r.added}개)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '실패';
      showToast(`조회 실패: ${msg}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleAddManual = async () => {
    if (!selectedId || !manualWord.trim()) return;
    setBusy(true);
    try {
      await naverApi.addSynonym(selectedId, { word: manualWord.trim(), source: 'manual' });
      setManualWord('');
      await loadSynonyms(selectedId);
      showToast('추가 완료');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '실패';
      showToast(`추가 실패: ${msg}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (syn: NaverSynonym) => {
    if (!selectedId) return;
    setBusyVerifyId(syn.id);
    setActiveVerification(null);
    try {
      const r = await naverApi.verifySynonym(selectedId, { synonym_id: syn.id });
      setActiveVerification({ word: syn.word, data: r.verification });
      // 결과 score/verdict 으로 목록 갱신
      setSynonyms(prev => prev.map(p => p.id === syn.id ? {
        ...p,
        verification_score: r.verification.score,
        verification_data: r.verification as unknown as Record<string, unknown>,
      } : p));
      showToast(`검증 완료: ${VERDICT_LABEL[r.verification.verdict] || r.verification.verdict}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '실패';
      showToast(`검증 실패: ${msg}`, 'err');
    } finally {
      setBusyVerifyId(null);
    }
  };

  const handleConfirm = async (syn: NaverSynonym, value: boolean | null) => {
    try {
      const updated = await naverApi.patchSynonym(syn.id, { is_confirmed: value });
      setSynonyms(prev => prev.map(p => p.id === syn.id ? updated : p));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '실패';
      showToast(`업데이트 실패: ${msg}`, 'err');
    }
  };

  const handleDelete = async (syn: NaverSynonym) => {
    if (!confirm(`"${syn.word}" 동의어를 삭제하시겠습니까?`)) return;
    try {
      await naverApi.deleteSynonym(syn.id);
      setSynonyms(prev => prev.filter(p => p.id !== syn.id));
      if (activeVerification && activeVerification.word === syn.word) setActiveVerification(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '실패';
      showToast(`삭제 실패: ${msg}`, 'err');
    }
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return synonyms;
    if (filter === 'pending') return synonyms.filter(s => s.is_confirmed === null);
    if (filter === 'confirmed') return synonyms.filter(s => s.is_confirmed === true);
    return synonyms.filter(s => s.is_confirmed === false);
  }, [synonyms, filter]);

  const counts = useMemo(() => ({
    all: synonyms.length,
    pending: synonyms.filter(s => s.is_confirmed === null).length,
    confirmed: synonyms.filter(s => s.is_confirmed === true).length,
    rejected: synonyms.filter(s => s.is_confirmed === false).length,
  }), [synonyms]);

  return (
    <div className="p-5 space-y-3">
      {/* 헤더 + 키워드 선택 */}
      <div className={`${card} border rounded-lg p-3 flex flex-wrap items-center gap-3`}>
        <div className={`text-[15px] font-bold ${titleText}`}>동의어 관리</div>
        <span className={`text-[12px] ${subText}`}>키워드별 동의어를 사전+자동완성에서 후보로 가져와 네이버쇼핑 검색결과로 검증합니다.</span>
        <div className="flex-1" />
        <select
          value={selectedId ?? ''}
          onChange={e => setSelectedId(Number(e.target.value) || null)}
          className={`px-2.5 py-1.5 text-[13px] rounded border ${inputCls} min-w-[180px]`}
        >
          <option value="">키워드 선택…</option>
          {keywords.map(k => (
            <option key={k.id} value={k.id}>{k.keyword}</option>
          ))}
        </select>
      </div>

      {!selectedKeyword ? (
        <div className={`${card} border rounded-lg p-10 text-center ${subText}`}>
          상단에서 키워드를 선택하세요.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
          {/* 좌측: 동의어 목록 + 도구 */}
          <div className={`${card} border rounded-lg p-4 space-y-3`}>
            {/* 도구 영역 */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleLookup}
                disabled={busy}
                className="px-3 py-1.5 text-[12px] rounded font-medium text-white bg-[#03c75a] hover:bg-[#02b350] disabled:opacity-50"
              >
                {busy ? '조회중…' : '후보 자동조회'}
              </button>
              <label className={`flex items-center gap-1 text-[12px] ${subText}`}>
                <input
                  type="checkbox"
                  checked={includeAutocomplete}
                  onChange={e => setIncludeAutocomplete(e.target.checked)}
                  className="accent-[#03c75a]"
                />
                자동완성 후보 포함
              </label>
              <div className="flex-1" />
              <input
                value={manualWord}
                onChange={e => setManualWord(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddManual(); }}
                placeholder="직접 추가… (예: 애견)"
                className={`px-2.5 py-1.5 text-[13px] rounded border ${inputCls} w-[180px]`}
              />
              <button
                onClick={handleAddManual}
                disabled={busy || !manualWord.trim()}
                className={`px-3 py-1.5 text-[12px] rounded border font-medium ${
                  dark ? 'border-[#2a2a40] text-gray-200 hover:bg-[#252540]' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                } disabled:opacity-50`}
              >
                추가
              </button>
            </div>

            {/* 필터 탭 */}
            <div className="flex gap-1">
              {(['all', 'pending', 'confirmed', 'rejected'] as const).map(t => {
                const active = filter === t;
                const label = { all: '전체', pending: '미확정', confirmed: '동의어 ✓', rejected: '아님 ✗' }[t];
                return (
                  <button
                    key={t}
                    onClick={() => setFilter(t)}
                    className={`px-2.5 py-1 text-[12px] rounded transition-colors ${
                      active
                        ? 'bg-[#03c75a] text-white'
                        : dark ? 'text-gray-400 hover:bg-[#252540]' : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {label} ({counts[t]})
                  </button>
                );
              })}
            </div>

            {/* 목록 */}
            {filtered.length === 0 ? (
              <div className={`text-center py-8 text-[12px] ${subText}`}>
                {synonyms.length === 0 ? '후보가 없습니다. "후보 자동조회"를 눌러보세요.' : '필터 조건에 맞는 항목이 없습니다.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className={`border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} ${subText}`}>
                      <th className="text-left py-1.5 pr-2">동의어</th>
                      <th className="text-left pr-2">출처</th>
                      <th className="text-right pr-2">검증점수</th>
                      <th className="text-left pr-2">판정</th>
                      <th className="text-left pr-2">상태</th>
                      <th className="text-right">작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(syn => {
                      const verdict = (syn.verification_data as { verdict?: string } | null)?.verdict;
                      const score = syn.verification_score;
                      return (
                        <tr key={syn.id} className={`border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-100'}`}>
                          <td className={`py-1.5 pr-2 font-medium ${titleText}`}>{syn.word}</td>
                          <td className="pr-2">
                            <span className={`inline-block px-1.5 py-0.5 text-[10.5px] rounded text-white ${SOURCE_BADGE[syn.source] || 'bg-gray-500'}`}>
                              {SOURCE_LABEL[syn.source] || syn.source}
                            </span>
                          </td>
                          <td className={`pr-2 text-right tabular-nums ${titleText}`}>
                            {score == null ? '-' : score.toFixed(2)}
                          </td>
                          <td className="pr-2">
                            {verdict ? (
                              <span className={`inline-block px-1.5 py-0.5 text-[10.5px] rounded ${VERDICT_COLOR[verdict] || 'bg-gray-500 text-white'}`}>
                                {VERDICT_LABEL[verdict] || verdict}
                              </span>
                            ) : (
                              <span className={`text-[11px] ${subText}`}>미검증</span>
                            )}
                          </td>
                          <td className="pr-2">
                            {syn.is_confirmed === true && <span className="text-emerald-500 font-bold">✓ 동의어</span>}
                            {syn.is_confirmed === false && <span className="text-rose-500 font-bold">✗ 아님</span>}
                            {syn.is_confirmed === null && <span className={subText}>미확정</span>}
                          </td>
                          <td className="text-right space-x-1 whitespace-nowrap py-1">
                            <button
                              onClick={() => handleVerify(syn)}
                              disabled={busyVerifyId === syn.id}
                              className="px-2 py-0.5 text-[11px] rounded text-white bg-[#0078d7] hover:bg-[#0064b8] disabled:opacity-50"
                              title="네이버쇼핑 검색결과로 동의어 여부 검증"
                            >
                              {busyVerifyId === syn.id ? '…' : '쇼핑검증'}
                            </button>
                            <button
                              onClick={() => handleConfirm(syn, syn.is_confirmed === true ? null : true)}
                              className={`px-2 py-0.5 text-[11px] rounded ${
                                syn.is_confirmed === true
                                  ? 'bg-emerald-600 text-white'
                                  : dark ? 'border border-[#2a2a40] text-gray-300 hover:bg-[#252540]' : 'border border-gray-300 hover:bg-gray-50'
                              }`}
                            >
                              ✓
                            </button>
                            <button
                              onClick={() => handleConfirm(syn, syn.is_confirmed === false ? null : false)}
                              className={`px-2 py-0.5 text-[11px] rounded ${
                                syn.is_confirmed === false
                                  ? 'bg-rose-600 text-white'
                                  : dark ? 'border border-[#2a2a40] text-gray-300 hover:bg-[#252540]' : 'border border-gray-300 hover:bg-gray-50'
                              }`}
                            >
                              ✗
                            </button>
                            <button
                              onClick={() => handleDelete(syn)}
                              className={`px-2 py-0.5 text-[11px] rounded ${
                                dark ? 'border border-[#2a2a40] text-gray-400 hover:bg-rose-900' : 'border border-gray-300 text-gray-500 hover:bg-rose-50'
                              }`}
                              title="삭제"
                            >
                              🗑
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 우측: 검증 결과 상세 */}
          <div className={`${card} border rounded-lg p-4 space-y-3`}>
            <div className={`text-[13px] font-bold ${titleText}`}>검증 결과</div>
            {!activeVerification ? (
              <div className={`text-[12px] ${subText} py-6 text-center`}>
                목록에서 "쇼핑검증" 버튼을 누르면 두 키워드의 네이버쇼핑 검색결과를 비교해 동의어 점수가 표시됩니다.
              </div>
            ) : (
              <VerificationDetail
                keyword={selectedKeyword.keyword}
                candidate={activeVerification.word}
                data={activeVerification.data}
                dark={dark}
              />
            )}
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

function VerificationDetail({ keyword, candidate, data, dark }: {
  keyword: string;
  candidate: string;
  data: SynonymVerification;
  dark: boolean;
}) {
  const subText = dark ? 'text-gray-400' : 'text-gray-500';
  const titleText = dark ? 'text-white' : 'text-gray-900';
  const verdictCls = VERDICT_COLOR[data.verdict] || 'bg-gray-500 text-white';
  const naverSearchUrl = (q: string) => `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(q)}`;

  if (data.error) {
    return <div className="text-rose-500 text-[12px]">에러: {data.error}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 text-[11px] rounded ${verdictCls}`}>{VERDICT_LABEL[data.verdict] || data.verdict}</span>
        <span className={`text-[18px] font-bold tabular-nums ${titleText}`}>{(data.score ?? 0).toFixed(2)}</span>
        <span className={`text-[11px] ${subText}`}>/ 1.00</span>
      </div>

      <div className={`text-[11.5px] space-y-1 ${subText}`}>
        <div>샘플: 상위 {data.sample_count ?? 0}개씩 비교</div>
        {data.cat_score != null && <div>카테고리 자카드: <span className={titleText}>{data.cat_score.toFixed(2)}</span></div>}
        {data.product_overlap != null && <div>상품 ID 중복도: <span className={titleText}>{data.product_overlap.toFixed(2)}</span></div>}
        <div>최상위 카테고리 일치: {data.top_cat_match ? <span className="text-emerald-500">○</span> : <span className="text-rose-500">×</span>}</div>
        <div>대분류 일치: {data.big_cat_match ? <span className="text-emerald-500">○</span> : <span className="text-rose-500">×</span>}</div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between mb-0.5">
            <div className={`text-[11.5px] font-bold ${titleText}`}>{keyword}</div>
            <a href={naverSearchUrl(keyword)} target="_blank" rel="noreferrer"
               className="text-[10.5px] text-[#03c75a] hover:underline">네이버에서 보기 ↗</a>
          </div>
          <div className={`text-[11px] ${subText}`}>전체 결과 {(data.total1 ?? 0).toLocaleString()}건</div>
          <ul className={`text-[11px] ${titleText} mt-1 space-y-0.5`}>
            {(data.top_categories_keyword || []).map(([cat, n], i) => (
              <li key={i}><span className={subText}>{n}건</span> {cat}</li>
            ))}
          </ul>
        </div>

        <div className={`border-t ${dark ? 'border-[#2a2a40]' : 'border-gray-200'} pt-2`}>
          <div className="flex items-center justify-between mb-0.5">
            <div className={`text-[11.5px] font-bold ${titleText}`}>{candidate}</div>
            <a href={naverSearchUrl(candidate)} target="_blank" rel="noreferrer"
               className="text-[10.5px] text-[#03c75a] hover:underline">네이버에서 보기 ↗</a>
          </div>
          <div className={`text-[11px] ${subText}`}>전체 결과 {(data.total2 ?? 0).toLocaleString()}건</div>
          <ul className={`text-[11px] ${titleText} mt-1 space-y-0.5`}>
            {(data.top_categories_candidate || []).map(([cat, n], i) => (
              <li key={i}><span className={subText}>{n}건</span> {cat}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
