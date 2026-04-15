// crawl_lohas.js — 로하스 페이지에 주입할 DOM 조작/파싱 함수
// chrome.scripting.executeScript로 주입되어 실행됨

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _extractLohasCode(productCode) {
  const m = productCode.match(/(L\d+)/);
  return m ? m[1] : '';
}

function _parsePrice(priceStr) {
  if (!priceStr) return [0, 0];
  const nums = priceStr.match(/[\d,]+/g) || [];
  const prices = nums.map(s => parseInt(s.replace(/,/g, ''), 10) || 0);
  if (prices.length >= 2) return [prices[0], prices[1]];
  if (prices.length === 1) return [prices[0], 0];
  return [0, 0];
}

function _parseDays(daysStr) {
  if (!daysStr) return 0;
  const m = daysStr.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}


// ──────────────────────────────────────────────
// 로그인
// ──────────────────────────────────────────────

function lohasLogin(id, pw) {
  // name 속성으로 찾기 (기존 Selenium 크롤러와 동일)
  const idInput = document.querySelector('input[name="login_id"]');
  const pwInput = document.querySelector('input[name="login_pw"]');
  const loginBtn = document.querySelector('input[type="image"]');

  if (!idInput || !pwInput) {
    return { ok: false, error: '로그인 폼을 찾을 수 없습니다 (login_id/login_pw)' };
  }
  if (!loginBtn) {
    return { ok: false, error: '로그인 버튼을 찾을 수 없습니다' };
  }

  idInput.focus();
  idInput.value = '';
  idInput.value = id;
  idInput.dispatchEvent(new Event('input', { bubbles: true }));
  idInput.dispatchEvent(new Event('change', { bubbles: true }));

  pwInput.focus();
  pwInput.value = '';
  pwInput.value = pw;
  pwInput.dispatchEvent(new Event('input', { bubbles: true }));
  pwInput.dispatchEvent(new Event('change', { bubbles: true }));

  loginBtn.click();
  return { ok: true };
}

function checkLoginSuccess() {
  return !window.location.href.includes('/member/');
}


// ──────────────────────────────────────────────
// tiedlist 페이지 조작
// ──────────────────────────────────────────────

function _xpath(expr) {
  return document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
}

function getPageDebugInfo() {
  return {
    url: window.location.href,
    title: document.title,
    hasSearchBox: !!document.getElementById('searchBox'),
    selectCount: document.querySelectorAll('select').length,
    bodyText: (document.body?.innerText || '').substring(0, 200),
  };
}

