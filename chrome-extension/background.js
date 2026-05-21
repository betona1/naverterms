// background.js v3.0.26 — 내부/외부 모드 통합 서비스 워커
// 내부용: Django API 연동 (DB 저장)
// 외부용: chrome.storage.local 저장 + CSV 내보내기
// 인간 행동 시뮬레이션: content-script에 타이핑/스크롤/네비 위임
'use strict';

importScripts('bg_lohas.js', 'bg_gmarket.js');

// ══════════════════════════════════════════
// 설정
// ══════════════════════════════════════════
const INTERNAL_API = 'http://192.168.219.100:8901/api/naver';
const HOME_URL = 'https://search.shopping.naver.com/';
// 기본 수집 순서: 가격비교 → 전체 → 네이버페이
const DEFAULT_TAB_ORDER = ['model', 'total', 'checkout'];
let currentTabOrder = DEFAULT_TAB_ORDER;
const RANK_TAB_ORDER = ['total'];
const TAB_NAME = { total: '전체', model: '가격비교', checkout: '네이버페이' };
// 프로그레스바 표시용 (전체 → 전체페이지둘러보기 위장)
const TAB_DISPLAY = { total: '전체페이지둘러보기', model: '가격비교', checkout: '네이버페이' };

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 세션마다 랜덤 (키워드 몇 개마다 휴식)
function nextBreakInterval() { return 3 + Math.floor(Math.random() * 4); } // 3~6

// 빌드 시점에 결정되는 기본 모드 (배포 ZIP 변종별로 sed 치환)
const BUILD_MODE = 'external'; // BUILD_MODE_PLACEHOLDER

let saveMode = BUILD_MODE; // 'internal' | 'external'
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
let breakEvery = nextBreakInterval();
let tabReadyResolver = null; // home 로드 대기용
let totalCollected = 0; // 누적 수집 상품 수
let repairMode = false; // 재수집 패스 여부
let manualTabKey = null; // 수동 수집 단일 탭 (null = 일반 배치)
let isReCollect = false; // 단일 키워드 + 3탭 = 전체다시수집

// 외부 사이트 잠깐 들렀다 오기 (40% 확률) — 봇 탐지 회피용 자연스러운 패턴
const EXTERNAL_SITES = [
  'https://www.daum.net',
  'https://search.daum.net/search?q=쇼핑',
  'https://www.nate.com',
  'https://www.google.com/search?q=올림머리',
  'https://shopping.daum.net',
  'https://m.daum.net',
];
async function externalDetour() {
  const site = EXTERNAL_SITES[Math.floor(Math.random() * EXTERNAL_SITES.length)];
  try {
    if (naverTab) {
      await chrome.tabs.update(naverTab, { url: site, active: true });
    } else {
      const t = await chrome.tabs.create({ url: site, active: true });
      naverTab = t.id;
    }
  } catch (e) { /* 일부 사이트는 차단될 수 있음 — 무시 */ }
  await sleep(rand(2500, 5000)); // 잠깐 둘러보기
}

// 진행 phase 알림 (0=회피작업중, 1=첫탭그냥보냄, 2=타겟수집)
function pushPhase(phase, tabKey, opts) {
  if (!naverTab) return;
  const label = tabKey ? TAB_DISPLAY[tabKey] : '';
  chrome.tabs.sendMessage(naverTab, {
    type: 'PHASE_UPDATE',
    phase,
    label: (opts && opts.label) || label,
    reCollect: isReCollect,
  }).catch(() => {});
}

const logs = [];
let logSeq = 0;
function log(msg) {
  console.log('[BG] ' + msg);
  logs.push({ i: logSeq++, t: Date.now(), msg });
  if (logs.length > 300) logs.splice(0, 100);
  if (processing && naverTab) pushLogToTab(msg);
}

function pushLogToTab(msg) {
  try {
    chrome.tabs.sendMessage(naverTab, { type: 'LOG_LINE', msg }).catch(() => {});
  } catch (e) {}
}

// 모드 로드 — 다른 빌드(internal/external)로 재설치 시 BUILD_MODE 강제 적용
chrome.storage.local.get(['saveMode', 'buildMode'], r => {
  if (r.buildMode !== BUILD_MODE) {
    // 다른 빌드 ZIP 으로 재설치됨 → 빌드 기본 모드로 강제
    saveMode = BUILD_MODE;
    chrome.storage.local.set({ saveMode: BUILD_MODE, buildMode: BUILD_MODE });
    log(`빌드 변경 감지 (${r.buildMode || '없음'} → ${BUILD_MODE}) — ${BUILD_MODE === 'internal' ? '내부용' : '외부용'} 으로 초기화`);
  } else if (r.saveMode) {
    saveMode = r.saveMode;
  }
  log(`모드: ${saveMode === 'internal' ? '내부용' : '외부용'} (빌드: ${BUILD_MODE})`);
});

// ══════════════════════════════════════════
// 메시지 핸들러
// ══════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  switch (msg.type) {
    case 'NAVER_START_TERM_SEARCH':
      start(msg.keywords || [], msg.tabOrder);
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
      log('⚠ ' + (msg.captchaType === 'receipt_puzzle' ? '네이버 영수증 풀이' : 'CAPTCHA') + ': ' + msg.captchaType);
      pauseForCaptcha(msg.captchaType);
      reply({ ok: true });
      return false;
    case 'CAPTCHA_RESOLVED':
      log('CAPTCHA 해결');
      resumeAfterCaptcha();
      reply({ ok: true });
      return false;
    case 'RESTART_CURRENT':
      restartCurrent();
      reply({ ok: true });
      return false;
    case 'SET_SAVE_MODE':
      saveMode = msg.mode || 'external';
      chrome.storage.local.set({ saveMode, buildMode: BUILD_MODE });
      log(`모드 변경: ${saveMode === 'internal' ? '내부용' : '외부용'}`);
      reply({ ok: true, mode: saveMode });
      return false;
    case 'GET_SAVE_MODE':
      reply({ mode: saveMode });
      return false;
    case 'GET_RESULTS':
      getStoredResults().then(r => reply(r));
      return true; // async
    case 'CLEAR_RESULTS':
      clearStoredResults().then(() => reply({ ok: true }));
      return true;
    case 'EXPORT_CSV':
      getStoredResults().then(r => reply(r));
      return true;
    case 'OPEN_RESULTS_PAGE':
      chrome.tabs.create({ url: msg.url || chrome.runtime.getURL('results.html') });
      reply({ ok: true });
      return false;
    case 'MANUAL_COLLECT_TAB':
      manualCollect(msg.keyword, msg.tabKey, sender.tab?.id);
      reply({ ok: true });
      return false;
    case 'MANUAL_COLLECT_ALL':
      manualCollectAll(msg.keyword, sender.tab?.id);
      reply({ ok: true });
      return false;
    case 'GET_RESULTS_FOR_KEYWORD':
      getResultsForKeyword(msg.keyword).then(r => reply(r));
      return true; // async
    case 'GET_PRODUCT_HISTORY':
      getProductHistory(msg.keyword, msg.tab, msg.productId).then(r => reply(r));
      return true; // async
    case 'DOWNLOAD_EXCEL':
      downloadExcelForKeyword(msg.keyword, !!msg.withImages).then(r => reply(r));
      return true; // async
    case 'PURCHASE_TRACK_START':
      startPurchaseTracking(msg.targets || []);
      reply({ ok: true, count: (msg.targets || []).length });
      return false;
    case 'PURCHASE_TRACK_STOP':
      stopPurchaseTracking();
      reply({ ok: true });
      return false;
    case 'PURCHASE_TRACK_STATUS':
      reply(getPurchaseTrackStatus());
      return false;
    case 'PURCHASE_DETAIL_DATA':
      onPurchaseData(msg);
      reply({ ok: true });
      return false;
  }
});

