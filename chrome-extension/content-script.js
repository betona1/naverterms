// content-script.js v1.2.0 — 네이버쇼핑 페이지에 주입
// 역할: injected.js 삽입 + 탭 클릭 제어 + CAPTCHA 감지
(function () {
  'use strict';

  console.log('[NaverExt v1.4] content-script.js 로드 (ISOLATED world)');
  // injected.js는 manifest.json에서 world:"MAIN"으로 직접 로드됨 (CSP 우회)

  // ── MAIN world에서 보낸 메시지 수신 → background.js로 전달 ──
  // injected.js가 shoppingResult에서 추출한 데이터를 직접 전달
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'NAVER_SHOPPING_RESPONSE') {
      chrome.runtime.sendMessage({
        type: 'NAVER_SHOPPING_DATA',
        url: event.data.url,
        query: event.data.query,
        terms: event.data.terms,
        termCount: event.data.termCount,
        total: event.data.total,
        products: event.data.products,
      });
    }
  });

  // ── 탭 클릭 함수 ──
  // 원본 betonaTerms2.py XPath: //*[@id="content"]/div[1]/div[1]/ul/li[N]/a
  // li[1]=전체, li[2]=가격비교, li[3]=네이버페이
  const TAB_TEXT = {
    total: '전체',
    model: '가격비교',
    checkout: '네이버페이'
  };

  function clickNaverTab(tabKey) {
    const targetText = TAB_TEXT[tabKey];
    if (!targetText) return false;

    console.log(`[NaverExt v1.4] 탭 클릭 시도: "${targetText}"`);

    // 전략 1: productSet 필터 영역 내 링크/버튼
    const filterAreas = document.querySelectorAll(
      '[class*="filter"], [class*="tab"], [class*="product_set"], [class*="productSet"], [class*="Filter"], [class*="Tab"]'
    );
    for (const area of filterAreas) {
      const links = area.querySelectorAll('a, button, [role="tab"], li');
      for (const el of links) {
        const text = (el.textContent || '').replace(/[\s,]/g, '');
        if (text.startsWith(targetText)) {
          console.log(`[NaverExt v1.4] 탭 발견 (필터영역):`, el.tagName, text.substring(0, 20));
          el.click();
          return true;
        }
      }
    }

    // 전략 2: 상단 영역 (헤더 아래) 에서 텍스트 매칭
    const allClickable = document.querySelectorAll('a, button, [role="tab"]');
    for (const el of allClickable) {
      const text = (el.textContent || '').trim();
      // "전체 73,065" 또는 "가격비교 1,234" 형태
      if (text.startsWith(targetText) && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.5 && rect.height > 0) {
          console.log(`[NaverExt v1.4] 탭 발견 (텍스트):`, el.tagName, text.substring(0, 30));
          el.click();
          return true;
        }
      }
    }

    // 전략 3: li > a 구조 (원본 betonaTerms2.py XPath 기반)
    // //*[@id="content"]/div[1]/div[1]/ul/li[1~3]/a
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
            console.log(`[NaverExt v1.4] 탭 발견 (li구조):`, text.substring(0, 30));
            link.click();
            return true;
          }
        }
      }
    }

    console.warn(`[NaverExt v1.4] 탭 "${targetText}" 찾지 못함`);
    return false;
  }

  // ── "000만 검색하기" 버튼 자동 클릭 ──
  // 원본 XPath: //*[@id="container"]/div/div[1]/div/a/em
  function clickExactSearchButton() {
    const buttons = document.querySelectorAll('a, button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('만 검색') || text.includes('만검색')) {
        console.log(`[NaverExt v1.4] "만 검색" 버튼 클릭:`, text);
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
    if (guideEl) {
      guideEl.remove();
      guideEl = null;
    }
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
        sendResponse({
          captcha: captchaType,
          url: location.href,
          ready: document.readyState === 'complete'
        });
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
    if (location.href.includes('nid.naver.com')) return '2fa';
    return null;
  }

  function checkCaptcha() {
    const captchaType = detectCaptcha();
    if (captchaType) {
      chrome.runtime.sendMessage({
        type: 'CAPTCHA_DETECTED',
        captchaType: captchaType,
        url: location.href
      });
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
      chrome.runtime.sendMessage({ type: 'CAPTCHA_RESOLVED' });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 페이지 로드 완료 알림
  function notifyReady() {
    chrome.runtime.sendMessage({ type: 'NAVER_PAGE_READY', url: location.href });
  }

  if (document.readyState === 'complete') {
    setTimeout(notifyReady, 500);
  } else {
    window.addEventListener('load', () => setTimeout(notifyReady, 500));
  }
})();
