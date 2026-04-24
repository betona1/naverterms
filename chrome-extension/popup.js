// popup.js v3.0.0 — 내부/외부 모드 통합
document.addEventListener('DOMContentLoaded', () => {
  const INTERNAL_API = 'http://192.168.219.100:8901/api/naver';
  const $ = id => document.getElementById(id);

  let pollTimer = null;
  let logOpen = false;
  let lastLogIdx = 0;
  let currentMode = 'external';

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  function setDot(id, cls) { const el = $(id); if (el) el.className = 'dot ' + cls; }

  // ══════════════════════════════════════════
  // 모드 전환
  // ══════════════════════════════════════════
  function setMode(mode) {
    currentMode = mode;
    const isInt = mode === 'internal';

    $('modeExt').classList.toggle('active', !isInt);
    $('modeInt').classList.toggle('active', isInt);

    $('djRow').classList.toggle('hidden', !isInt);
    $('extRow').classList.toggle('hidden', isInt);
    $('extFooter').classList.toggle('hidden', isInt);
    $('intFooter').classList.toggle('hidden', !isInt);
    $('statRow').classList.toggle('hidden', isInt);

    chrome.runtime.sendMessage({ type: 'SET_SAVE_MODE', mode });

    if (isInt) testDj();
    else updateLocalCount();
  }

  // 모드 로드
  chrome.runtime.sendMessage({ type: 'GET_SAVE_MODE' }, r => {
    if (r?.mode) setMode(r.mode);
  });

  $('modeExt').addEventListener('click', () => setMode('external'));
  $('modeInt').addEventListener('click', () => setMode('internal'));

  // ══════════════════════════════════════════
  // 로그
  // ══════════════════════════════════════════
  function addLog(cls, msg, time) {
    const t = time ? new Date(time).toLocaleTimeString('ko-KR', { hour12: false })
                    : new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const div = document.createElement('div');
    div.className = 'll ' + cls;
    div.textContent = `[${t}] ${msg}`;
    $('logBox').appendChild(div);
    $('logBox').scrollTop = $('logBox').scrollHeight;
    $('logLast').textContent = msg;
    $('logCnt').textContent = $('logBox').children.length;
  }

  function logCls(msg) {
    if (msg.includes('★') || msg.includes('저장OK') || msg.includes('로컬저장OK') || msg.includes('완료') || msg.includes('OK')) return 'g';
    if (msg.includes('실패') || msg.includes('오류')) return 'r';
    if (msg.includes('──') || msg.includes('이동') || msg.includes('시작')) return 'b';
    if (msg.includes('타임아웃') || msg.includes('스킵') || msg.includes('CAPTCHA') || msg.includes('중지') || msg.includes('휴식')) return 'y';
    return 'w';
  }

  $('logHdr').addEventListener('click', () => {
    logOpen = !logOpen;
    $('logBox').classList.toggle('open', logOpen);
    $('logArrow').classList.toggle('open', logOpen);
  });

  // ══════════════════════════════════════════
  // 프로그레스
  // ══════════════════════════════════════════
  function updateProgress(r) {
    const dotId = currentMode === 'internal' ? 'crDot' : 'crDot2';
    const valId = currentMode === 'internal' ? 'crVal' : 'crVal2';

    if (r.captchaPaused) {
      $(valId).textContent = 'CAPTCHA';
      setDot(dotId, 'dot-ng');
    } else if (r.running) {
      $(valId).textContent = '수집중';
      setDot(dotId, 'dot-ok');
    } else if (r.total > 0 && r.steps >= r.totalSteps) {
      $(valId).textContent = '완료';
      setDot(dotId, 'dot-ok');
      stopPoll();
      if (currentMode === 'external') updateLocalCount();
    } else if (!r.running && r.totalSteps > 0) {
      $(valId).textContent = '완료';
      setDot(dotId, 'dot-ok');
      stopPoll();
      if (currentMode === 'external') updateLocalCount();
    } else {
      $(valId).textContent = '대기';
      setDot(dotId, 'dot-off');
    }

    if (!r.totalSteps) {
      $('prog').style.display = 'none';
      return;
    }

    $('prog').style.display = 'block';
    if (r.keyword) {
      $('kwLabel').innerHTML = `"${r.keyword}" <span style="color:#666;font-weight:400;font-size:11px">${r.kwIdx}/${r.total}</span>`;
    }

    const pct = r.totalSteps > 0 ? Math.round(r.steps / r.totalSteps * 100) : 0;
    $('fill').style.width = pct + '%';
    $('pct').textContent = pct + '%';
    $('steps').textContent = `${r.steps}/${r.totalSteps} 탭`;
  }

  // ══════════════════════════════════════════
  // 폴링
  // ══════════════════════════════════════════
  function poll() {
    chrome.runtime.sendMessage({ type: 'NAVER_GET_STATUS', logSince: lastLogIdx }, r => {
      if (chrome.runtime.lastError || !r) {
        const valId = currentMode === 'internal' ? 'crVal' : 'crVal2';
        const dotId = currentMode === 'internal' ? 'crDot' : 'crDot2';
        $(valId).textContent = 'SW없음';
        setDot(dotId, 'dot-ng');
        return;
      }
      if (r.logs && r.logs.length > 0) {
        for (const entry of r.logs) {
          addLog(logCls(entry.msg), entry.msg, entry.t);
          if (entry.i >= lastLogIdx) lastLogIdx = entry.i + 1;
        }
      }
      updateProgress(r);
    });
  }

  function startPoll() { stopPoll(); poll(); pollTimer = setInterval(poll, 1000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function getKeywords() {
    const val = $('kw').value.trim();
    if (!val) return [];
    return val.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  }

  function openLog() {
    if (!logOpen) {
      logOpen = true;
      $('logBox').classList.add('open');
      $('logArrow').classList.add('open');
    }
  }

  // ══════════════════════════════════════════
  // 내부용: Django 테스트
  // ══════════════════════════════════════════
  async function testDj() {
    $('djVal').textContent = '...';
    setDot('djDot', 'dot-wt');
    try {
      const t0 = Date.now();
      const r = await fetch(INTERNAL_API + '/keywords/');
      const ms = Date.now() - t0;
      if (r.ok) {
        const d = await r.json();
        $('djVal').textContent = `OK ${ms}ms (${d.length}kw)`;
        setDot('djDot', 'dot-ok');
        addLog('g', `Django OK — ${ms}ms, ${d.length}개 키워드`);
      } else {
        $('djVal').textContent = `HTTP ${r.status}`;
        setDot('djDot', 'dot-ng');
        addLog('r', `Django HTTP ${r.status}`);
      }
    } catch (e) {
      $('djVal').textContent = '실패';
      setDot('djDot', 'dot-ng');
      addLog('r', `Django 연결실패: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════
  // 외부용: 로컬 데이터 카운트
  // ══════════════════════════════════════════
  function updateLocalCount() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (r?.count !== undefined) {
        $('localCnt').textContent = r.count;
      }
    });
  }

  // ══════════════════════════════════════════
  // 외부용: CSV 내보내기
  // ══════════════════════════════════════════
  function exportCsv() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (!r?.results?.length) {
        addLog('y', '내보낼 데이터 없음');
        return;
      }

      const BOM = '\uFEFF';
      const headers = ['키워드', '탭', '전체수', 'Term수', 'Terms', '순위', '상품명', '스토어', '가격', '리뷰수', '상품ID'];
      const rows = [headers.join(',')];

      for (const kw of r.results) {
        for (const [tabType, data] of Object.entries(kw.tabs)) {
          const termsStr = (data.terms || []).map(t => t.value || t).join('|');
          const products = data.products || [];
          if (products.length === 0) {
            rows.push(csvRow([kw.keyword, tabType, data.total, data.termCount, termsStr, '', '', '', '', '', '']));
          } else {
            products.forEach((p, i) => {
              rows.push(csvRow([
                kw.keyword, tabType, data.total, data.termCount, termsStr,
                i + 1,
                p.productName || p.productTitle || '',
                p.mallName || '',
                p.lowPrice || p.price || '',
                p.reviewCount || 0,
                p.nvMid || p.id || '',
              ]));
            });
          }
        }
      }

      const csv = BOM + rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().slice(0, 10);
      chrome.downloads.download({ url, filename: `term-수집-${ts}.csv`, saveAs: true });
      addLog('g', `CSV 내보내기: ${r.results.length}개 키워드`);
    });
  }

  function csvRow(vals) {
    return vals.map(v => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  }

  // ══════════════════════════════════════════
  // 수집 시작 / 중지
  // ══════════════════════════════════════════
  $('go').addEventListener('click', () => {
    const kws = getKeywords();
    if (!kws.length) return;

    $('logBox').innerHTML = '';
    lastLogIdx = 0;
    addLog('b', `${kws.length}개 키워드: [${kws.join(', ')}]`);

    chrome.runtime.sendMessage({ type: 'NAVER_START_TERM_SEARCH', keywords: kws }, r => {
      if (chrome.runtime.lastError) {
        addLog('r', '시작 실패: ' + chrome.runtime.lastError.message);
        return;
      }
      $('prog').style.display = 'block';
      $('fill').style.width = '0%';
      $('pct').textContent = '0%';
      startPoll();
      openLog();
    });
  });

  $('stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'NAVER_CANCEL' });
    const valId = currentMode === 'internal' ? 'crVal' : 'crVal2';
    const dotId = currentMode === 'internal' ? 'crDot' : 'crDot2';
    $(valId).textContent = '중지';
    setDot(dotId, 'dot-off');
    $('prog').style.display = 'none';
    addLog('y', '중지');
    stopPoll();
  });

  $('kw').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });

  // ══════════════════════════════════════════
  // 버튼 이벤트
  // ══════════════════════════════════════════

  // 외부용
  $('btnResults').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
    window.close();
  });
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', () => {
    if (!confirm('수집된 Term 데이터를 모두 삭제합니다.\n\n진행하시겠습니까?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => {
      addLog('g', '로컬 데이터 초기화 완료');
      updateLocalCount();
    });
  });
  $('btnExt').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions' }));

  // 내부용
  $('btnTest').addEventListener('click', () => testDj());
  $('btnDash').addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://192.168.219.100:8900/#terms' });
    window.close();
  });
  $('btnReset').addEventListener('click', async () => {
    if (!confirm('스냅샷/분석 데이터를 모두 삭제합니다.\n(키워드는 유지됩니다)\n\n진행하시겠습니까?')) return;
    addLog('y', '데이터 초기화 중...');
    try {
      const r = await fetch(INTERNAL_API + '/reset-data/', { method: 'POST' });
      if (r.ok) {
        const d = await r.json();
        addLog('g', `초기화 완료 — 스냅샷 ${d.deleted.snapshots}개, 분석 ${d.deleted.analyses}개, 순위 ${d.deleted.rank_history}개 삭제`);
      } else {
        addLog('r', `초기화 실패: HTTP ${r.status}`);
      }
    } catch (e) {
      addLog('r', `초기화 실패: ${e.message}`);
    }
  });
  $('btnExt2').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions' }));

  // 초기 상태
  poll();
});
