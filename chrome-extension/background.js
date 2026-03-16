// background.js v1.7.1 — Simple & Reliable
// 초기 total 시도 → model 클릭 → checkout 클릭 → (total 미수집시) total 클릭
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

const logs = [];
let logSeq = 0;
function log(msg) {
  console.log('[BG] ' + msg);
  logs.push({ i: logSeq++, t: Date.now(), msg });
  if (logs.length > 300) logs.splice(0, 100);
}

// ── 메시지 ──
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
    reply({ ok: true });
  } else if (msg.type === 'CAPTCHA_RESOLVED') {
    log('CAPTCHA 해결');
    if (cur) openPage();
    reply({ ok: true });
  } else {
    reply({});
  }
  return false;
});

chrome.tabs.onUpdated.addListener((id, ci, tab) => {
  if (tab.url && (tab.url.includes('192.168.219.100') || tab.url.includes('localhost')) &&
      (tab.url.includes('naver-terms') || tab.url.includes('naver-rank'))) {
    appTab = id;
  }
});
chrome.tabs.onRemoved.addListener(id => {
  if (id === naverTab) naverTab = null;
  if (id === appTab) appTab = null;
});

// ── 시작 ──
function start(keywords) {
  cancel();
  logs.length = 0;
  logSeq = 0;
  queue = keywords.map(kw => ({
    keyword: kw,
    pending: ['total', 'model', 'checkout'],
    done: [], results: {}, retry: 0, status: 'pending'
  }));
  log(`── ${keywords.length}개 키워드 ──`);
  next();
}

function next() {
  if (processing) return;
  const item = queue.find(q => q.status === 'pending');
  if (!item) {
    if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
    log('★ 전체 완료!');
    notify({ type: 'NAVER_QUEUE_STATUS', status: 'complete' });
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
  setTimer(5000);
}

// ── 페이지 로드 완료 ──
function onPageReady(tabId) {
  if (tabId !== naverTab || !cur) return;
  log('  페이지 로드');
  // total 대기 중이면 1.5초 더 대기
  if (waitTab === 'total') setTimer(1500);
}

// ── ★ 데이터 수신 ──
async function onData(msg) {
  if (!waitTab || !cur) return;
  const products = msg.products || [];
  if (!products.length) return;

  const tabKey = waitTab;
  clr();
  waitTab = null;

  log(`  ★ [${TAB_NAME[tabKey]}] ${products.length}개 total=${msg.total || 0} terms=${(msg.terms||[]).length}`);

  // Django 저장
  try {
    const r = await fetch(`${API}/ext/search-result/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: msg.query || cur.keyword,
        tab_type: tabKey,
        products: products.slice(0, 40),
        total: msg.total || 0,
        terms: msg.terms || [],
        term_count: msg.termCount || 0,
      })
    });
    log(`  [${TAB_NAME[tabKey]}] ${r.ok ? '저장OK' : 'Django ' + r.status}`);
  } catch (e) {
    log(`  [${TAB_NAME[tabKey]}] Django실패`);
  }

  // 완료 기록
  cur.pending = cur.pending.filter(t => t !== tabKey);
  cur.done.push(tabKey);
  cur.results[tabKey] = { count: products.length, total: msg.total || 0 };
  cur.retry = 0;

  // 다음 탭
  clickNext();
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
    .catch(() => log(`  [${TAB_NAME[tabKey]}] 클릭실패`));
  waitTab = tabKey;
  setTimer(12000);
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
  notify({ type: 'NAVER_SEARCH_COMPLETE' });
  setTimeout(next, 1500 + Math.random() * 1500);
}

// ── 타이머 ──
function setTimer(ms) {
  clr();
  timer = setTimeout(() => {
    if (!waitTab || !cur) return;
    const tabKey = waitTab;

    // 초기 total 대기 타임아웃 → 탭 클릭으로 전환
    if (tabKey === 'total' && cur.done.length === 0) {
      log('  total 초기데이터 없음 → 탭클릭');
      waitTab = null;
      clickNext();  // model 먼저
      return;
    }

    // 탭 클릭 타임아웃
    if (cur.retry < 1) {
      cur.retry++;
      log(`  [${TAB_NAME[tabKey]}] 타임아웃 → 재클릭`);
      chrome.tabs.sendMessage(naverTab, { type: 'CLICK_NAVER_TAB', tab: tabKey }).catch(() => {});
      setTimer(12000);
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

// ── 취소 ──
function cancel() {
  queue = [];
  processing = false;
  cur = null;
  waitTab = null;
  clr();
  if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
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
    logs: logs.filter(l => l.i >= since),
  };
}

function notify(msg) {
  if (!appTab) return;
  chrome.tabs.sendMessage(appTab, msg).catch(() => { appTab = null; });
}

fetch(`${API}/keywords/`).then(r => log('Django ' + (r.ok ? 'OK' : r.status))).catch(() => log('Django 연결실패'));
log('background.js v1.7.1');
