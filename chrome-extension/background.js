// background.js v1.8.0 — Reliable Crawling
// ★ productSet검증 + 타이밍개선 + SW보존 + 클릭확인 + CAPTCHA
'use strict';

const API = 'http://192.168.219.100:8003/api/cpc/naver';
const TAB_NAME = { total: '전체', model: '가격비교', checkout: '네이버페이' };
const CLICK_ORDER = ['model', 'checkout', 'total'];

let queue = [];
let processing = false;
let cur = null;
let waitTab = null;
let timer = null;
let naverTab = null;
let appTab = null;
let captchaPaused = false;

const logs = [];
let logSeq = 0;
function log(msg) {
  console.log('[BG] ' + msg);
  logs.push({ i: logSeq++, t: Date.now(), msg });
  if (logs.length > 300) logs.splice(0, 100);
}

// ══════════════════════════════════════════
// ★ SW 상태 보존 (chrome.storage.session)
// ══════════════════════════════════════════
async function saveState() {
  if (!queue.length) return;
  try {
    await chrome.storage.session.set({
      crawlState: {
        queue: queue.map(q => ({
          keyword: q.keyword, pending: [...q.pending],
          done: [...q.done], status: q.status,
        })),
        processing,
        timestamp: Date.now(),
      }
    });
  } catch (e) {}
}

async function restoreState() {
  try {
    const { crawlState } = await chrome.storage.session.get('crawlState');
    if (!crawlState?.queue?.length) return false;
    // 5분 초과면 폐기
    if (Date.now() - crawlState.timestamp > 5 * 60 * 1000) {
      await chrome.storage.session.remove('crawlState');
      return false;
    }
    queue = crawlState.queue.map(q => ({
      keyword: q.keyword,
      pending: q.pending || ['total', 'model', 'checkout'],
      done: q.done || [],
      results: {}, retry: 0,
      status: q.status === 'active' ? 'pending' : q.status,
    }));
    processing = false;
    cur = null;
    waitTab = null;
    naverTab = null;
    log('★ SW 재시작 — 크롤링 재개');
    chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });
    next();
    return true;
  } catch (e) { return false; }
}

async function clearState() {
  try { await chrome.storage.session.remove('crawlState'); } catch (e) {}
}

// ══════════════════════════════════════════
// 메시지 처리
// ══════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'NAVER_START_TERM_SEARCH') {
    start(msg.keywords || []);
    reply({ ok: true, count: (msg.keywords || []).length });
  } else if (msg.type === 'NAVER_CANCEL') {
    cancel();
    reply({ ok: true });
  } else if (msg.type === 'NAVER_GET_STATUS') {
    reply(getStatus(msg.logSince || 0));
  } else if (msg.type === 'NAVER_SHOPPING_DATA') {
    onData(msg);
    reply({ ok: true });
  } else if (msg.type === 'NAVER_PAGE_READY') {
    onPageReady(sender.tab?.id);
    reply({ ok: true });
  } else if (msg.type === 'CAPTCHA_DETECTED') {
    log('⚠ CAPTCHA: ' + msg.captchaType);
    pauseForCaptcha();
    reply({ ok: true });
  } else if (msg.type === 'CAPTCHA_RESOLVED') {
    log('CAPTCHA 해결');
    resumeAfterCaptcha();
    reply({ ok: true });
  } else {
    reply({});
  }
  return false;
});

// ── keepalive alarm ──
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'crawlKeepAlive') {
    if (processing) saveState();
    else chrome.alarms.clear('crawlKeepAlive');
  }
});

// ── 탭 감시 ──
chrome.tabs.onUpdated.addListener((id, ci, tab) => {
  // 앱 탭 감지
  if (tab.url && (tab.url.includes('192.168.219.100') || tab.url.includes('localhost')) &&
      (tab.url.includes('naver-terms') || tab.url.includes('naver-rank'))) {
    appTab = id;
  }
  // ★ 네이버 탭 이탈 감지 (CAPTCHA/2FA 리다이렉트)
  if (id === naverTab && ci.url) {
    if (ci.url.includes('nid.naver.com') || ci.url.includes('captcha')) {
      log('⚠ 로그인/CAPTCHA 리다이렉트: ' + ci.url.substring(0, 60));
      pauseForCaptcha();
    } else if (captchaPaused && ci.url.includes('search.shopping.naver.com')) {
      log('네이버쇼핑 복귀');
      resumeAfterCaptcha();
    }
  }
});