// ══════════════════════════════════════════
// 수동 수집 — 첫 검색은 무조건 실패한다고 가정하고 "준비 시퀀스" 수행:
//   1) 타겟 제외 디코이1 URL 진입 → 스크롤
//   2) 디코이2 클릭 → 스크롤
//   3) 잠깐 대기
//   4) 타겟 클릭 → XHR 풀데이터 수집
// 모든 단계에서 바에 "데이터 수집 위해 준비중입니다..." 표시
// ══════════════════════════════════════════
async function manualCollect(keyword, tabKey, tabId) {
  if (processing) {
    pushLogToTab('이미 수집 중 — 잠시 후 다시 시도');
    return;
  }
  if (!keyword || !tabKey || !['total', 'model', 'checkout'].includes(tabKey)) {
    pushLogToTab('수집 정보가 올바르지 않습니다');
    return;
  }
  cancel(true); // 사용자 탭은 유지 (그 탭에서 클릭한 수집)
  logs.length = 0; logSeq = 0;
  mode = 'term';
  manualTabKey = tabKey;
  currentTabOrder = [tabKey]; // 단일 탭만
  isReCollect = false; // 수동 단일탭은 재수집 아님
  totalCollected = 0;
  if (tabId) naverTab = tabId;

  queue = [{ keyword, tabsDone: [], tabIdx: 0, status: 'active', tabRetries: {} }];
  qIdx = 0;
  processing = true;

  log(`📦 수동 수집: "${keyword}" [${TAB_DISPLAY[tabKey]}]`);
  chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });
  pushProgressToTab();

  // 타겟 제외한 디코이 2개 (랜덤 순서)
  const decoys = ['total', 'model', 'checkout'].filter(t => t !== tabKey);
  for (let i = decoys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [decoys[i], decoys[j]] = [decoys[j], decoys[i]];
  }
  const [decoy1, decoy2] = decoys;

  waitingData = false; // 준비 단계 데이터는 무시

  // ── 1단계: 회피작업 (랜덤 외부 detour + 네이버 홈에서 키보드 타이핑) ──
  pushPhase(0, decoy1);
  log(`  🔀 1단계: 회피작업 시작`);

  // 40% 확률로 외부 사이트 잠깐 들르기
  if (Math.random() < 0.4) {
    log(`  🌐 외부 사이트 잠깐 들렀다 옴`);
    pushLogToTab('다른 사이트 잠깐 둘러보는 중...');
    await externalDetour();
  }

  // 네이버쇼핑 홈으로 이동 → 검색창에 키워드 키보드 타이핑 → decoy1 검색결과로 진입
  pushLogToTab('네이버 쇼핑 홈 진입...');
  try {
    if (naverTab) {
      await chrome.tabs.update(naverTab, { url: HOME_URL, active: true });
    } else {
      await createTab(HOME_URL);
    }
  } catch (e) {
    naverTab = null;
    await createTab(HOME_URL);
  }
  await sleep(rand(2200, 3400)); // 페이지 로드 + 살짝 둘러보기

  // 검색창 키보드 타이핑 → 검색 → decoy1 결과페이지
  pushLogToTab(`검색창에 "${keyword}" 타이핑 중...`);
  const typeResult = await sendTab({
    type: 'HUMAN_TYPE_NAV',
    keyword,
    url: buildSearchUrl(keyword, decoy1),
  });
  if (!typeResult?.ok) {
    // 타이핑 실패 시 URL 직접 이동 폴백
    log(`  ⚠ 타이핑 실패 → URL 직접이동`);
    chrome.tabs.update(naverTab, { url: buildSearchUrl(keyword, decoy1), active: true }).catch(() => {});
  }
  await sleep(rand(2500, 3800));

  // 스크롤
  pushLogToTab('데이터 수집 위해 준비중입니다... (스크롤 중)');
  await sendTab({ type: 'SET_EXPECTED_TAB', tabKey: decoy1 }).catch(() => {});
  await sendTab({ type: 'HUMAN_BEHAVIOR' }).catch(() => {});
  await sleep(rand(1800, 2800));

  // ── 2단계: 두번째 디코이 클릭 (첫탭 그냥보냄) ──
  pushPhase(1, decoy2);
  log(`  🔀 2단계: ${TAB_DISPLAY[decoy2]} 클릭 (디코이)`);
  pushLogToTab(`데이터 수집 위해 준비중입니다... (${TAB_DISPLAY[decoy2]})`);
  await sendTab({ type: 'SET_EXPECTED_TAB', tabKey: decoy2 });
  const c2 = await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey: decoy2 });
  if (!c2?.ok) {
    chrome.tabs.update(naverTab, { url: buildSearchUrl(keyword, decoy2), active: true }).catch(() => {});
  }
  await sleep(rand(2200, 3500));

  // 또 스크롤
  pushLogToTab('데이터 수집 위해 준비중입니다... (스크롤 중)');
  await sendTab({ type: 'HUMAN_BEHAVIOR' }).catch(() => {});
  await sleep(rand(1500, 2500));

  // ── 3단계: 타겟 탭 클릭 (실수집 — phase 2) ──
  pushPhase(2, tabKey);
  log(`  🎯 3단계: ${TAB_DISPLAY[tabKey]} 클릭 (실수집)`);
  pushLogToTab(`${TAB_DISPLAY[tabKey]} 탭 데이터 수집중...`);
  waitingData = true;
  retryCount = 0;
  await sendTab({ type: 'SET_EXPECTED_TAB', tabKey });
  const c3 = await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey });
  if (!c3?.ok) {
    log(`  ⚠ 탭 클릭 실패(${c3?.reason || 'n/a'}) → URL 폴백`);
    chrome.tabs.update(naverTab, { url: buildSearchUrl(keyword, tabKey), active: true }).catch(() => {});
  }
  setTimer(30000);
}

// 바의 🔥All 버튼 — 현재 탭 유지하면서 단일 키워드 3탭 일괄 수집
async function manualCollectAll(keyword, tabId) {
  if (processing) {
    pushLogToTab('이미 수집 중 — 잠시 후 다시 시도');
    return;
  }
  if (!keyword) return;
  if (tabId) naverTab = tabId;
  // start() 호출 시 keepTab=true 로 사용자 탭 유지
  start([keyword], ['model', 'total', 'checkout'], { keepTab: true });
}

