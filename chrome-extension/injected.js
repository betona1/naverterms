// injected.js v3.0.26 — MAIN world
// __NEXT_DATA__ + fetch/XHR 훅 (스텔스) → window.postMessage로 content-script 전달
// + 상세페이지 purchaseCnt 추출 (구매수 추적)
(function () {
  'use strict';

  const TAG = '__nd';
  const PTAG = '__nd_purchase';
  const TRACE = '__ndt';
  let sent = {};
  const DEBUG = false; // 메모리 절약 — 문제 진단 시에만 true
  const dlog = (...a) => {
    if (DEBUG) console.log('[n]', ...a);
    try { window.postMessage({ [TRACE]: true, msg: a.map(x => typeof x === 'object' ? JSON.stringify(x).slice(0, 80) : String(x)).join(' ') }, '*'); } catch (e) {}
  };

  // terms 배열을 트리 어디든지 찾아서 반환 (본체/거치대 같은 분해 term들)
  function findTerms(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return null;
    if (Array.isArray(obj.terms) && obj.terms.length > 0 && typeof obj.terms[0] === 'string') {
      return { terms: obj.terms.slice(), termCount: obj.termCount || obj.terms.length };
    }
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) {
      if (v && typeof v === 'object') {
        const r = findTerms(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function findProducts(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return null;
    // shoppingResult: products 가 실제로 있을 때만 채택
    if (obj.shoppingResult && Array.isArray(obj.shoppingResult.products) && obj.shoppingResult.products.length > 0) {
      return obj.shoppingResult;
    }
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

  // 풀 데이터 판별: 스토어정보 + 상세필드 중 1개 이상 (stub 저장 방지)
  // mallName 단독은 stub 으로 간주 — XHR 풀데이터 대기
  function isRichProduct(p) {
    if (!p || typeof p !== 'object') return false;
    const hasStore = Boolean(p.mallName) || (Array.isArray(p.lowMallList) && p.lowMallList.length > 0);
    if (!hasStore) return false;
    const hasDetail = Boolean(
      p.manuTag ||
      p.attributeValue ||
      p.characterValue ||
      (p.reviewCount != null && Number(p.reviewCount) > 0) ||
      p.openDate ||
      p.scoreInfo != null ||
      p.brand || p.maker
    );
    return hasDetail;
  }

  // 첫 상품 전체 JSON을 콘솔에 덤프 (진단용 — F12에서 복사해서 보내주세요)
  let dumped = false;
  function dumpProduct(p, productSet) {
    if (dumped) return;
    dumped = true;
    try {
      console.log(`%c[n] 첫상품 덤프 [${productSet}]`, 'color:#03c75a;font-weight:bold');
      console.log(JSON.parse(JSON.stringify(p))); // deep clone so it's inspectable
    } catch (e) {}
  }

  function send(sr, sourceUrl, rootData) {
    if (!sr || !sr.products || !sr.products.length) return false;
    const urlForMatch = sourceUrl || location.href;
    const m = urlForMatch.match(/[?&]productSet=(\w+)/);
    const productSet = m ? m[1] : 'total';

    // 풀 데이터(스토어명 등 포함)만 전송 — 간소화 stub은 스킵하고 XHR 대기
    const p0 = sr.products[0];
    const rich = isRichProduct(p0);
    if (!rich) {
      dlog('예비데이터 무시(상세정보 대기중)');
      return false;
    }

    const key = `${sr.query || ''}_${productSet}_${sr.products.length}`;
    if (sent[productSet] === key) { return false; }
    sent[productSet] = key;

    // terms 보강: sr에 없으면 root 데이터 전체에서 찾아봄
    let terms = sr.terms || [];
    let termCount = sr.termCount || 0;
    if (!terms.length && rootData) {
      const tr = findTerms(rootData, 0);
      if (tr) { terms = tr.terms; termCount = tr.termCount; }
    }

    const store = p0.mallName || (p0.lowMallList && p0.lowMallList[0] && p0.lowMallList[0].name) || '?';
    const tabName = { total: '전체', model: '가격비교', checkout: '네이버페이' }[productSet] || productSet;
    dlog(`★ [${tabName}] 상품 ${sr.products.length}개 · term ${terms.length}개 · 스토어 ${store}`);
    dumpProduct(p0, productSet);

    window.postMessage({
      [TAG]: true,
      url: sourceUrl || location.href,
      productSet,
      query: sr.query || '',
      terms,
      termCount,
      total: sr.total || 0,
      products: sr.products,
    }, '*');
    return true;
  }

  // ══════════════════════════════════════════
  // 상세페이지 구매수 추출 (catalog/products)
  // ══════════════════════════════════════════
  function isDetailPage() {
    return /\/(catalog|products)\/\d+/.test(location.pathname);
  }

  function findPurchaseData(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 15) return null;
    if (typeof obj === 'object' && !Array.isArray(obj) && 'purchaseCnt' in obj) {
      const pc = obj.purchaseCnt;
      return {
        purchaseCnt: typeof pc === 'string' ? (parseInt(pc, 10) || 0) : (pc || 0),
        reviewCount: Number(obj.reviewCount || obj.totalReviewCount || obj.reviewCountSum || 0) || null,
        keepCnt: Number(obj.keepCnt || obj.keepCount || 0) || null,
        price: Number(obj.price || obj.lowPrice || obj.salePrice || 0) || null,
      };
    }
    const vals = Array.isArray(obj) ? obj : Object.values(obj);
    for (const v of vals) {
      if (v && typeof v === 'object') {
        const r = findPurchaseData(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  let purchaseSent = false;
  function extractDetailPage() {
    if (purchaseSent) return true;
    const next = document.getElementById('__NEXT_DATA__');
    if (!next) return false;
    try {
      const data = JSON.parse(next.textContent);
      const result = findPurchaseData(data, 0);
      const nvMid = location.pathname.split('/').pop();
      dlog('상세페이지 purchaseCnt 추출:', nvMid, result ? result.purchaseCnt : 'null');
      purchaseSent = true;
      window.postMessage({
        [PTAG]: true,
        nvMid: nvMid,
        purchaseCnt: result ? result.purchaseCnt : null,
        reviewCount: result ? result.reviewCount : null,
        keepCnt: result ? result.keepCnt : null,
        price: result ? result.price : null,
        success: result != null,
      }, '*');
      return true;
    } catch (e) {
      dlog('상세페이지 파싱 오류:', e.message);
    }
    return false;
  }

  // 추출: __NEXT_DATA__ + 모든 inline script JSON. 풀 데이터 sent 시만 true
  function extract() {
    // 상세페이지(catalog/products)면 purchaseCnt 전용 추출
    if (isDetailPage()) return extractDetailPage();
    // 1) __NEXT_DATA__
    const next = document.getElementById('__NEXT_DATA__');
    if (next) {
      try {
        const data = JSON.parse(next.textContent);
        const sr = findProducts(data, 0);
        if (sr && send(sr, null, data)) return true;
      } catch (e) {}
    }

    // 2) 모든 script 태그 안의 큰 JSON
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent;
      if (!txt || txt.length < 200) continue;
      const trimmed = txt.trim();
      if (trimmed[0] !== '{' && trimmed[0] !== '[') continue;
      try {
        const data = JSON.parse(trimmed);
        const sr = findProducts(data, 0);
        if (sr && send(sr, null, data)) return true;
      } catch (e) {}
    }

    // 3) 전역 변수
    const globals = ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__'];
    for (const g of globals) {
      if (window[g] && typeof window[g] === 'object') {
        const sr = findProducts(window[g], 0);
        if (sr && send(sr, null, window[g])) return true;
      }
    }

    return false;
  }

  let polling = false;
  function startPolling() {
    if (polling) return;
    polling = true;
    sent = {};
    purchaseSent = false;
    let attempts = 0;
    dlog('폴링 시작');
    (function poll() {
      attempts++;
      if (extract()) { dlog('추출 성공 (' + attempts + '회)'); polling = false; return; }
      if (attempts < 30) setTimeout(poll, 400 + Math.random() * 300);
      else { dlog('폴링 타임아웃 (fetch훅 대기)'); polling = false; }
    })();
  }

  function init() { setTimeout(startPolling, 200 + Math.random() * 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // SPA 네비 감지
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function () { const r = origPush.apply(this, arguments); setTimeout(startPolling, 500); return r; };
  history.replaceState = function () { const r = origReplace.apply(this, arguments); setTimeout(startPolling, 500); return r; };
  window.addEventListener('popstate', () => setTimeout(startPolling, 500));

  // ══════════════════════════════════════════
  // fetch 훅 (Proxy + toString 위장)
  // ══════════════════════════════════════════
  const origFetch = window.fetch;
  let fetchSeq = 0;
  const fetchProxy = new Proxy(origFetch, {
    apply(target, thisArg, args) {
      const promise = Reflect.apply(target, thisArg, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (!u) return promise;
        fetchSeq++;
        // fetch 원문은 console 에만 (진단용), 바로는 보내지 않음
        if (DEBUG && (u.includes('naver') || u.includes('/search') || u.startsWith('/'))) {
          const short = u.length > 100 ? u.slice(0, 100) + '…' : u;
          console.log('[n] fetch#' + fetchSeq + ':', short);
        }
        // 캡처 시도 — JSON 응답이면 무조건 findProducts 돌려봄
        promise.then(res => {
          if (!res || !res.ok) return;
          const ct = res.headers.get('content-type') || '';
          if (!ct.includes('json')) return;
          res.clone().json().then(data => {
            const sr = findProducts(data, 0);
            if (sr) send(sr, u.includes('productSet=') ? u : location.href, data);
          }).catch(() => {});
        }).catch(() => {});
      } catch (e) {}
      return promise;
    },
  });
  // toString 네이티브 위장
  const nativeToString = Function.prototype.toString;
  const origFetchStr = nativeToString.call(origFetch);
  Function.prototype.toString = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (thisArg === fetchProxy) return origFetchStr;
      return Reflect.apply(target, thisArg, args);
    },
  });
  window.fetch = fetchProxy;

  // ══════════════════════════════════════════
  // XHR 훅
  // ══════════════════════════════════════════
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__u = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const self = this;
    this.addEventListener('load', function () {
      try {
        const u = self.__u || '';
        if (self.status !== 200) return;
        if (DEBUG && u.includes('naver')) console.log('[n] XHR:', u.slice(0, 100));
        // content-type 확인
        const ct = (self.getResponseHeader && self.getResponseHeader('content-type')) || '';
        if (!ct.includes('json')) return;
        const data = JSON.parse(self.responseText);
        const sr = findProducts(data, 0);
        if (sr) { dlog('★ XHR 캡처:', sr.products.length); send(sr, u.includes('productSet=') ? u : location.href); }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