chrome.tabs.onRemoved.addListener(id => {
  if (id === naverTab) {
    naverTab = null;
    // ★ 네이버 탭 닫힘 → 현재 키워드 스킵
    if (cur && processing) {
      log('  ⚠ 네이버 탭 닫힘 → 키워드 스킵');
      clr();
      waitTab = null;
      cur.status = 'done';
      cur = null;
      processing = false;
      setTimeout(next, 1000);
    }
  }
  if (id === appTab) appTab = null;
});

// ══════════════════════════════════════════
// 크롤링 흐름
// ══════════════════════════════════════════

function start(keywords) {
  cancel();
  logs.length = 0;
  logSeq = 0;
  queue = keywords.map(kw => ({
    keyword: kw,
    pending: ['total', 'model', 'checkout'],
    done: [], results: {}, retry: 0, status: 'pending',
  }));
  log(`── ${keywords.length}개 키워드 ──`);
  chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });
  next();
}

function next() {
  if (processing || captchaPaused) return;
  const item = queue.find(q => q.status === 'pending');
  if (!item) {
    if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
    log('★ 전체 완료!');
    notify({ type: 'NAVER_QUEUE_STATUS', status: 'complete' });
    chrome.alarms.clear('crawlKeepAlive');
    clearState();
    return;
  }
  processing = true;
  item.status = 'active';
  cur = item;
  log(`[${queue.indexOf(item) + 1}/${queue.length}] "${item.keyword}"`);
  openPage();
}

// ── 페이지 열기 ──
async function openPage() {
  if (!cur) return;
  if (naverTab) { try { await chrome.tabs.remove(naverTab); } catch(e) {} naverTab = null; }

  const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(cur.keyword)}&sort=rel`;
  const tab = await chrome.tabs.create({ url, active: true });
  naverTab = tab.id;

  // 초기 total 데이터 대기 (injected.js __NEXT_DATA__ 추출)
  waitTab = 'total';
  setTimer(10000);  // ★ 10초 max ("만 검색" 리로드 포함 여유)
}

// ── 페이지 로드 완료 ──
function onPageReady(tabId) {
  if (tabId !== naverTab || !cur) return;
  log('  페이지 로드');
  // total 대기중이면 3초로 조정 (페이지 로드 후 충분한 시간)
  if (waitTab === 'total' && cur.done.length === 0) {
    setTimer(3000);
  }
}

// ══════════════════════════════════════════
// ★ 데이터 수신 (핵심 개선)
// ══════════════════════════════════════════
async function onData(msg) {
  if (!cur) return;
  const products = msg.products || [];
  if (!products.length) return;

  // ★ productSet으로 실제 탭 식별 (URL 기반)
  const dataTab = msg.productSet || 'total';

  // 이미 수집된 탭이면 무시
  if (!cur.pending.includes(dataTab)) {
    log(`  [${TAB_NAME[dataTab] || dataTab}] 중복 → 무시`);
    return;
  }

  // ★ 동기적으로 상태 먼저 업데이트 (race condition 방지)
  cur.pending = cur.pending.filter(t => t !== dataTab);
  cur.done.push(dataTab);
  cur.results[dataTab] = { count: products.length, total: msg.total || 0 };

  // 대기중 탭과 일치하면 타이머 취소
  const wasWaiting = (dataTab === waitTab);
  if (wasWaiting) {
    clr();
    waitTab = null;
  } else {
    log(`  [${TAB_NAME[dataTab]}] 예상외 탭 (대기: ${TAB_NAME[waitTab] || '없음'}) → 수락`);
  }

  log(`  ★ [${TAB_NAME[dataTab]}] ${products.length}개 total=${msg.total || 0} terms=${(msg.terms||[]).length}`);

  // ★ 다음 탭으로 즉시 진행 (Django 저장 전에)
  if (!waitTab) {
    cur.retry = 0;
    clickNext();
  }

  // Django 저장 (백그라운드)
  try {
    const r = await fetch(`${API}/ext/search-result/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: msg.query || cur.keyword,
        tab_type: dataTab,
        products: products.slice(0, 40),
        total: msg.total || 0,
        terms: msg.terms || [],
        term_count: msg.termCount || 0,
      })
    });
    log(`  [${TAB_NAME[dataTab]}] ${r.ok ? '저장OK' : 'Django ' + r.status}`);
  } catch (e) {
    log(`  [${TAB_NAME[dataTab]}] Django실패`);
  }

  saveState();
}

// ── 다음 탭 클릭 ──
function clickNext() {
  if (!cur) return;
  const nxt = CLICK_ORDER.find(t => cur.pending.includes(t));
  if (!nxt) { finish(); return; }
  setTimeout(() => clickTab(nxt), 400);
}

