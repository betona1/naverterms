// injected.js v1.7.0 — MAIN world
// ★ fetch/XHR 가로채기 로깅 강화 + __NEXT_DATA__ 개선
(function () {
  'use strict';

  let captured = {};   // productSet별 중복키
  let capturedCount = 0;

  function getProductSet(url) {
    const m = url.match(/[?&]productSet=(\w+)/);
    return m ? m[1] : 'total';
  }

  function sendData(url, sr) {
    if (!sr || !sr.products || sr.products.length === 0) return;

    const productSet = getProductSet(url);
    const key = `${sr.query || ''}_${productSet}_${sr.products.length}`;
    if (captured[productSet] === key) {
      console.log(`[NaverExt] 중복 스킵: [${productSet}]`);
      return;
    }
    captured[productSet] = key;

    capturedCount++;
    console.log(`[NaverExt] ★ #${capturedCount}: "${sr.query}" [${productSet}] ${sr.products.length}개 total=${sr.total}`);

    // 상품 필드 확인 로그
    if (sr.products[0]) {
      const p = sr.products[0];
      console.log(`[NaverExt] 상품필드: mallName=${!!p.mallName} manuTag=${!!p.manuTag} attrVal=${!!p.attributeValue}`);
    }

    window.postMessage({
      type: 'NAVER_SHOPPING_RESPONSE',
      url: url,
      productSet: productSet,
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

  // ── "000만 검색하기" 버튼 ──
  function clickExactSearchButton() {
    const buttons = document.querySelectorAll('a, button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('만 검색') || text.includes('만검색')) {
        console.log(`[NaverExt] "만 검색" 자동클릭:`, text);
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ── __NEXT_DATA__ 추출 ──
  function extractFromPage() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) {
        console.log('[NaverExt] __NEXT_DATA__ 없음');
        return false;
      }

      const data = JSON.parse(el.textContent);
      const pp = data?.props?.pageProps;
      if (!pp) {
        console.log('[NaverExt] pageProps 없음, 키:', Object.keys(data?.props || {}).join(','));
        return false;
      }

      console.log('[NaverExt] pageProps 키:', Object.keys(pp).slice(0, 8).join(','));

      // 다양한 경로 탐색
      const targets = [pp.initialState, pp.dehydratedState, pp.compositeList, pp, data?.props];
      for (const t of targets) {
        if (!t) continue;
        const sr = findProducts(t, 0);
        if (sr) {
          console.log('[NaverExt] __NEXT_DATA__ 추출 성공');
          sendData(location.href, sr);
          return true;
        }
        if (t.queries) {
          for (const q of t.queries) {
            const sr2 = findProducts(q?.state?.data, 0);
            if (sr2) {
              console.log('[NaverExt] __NEXT_DATA__ queries 추출 성공');
              sendData(location.href, sr2);
              return true;
            }
          }
        }
      }
      console.log('[NaverExt] __NEXT_DATA__ 에서 상품 못찾음');
    } catch (e) {
      console.error('[NaverExt] __NEXT_DATA__ 파싱 오류:', e.message);
    }
    return false;
  }

  // ── 폴링: 페이지 로드 후 __NEXT_DATA__ 추출 ──
  let polling = false;
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
      if (attempts < 20) {
        setTimeout(poll, 500);
      } else {
        console.log('[NaverExt] __NEXT_DATA__ 추출 타임아웃 — fetch hook 대기');
        polling = false;
      }
    }
    poll();
  }

  // ── 초기 페이지 ──
  function initPage() {
    if (clickExactSearchButton()) {
      setTimeout(startPolling, 3000);
    } else {
      setTimeout(startPolling, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }

  // ── ★ fetch 가로채기 (로깅 강화) ──
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then(response => {
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        // 넓은 패턴 매칭
        const isSearch = (url.includes('/search') || url.includes('shopping.naver.com')) && url.includes('query=');
        const isNextData = url.includes('/_next/data/');

        if ((isSearch || isNextData) && response.status === 200) {
          console.log('[NaverExt] fetch 감지:', url.substring(0, 120));
          response.clone().json().then(data => {
            const sr = findProducts(data, 0);
            if (sr) {
              console.log('[NaverExt] fetch 상품 발견:', sr.products.length, '개');
              // _next/data 응답은 pageProps 안에 있을 수 있음
              sendData(url.includes('productSet=') ? url : location.href, sr);
            } else {
              console.log('[NaverExt] fetch 응답에서 상품 못찾음');
            }
          }).catch(e => {
            console.log('[NaverExt] fetch JSON 파싱 실패:', e.message);
          });
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
        const isSearch = (url.includes('/search') || url.includes('shopping.naver.com')) && url.includes('query=');
        if (isSearch && this.status === 200) {
          console.log('[NaverExt] XHR 감지:', url.substring(0, 100));
          const data = JSON.parse(this.responseText);
          const sr = findProducts(data, 0);
          if (sr) {
            console.log('[NaverExt] XHR 상품 발견:', sr.products.length, '개');
            sendData(url.includes('productSet=') ? url : location.href, sr);
          }
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  console.log('[NaverExt] injected.js v1.7.0');
})();
