// bg_gmarket.js — 지마켓 순위추적 (서비스 워커 모듈)
// importScripts()로 background.js에서 로드됨

const GMARKET_API_URLS = [
  'http://localhost:8001/api/cpc/gmarket-rank/ext-search/',
  'http://192.168.219.100:8001/api/cpc/gmarket-rank/ext-search/',
];

let _gmarketSenderTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GMARKET_SEARCH' && msg.keywords) {
    _gmarketSenderTabId = sender.tab?.id || null;
    sendResponse({ ok: true });
    gmarketProcessKeywords(msg.keywords);
    return false;
  }
  if (msg.type === 'GMARKET_PING') {
    sendResponse({ ok: true });
    return false;
  }
});

async function gmarketProcessKeywords(keywords) {
  gmarketSendToContent({ type: 'GMARKET_SEARCH_LOG', message: `확장: ${keywords.length}개 키워드 검색 시작` });

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    gmarketSendToContent({
      type: 'GMARKET_SEARCH_LOG',
      message: `[${i + 1}/${keywords.length}] "${kw.keyword}" 검색 중...`,
    });

    try {
      const result = await gmarketSearchOneKeyword(kw);
      gmarketSendToContent({
        type: 'GMARKET_SEARCH_RESULT',
        keyword_id: kw.id,
        data: result,
      });
      gmarketSendToContent({
        type: 'GMARKET_SEARCH_LOG',
        message: `[${i + 1}/${keywords.length}] "${kw.keyword}" 완료 — ${result.found?.length || 0}개 발견`,
      });
    } catch (err) {
      gmarketSendToContent({
        type: 'GMARKET_SEARCH_ERROR',
        keyword_id: kw.id,
        message: `"${kw.keyword}" 오류: ${err.message}`,
      });
      gmarketSendToContent({
        type: 'GMARKET_SEARCH_LOG',
        message: `[${i + 1}/${keywords.length}] "${kw.keyword}" 오류: ${err.message}`,
      });
    }

    // 키워드 간 1초 대기
    if (i < keywords.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  gmarketSendToContent({ type: 'GMARKET_SEARCH_DONE', total: keywords.length });
}

async function gmarketSearchOneKeyword(kw) {
  const url = `https://www.gmarket.co.kr/n/search?keyword=${encodeURIComponent(kw.keyword)}`;
  let tabId = null;

  try {
    // 백그라운드 탭 생성
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;

    // 페이지 로드 완료 대기
    await gmarketWaitForTabLoad(tabId, 15000);

    // 스크립트 주입: Cloudflare 대기 + DOM 로딩 + 스크롤 + HTML 추출
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: gmarketExtractPageHtml,
    });

    const html = result?.result;
    if (!html) throw new Error('HTML 추출 실패');

    // 탭 닫기
    await chrome.tabs.remove(tabId).catch(() => {});
    tabId = null;

    // 백엔드로 HTML 전송
    const apiResult = await gmarketPostToBackend(kw.id, html);
    return apiResult;
  } finally {
    if (tabId) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// 탭에 주입되어 실행될 함수
function gmarketExtractPageHtml() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const MAX_WAIT = 15000;

    function check() {
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_WAIT) {
        resolve(document.documentElement.outerHTML);
        return;
      }

      // Cloudflare 체크
      if (document.title.includes('Just a moment') || document.title.includes('Checking')) {
        setTimeout(check, 500);
        return;
      }

      // 상품 카드 DOM 로딩 대기
      const cards = document.querySelectorAll('div.box__component-itemcard');
      if (cards.length < 3) {
        setTimeout(check, 500);
        return;
      }

      // 스크롤로 lazy loading 트리거
      doScrolls().then(() => {
        resolve(document.documentElement.outerHTML);
      });
    }

    async function doScrolls() {
      const totalHeight = document.body.scrollHeight;
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, (totalHeight * i) / steps);
        await new Promise(r => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 500));
    }

    check();
  });
}

function gmarketWaitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function gmarketPostToBackend(keywordId, html) {
  let lastError = null;
  for (const apiUrl of GMARKET_API_URLS) {
    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword_id: keywordId, html }),
      });
      if (resp.ok) {
        return await resp.json();
      }
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('백엔드 연결 실패');
}

function gmarketSendToContent(msg) {
  if (_gmarketSenderTabId) {
    chrome.tabs.sendMessage(_gmarketSenderTabId, msg).catch(() => {});
  }
}
