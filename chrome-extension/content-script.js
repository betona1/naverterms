// content-script.js v2.0.0 — ISOLATED world
// CAPTCHA 감지 강화 + 메시지 재시도
(function () {
  'use strict';

  console.log('[NaverExt] content-script.js v2.0.0');

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
      console.log('[NaverExt] 데이터 전달:', event.data.productSet, (event.data.products || []).length, '개');
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

  // ── CAPTCHA 감지 (강화) ──
  function detectCaptcha() {
    if (document.querySelector('[class*="captcha"]')) return 'captcha_class';
    if (document.querySelector('[class*="receipt"]')) return 'receipt';
    if (document.querySelector('script[src*="wtm_captcha"]')) return 'wtm_captcha';
    if (document.querySelector('script[src*="ncpt.naver.com"]')) return 'ncpt_captcha';
    if (document.title?.toLowerCase().includes('captcha')) return 'title_captcha';
    const body = document.body?.textContent || '';
    if (body.includes('비정상적인 접근') || body.includes('접속이 일시적으로 제한')) return 'block_text';
    return null;
  }

  function checkCaptcha() {
    const captchaType = detectCaptcha();
    if (captchaType) {
      console.log('[NaverExt] CAPTCHA 감지:', captchaType);
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
      if (!wasCaptcha) {
        wasCaptcha = true;
        sendToBackground({ type: 'CAPTCHA_DETECTED', captchaType, url: location.href });
      }
    } else if (wasCaptcha) {
      wasCaptcha = false;
      sendToBackground({ type: 'CAPTCHA_RESOLVED' });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ── 페이지 로드 완료 ──
  function handlePageReady() {
    sendToBackground({ type: 'NAVER_PAGE_READY', url: location.href });
  }

  if (document.readyState === 'complete') {
    setTimeout(handlePageReady, 500);
  } else {
    window.addEventListener('load', () => setTimeout(handlePageReady, 500));
  }
})();
