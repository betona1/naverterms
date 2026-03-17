// content-script.js v1.4.0 — ISOLATED world
// ★ 메시지 재시도 + "만 검색" + productSet 전달
(function () {
  'use strict';

  console.log('[NaverExt] content-script.js v1.4.0');

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

  // ── MAIN world → background 전달 ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'NAVER_SHOPPING_RESPONSE') {
      console.log('[NaverExt] 데이터 전달:', event.data.productSet, (event.data.products||[]).length, '개');
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

  // ── "만 검색" 버튼 클릭 ──
  function clickExactSearchButton() {
    const buttons = document.querySelectorAll('a, button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('만 검색') || text.includes('만검색')) {
        console.log('[NaverExt] "만 검색" 버튼 클릭:', text);
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ── CAPTCHA 감지 ──
  function detectCaptcha() {
    if (document.querySelector('[class*="captcha"]')) return 'captcha';
    if (document.querySelector('[class*="receipt"]')) return 'receipt';
    return null;
  }

  function checkCaptcha() {
    const captchaType = detectCaptcha();
    if (captchaType) {
      sendToBackground({ type: 'CAPTCHA_DETECTED', captchaType, url: location.href });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(checkCaptcha, 1500));
  } else {
    setTimeout(checkCaptcha, 1500);
  }

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

  // ── 페이지 로드 완료 ──
  function handlePageReady() {
    if (clickExactSearchButton()) {
      console.log('[NaverExt] "만 검색" 클릭 → 대기');
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