// Excel 다운로드 — 내부: Django endpoint, 외부: 클라이언트 SpreadsheetML
async function downloadExcelForKeyword(keyword, withImages) {
  if (!keyword) return { error: '키워드 없음' };
  if (saveMode === 'internal') {
    try {
      const r = await fetch(`${INTERNAL_API}/keywords/`);
      const keywords = await r.json();
      const kw = keywords.find(k => k.keyword === keyword);
      if (!kw) return { error: '키워드를 찾을 수 없음 — 먼저 수집하세요' };
      const url = `${INTERNAL_API}/export/products/${kw.id}/${withImages ? '?images=true' : ''}`;
      // chrome.downloads 로 직접 다운로드
      await chrome.downloads.download({
        url,
        filename: `${keyword}_전체${withImages ? '+이미지' : ''}.xlsx`,
        saveAs: false,
      });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  } else {
    // 외부모드: chrome.storage 데이터로 SpreadsheetML 생성 (이미지 임베드 미지원)
    if (withImages) {
      return { error: '외부모드는 이미지 임베드 미지원 — 내부모드 사용 또는 일반 xls 사용' };
    }
    return await downloadExcelExternal(keyword);
  }
}

async function downloadExcelExternal(keyword) {
  try {
    const tabs = ['total', 'model', 'checkout'];
    const tabNames = { total: '전체', model: '가격비교', checkout: '네이버페이' };
    const sheets = [];
    for (const tab of tabs) {
      const key = `term_${keyword}_${tab}`;
      const data = await chrome.storage.local.get(key);
      const products = data[key]?.products || [];
      sheets.push({ name: tabNames[tab], products });
    }
    const xml = buildSpreadsheetXml(sheets);
    const BOM = '﻿';
    // data URL 로 다운로드
    const blob = new Blob([BOM + xml], { type: 'application/vnd.ms-excel' });
    const reader = new FileReader();
    const dataUrl = await new Promise((res, rej) => {
      reader.onload = () => res(reader.result);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    await chrome.downloads.download({
      url: dataUrl,
      filename: `${keyword}_전체.xls`,
      saveAs: false,
    });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

function buildSpreadsheetXml(sheets) {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const cols = ['상품명', '스토어명', '카테고리명', '속성항목', '속성값', '태그',
                '브랜드', '제조사', '리뷰수', '등록일', '이미지URL'];
  const fmtPipe = v => !v ? '' : (Array.isArray(v) ? v.join('|') : String(v));
  const fmtTag = v => {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x && (x.name || x.value || x.text) || '')).filter(Boolean).join(',');
    return String(v);
  };
  const fmtCat = p => [p.category1Name, p.category2Name, p.category3Name, p.category4Name].filter(Boolean).join(' > ');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<?mso-application progid="Excel.Sheet"?>\n';
  xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  xml += '<Styles><Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#03C75A" ss:Pattern="Solid"/></Style></Styles>\n';
  for (const s of sheets) {
    xml += `<Worksheet ss:Name="${esc(s.name)}">\n<Table>\n`;
    xml += '<Row>' + cols.map(c => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${esc(c)}</Data></Cell>`).join('') + '</Row>\n';
    for (const p of s.products) {
      const row = [
        p.productName || p.productTitle || '',
        p.mallName || (p.lowMallList && p.lowMallList[0] && p.lowMallList[0].name) || '',
        fmtCat(p), fmtPipe(p.attributeValue), fmtPipe(p.characterValue), fmtTag(p.manuTag),
        p.brand || '', p.maker || '',
        Number(p.reviewCount || 0),
        p.openDate || '',
        p.imageUrl || '',
      ];
      xml += '<Row>' + row.map((v, i) => {
        const isNum = i === 8;
        const t = isNum ? 'Number' : 'String';
        return `<Cell><Data ss:Type="${t}">${isNum ? Number(v) : esc(v)}</Data></Cell>`;
      }).join('') + '</Row>\n';
    }
    xml += '</Table>\n</Worksheet>\n';
  }
  xml += '</Workbook>';
  return xml;
}

// 상품ID 별 시계열 변동 — 내부모드는 Django, 외부모드는 현재 스냅샷만
async function getProductHistory(keyword, tab, productId) {
  if (!keyword || !productId) return { error: 'keyword/productId 필요', history: [] };
  const tabKey = tab || 'total';
  if (saveMode === 'external') {
    // 외부모드는 chrome.storage 에 마지막 스냅샷만 — 단일 행 반환
    try {
      const key = `term_${keyword}_${tabKey}`;
      const data = await chrome.storage.local.get(key);
      const products = data[key]?.products || [];
      const idx = products.findIndex(p => String(p.nvMid || p.id || '') === String(productId));
      if (idx < 0) return { history: [], note: '외부모드는 1회 분량만 보관됩니다 (해당 상품 없음)' };
      const p = products[idx];
      return {
        product_id: productId, tab: tabKey,
        history: [{
          collected_at: new Date(data[key].timestamp || Date.now()).toISOString(),
          rank: idx + 1,
          productName: p.productName || p.productTitle || '',
          mallName: p.mallName || '',
          lowPrice: p.lowPrice || p.price || 0,
          reviewCount: p.reviewCount || 0,
          imageUrl: p.imageUrl || '',
          delta: { rank: 0, price: 0, name_changed: false, image_changed: false },
        }],
        note: '외부모드는 시계열 누적 미지원 — Django(내부모드)에서 누적됩니다',
      };
    } catch (e) { return { error: e.message, history: [] }; }
  } else {
    // 내부모드: Django API
    try {
      // 키워드 ID 찾기
      const r = await fetch(`${INTERNAL_API}/keywords/`);
      const keywords = await r.json();
      const kw = keywords.find(k => k.keyword === keyword);
      if (!kw) return { error: '키워드를 찾을 수 없음', history: [] };
      const r2 = await fetch(`${INTERNAL_API}/product-history/${kw.id}/?tab=${tabKey}&product_id=${encodeURIComponent(productId)}&limit=30`);
      if (!r2.ok) return { error: `HTTP ${r2.status}`, history: [] };
      return await r2.json();
    } catch (e) {
      return { error: e.message, history: [] };
    }
  }
}

// 결과 데이터 조회 — 모달용
async function getResultsForKeyword(keyword) {
  const result = { total: null, model: null, checkout: null };
  try {
    if (saveMode === 'external') {
      for (const tab of ['total', 'model', 'checkout']) {
        const key = `term_${keyword}_${tab}`;
        const data = await chrome.storage.local.get(key);
        if (data[key]) {
          result[tab] = {
            products: data[key].products || [],
            total: data[key].total || 0,
          };
        }
      }
    } else {
      // 내부용: Django API
      const r = await fetch(`${INTERNAL_API}/keywords/`);
      if (!r.ok) return { ...result, error: `keywords HTTP ${r.status}` };
      const keywords = await r.json();
      const kw = keywords.find(k => k.keyword === keyword);
      if (!kw) return result;
      for (const tab of ['total', 'model', 'checkout']) {
        try {
          const r2 = await fetch(`${INTERNAL_API}/products/${kw.id}/?tab=${tab}`);
          if (r2.ok) {
            const d = await r2.json();
            result[tab] = { products: d.products || [], total: d.total || 0 };
          }
        } catch (e) {}
      }
    }
    return result;
  } catch (e) {
    return { ...result, error: e.message };
  }
}

// ══════════════════════════════════════════
// 크롤링 흐름
// ══════════════════════════════════════════
async function start(keywords, tabOrder, opts) {
  cancel((opts && opts.keepTab) ? true : false);
  logs.length = 0;
  logSeq = 0;
  mode = 'term';
  currentTabOrder = (tabOrder && tabOrder.length === 3) ? tabOrder : DEFAULT_TAB_ORDER;
  // 단일 키워드 + 3탭 = 전체다시수집 (재수집 라벨 표시)
  isReCollect = (keywords.length === 1 && currentTabOrder.length === 3);
  breakEvery = nextBreakInterval();
  totalCollected = 0;
  queue = keywords.map(kw => ({
    keyword: kw, tabsDone: [], tabIdx: 0, status: 'pending', tabRetries: {},
  }));
  qIdx = -1;
  processing = true; // 워밍업 단계부터 프로그레스바 노출
  log(`── ${keywords.length}개 키워드 시작 (${saveMode === 'internal' ? '내부용' : '외부용'}, 휴식주기 ${breakEvery}) ──`);
  chrome.alarms.create('crawlKeepAlive', { periodInMinutes: 0.5 });

  // 사전 워밍업 — 네이버 쇼핑 홈 방문하고 뻘짓 (봇 탐지 회피)
  pushPhase(0); // 회피작업중
  await warmupBrowse();

  nextKeyword();
}

// 워밍업/완료 등 상태 표시용 (qIdx=-1 일 때도 프로그레스바 노출)
function pushCustomStatus(status, log) {
  if (!naverTab) return;
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  chrome.tabs.sendMessage(naverTab, {
    type: 'SHOW_PROGRESS',
    keyword: '',
    tabName: '',
    tabKey: '',
    kwIdx: 0,
    total: queue.length,
    steps: 0,
    totalSteps: queue.length * tabs.length,
    overrideStatus: status,
    overrideLog: log,
  }).catch(() => {});
}

// 여러 워밍업 루틴 중 랜덤 선택 — 매번 다르게
async function warmupBrowse() {
  const routines = [
    warmupHomeScroll,
    warmupShoppingHome,
    warmupBestKeyword,
    warmupDirectSearch,
  ];
  const routine = routines[Math.floor(Math.random() * routines.length)];
  try {
    // 40% 확률로 외부 사이트 잠깐 들르기 (다음/네이트/구글 등)
    if (Math.random() < 0.4) {
      log(`🌐 외부 사이트 잠깐 들렀다 옴`);
      pushCustomStatus('🛍️ 네이버플러스 스토어', '다른 사이트 둘러보는 중...');
      await externalDetour();
    }
    log(`🛍️ 네이버플러스 스토어 접속 중...`);
    await routine();
    pushCustomStatus('🛍️ 네이버플러스 스토어', '둘러보기 완료 — 수집 시작');
  } catch (e) {
    log(`  워밍업 실패(무시): ${e.message}`);
  }
}

async function warmupHomeScroll() {
  // naver 쇼핑 홈 → 스크롤
  await openOrUpdate(HOME_URL);
  await sleep(rand(1200, 2200));
  pushCustomStatus('🛍️ 네이버플러스 스토어', '홈 둘러보는 중...');
  await sleep(rand(1000, 2500));
  await sendTab({ type: 'HUMAN_BEHAVIOR' });
  await sleep(rand(3000, 6000));
}

async function warmupShoppingHome() {
  // 랭킹/핫아이템 페이지로 놀다가 (search.shopping.naver.com 도메인 내)
  await openOrUpdate('https://search.shopping.naver.com/best/trend');
  await sleep(rand(1200, 2500));
  pushCustomStatus('🛍️ 네이버플러스 스토어', '베스트 트렌드 둘러보는 중...');
  await sleep(rand(1300, 2500));
  await sendTab({ type: 'HUMAN_BEHAVIOR' });
  await sleep(rand(2500, 5500));
}

async function warmupBestKeyword() {
  // 랜덤 인기 키워드로 한번 검색 후 결과 둘러보기
  const seeds = ['선풍기', '노트북', '운동화', '청소기', '커피', '책상', '의자', '공책', '물통', '가방'];
  const seed = seeds[Math.floor(Math.random() * seeds.length)];
  await openOrUpdate(`https://search.shopping.naver.com/search/all?query=${encodeURIComponent(seed)}`);
  await sleep(rand(1500, 2500));
  pushCustomStatus('🛍️ 네이버플러스 스토어', `"${seed}" 검색 결과 둘러보는 중...`);
  await sleep(rand(1500, 3000));
  await sendTab({ type: 'HUMAN_BEHAVIOR' });
  await sleep(rand(2500, 5000));
}

async function warmupDirectSearch() {
  // 쇼핑 홈 → 잠깐 스크롤
  await openOrUpdate(HOME_URL);
  await sleep(rand(800, 1800));
  pushCustomStatus('🛍️ 네이버플러스 스토어', '쇼핑 홈 진입...');
  await sleep(rand(700, 1700));
  await sendTab({ type: 'HUMAN_BEHAVIOR' });
  await sleep(rand(2000, 4000));
}

async function openOrUpdate(url) {
  if (naverTab) {
    try { await chrome.tabs.update(naverTab, { url, active: true }); }
    catch (e) { naverTab = null; await createTab(url); }
  } else {
    await createTab(url);
  }
}

function startRankTracking(targets) {
  cancel();
  logs.length = 0;
  logSeq = 0;
  mode = 'rank';
  breakEvery = nextBreakInterval();
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
    // 1차 끝. 미수집 탭 있는 키워드 → 재수집 패스
    if (!repairMode && hasMissingTabs()) {
      startRepairPass();
      return;
    }
    // 탭은 닫지 않고 유지 — 결과보기 버튼 노출을 위해
    log('★ 전체 완료!');
    chrome.alarms.clear('crawlKeepAlive');
    processing = false;
    notifyComplete();
    return;
  }

  // 랜덤 휴식 주기
  if (qIdx > 0 && qIdx % breakEvery === 0) {
    const breakMs = rand(45000, 150000); // 45~150초
    log(`  ☕ ${Math.round(breakMs / 1000)}초 휴식 (${qIdx}/${queue.length})`);
    breakEvery = nextBreakInterval();
    setTimeout(() => startKeyword(), breakMs);
    return;
  }

  startKeyword();
}

function startKeyword() {
  if (captchaPaused) return;
  processing = true;
  const item = queue[qIdx];
  item.status = 'active';
  item.tabIdx = 0;
  log(`[${qIdx + 1}/${queue.length}] "${item.keyword}"`);
  // 첫 키워드면 홈부터, 이후 키워드는 현재 결과 페이지에서 재타이핑
  enterKeyword();
}

// 키워드 진입: 검색창에 타이핑 → Enter (사람처럼)
async function enterKeyword() {
  const item = queue[qIdx];
  const firstTabKey = (mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder)[0];
  const searchUrl = buildSearchUrl(item.keyword, firstTabKey);

  waitingData = true;
  retryCount = 0;

  // 첫 탭 진입 = 첫탭 그냥보냄 (phase 1)
  pushPhase(1, firstTabKey);
  log(`  상품정보 수집중... "${item.keyword}" (${TAB_DISPLAY[firstTabKey]})`);

  // naver 쇼핑 도메인 탭이 이미 있으면 거기서 타이핑, 없으면 홈 만들고 타이핑
  const tabInfo = naverTab ? await chrome.tabs.get(naverTab).catch(() => null) : null;
  const onNaverShop = tabInfo && tabInfo.url && tabInfo.url.includes('shopping.naver.com');

  if (!onNaverShop) {
    await openOrUpdate(HOME_URL);
    await sleep(rand(2500, 4000)); // 홈 로드 + 살짝 둘러보기
    await sendTab({ type: 'HUMAN_BEHAVIOR' }).catch(() => {});
    await sleep(rand(800, 1800));
  }

  // 검색창에 타이핑 → 검색 URL로 이동
  const typeResult = await sendTab({ type: 'HUMAN_TYPE_NAV', keyword: item.keyword, url: searchUrl });
  if (!typeResult?.ok) {
    log(`  타이핑 실패 → URL 직접이동`);
    await chrome.tabs.update(naverTab, { url: searchUrl, active: true }).catch(() => {});
  }
  setTimeout(() => sendTab({ type: 'SET_EXPECTED_TAB', tabKey: firstTabKey }), 500);
  setTimer(30000);
  updateProgressBadge();
}

// 탭 전환 (가격비교/네이버페이): DOM 클릭 → XHR → fetch훅 캡처 (파이썬 방식)
async function goNextTab() {
  const item = queue[qIdx];
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  if (!item || item.tabIdx >= tabs.length) {
    finishKeyword();
    return;
  }
  const tabKey = tabs[item.tabIdx];

  // 후속 탭 = 실수집 (phase 2)
  pushPhase(2, tabKey);
  log(`  상품정보 수집중... (${TAB_DISPLAY[tabKey]})`);
  waitingData = true;
  retryCount = 0;
  updateProgressBadge();

  const sent = await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey });
  if (!sent?.ok) {
    log(`  ⚠ 탭 클릭 실패(${sent?.reason || 'n/a'}) → URL 이동`);
    const url = buildSearchUrl(item.keyword, tabKey);
    if (naverTab) {
      await chrome.tabs.update(naverTab, { url, active: true }).catch(() => {});
    } else {
      await createTab(url);
    }
  }
  setTimer(25000);
}

function buildSearchUrl(keyword, tabKey) {
  return `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}&sort=rel&productSet=${tabKey}`;
}

function sendTab(msg) {
  return new Promise(resolve => {
    if (!naverTab) return resolve(null);
    chrome.tabs.sendMessage(naverTab, msg, (r) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r);
    });
  });
}

function openHomeTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: HOME_URL, active: true }).then(tab => {
      naverTab = tab.id;
      waitForPageReady(12000).then(resolve).catch(() => resolve());
    }).catch(reject);
  });
}

async function navToHome() {
  const sent = await sendTab({ type: 'HUMAN_NAV', url: HOME_URL });
  if (!sent?.ok && naverTab) {
    await chrome.tabs.update(naverTab, { url: HOME_URL, active: true }).catch(() => {});
  }
  await waitForPageReady(12000).catch(() => {});
  // 홈에서 잠깐 대기 (자연스럽게)
  await sleep(rand(1500, 3500));
}

function waitForPageReady(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (tabReadyResolver) tabReadyResolver = null;
    const to = setTimeout(() => { tabReadyResolver = null; reject(new Error('page ready timeout')); }, timeoutMs);
    tabReadyResolver = () => { clearTimeout(to); tabReadyResolver = null; resolve(); };
  });
}

function createTab(url) {
  return chrome.tabs.create({ url, active: true })
    .then(tab => { naverTab = tab.id; setTimer(25000); })
    .catch(e => { log(`  ⚠ 탭 생성 실패: ${e.message}`); skipTab(); });
}

function onPageReady(tabId) {
  if (tabId !== naverTab) return;
  // 홈 로드 대기자가 있으면 해소
  if (tabReadyResolver) {
    const r = tabReadyResolver;
    tabReadyResolver = null;
    r();
  }
  if (waitingData) {
    log('  페이지 로드 완료');
    setTimer(12000);
  }
  if (processing) updateProgressBadge();
}