function selectFolderAndSearch(folderName) {
  // XPath: //*[@id="searchBox"]/tbody/tr[2]/td[2]/select[1] (기존 Selenium과 동일)
  const folderSel = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/select[1]');
  if (!folderSel) {
    const debug = getPageDebugInfo();
    return { ok: false, error: `폴더 select 없음 (url=${debug.url}, searchBox=${debug.hasSearchBox}, selects=${debug.selectCount})` };
  }

  let found = false;
  for (const opt of folderSel.options) {
    if (opt.value === folderName || opt.text === folderName) {
      folderSel.value = opt.value;
      folderSel.dispatchEvent(new Event('change', { bubbles: true }));
      found = true;
      break;
    }
  }
  if (!found) return { ok: false, error: `폴더 "${folderName}" 없음` };

  // 500개 보기
  const viewNumSel = document.querySelector("select[name='viewnum']");
  if (viewNumSel) {
    viewNumSel.value = '500';
    viewNumSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 검색 버튼: //*[@id="searchBox"]/tbody/tr[2]/td[2]/button
  const searchBtn = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/button');
  if (searchBtn) searchBtn.click();

  return { ok: true };
}

function searchLcpCode(lcpCode) {
  const textarea = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/textarea');
  if (!textarea) {
    const debug = getPageDebugInfo();
    return { ok: false, error: `textarea 없음 (url=${debug.url}, searchBox=${debug.hasSearchBox})` };
  }

  textarea.value = lcpCode;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  const searchBtn = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/button');
  if (searchBtn) searchBtn.click();

  return { ok: true };
}

function clickEdit2Button() {
  const btn = _xpath('//*[@id="tiedlistForm"]/table[2]/tbody/tr[2]/td[10]/span[2]/input');
  if (!btn) return { ok: false, error: 'Edit 2.0 버튼 없음' };

  // alert 가로채기 — "1.0작업완료상태가 아닙니다" 등 사이트 경고 캡처
  const origAlert = window.alert;
  let alertMsg = null;
  window.alert = function(msg) { alertMsg = msg; };

  btn.click();

  // alert 복원
  window.alert = origAlert;

  if (alertMsg) {
    return { ok: false, error: alertMsg };
  }
  return { ok: true };
}


// ──────────────────────────────────────────────
// 팝업 상품 테이블 파싱
// ──────────────────────────────────────────────

function parsePopupProducts(lcpCode) {
  const CELLS_PER_ITEM = 11;
  const items = [];

  // "상품코드" 헤더가 있는 테이블 찾기
  const tables = document.querySelectorAll('table');
  let targetTable = null;
  for (const tbl of tables) {
    const text = tbl.innerText || '';
    if (text.includes('상품코드') && text.includes('상품명')) {
      targetTable = tbl;
      break;
    }
  }

  if (!targetTable) return items;

  const allTds = targetTable.querySelectorAll('td');
  const cells = [];
  for (const td of allTds) {
    cells.push(td.textContent.trim());
  }

  // 첫 번째 유효 셀 찾기 (숫자로 시작하는 item_no)
  let startIdx = 0;
  for (let i = 0; i < cells.length; i++) {
    if (/^\d+$/.test(cells[i]) && i + CELLS_PER_ITEM <= cells.length) {
      const code = cells[i + 2] || '';
      if (code.startsWith('LCE_') || code.startsWith('LCP_') || code.startsWith('LCM_')) {
        startIdx = i;
        break;
      }
    }
  }

  let idx = startIdx;
  while (idx + CELLS_PER_ITEM <= cells.length) {
    const itemNoStr = cells[idx];
    if (!/^\d+$/.test(itemNoStr)) {
      idx += 1;
      continue;
    }

    const productCode = cells[idx + 2];
    if (!productCode.startsWith('LCE_') && !productCode.startsWith('LCP_') && !productCode.startsWith('LCM_')) {
      idx += 1;
      continue;
    }

    // 썸네일 URL
    let thumbnailUrl = '';
    const tdElements = targetTable.querySelectorAll('td');
    if (tdElements[idx + 1]) {
      const img = tdElements[idx + 1].querySelector('img');
      if (img) thumbnailUrl = img.src || img.getAttribute('src') || '';
    }

    const lohasCode = _extractLohasCode(productCode);
    const productName = cells[idx + 3];
    const regCount = parseInt(cells[idx + 4], 10) || 0;
    const salesQty = parseInt(cells[idx + 5], 10) || 0;
    const [wholesalePrice, compliancePrice] = _parsePrice(cells[idx + 6]);
    const marketNameEdit = cells[idx + 8];
    const sellingPeriodDays = _parseDays(cells[idx + 9]);

    items.push({
      lcp_code: lcpCode,
      item_no: parseInt(itemNoStr, 10),
      product_code: productCode,
      lohas_code: lohasCode,
      product_name: productName,
      thumbnail_url: thumbnailUrl,
      reg_count: regCount,
      sales_qty: salesQty,
      wholesale_price: wholesalePrice,
      compliance_price: compliancePrice,
      market_name_edit: marketNameEdit,
      selling_period_days: sellingPeriodDays,
    });

    idx += CELLS_PER_ITEM;
  }

  return items;
}


// ──────────────────────────────────────────────
// 상세페이지 이미지 추출
// ──────────────────────────────────────────────

function extractDetailImages() {
  const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const images = [];

  document.querySelectorAll('img').forEach((img) => {
    const src = img.src || img.getAttribute('src') || '';
    if (!src) return;
    const srcLower = src.toLowerCase();
    const hasExt = IMG_EXTS.some(ext => srcLower.endsWith(ext) || srcLower.includes(ext + '?'));
    if (!hasExt) return;

    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && (w < 50 || h < 50)) return;

    if (!images.includes(src) && images.length < 100) {
      images.push(src);
    }
  });

  return images;
}


// ──────────────────────────────────────────────
// 상품명 TD에서 상세페이지 링크 클릭
// ──────────────────────────────────────────────

function getProductCount() {
  // 팝업 테이블에서 상품코드(LCE_/LCP_/LCM_) 개수 반환
  const allTds = document.querySelectorAll('td');
  let count = 0;
  for (const td of allTds) {
    const txt = td.textContent.trim();
    if (txt.startsWith('LCE_') || txt.startsWith('LCP_') || txt.startsWith('LCM_')) {
      count++;
    }
  }
  return count;
}

function getProductLinksInfo() {
  // 팝업 테이블에서 상품별 상세페이지 URL 추출
  const allTds = document.querySelectorAll('td');
  const results = [];

  for (let i = 0; i < allTds.length; i++) {
    const txt = allTds[i].textContent.trim();
    if ((txt.startsWith('LCE_') || txt.startsWith('LCP_') || txt.startsWith('LCM_')) && i + 1 < allTds.length) {
      const lohasCode = _extractLohasCode(txt);
      const nameTd = allTds[i + 1];
      const a = nameTd.querySelector('a');

      // a.href (DOM 프로퍼티) = 브라우저가 해석한 절대 URL
      const href = a ? a.href : '';
      const rawHref = a ? (a.getAttribute('href') || '') : '';
      const onclick = a ? (a.getAttribute('onclick') || '') : '';

      results.push({
        lohas_code: lohasCode,
        product_code: txt,
        href: href,         // 절대 URL
        rawHref: rawHref,   // 원본 href 속성
        onclick: onclick.substring(0, 100),
      });
    }
  }
  return results;
}

