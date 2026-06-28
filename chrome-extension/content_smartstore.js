// content_smartstore.js — 스마트스토어 상품 페이지 재고 수집
(function () {
  'use strict';

  if (!location.href.match(/smartstore\.naver\.com\/[^/]+\/products\/\d+/)) return;

  function extractFromNextData() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent);
      return data;
    } catch (e) {
      return null;
    }
  }

  function findRecursive(obj, key, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 15 || !obj) return undefined;
    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const r = findRecursive(item, key, depth + 1);
          if (r !== undefined) return r;
        }
      } else {
        if (key in obj) return obj[key];
        for (const v of Object.values(obj)) {
          const r = findRecursive(v, key, depth + 1);
          if (r !== undefined) return r;
        }
      }
    }
    return undefined;
  }

  function parseProductData(nextData) {
    const result = { productName: '', price: null, options: [] };

    // 상품명
    const name = findRecursive(nextData, 'name');
    if (name && typeof name === 'string' && name.length > 2) result.productName = name;

    // 가격
    for (const key of ['salePrice', 'price', 'discountedSalePrice']) {
      const val = findRecursive(nextData, key);
      if (val && typeof val === 'number' && val > 0) { result.price = val; break; }
    }

    // 옵션 재고
    const combos = findRecursive(nextData, 'optionCombinations');
    if (combos && Array.isArray(combos)) {
      for (const opt of combos) {
        if (typeof opt !== 'object') continue;
        const stock = opt.soldOut ? 0 : (opt.stockQuantity || 0);
        const parts = ['optionName1', 'optionName2', 'optionName3']
          .map(k => opt[k]).filter(Boolean);
        const name = parts.length ? parts.join(' / ') : ('옵션' + (result.options.length + 1));
        result.options.push({ name, stock });
      }
    } else {
      const stock = findRecursive(nextData, 'stockQuantity');
      if (typeof stock === 'number') {
        result.options = [{ name: '기본', stock }];
      }
    }

    // purchaseCount (누적), recentPurchaseCount (오늘), reviewCount
    result.purchaseCount = null;
    result.recentPurchaseCount = null;
    result.reviewCount = null;

    const pc = findRecursive(nextData, 'purchaseCount');
    if (pc != null && typeof pc === 'number') result.purchaseCount = pc;

    const rpc = findRecursive(nextData, 'recentPurchaseCount');
    if (rpc != null && typeof rpc === 'number') result.recentPurchaseCount = rpc;

    const rc = findRecursive(nextData, 'reviewCount');
    if (rc != null && typeof rc === 'number') result.reviewCount = rc;

    return result;
  }

  function send(productData) {
    chrome.runtime.sendMessage({
      type: 'SMARTSTORE_STOCK_DATA',
      url: location.href,
      productName: productData.productName,
      price: productData.price,
      options: productData.options,
      purchaseCount: productData.purchaseCount,
      recentPurchaseCount: productData.recentPurchaseCount,
      reviewCount: productData.reviewCount,
    });
  }

  function tryExtract() {
    const nextData = extractFromNextData();
    if (!nextData) return false;
    const data = parseProductData(nextData);
    if (!data.options.length) return false;
    send(data);
    return true;
  }

  // 즉시 시도 → 실패 시 DOM 준비 후 재시도
  if (!tryExtract()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(tryExtract, 800));
    } else {
      setTimeout(tryExtract, 800);
    }
  }
})();
