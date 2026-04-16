// background.js v2.1.0 — 통합 서비스 워커
// 네이버 Term 분석 + 순위추적 + 로하스 수집 + 지마켓 순위추적
'use strict';

// 로하스 / 지마켓 모듈 로드
importScripts('bg_lohas.js', 'bg_gmarket.js');

// ══════════════════════════════════════════
// 네이버 Term 분석 + 순위추적
// ══════════════════════════════════════════

const API = 'http://192.168.219.100:8901/api/naver';
const TAB_ORDER = ['total', 'model', 'checkout'];
const RANK_TAB_ORDER = ['total'];
const TAB_NAME = { total: '전체', model: '가격비교', checkout: '네이버페이' };

let mode = 'term'; // 'term' | 'rank'
let queue = [];
let qIdx = -1;
let processing = false;
let naverTab = null;
let appTab = null;
let captchaPaused = false;
let waitingData = false;
let timer = null;
let retryCount = 0;

const logs = [];
let logSeq = 0;
function log(msg) {
  console.log('[BG] ' + msg);
  logs.push({ i: logSeq++, t: Date.now(), msg });
  if (logs.length > 300) logs.splice(0, 100);
}

// ── 메시지 (네이버) ──
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  switch (msg.type) {
    case 'NAVER_START_TERM_SEARCH':
      start(msg.keywords || []);
      reply({ ok: true, count: (msg.keywords || []).length });
      return false;
    case 'NAVER_CANCEL':
      cancel();
      reply({ ok: true });
      return false;
    case 'NAVER_GET_STATUS':
      reply(getStatus(msg.logSince || 0));
      return false;
    case 'NAVER_START_RANK_TRACKING':
      startRankTracking(msg.targets || []);
      reply({ ok: true, count: (msg.targets || []).length });
      return false;
    case 'NAVER_SHOPPING_DATA':
      onData(msg);
      reply({ ok: true });
      return false;
    case 'NAVER_PAGE_READY':
      onPageReady(sender.tab?.id);
      reply({ ok: true });
      return false;
    case 'CAPTCHA_DETECTED':
      log('⚠ CAPTCHA: ' + msg.captchaType);
      pauseForCaptcha();
      reply({ ok: true });
      return false;
    case 'CAPTCHA_RESOLVED':
      log('CAPTCHA 해결');
      resumeAfterCaptcha();
      reply({ ok: true });
      return false;
  }
  // 네이버 메시지가 아니면 다음 리스너로 전달
});

// ══════════════════════════════════════════
// 크롤링 흐름
// ══════════════════════════════════════════
function start(keywords) {
  cancel();
  logs.length = 0;
  logSeq = 0;
  mode = 'term';
  queue = keywords.map(kw => ({
    keyword: kw, tabsDone: [], tabIdx: 0, status: 'pending',
  }));
  qIdx = -1;
  log(`── ${keywords.length}개 키워드 시작 ──`);
  chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });
  nextKeyword();
}

function startRankTracking(targets) {
  cancel();
  logs.length = 0;
  logSeq = 0;
  mode = 'rank';

  // 키워드별로 타겟 그룹핑
  const kwMap = {};
  for (const t of targets) {
    if (!kwMap[t.keyword]) kwMap[t.keyword] = [];
    kwMap[t.keyword].push(t);
  }

  queue = Object.keys(kwMap).map(kw => ({
    keyword: kw, tabsDone: [], tabIdx: 0, status: 'pending',
    targets: kwMap[kw],
  }));
  qIdx = -1;
  log(`── 순위추적 시작: ${targets.length}개 대상 (${queue.length}개 키워드) ──`);
  chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });
  nextKeyword();
}

function nextKeyword() {
  if (captchaPaused) return;
  qIdx++;
  if (qIdx >= queue.length) {
    if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
    log('★ 전체 완료!');
    chrome.alarms.clear('crawlKeepAlive');
    processing = false;
    notifyComplete();
    return;
  }
  processing = true;
  const item = queue[qIdx];
  item.status = 'active';
  item.tabIdx = 0;
  log(`[${qIdx + 1}/${queue.length}] "${item.keyword}"`);
  navigateToTab();
}