function clickProductNameByIndex(index) {
  // 팝업 테이블에서 index번째 상품의 상품명 TD 클릭
  const allTds = document.querySelectorAll('td');
  let productIdx = 0;

  for (let i = 0; i < allTds.length; i++) {
    const txt = allTds[i].textContent.trim();
    if ((txt.startsWith('LCE_') || txt.startsWith('LCP_') || txt.startsWith('LCM_')) && i + 1 < allTds.length) {
      if (productIdx === index) {
        const nameTd = allTds[i + 1];
        // <a> 태그가 있으면 클릭, 없으면 TD 직접 클릭 (Selenium 크롤러와 동일)
        const a = nameTd.querySelector('a');
        if (a) {
          a.click();
        } else {
          nameTd.click();
        }
        return { ok: true, lohas_code: _extractLohasCode(txt) };
      }
      productIdx++;
    }
  }
  return { ok: false, error: `index ${index} 상품 없음` };
}


// ──────────────────────────────────────────────
// commercial_manage 키워드 수집
// ──────────────────────────────────────────────

function searchLcpInManage(lcpCode) {
  // commercial_manage 페이지의 검색 textarea에 LCP코드 입력 후 검색
  const textarea = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/textarea');
  if (!textarea) {
    const debug = getPageDebugInfo();
    return { ok: false, error: `manage textarea 없음 (url=${debug.url})` };
  }

  textarea.value = lcpCode;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  const searchBtn = _xpath('//*[@id="searchBox"]/tbody/tr[2]/td[2]/button');
  if (searchBtn) searchBtn.click();

  return { ok: true };
}

function clickKeywordButton() {
  // 검색 결과의 첫 번째 행에서 키워드입력 버튼 클릭
  // td[9]/span[1]/input (키워드입력 버튼)
  const btn = _xpath('//*[@id="tiedlistForm"]/table[2]/tbody/tr[2]/td[9]/span[1]/input');
  if (!btn) {
    // fallback: value에 '키워드' 포함된 input 찾기
    const allInputs = document.querySelectorAll('#tiedlistForm input');
    for (const inp of allInputs) {
      if ((inp.value || '').includes('키워드')) {
        inp.click();
        return { ok: true };
      }
    }
    return { ok: false, error: '키워드입력 버튼 없음' };
  }
  btn.click();
  return { ok: true };
}

function extractKeywordsFromPopup() {
  // 키워드 팝업에서 #fk 필드의 value 읽기 (읽기만! 저장 절대 X)
  const fk = document.getElementById('fk');
  if (!fk) return { ok: false, error: '#fk 필드 없음', keywords: '' };

  const text = (fk.value || '').trim();
  return { ok: true, keywords: text, lineCount: text ? text.split('\n').filter(l => l.trim()).length : 0 };
}

// 팝업1에서 전체선택 + 전송 (카테고리 키워드 수집 준비)
function prepareForCategoryKeywords() {
  const allBtn = document.getElementById('all');
  if (allBtn) allBtn.click();
  const transferBtn = document.evaluate(
    '/html/body/table/tbody/tr[4]/td[2]/img',
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  ).singleNodeValue;
  if (transferBtn) transferBtn.click();
  return { ok: true };
}

// 팝업1에서 키워드관리2 버튼 클릭
function clickKeywordManage2() {
  const kw2Btn = document.evaluate(
    '/html/body/div[3]/span/input',
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  ).singleNodeValue;
  if (!kw2Btn) return { ok: false, error: '키워드관리2 버튼 없음' };
  kw2Btn.click();
  return { ok: true };
}

// 팝업2에서 전체선택 + 전송 후 #fk 읽기 (카테고리 키워드)
function extractCategoryKeywords() {
  const allBtn = document.getElementById('all');
  if (allBtn) allBtn.click();
  const transferBtn = document.evaluate(
    '//*[@id="floatingTop"]/img',
    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
  ).singleNodeValue;
  if (transferBtn) transferBtn.click();
  const fk = document.getElementById('fk');
  if (!fk) return { ok: false, keywords: '', lineCount: 0 };
  const text = (fk.value || '').trim();
  return { ok: true, keywords: text,
    lineCount: text ? text.split('\n').filter(l => l.trim()).length : 0 };
}
