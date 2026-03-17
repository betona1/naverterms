// popup.js v1.9.2 — Chrome 전용
document.addEventListener('DOMContentLoaded', () => {
  const API = 'http://192.168.219.100:8003/api/cpc/naver';
  const $ = id => document.getElementById(id);

  let pollTimer = null;
  let logOpen = false;
  let lastLogIdx = 0;

  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  function setDot(id, cls) { $(id).className = 'dot ' + cls; }

  // ── 로그 ──
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
    if (msg.includes('★') || msg.includes('저장OK') || msg.includes('완료') || msg.includes('OK')) return 'g';
    if (msg.includes('실패') || msg.includes('오류')) return 'r';
    if (msg.includes('──') || msg.includes('이동') || msg.includes('시작')) return 'b';
    if (msg.includes('타임아웃') || msg.includes('스킵') || msg.includes('CAPTCHA') || msg.includes('중지')) return 'y';
    return 'w';
  }

  $('logHdr').addEventListener('click', () => {
    logOpen = !logOpen;
    $('logBox').classList.toggle('open', logOpen);
    $('logArrow').classList.toggle('open', logOpen);
  });

  // ── 프로그레스 업데이트 ──
  function updateProgress(r) {
    if (r.captchaPaused) {
      $('crVal').textContent = 'CAPTCHA';
      setDot('crDot', 'dot-ng');
    } else if (r.running) {
      $('crVal').textContent = '수집중';
      setDot('crDot', 'dot-ok');
    } else if (r.total > 0 && r.steps >= r.totalSteps) {
      $('crVal').textContent = '완료';
      setDot('crDot', 'dot-ok');
      stopPoll();
    } else if (!r.running && r.totalSteps > 0) {
      $('crVal').textContent = '완료';
      setDot('crDot', 'dot-ok');
      stopPoll();
    } else {
      $('crVal').textContent = '대기';
      setDot('crDot', 'dot-off');
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

  // ── 폴링 ──
  function poll() {
    chrome.runtime.sendMessage({ type: 'NAVER_GET_STATUS', logSince: lastLogIdx }, r => {
      if (chrome.runtime.lastError || !r) {
        $('crVal').textContent = 'SW없음';
        setDot('crDot', 'dot-ng');
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

  function startPoll() {
    stopPoll();
    poll();
    pollTimer = setInterval(poll, 1000);
  }
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

  // ── Django 테스트 ──
  async function testDj() {
    $('djVal').textContent = '...';
    setDot('djDot', 'dot-wt');
    try {
      const t0 = Date.now();
      const r = await fetch(API + '/keywords/');
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

  // ── 수집 시작 ──
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

  // ── 중지 ──
  $('stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'NAVER_CANCEL' });
    $('crVal').textContent = '중지';
    setDot('crDot', 'dot-off');
    $('prog').style.display = 'none';
    addLog('y', '중지');
    stopPoll();
  });

  // ── 데이터 초기화 ──
  $('btnReset').addEventListener('click', async () => {
    if (!confirm('스냅샷/분석 데이터를 모두 삭제합니다.\n(키워드는 유지됩니다)\n\n진행하시겠습니까?')) return;
    addLog('y', '데이터 초기화 중...');
    try {
      const r = await fetch(API + '/reset-data/', { method: 'POST' });
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

  // ── 버튼 ──
  $('btnTest').addEventListener('click', () => testDj());
  $('btnDash').addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://192.168.219.100:5173/#naver-terms' });
    window.close();
  });
  $('btnExt').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions' }));

  $('kw').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });

  // 초기화
  testDj();
});