function clickTab(tabKey) {
  if (!naverTab || !cur) return;
  log(`  [${TAB_NAME[tabKey]}] 클릭`);

  chrome.tabs.sendMessage(naverTab, { type: 'CLICK_NAVER_TAB', tab: tabKey })
    .then(r => {
      // ★ 클릭 실패 시 1초 후 재시도
      if (!r?.success) {
        log(`  [${TAB_NAME[tabKey]}] 탭 못찾음 → 1초후 재시도`);
        setTimeout(() => {
          if (waitTab === tabKey && naverTab) {
            chrome.tabs.sendMessage(naverTab, { type: 'CLICK_NAVER_TAB', tab: tabKey }).catch(() => {});
          }
        }, 1000);
      }
    })
    .catch(() => log(`  [${TAB_NAME[tabKey]}] 클릭전송실패`));

  waitTab = tabKey;
  setTimer(8000);  // ★ 8초 (12초에서 단축)
}

// ── 키워드 완료 ──
function finish() {
  if (!cur) return;
  const tabs = cur.done.map(t => TAB_NAME[t]).join(', ');
  log(`  ✓ "${cur.keyword}" (${tabs || '없음'})`);
  if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
  cur.status = 'done';
  cur = null;
  processing = false;
  saveState();
  notify({ type: 'NAVER_SEARCH_COMPLETE' });
  setTimeout(next, 1500 + Math.random() * 1500);
}

// ══════════════════════════════════════════
// 타이머
// ══════════════════════════════════════════
function setTimer(ms) {
  clr();
  timer = setTimeout(() => {
    if (!waitTab || !cur) return;
    const tabKey = waitTab;

    // 초기 total 대기 타임아웃 → 탭 클릭으로 전환
    if (tabKey === 'total' && cur.done.length === 0) {
      log('  total 초기데이터 없음 → 탭클릭으로');
      waitTab = null;
      clickNext();  // model 먼저
      return;
    }

    // 탭 클릭 타임아웃
    if (cur.retry < 1) {
      cur.retry++;
      log(`  [${TAB_NAME[tabKey]}] 타임아웃 → 재클릭`);
      if (naverTab) {
        chrome.tabs.sendMessage(naverTab, { type: 'CLICK_NAVER_TAB', tab: tabKey }).catch(() => {});
      }
      setTimer(8000);
    } else {
      log(`  [${TAB_NAME[tabKey]}] 스킵`);
      cur.retry = 0;
      waitTab = null;
      cur.pending = cur.pending.filter(t => t !== tabKey);
      clickNext();
    }
  }, ms);
}

function clr() { if (timer) { clearTimeout(timer); timer = null; } }

// ══════════════════════════════════════════
// CAPTCHA
// ══════════════════════════════════════════
function pauseForCaptcha() {
  if (captchaPaused) return;
  captchaPaused = true;
  clr();
  log('⏸ CAPTCHA — 크롤링 일시정지');
}

function resumeAfterCaptcha() {
  if (!captchaPaused) return;
  captchaPaused = false;
  if (cur) {
    log('▶ CAPTCHA 해결 — 크롤링 재개');
    openPage();
  } else {
    next();
  }
}

// ── 취소 ──
function cancel() {
  queue = [];
  processing = false;
  cur = null;
  waitTab = null;
  captchaPaused = false;
  clr();
  if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
  chrome.alarms.clear('crawlKeepAlive');
  clearState();
}

// ── 상태 ──
function getStatus(since) {
  let steps = 0;
  for (const q of queue) {
    if (q.status === 'done') steps += 3;
    else if (q.status === 'active') steps += q.done.length;
  }
  const ts = {};
  if (cur) {
    for (const tk of ['total', 'model', 'checkout']) {
      if (cur.done.includes(tk)) ts[tk] = 'done';
      else if (waitTab === tk) ts[tk] = 'active';
      else ts[tk] = 'wait';
    }
  }
  return {
    running: processing,
    total: queue.length,
    done: queue.filter(q => q.status === 'done').length,
    steps, totalSteps: queue.length * 3,
    keyword: cur?.keyword || null,
    kwIdx: cur ? queue.indexOf(cur) + 1 : 0,
    tabStatus: ts,
    captchaPaused,
    logs: logs.filter(l => l.i >= since),
  };
}

function notify(msg) {
  if (!appTab) return;
  chrome.tabs.sendMessage(appTab, msg).catch(() => { appTab = null; });
}

// ══════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════
restoreState().then(restored => {
  if (!restored) {
    fetch(`${API}/keywords/`).then(r => log('Django ' + (r.ok ? 'OK' : r.status))).catch(() => log('Django 연결실패'));
  }
});
log('background.js v1.8.0');
