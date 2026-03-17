// content-script.js v1.3.0 — 네이버쇼핑 페이지에 주입
// ★ 메시지 재시도 + "만 검색" 자동클릭 + productSet 전달
(function () {
  'use strict';

  console.log('[NaverExt] content-script.js v1.3.0 (ISOLATED world)');

  // ── ★ 메시지 전송 (재시도 포함) ──
  function sendToBackground(data, retries) {
    if (retries === undefined) retries = 2;
    chrome.runtime.sendMessage(data, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[NaverExt] 메시지 실패:', chrome.runtime.lastError.message);
        if (retries > 0) {
          setTimeout(() => sendToBackground(data, retries - 1), 500);
        }
      }
    });
  }

  // ── MAIN world에서 보낸 메시지 수신 → background.js로 전달 ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'NAVER_SHOPPING_RESPONSE') {
      sendToBackground({
        type: 'NAVER_SHOPPING_DATA',
        url: event.data.url,
        productSet: event.data.productSet || 'total',
        query: event.data.query,
        terms: event.data.terms,
        termCount: event.data.termCount,
        total: event.data.total,
        products: event.data.products,
      });
    }
  });

  // ── 탭 클릭 함수 ──
  const TAB_TEXT = {
    total: '전체',
    model: '가격비교',
    checkout: '네이버페이'
  };

  function clickNaverTab(tabKey) {
    const targetText = TAB_TEXT[tabKey];
    if (!targetText) return false;

    console.log(`[NaverExt] 탭 클릭 시도: "${targetText}"`);

    // 전략 1: productSet 필터 영역 내 링크/버튼
    const filterAreas = document.querySelectorAll(
      '[class*="filter"], [class*="tab"], [class*="product_set"], [class*="productSet"], [class*="Filter"], [class*="Tab"]'
    );
    for (const area of filterAreas) {
      const links = area.querySelectorAll('a, button, [role="tab"], li');
      for (const el of links) {
        const text = (el.textContent || '').replace(/[\s,]/g, '');
        if (text.startsWith(targetText)) {
          console.log(`[NaverExt] 탭 발견 (필터영역):`, el.tagName, text.substring(0, 20));
          el.click();
          return true;
        }
      }
    }

    // 전략 2: 상단 영역에서 텍스트 매칭
    const allClickable = document.querySelectorAll('a, button, [role="tab"]');
    for (const el of allClickable) {
      const text = (el.textContent || '').trim();
      if (text.startsWith(targetText) && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.5 && rect.height > 0) {
          console.log(`[NaverExt] 탭 발견 (텍스트):`, el.tagName, text.substring(0, 30));
          el.click();
          return true;
        }
      }
    }

    // 전략 3: li > a 구조 (XPath 기반)
    const tabIndices = { total: 0, model: 1, checkout: 2 };
    const idx = tabIndices[tabKey];
    const tabContainers = document.querySelectorAll('ul');
    for (const ul of tabContainers) {
      const items = ul.querySelectorAll('li');
      if (items.length >= 3 && items.length <= 10) {
        const li = items[idx];
        if (li) {
          const text = (li.textContent || '').trim();
          if (text.includes(targetText) || (idx === 0 && text.includes('전체'))) {
            const link = li.querySelector('a') || li;
            console.log(`[NaverExt] 탭 발견 (li구조):`, text.substring(0, 30));
            link.click();
            return true;
          }
        }
      }
    }

    console.warn(`[NaverExt] 탭 "${targetText}" 찾지 못함`);
    return false;
  }

  // ── "000만 검색하기" 버튼 클릭 ──
  function clickExactSearchButton() {
    const buttons = document.querySelectorAll('a, button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('만 검색') || text.includes('만검색')) {
        console.log(`[NaverExt] "만 검색" 버튼 클릭:`, text);
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ── 가이드 오버레이 ──
  let guideEl = null;

  function showGuide(tabLabel, keyword, kwIdx, kwTotal, tabIdx, tabTotal) {
    hideGuide();
    guideEl = document.createElement('div');
    guideEl.id = 'naver-ext-guide';
    guideEl.innerHTML = `
      <div style="position:fixed;top:0;left:0;right:0;z-index:999999;
        background:linear-gradient(135deg,#03c75a,#02a34a);
        color:#fff;padding:14px 20px;font-family:'Malgun Gothic',sans-serif;
        display:flex;align-items:center;gap:12px;box-shadow:0 4px 20px rgba(0,0,0,0.3);">
        <div style="font-size:24px;">👆</div>
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:800;margin-bottom:2px;">
            「${tabLabel}」 탭을 클릭하세요
          </div>
          <div style="font-size:12px;opacity:0.85;">
            키워드 ${kwIdx}/${kwTotal}: "${keyword}" · 탭 ${tabIdx}/${tabTotal}
          </div>
        </div>
        <div style="font-size:11px;opacity:0.7;text-align:right;">
          Term 분석기<br>수동 클릭 모드
        </div>
      </div>
    `;
    document.body.appendChild(guideEl);
  }

  function hideGuide() {
    if (guideEl) { guideEl.remove(); guideEl = null; }
    const existing = document.getElementById('naver-ext-guide');
    if (existing) existing.remove();
  }

  // ── background.js 명령 수신 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'SHOW_TAB_GUIDE': {
        showGuide(msg.tabLabel, msg.keyword, msg.kwIdx, msg.kwTotal, msg.tabIdx, msg.tabTotal);
        sendResponse({ ok: true });
        break;
      }
      case 'HIDE_TAB_GUIDE': {
        hideGuide();
        sendResponse({ ok: true });
        break;
      }
      case 'CLICK_NAVER_TAB': {
        const clicked = clickNaverTab(msg.tab);
        sendResponse({ success: clicked, tab: msg.tab });
        break;
      }
      case 'CLICK_EXACT_SEARCH': {
        const clicked = clickExactSearchButton();
        sendResponse({ success: clicked });
        break;
      }
      case 'CHECK_PAGE_STATUS': {
        const captchaType = detectCaptcha();
        sendResponse({ captcha: captchaType, url: location.href, ready: document.readyState === 'complete' });
        break;
      }
      case 'CHECK_PAGE_READY': {
        sendResponse({
          ready: document.readyState === 'complete',
          url: location.href,
          hasProducts: !!document.querySelector('[class*="product"], [class*="Product"], [class*="item"], [class*="Item"]')
        });
        break;
      }
    }
    return false;
  });

  // ── CAPTCHA / 봇 탐지 감지 ──
  function detectCaptcha() {
    if (document.querySelector('[class*="captcha"]')) return 'captcha';
    if (document.querySelector('[class*="receipt"]')) return 'receipt';
    return null;
  }

  function checkCaptcha() {
    const captchaType = detectCaptcha();
    if (captchaType) {
      sendToBackground({ type: 'CAPTCHA_DETECTED', captchaType: captchaType, url: location.href });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(checkCaptcha, 1500));
  } else {
    setTimeout(checkCaptcha, 1500);
  }

  // CAPTCHA 해결 감지
  let wasCaptcha = false;
  const observer = new MutationObserver(() => {
    const captchaType = detectCaptcha();
    if (captchaType) {
      wasCaptcha = true;
    } else if (wasCaptcha) {
      wasCaptcha = false;
      sendToBackground({ type: 'CAPTCHA_RESOLVED' });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ── ★ 페이지 로드 완료: "만 검색" 체크 후 PAGE_READY ──
  function handlePageReady() {
    if (clickExactSearchButton()) {
      console.log('[NaverExt] "만 검색" 클릭 → 페이지 업데이트 대기');
      // 리로드면 스크립트 재실행, SPA면 2.5초 후 PAGE_READY
      setTimeout(() => {
        sendToBackground({ type: 'NAVER_PAGE_READY', url: location.href });
      }, 2500);
    } else {
      sendToBackground({ type: 'NAVER_PAGE_READY', url: location.href });
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(handlePageReady, 500);
  } else {
    window.addEventListener('load', () => setTimeout(handlePageReady, 500));
  }
})();