// ── ★ 핵심: URL 이동으로 탭별 데이터 수집 ──
function navigateToTab() {
  const item = queue[qIdx];
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : TAB_ORDER;
  if (!item || item.tabIdx >= tabs.length) {
    finishKeyword();
    return;
  }
  const tabKey = tabs[item.tabIdx];
  const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(item.keyword)}&sort=rel&productSet=${tabKey}`;

  log(`  [${TAB_NAME[tabKey]}] 페이지 이동`);
  waitingData = true;
  retryCount = 0;

  if (naverTab) {
    chrome.tabs.update(naverTab, { url, active: true })
      .then(() => setTimer(12000))
      .catch(e => {
        log(`  ⚠ 탭 업데이트 실패: ${e.message}`);
        naverTab = null;
        createTab(url);
      });
  } else {
    createTab(url);
  }
}

function createTab(url) {
  chrome.tabs.create({ url, active: true })
    .then(tab => { naverTab = tab.id; setTimer(12000); })
    .catch(e => { log(`  ⚠ 탭 생성 실패: ${e.message}`); skipTab(); });
}

// ── 페이지 로드 완료 ──
function onPageReady(tabId) {
  if (tabId !== naverTab || !waitingData) return;
  log('  페이지 로드 완료');
  setTimer(5000);
}

// ── ★ 데이터 수신 ──
async function onData(msg) {
  if (!waitingData || qIdx < 0 || qIdx >= queue.length) return;
  const item = queue[qIdx];
  const products = msg.products || [];
  if (!products.length) { log('  (상품 0개 무시)'); return; }

  const dataTab = msg.productSet || 'total';
  waitingData = false;
  clr();

  if (!item.tabsDone.includes(dataTab)) item.tabsDone.push(dataTab);

  if (mode === 'rank') {
    log(`  ★ [${TAB_NAME[dataTab]}] ${products.length}개 — 순위 검색`);
    await processRankResults(item, products, dataTab, msg.total || 0);
  } else {
    log(`  ★ [${TAB_NAME[dataTab]}] ${products.length}개 total=${msg.total || 0} terms=${(msg.terms||[]).length}`);
    // Django 저장
    try {
      const r = await fetch(`${API}/ext/search-result/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: msg.query || item.keyword,
          tab_type: dataTab,
          products: products.slice(0, 40),
          total: msg.total || 0,
          terms: msg.terms || [],
          term_count: msg.termCount || 0,
        })
      });
      log(`  [${TAB_NAME[dataTab]}] ${r.ok ? '저장OK' : 'Django실패 ' + r.status}`);
    } catch (e) {
      log(`  [${TAB_NAME[dataTab]}] Django실패`);
    }
  }

  // 다음 탭
  item.tabIdx++;
  const delay = 1500 + Math.random() * 2000;
  setTimeout(() => navigateToTab(), delay);
}