// ══════════════════════════════════════════
// 데이터 수신 + 저장
// ══════════════════════════════════════════
async function onData(msg) {
  if (!waitingData || qIdx < 0 || qIdx >= queue.length) return;
  const item = queue[qIdx];
  const products = msg.products || [];
  if (!products.length) { log('  (상품 0개 무시)'); return; }

  const dataTab = msg.productSet || 'total';
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  // 재수집 모드에선 tabsTodoForRepair 기반, 일반은 tabIdx 기반
  const expectedTab = repairMode
    ? (item.tabsTodoForRepair && item.tabsTodoForRepair[0])
    : tabs[item.tabIdx];
  if (expectedTab && dataTab !== expectedTab) {
    log(`  (탭 불일치: ${dataTab} ≠ ${expectedTab}, 무시)`);
    return;
  }

  waitingData = false;
  clr();
  if (!item.tabsDone.includes(dataTab)) item.tabsDone.push(dataTab);
  totalCollected += products.length;
  // 재수집 중이면 missingTabs에서 제거
  if (repairMode && item.missingTabs) {
    item.missingTabs = item.missingTabs.filter(t => t !== dataTab);
    if (item.tabsTodoForRepair) item.tabsTodoForRepair = item.tabsTodoForRepair.filter(t => t !== dataTab);
  }

  const cnt = (f) => products.filter(p => {
    const v = p[f];
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null && v !== '' && v !== 0;
  }).length;
  const mallC = cnt('mallName') + products.filter(p => p.lowMallList && p.lowMallList.length > 0).length;
  const tagC = cnt('manuTag');
  const attrC = cnt('attributeValue');
  const catC = cnt('category1Name');
  log(`  ✓ 데이터 수집 (${products.length}개의 상품정보 수집) [${TAB_DISPLAY[dataTab]}]`);
  updateProgressBadge();

  if (mode === 'rank') {
    log(`  ★ [${TAB_NAME[dataTab]}] ${products.length}개 — 순위 검색`);
    await processRankResults(item, products, dataTab, msg.total || 0);
  } else {
    log(`  ★ [${TAB_NAME[dataTab]}] ${products.length}개 total=${msg.total || 0} terms=${(msg.terms || []).length}`);
    await saveTermData(item.keyword, dataTab, products.slice(0, 40), msg.total || 0, msg.terms || [], msg.termCount || 0);
  }

  // 재수집 모드: 다음 재수집 키워드로
  if (repairMode) {
    setTimeout(() => enterRepairKeyword(), rand(6000, 14000));
    return;
  }

  // 수동 수집(단일 탭): 한 번 저장하고 즉시 완료
  if (manualTabKey) {
    const savedTab = manualTabKey;
    manualTabKey = null;
    setTimeout(() => {
      log(`★ 수동 수집 완료 [${TAB_DISPLAY[savedTab]}]`);
      chrome.alarms.clear('crawlKeepAlive');
      processing = false;
      notifyComplete();
    }, 1200);
    return;
  }

  // 일반: 다음 탭 — 사람이 결과 읽는 시간 (10~22초)
  item.tabIdx++;
  const delay = rand(10000, 22000);
  log(`  ${Math.round(delay / 1000)}초 읽은 뒤 다음 탭 클릭`);
  setTimeout(() => goNextTab(), delay);
}

