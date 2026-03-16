// content_app_naver.js — React 웹앱 페이지에 주입 (통신 브릿지)
(function () {
  'use strict';

  // ── React → Extension 통신 ──
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'NAVER_START_TERM_SEARCH':
      case 'NAVER_START_RANK_TRACKING':
      case 'NAVER_CANCEL':
      case 'NAVER_GET_STATUS':
      case 'NAVER_SET_SCHEDULE':
        chrome.runtime.sendMessage(msg, (response) => {
          window.postMessage({
            type: msg.type + '_RESPONSE',
            data: response
          }, '*');
        });
        break;

      case 'NAVER_PING':
        // 확장프로그램 연결 확인
        window.postMessage({
          type: 'NAVER_PONG',
          data: { connected: true, version: chrome.runtime.getManifest().version }
        }, '*');
        break;
    }
  });

  // ── Extension → React 통신 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'NAVER_TRACKING_PROGRESS':
      case 'NAVER_TAB_COMPLETE':
      case 'NAVER_SEARCH_COMPLETE':
      case 'NAVER_RANK_COMPLETE':
      case 'NAVER_CAPTCHA_ALERT':
      case 'NAVER_ERROR':
      case 'NAVER_QUEUE_STATUS':
        window.postMessage(msg, '*');
        break;
    }
  });
})();
