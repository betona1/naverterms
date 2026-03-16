// injected.js v1.5.0 — MAIN world
// __NEXT_DATA__ 초기 추출 + fetch/XHR 캡처
// ★ 탭 변경 시 폴링 재시작 제거 (stale 데이터 방지)
(function () {
  'use strict';

  let lastCaptureKey = '';
  let capturedCount = 0;
  let polling = false;

  function sendData(url, sr) {
    if (!sr || !sr.products || sr.products.length === 0) return;

    const key = `${sr.query || ''}_${url}_${sr.products.length}`;
    if (key === lastCaptureKey) return;
    lastCaptureKey = key;

    capturedCount++;
    console.log(`[NaverExt] ★ #${capturedCount}: "${sr.query}" ${sr.products.length}개 total=${sr.total} terms=[${(sr.terms || []).join(',')}]`);

    window.postMessage({
      type: 'NAVER_SHOPPING_RESPONSE',
      url: url,
      query: sr.query || '',
      terms: sr.terms || [],
      termCount: sr.termCount || 0,
      total: sr.total || 0,
      products: sr.products,
    }, '*');
  }

  function findProducts(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    if (obj.shoppingResult && Array.isArray(obj.shoppingResult.products)) return obj.shoppingResult;
    if (Array.isArray(obj.products) && obj.products.length > 0) {
      const f = obj.products[0];
      if (f && (f.productName || f.productTitle || f.mallName)) return obj;
    }
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) {
      if (v && typeof v === 'object') {
        const r = findProducts(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // ── __NEXT_DATA__ 추출 (초기 페이지 로드 전용) ──
  function extractFromPage() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return false;

      const data = JSON.parse(el.textContent);
      const pp = data?.props?.pageProps;
      if (!pp) return false;

      const targets = [pp.initialState, pp.dehydratedState, pp.compositeList, pp];
      for (const t of targets) {
        if (!t) continue;
        const sr = findProducts(t, 0);
        if (sr) { sendData(location.href, sr); return true; }
        if (t.queries) {
          for (const q of t.queries) {
            const sr2 = findProducts(q?.state?.data, 0);
            if (sr2) { sendData(location.href, sr2); return true; }
          }
        }
      }
    } catch (e) {}
    return false;
  }

  // ── 폴링: 초기 페이지 로드 전용 ──
  function startPolling() {
    if (polling) return;
    polling = true;
    let attempts = 0;

    function poll() {
      attempts++;
      if (extractFromPage()) {
        console.log(`[NaverExt] 추출 성공 (${attempts}회)`);
        polling = false;
        return;
      }
      if (attempts < 30) {
        setTimeout(poll, 500);
      } else {
        console.log('[NaverExt] 추출 타임아웃');
        polling = false;
      }
    }
    poll();
  }

  // ── URL 변경 감지 ──
  let lastUrl = location.href;

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (!location.href.includes('search.shopping.naver.com')) return;

    console.log('[NaverExt] URL 변경:', location.href.substring(0, 100));
    lastCaptureKey = '';  // 리셋 → 새 캡처 허용
    // ★ 폴링 재시작 안함 — fetch/XHR hook이 SPA 데이터 캡처
  }

  const origPush = history.pushState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    setTimeout(onUrlChange, 100);
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    setTimeout(onUrlChange, 100);
  };
  window.addEventListener('popstate', () => setTimeout(onUrlChange, 100));
  setInterval(onUrlChange, 1000);

  // ── 초기 페이지 로드만 폴링 ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(startPolling, 200));
  } else {
    setTimeout(startPolling, 200);
  }

  // ── fetch 가로채기 ──
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(response => {
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('/search') && url.includes('query=') && response.status === 200) {
          response.clone().json().then(data => {
            const sr = findProducts(data, 0);
            if (sr) {
              console.log('[NaverExt] fetch:', url.substring(0, 100));
              sendData(url, sr);
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    });
  };

  // ── XHR 가로채기 ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._naverUrl = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._naverUrl || '';
        if (url.includes('/search') && url.includes('query=') && this.status === 200) {
          const data = JSON.parse(this.responseText);
          const sr = findProducts(data, 0);
          if (sr) {
            console.log('[NaverExt] XHR:', url.substring(0, 80));
            sendData(url, sr);
          }
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  console.log('[NaverExt] injected.js v1.5.0');
})();