// ── 모드별 저장 ──
async function saveTermData(keyword, tabType, products, total, terms, termCount) {
  if (saveMode === 'internal') {
    // Django API POST
    try {
      const r = await fetch(`${INTERNAL_API}/ext/search-result/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, tab_type: tabType, products, total, terms, term_count: termCount })
      });
      log(`  [${TAB_NAME[tabType]}] ${r.ok ? '저장OK' : 'Django실패 ' + r.status}`);
    } catch (e) {
      log(`  [${TAB_NAME[tabType]}] Django실패`);
    }
  } else {
    // chrome.storage.local 저장
    try {
      const storageKey = `term_${keyword}_${tabType}`;
      const entry = { keyword, tabType, products, total, terms, termCount, timestamp: Date.now() };
      await chrome.storage.local.set({ [storageKey]: entry });

      // 키워드 인덱스 업데이트
      const idx = await chrome.storage.local.get('_keyword_index');
      const kwIndex = idx._keyword_index || [];
      const existing = kwIndex.find(k => k.keyword === keyword);
      if (existing) {
        if (!existing.tabs.includes(tabType)) existing.tabs.push(tabType);
        existing.lastUpdated = Date.now();
      } else {
        kwIndex.push({ keyword, tabs: [tabType], lastUpdated: Date.now() });
      }
      await chrome.storage.local.set({ _keyword_index: kwIndex });

      log(`  [${TAB_NAME[tabType]}] 로컬저장OK`);
    } catch (e) {
      log(`  [${TAB_NAME[tabType]}] 로컬저장실패: ${e.message}`);
    }
  }
}

// ── 순위추적 (항상 Django API) ──
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
      if (match) { rank = i + 1; foundProduct = p; break; }
    }

    log(`  [${target.target_value}] ${rank ? rank + '위' : '미발견'}`);

    if (appTab) {
      chrome.tabs.sendMessage(appTab, {
        type: 'NAVER_TRACKING_PROGRESS',
        keyword: item.keyword,
        target_value: target.target_value,
        rank,
        current: qIdx + 1,
        total: queue.length,
      }).catch(() => {});
    }

    if (saveMode === 'internal') {
      try {
        const r = await fetch(`${INTERNAL_API}/ext/rank-result/`, {
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
}

// ══════════════════════════════════════════
// 로컬 데이터 관리 (외부용)
// ══════════════════════════════════════════
async function getStoredResults() {
  const idx = await chrome.storage.local.get('_keyword_index');
  const kwIndex = idx._keyword_index || [];
  const results = [];

  for (const kw of kwIndex) {
    const kwData = { keyword: kw.keyword, tabs: {}, lastUpdated: kw.lastUpdated };
    for (const tab of kw.tabs) {
      const key = `term_${kw.keyword}_${tab}`;
      const data = await chrome.storage.local.get(key);
      if (data[key]) {
        kwData.tabs[tab] = data[key];
      }
    }
    results.push(kwData);
  }
  return { results, count: results.length };
}

async function clearStoredResults() {
  const idx = await chrome.storage.local.get('_keyword_index');
  const kwIndex = idx._keyword_index || [];
  const keys = ['_keyword_index'];
  for (const kw of kwIndex) {
    for (const tab of kw.tabs) {
      keys.push(`term_${kw.keyword}_${tab}`);
    }
  }
  await chrome.storage.local.remove(keys);
  log('로컬 데이터 초기화 완료');
}

// ══════════════════════════════════════════
// 진행 관리
// ══════════════════════════════════════════
function skipTab() {
  if (qIdx < 0 || qIdx >= queue.length) return;
  const item = queue[qIdx];
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  const tabKey = tabs[item.tabIdx];
  log(`  [${TAB_NAME[tabKey] || tabKey}] 스킵`);
  waitingData = false;
  clr();
  // 재수집 모드: 이 탭 포기하고 다음 재수집 진행
  if (repairMode) {
    if (item.tabsTodoForRepair) item.tabsTodoForRepair = item.tabsTodoForRepair.filter(t => t !== tabKey);
    setTimeout(() => enterRepairKeyword(), rand(2000, 4000));
    return;
  }
  item.tabIdx++;
  setTimeout(() => goNextTab(), rand(1500, 3500));
}

function finishKeyword() {
  const item = queue[qIdx];
  const tabs = item.tabsDone.map(t => TAB_NAME[t]).join(', ');
  log(`  ✓ "${item.keyword}" 완료 (${tabs || '없음'})`);
  item.status = 'done';
  processing = false;
  // 키워드 간 딜레이: 보통 15~40초, 가끔 긴 휴식 60~120초
  const longBreak = Math.random() < 0.15;
  const delay = longBreak ? rand(60000, 120000) : rand(15000, 40000);
  log(`  ${Math.round(delay / 1000)}초 후 다음${longBreak ? ' (긴 휴식)' : ''}`);
  setTimeout(() => nextKeyword(), delay);
}

function notifyComplete() {
  const msgType = mode === 'rank' ? 'NAVER_RANK_COMPLETE' : 'NAVER_SEARCH_COMPLETE';
  const total = queue.length;
  const done = queue.filter(q => q.status === 'done').length;
  const failed = total - done;

  // 프로그레스바 유지 + "결과보기" 버튼 노출
  if (naverTab) {
    const resultsUrl = saveMode === 'internal'
      ? 'http://192.168.219.100:8900/#results'
      : chrome.runtime.getURL('results.html');
    const statusText = mode === 'rank'
      ? `✓ 순위추적 완료 (${done}/${total} 키워드)`
      : `✓ 수집 완료 (${done}/${total} 키워드 · ${totalCollected}개 상품)`;
    const logText = failed
      ? `${done}개 완료 / ${failed}개 실패 — 결과보기 버튼으로 확인`
      : `모두 수집 완료! 결과보기 버튼을 눌러 확인하세요`;
    chrome.tabs.sendMessage(naverTab, {
      type: 'SHOW_COMPLETE',
      status: statusText,
      msg: logText,
      resultsUrl,
    }).catch(() => {});
  }

  if (appTab) {
    chrome.tabs.sendMessage(appTab, { type: msgType, total, done }).catch(() => {});
  }

  // 배지: 완료 표시 (10초 후 자동 제거)
  chrome.action.setBadgeBackgroundColor({ color: failed ? '#f59e0b' : '#03c75a' }).catch(() => {});
  chrome.action.setBadgeText({ text: '✓' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 10000);

  // 시스템 알림
  const title = mode === 'rank' ? '순위추적 완료' : 'Term 수집 완료';
  const body = failed
    ? `${done}개 완료 / ${failed}개 실패 (총 ${total}개)`
    : `${total}개 키워드 모두 완료!`;
  try {
    chrome.notifications.create('naver-crawl-done-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: body,
      priority: 2,
      requireInteraction: false,
    });
  } catch (e) {}
}

// 진행중 배지 업데이트 + 페이지 프로그레스바
function updateProgressBadge() {
  const total = queue.length;
  if (!total || !processing) return;
  const done = queue.filter(q => q.status === 'done').length;
  chrome.action.setBadgeBackgroundColor({ color: '#60a5fa' }).catch(() => {});
  chrome.action.setBadgeText({ text: `${done}/${total}` }).catch(() => {});
  if (qIdx >= 0) pushProgressToTab(); // 워밍업 중엔 pushCustomStatus 사용
}

function pushProgressToTab() {
  if (!naverTab) return;
  const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  let steps = 0;
  for (const q of queue) steps += q.tabsDone.length;
  const cur = qIdx >= 0 && qIdx < queue.length ? queue[qIdx] : null;
  const tabKey = cur ? tabs[Math.min(cur.tabIdx, tabs.length - 1)] : null;
  chrome.tabs.sendMessage(naverTab, {
    type: 'SHOW_PROGRESS',
    keyword: cur?.keyword || '',
    tabName: tabKey ? TAB_DISPLAY[tabKey] : '',
    tabKey: tabKey || '',
    kwIdx: qIdx + 1,
    total: queue.length,
    steps,
    totalSteps: queue.length * tabs.length,
  }).catch(() => {});
}

function hideProgressBar() {
  if (!naverTab) return;
  chrome.tabs.sendMessage(naverTab, { type: 'HIDE_PROGRESS' }).catch(() => {});
}

// ══════════════════════════════════════════
// 재수집 패스 (미수집 탭 복구)
// ══════════════════════════════════════════
function hasMissingTabs() {
  const allTabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  return queue.some(q => allTabs.some(t => !q.tabsDone.includes(t)));
}

function startRepairPass() {
  log('── 마지막 전체보기 다시 수집... (누락 탭 복구) ──');
  repairMode = true;
  const allTabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
  // 미수집 탭만 tabIdx 에 맞춰 재세팅 (하나씩 재방문)
  for (const q of queue) {
    q.missingTabs = allTabs.filter(t => !q.tabsDone.includes(t));
    if (q.missingTabs.length > 0) q.status = 'pending';
  }
  qIdx = -1;
  nextRepair();
}

function nextRepair() {
  qIdx++;
  while (qIdx < queue.length && (!queue[qIdx].missingTabs || !queue[qIdx].missingTabs.length)) {
    qIdx++;
  }
  if (qIdx >= queue.length) {
    // 탭 유지 — 결과보기 버튼 노출
    log('★ 재수집 완료!');
    chrome.alarms.clear('crawlKeepAlive');
    processing = false;
    repairMode = false;
    notifyComplete();
    return;
  }
  processing = true;
  const item = queue[qIdx];
  item.status = 'active';
  item.tabIdx = 0;
  item.tabsTodoForRepair = item.missingTabs.slice();
  const missingNames = item.tabsTodoForRepair.map(t => TAB_DISPLAY[t]).join(', ');
  log(`[다시 수집 ${qIdx + 1}/${queue.length}] "${item.keyword}" — ${missingNames}`);
  enterRepairKeyword();
}

// 재수집: URL 진입 후 여러 탭 돌려 XHR 강제 유발
async function enterRepairKeyword() {
  const item = queue[qIdx];
  if (!item.tabsTodoForRepair || !item.tabsTodoForRepair.length) {
    setTimeout(() => nextRepair(), rand(5000, 12000));
    return;
  }
  const targetTab = item.tabsTodoForRepair[0];
  const searchUrl = buildSearchUrl(item.keyword, targetTab);

  waitingData = true;
  retryCount = 0;
  log(`  마지막 전체보기 다시 수집... (${TAB_DISPLAY[targetTab]})`);

  if (naverTab) {
    await chrome.tabs.update(naverTab, { url: searchUrl, active: true }).catch(async () => { naverTab = null; await createTab(searchUrl); });
  } else {
    await createTab(searchUrl);
  }
  setTimeout(() => sendTab({ type: 'SET_EXPECTED_TAB', tabKey: targetTab }), 500);
  // 페이지 로드 후 다탭 클릭 시퀀스로 XHR 유발
  setTimeout(() => multiTabRefresh(targetTab), rand(3000, 5000));
  setTimer(30000);
}

async function multiTabRefresh(targetTab) {
  // 여러 탭을 번갈아 클릭 (XHR 여러 번 유발)
  const others = currentTabOrder.filter(t => t !== targetTab);
  for (const t of others) {
    await sendTab({ type: 'SET_EXPECTED_TAB', tabKey: t });
    await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey: t });
    await sleep(rand(2500, 4500));
  }
  // 마지막에 타겟 탭 클릭
  await sendTab({ type: 'SET_EXPECTED_TAB', tabKey: targetTab });
  await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey: targetTab });
}

// ══════════════════════════════════════════
// 타이머
// ══════════════════════════════════════════
function setTimer(ms) {
  clr();
  timer = setTimeout(async () => {
    if (!waitingData || qIdx < 0) return;
    const item = queue[qIdx];
    const tabs = mode === 'rank' ? RANK_TAB_ORDER : currentTabOrder;
    const tabKey = tabs[item.tabIdx];

    if (retryCount < 2) {
      retryCount++;
      log(`  [${TAB_NAME[tabKey]}] 타임아웃 → 재시도 ${retryCount}/2`);
      if (item.tabIdx === 0) {
        // 첫 탭: URL 재이동
        const url = buildSearchUrl(item.keyword, tabKey);
        if (naverTab) chrome.tabs.update(naverTab, { url, active: true }).catch(() => {});
        else await createTab(url);
      } else {
        // 후속 탭: 재클릭 시도
        const sent = await sendTab({ type: 'HUMAN_CLICK_TAB', tabKey });
        if (!sent?.ok) {
          // 클릭 실패 → URL 폴백
          const url = buildSearchUrl(item.keyword, tabKey);
          if (naverTab) chrome.tabs.update(naverTab, { url, active: true }).catch(() => {});
        }
      }
      setTimer(15000);
    } else {
      log(`  [${TAB_NAME[tabKey]}] 3회 실패 → 스킵`);
      skipTab();
    }
  }, ms);
}

function clr() { if (timer) { clearTimeout(timer); timer = null; } }

// ══════════════════════════════════════════
// CAPTCHA
// ══════════════════════════════════════════
let captchaLongWaitTimer = null;
function pauseForCaptcha(kind) {
  if (captchaPaused) return;
  captchaPaused = true;
  clr();
  const isReceipt = kind === 'receipt_puzzle';
  if (isReceipt) {
    log('⏸ 네이버 영수증 풀이 — 직접 풀어주세요');
    sendTab({ type: 'SHOW_RECEIPT_PUZZLE', msg: '영수증에 있는 숫자를 입력해주세요' }).catch(() => {});
  } else {
    log('⏸ CAPTCHA — 수동으로 해결해주세요');
  }
  // 45초 넘게 미해결이면 다시시작 버튼 노출
  if (captchaLongWaitTimer) clearTimeout(captchaLongWaitTimer);
  captchaLongWaitTimer = setTimeout(() => {
    if (!captchaPaused) return;
    log('⏸ 장시간 미해결 → 다시시작 버튼 표시');
    sendTab({ type: 'SHOW_RESTART', msg: (isReceipt ? '영수증 풀이' : 'CAPTCHA') + ' 해결 후 다시시작 클릭' }).catch(() => {});
  }, 45000);
}

function resumeAfterCaptcha() {
  if (!captchaPaused) return;
  captchaPaused = false;
  if (captchaLongWaitTimer) { clearTimeout(captchaLongWaitTimer); captchaLongWaitTimer = null; }
  sendTab({ type: 'HIDE_RESTART' }).catch(() => {});
  log('▶ CAPTCHA 해결 — 페이지 안정화 대기');
  setTimeout(() => {
    log('▶ 수집 재개');
    waitingData = true;
    sendTab({ type: 'HUMAN_BEHAVIOR' }).catch(() => {});
    setTimer(25000);
  }, 5000);
}

// 다시시작 버튼 → 현재 키워드 재진입
function restartCurrent() {
  if (qIdx < 0 || qIdx >= queue.length) return;
  log('🔄 현재 키워드 재시작');
  captchaPaused = false;
  if (captchaLongWaitTimer) { clearTimeout(captchaLongWaitTimer); captchaLongWaitTimer = null; }
  sendTab({ type: 'HIDE_RESTART' }).catch(() => {});
  const item = queue[qIdx];
  item.tabIdx = 0;
  item.tabsDone = [];
  item.status = 'active';
  waitingData = false;
  retryCount = 0;
  clr();
  // 새 탭 열고 재진입
  if (naverTab) {
    chrome.tabs.remove(naverTab).catch(() => {});
    naverTab = null;
  }
  setTimeout(() => enterKeyword(), rand(2000, 4000));
}

function cancel(keepTab) {
  queue = [];
  qIdx = -1;
  processing = false;
  waitingData = false;
  captchaPaused = false;
  retryCount = 0;
  repairMode = false;
  manualTabKey = null;
  isReCollect = false;
  mode = 'term';
  clr();
  if (!keepTab && naverTab) { chrome.tabs.remove(naverTab).catch(() => {}); naverTab = null; }
  chrome.alarms.clear('crawlKeepAlive');
}

// ══════════════════════════════════════════
// 상태
// ══════════════════════════════════════════
function getStatus(since) {
  const tabCount = mode === 'rank' ? 1 : 3;
  let steps = 0;
  for (const q of queue) steps += q.tabsDone.length;
  const cur = qIdx >= 0 && qIdx < queue.length ? queue[qIdx] : null;
  return {
    running: processing,
    mode,
    saveMode,
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
    if (ci.url.includes('nid.naver.com') || ci.url.includes('captcha') || ci.url.includes('wtm_captcha')) {
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

// ══════════════════════════════════════════
// 구매수 추적 (확장프로그램 방식)
// ══════════════════════════════════════════
let purchaseQueue = [];
let purchaseIdx = -1;
let purchaseRunning = false;
let purchaseTabId = null;
const purchaseLogs = [];
let purchaseLogSeq = 0;

function plog(msg) {
  console.log('[BG-P] ' + msg);
  purchaseLogs.push({ i: purchaseLogSeq++, t: Date.now(), msg });
  if (purchaseLogs.length > 300) purchaseLogs.splice(0, 100);
}

function sendPurchaseProgress() {
  if (!appTab) return;
  chrome.tabs.sendMessage(appTab, {
    type: 'NAVER_PURCHASE_TRACK_PROGRESS',
    completed: purchaseIdx,
    total: purchaseQueue.length,
    current: purchaseIdx >= 0 && purchaseIdx < purchaseQueue.length
      ? purchaseQueue[purchaseIdx].product_name : null,
    running: purchaseRunning,
    logs: purchaseLogs.slice(-30),
  }).catch(() => {});
}

async function startPurchaseTracking(targets) {
  if (purchaseRunning) { plog('이미 수집중'); return; }
  purchaseQueue = targets.map(t => ({ ...t, done: false, error: null }));
  purchaseIdx = -1;
  purchaseRunning = true;
  purchaseLogs.length = 0;
  purchaseLogSeq = 0;
  plog(`── 구매수 추적 시작: ${targets.length}개 ──`);
  sendPurchaseProgress();
  visitNextPurchaseTarget();
}

async function visitNextPurchaseTarget() {
  purchaseIdx++;
  if (purchaseIdx >= purchaseQueue.length) {
    plog('★ 구매수 추적 완료');
    purchaseRunning = false;
    sendPurchaseProgress();
    if (appTab) {
      chrome.tabs.sendMessage(appTab, {
        type: 'NAVER_PURCHASE_TRACK_COMPLETE',
        total: purchaseQueue.length,
        done: purchaseQueue.filter(t => t.done).length,
      }).catch(() => {});
    }
    return;
  }
  const target = purchaseQueue[purchaseIdx];
  const detailUrl = `https://search.shopping.naver.com/catalog/${target.nv_mid}`;
  plog(`[${purchaseIdx + 1}/${purchaseQueue.length}] ${target.product_name} (${target.nv_mid})`);
  sendPurchaseProgress();

  try {
    if (purchaseTabId) {
      try {
        await chrome.tabs.get(purchaseTabId);
        await chrome.tabs.update(purchaseTabId, { url: detailUrl, active: true });
      } catch {
        const tab = await chrome.tabs.create({ url: detailUrl, active: true });
        purchaseTabId = tab.id;
      }
    } else {
      const tab = await chrome.tabs.create({ url: detailUrl, active: true });
      purchaseTabId = tab.id;
    }
  } catch (e) {
    plog(`  ⚠ 탭 열기 실패: ${e.message}`);
    target.error = e.message;
    setTimeout(() => visitNextPurchaseTarget(), 1000);
  }

  // 타임아웃: 15초 내 응답 없으면 다음으로
  setTimeout(() => {
    if (!purchaseRunning) return;
    const cur = purchaseQueue[purchaseIdx];
    if (cur && !cur.done && !cur.error) {
      plog(`  ⚠ 타임아웃 → 다음`);
      cur.error = 'timeout';
      onPurchaseData({ nvMid: cur.nv_mid, success: false });
    }
  }, 15000);
}

async function onPurchaseData(data) {
  if (!purchaseRunning || purchaseIdx < 0) return;
  const target = purchaseQueue[purchaseIdx];
  if (!target || target.done) return;
  // nvMid 검증
  if (String(data.nvMid) !== String(target.nv_mid)) return;

  target.done = true;
  if (data.success) {
    plog(`  ✓ 구매수: ${data.purchaseCnt ?? 'N/A'}`);
  } else {
    plog(`  ✗ 추출 실패`);
  }

  // 서버로 전송
  try {
    const body = {
      target_id: target.id,
      purchase_count: data.purchaseCnt ?? null,
      review_count: data.reviewCount ?? null,
      keep_count: data.keepCnt ?? null,
      price: data.price ?? null,
      error: data.success ? '' : (target.error || 'extract_failed'),
    };
    const r = await fetch(`${INTERNAL_API}/ext/purchase-result/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    plog(`  서버 ${r.ok ? 'OK' : '실패 ' + r.status}`);
  } catch (e) {
    plog(`  서버 전송실패: ${e.message}`);
  }

  sendPurchaseProgress();
  // 다음 타겟 (3~5초 딜레이)
  const delay = 3000 + Math.random() * 2000;
  setTimeout(() => visitNextPurchaseTarget(), delay);
}

function stopPurchaseTracking() {
  plog('수집 중지');
  purchaseRunning = false;
  sendPurchaseProgress();
}

function getPurchaseTrackStatus() {
  return {
    running: purchaseRunning,
    total: purchaseQueue.length,
    completed: purchaseIdx >= 0 ? Math.min(purchaseIdx + 1, purchaseQueue.length) : 0,
    current: purchaseIdx >= 0 && purchaseIdx < purchaseQueue.length
      ? purchaseQueue[purchaseIdx].product_name : null,
    logs: purchaseLogs.slice(-30),
  };
}

// 초기화
if (saveMode === 'internal') {
  fetch(`${INTERNAL_API}/keywords/`).then(r => log('Django ' + (r.ok ? 'OK' : r.status))).catch(() => log('Django 연결실패'));
}
log('background.js 로드 (인간 행동 시뮬레이션 모드)');