// ── ★ 순위추적: 상품 매칭 + Django 저장 ──
async function processRankResults(item, products, tabType, totalResults) {
  const targets = item.targets || [];
  for (const target of targets) {
    let rank = null;
    let foundProduct = null;

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let match = false;
      if (target.target_type === 'store') {
        match = (p.mallName || '').trim() === target.target_value.trim();
      } else if (target.target_type === 'product_id') {
        match = String(p.nvMid || p.id || '') === String(target.target_value);
      }
      if (match) {
        rank = i + 1;
        foundProduct = p;
        break;
      }
    }

    log(`  📊 [${target.target_value}] ${rank ? rank + '위' : '미발견 (40위 밖)'}`);

    // 앱 탭에 진행상황 전달
    if (appTab) {
      chrome.tabs.sendMessage(appTab, {
        type: 'NAVER_TRACKING_PROGRESS',
        keyword: item.keyword,
        target_value: target.target_value,
        rank: rank,
        current: qIdx + 1,
        total: queue.length,
      }).catch(() => {});
    }

    // Django 저장
    try {
      const r = await fetch(`${API}/ext/rank-result/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_id: target.target_id,
          rank_position: rank,
          tab_type: tabType,
          total_results: totalResults,
          found_product_name: foundProduct?.productName || foundProduct?.productTitle || '',
          found_product_price: foundProduct ? parseInt(foundProduct.lowPrice || foundProduct.price || '0', 10) || null : null,
          found_review_count: foundProduct ? (foundProduct.reviewCount || 0) : null,
        })
      });
      log(`  [${target.target_value}] ${r.ok ? '저장OK' : 'Django실패 ' + r.status}`);
    } catch (e) {
      log(`  [${target.target_value}] Django실패`);
    }
  }
}

function skipTab() {
  if (qIdx < 0 || qIdx >= queue.length) return;
  const item = queue[qIdx];
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : TAB_ORDER;
  const tabKey = tabs[item.tabIdx];
  log(`  [${TAB_NAME[tabKey] || tabKey}] 스킵`);
  waitingData = false;
  clr();
  item.tabIdx++;
  setTimeout(() => navigateToTab(), 1000);
}

function finishKeyword() {
  const item = queue[qIdx];
  const tabs = item.tabsDone.map(t => TAB_NAME[t]).join(', ');
  log(`  ✓ "${item.keyword}" 완료 (${tabs || '없음'})`);
  item.status = 'done';
  processing = false;
  const delay = 2000 + Math.random() * 3000;
  log(`  ${Math.round(delay / 1000)}초 후 다음`);
  setTimeout(() => nextKeyword(), delay);
}

function notifyComplete() {
  const msgType = mode === 'rank' ? 'NAVER_RANK_COMPLETE' : 'NAVER_SEARCH_COMPLETE';
  if (appTab) {
    chrome.tabs.sendMessage(appTab, {
      type: msgType,
      total: queue.length,
      done: queue.filter(q => q.status === 'done').length,
    }).catch(() => {});
  }
}

// ══════════════════════════════════════════
// 타이머
// ══════════════════════════════════════════
function setTimer(ms) {
  clr();
  timer = setTimeout(() => {
    if (!waitingData || qIdx < 0) return;
    const item = queue[qIdx];
    const tabs = mode === 'rank' ? RANK_TAB_ORDER : TAB_ORDER;
    const tabKey = tabs[item.tabIdx];

    if (retryCount < 1) {
      retryCount++;
      log(`  [${TAB_NAME[tabKey]}] 타임아웃 → 새로고침`);
      if (naverTab) {
        chrome.tabs.reload(naverTab).catch(() => {});
        setTimer(8000);
      } else { skipTab(); }
    } else {
      log(`  [${TAB_NAME[tabKey]}] 2회 실패 → 스킵`);
      skipTab();
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
  log('⏸ CAPTCHA — 일시정지');
}

function resumeAfterCaptcha() {
  if (!captchaPaused) return;
  captchaPaused = false;
  log('▶ CAPTCHA 해결 — 재개');
  navigateToTab();
}

function cancel() {
  queue = [];
  qIdx = -1;
  processing = false;
  waitingData = false;
  captchaPaused = false;
  retryCount = 0;
  mode = 'term';
  clr();
  if (naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
  chrome.alarms.clear('crawlKeepAlive');
}

// ══════════════════════════════════════════
// 상태
// ══════════════════════════════════════════
function getStatus(since) {
  let steps = 0;
  const tabCount = mode === 'rank' ? 1 : 3;
  for (const q of queue) {
    steps += q.tabsDone.length;
  }
  const cur = qIdx >= 0 && qIdx < queue.length ? queue[qIdx] : null;
  return {
    running: processing,
    mode,
    total: queue.length,
    done: queue.filter(q => q.status === 'done').length,
    steps, totalSteps: queue.length * tabCount,
    keyword: cur?.keyword || null,
    kwIdx: qIdx >= 0 ? qIdx + 1 : 0,
    captchaPaused,
    logs: logs.filter(l => l.i >= since),
  };
}

// ══════════════════════════════════════════
// 탭 감시
// ══════════════════════════════════════════
chrome.tabs.onUpdated.addListener((id, ci, tab) => {
  if (tab.url && (tab.url.includes('192.168.219.100') || tab.url.includes('localhost')) &&
      (tab.url.includes('naver-terms') || tab.url.includes('naver-rank'))) {
    appTab = id;
  }
  if (id === naverTab && ci.url) {
    if (ci.url.includes('nid.naver.com') || ci.url.includes('captcha')) {
      log('⚠ 로그인/CAPTCHA 리다이렉트');
      pauseForCaptcha();
    } else if (captchaPaused && ci.url.includes('search.shopping.naver.com')) {
      resumeAfterCaptcha();
    }
  }
});

chrome.tabs.onRemoved.addListener(id => {
  if (id === naverTab) {
    naverTab = null;
    if (processing) { log('  ⚠ 네이버 탭 닫힘'); skipTab(); }
  }
  if (id === appTab) appTab = null;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'crawlKeepAlive' && !processing) {
    chrome.alarms.clear('crawlKeepAlive');
  }
});

// 초기화
fetch(`${API}/keywords/`).then(r => log('Django ' + (r.ok ? 'OK' : r.status))).catch(() => log('Django 연결실패'));
log('background.js v2.1.0 (통합+순위추적)');
