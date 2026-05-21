// content_app.js — 통합 브릿지 (네이버 Term + 로하스 수집 + 지마켓 순위추적)
// 우리 앱 페이지(localhost, 192.168.219.100)에서 실행
// 프론트엔드 ↔ background.js 메시지 중계

(function () {
  'use strict';

  // ══════════════════════════════════════════
  // 프론트엔드 → 확장프로그램
  // ══════════════════════════════════════════
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.type) return;

    // ── 구매수 추적 ──
    if (msg.type === 'PURCHASE_TRACK_START' || msg.type === 'PURCHASE_TRACK_STOP' || msg.type === 'PURCHASE_TRACK_STATUS') {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) return;
        window.postMessage({ type: msg.type + '_RESPONSE', data: response }, '*');
      });
      return;
    }

    // ── 네이버 Term ──
    switch (msg.type) {
      case 'NAVER_START_TERM_SEARCH':
      case 'NAVER_START_RANK_TRACKING':
      case 'NAVER_CANCEL':
      case 'NAVER_GET_STATUS':
      case 'NAVER_SET_SCHEDULE':
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) return;
          window.postMessage({
            type: msg.type + '_RESPONSE',
            data: response
          }, '*');
        });
        return;

      case 'NAVER_PING':
        window.postMessage({
          type: 'NAVER_PONG',
          data: { connected: true, version: chrome.runtime.getManifest().version }
        }, '*');
        return;
    }

    // ── 로하스 수집 ──
    if (msg.type === 'LOHAS_EXT_PING') {
      const ver = chrome.runtime.getManifest().version;
      window.postMessage({ type: 'LOHAS_EXT_PONG', version: ver }, '*');
      return;
    }

    if (msg.type === 'LOHAS_CRAWL_START') {
      chrome.runtime.sendMessage({
        action: 'startCrawl',
        lcpGroups: msg.lcpGroups,
        apiBase: msg.apiBase,
      });
      return;
    }

    if (msg.type === 'LOHAS_KW_CRAWL_START') {
      chrome.runtime.sendMessage({
        action: 'startKeywordCrawl',
        lcpCodes: msg.lcpCodes,
        apiBase: msg.apiBase,
      });
      return;
    }

    if (msg.type === 'LOHAS_CRAWL_CANCEL') {
      chrome.runtime.sendMessage({ action: 'cancelCrawl' });
      return;
    }

    if (msg.type === 'LOHAS_OPEN_OTHER_MONITOR') {
      window.postMessage({ type: 'LOHAS_OPEN_ACK' }, '*');
      chrome.runtime.sendMessage({
        action: 'openOnOtherMonitor',
        url: msg.url,
        width: msg.width || 1400,
        height: msg.height || 900,
      });
      return;
    }

    // ── 지마켓 순위추적 ──
    if (msg.type === 'GMARKET_SEARCH') {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage({
            type: 'GMARKET_SEARCH_ERROR',
            message: '확장프로그램 연결 실패: ' + chrome.runtime.lastError.message,
          }, '*');
          return;
        }
        if (response?.ok) {
          window.postMessage({ type: 'GMARKET_SEARCH_ACK' }, '*');
        }
      });
      return;
    }

    if (msg.type === 'GMARKET_PING') {
      chrome.runtime.sendMessage({ type: 'GMARKET_PING' }, (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ type: 'GMARKET_PONG', ok: false }, '*');
        } else {
          window.postMessage({ type: 'GMARKET_PONG', ok: true }, '*');
        }
      });
      return;
    }
  });

  // ══════════════════════════════════════════
  // 확장프로그램 → 프론트엔드
  // ══════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    // 네이버
    if (msg.type.startsWith('NAVER_')) {
      window.postMessage(msg, '*');
      return;
    }

    // 구매수 추적
    if (msg.type.startsWith('PURCHASE_') || msg.type === 'NAVER_PURCHASE_TRACK_PROGRESS' || msg.type === 'NAVER_PURCHASE_TRACK_COMPLETE') {
      window.postMessage(msg, '*');
      return;
    }

    // 로하스
    if (msg.type.startsWith('LOHAS_')) {
      window.postMessage(msg, '*');
      return;
    }

    // 지마켓
    if (msg.type.startsWith('GMARKET_')) {
      window.postMessage(msg, '*');
      return;
    }
  });
})();
