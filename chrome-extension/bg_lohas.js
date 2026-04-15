// bg_lohas.js — 로하스 상품수집 + 키워드수집 (서비스 워커 모듈)
// importScripts()로 background.js에서 로드됨

// ──────────────────────────────────────────────
// 메시지 수신 — 로하스
// ──────────────────────────────────────────────

let _lohasCancelRequested = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startCrawl') {
    const appTabId = sender.tab?.id;
    if (!appTabId) return;
    _lohasCancelRequested = false;
    lohasRunCrawl(appTabId, msg.lcpGroups, msg.apiBase);
    return;
  }
  if (msg.action === 'startKeywordCrawl') {
    const appTabId = sender.tab?.id;
    if (!appTabId) return;
    _lohasCancelRequested = false;
    lohasRunKeywordCrawl(appTabId, msg.lcpCodes, msg.apiBase);
    return;
  }
  if (msg.action === 'cancelCrawl') {
    _lohasCancelRequested = true;
    return;
  }
  if (msg.action === 'openOnOtherMonitor') {
    lohasOpenOnOtherMonitor(sender.tab, msg.url, msg.width, msg.height);
    return;
  }
});

// ──────────────────────────────────────────────
// 다른 모니터에 창 열기
// ──────────────────────────────────────────────

async function lohasOpenOnOtherMonitor(senderTab, url, width, height) {
  try {
    const displays = await chrome.system.display.getInfo();
    const curWin = await chrome.windows.get(senderTab.windowId);

    if (displays.length < 2) {
      chrome.windows.create({ url, width, height, type: 'normal' });
      return;
    }

    const curX = curWin.left || 0;
    let curDisplay = displays[0];
    for (const d of displays) {
      const bx = d.bounds.left;
      const bw = d.bounds.width;
      if (curX >= bx && curX < bx + bw) {
        curDisplay = d;
        break;
      }
    }

    const otherDisplay = displays.find(d => d.id !== curDisplay.id) || displays[0];
    const ob = otherDisplay.workArea || otherDisplay.bounds;

    const left = ob.left + Math.max(0, Math.floor((ob.width - width) / 2));
    const top = ob.top + Math.max(0, Math.floor((ob.height - height) / 2));

    const newWin = await chrome.windows.create({ url, type: 'normal' });
    await chrome.windows.update(newWin.id, { left, top, width, height });
    setTimeout(() => {
      chrome.windows.update(newWin.id, { left, top, width, height });
    }, 200);
  } catch (e) {
    console.error('[lohas] openOnOtherMonitor error:', e);
    chrome.windows.create({ url, width, height, type: 'normal' });
  }
}

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────

function lohasSendProgress(appTabId, data) {
  try {
    chrome.tabs.sendMessage(appTabId, data);
  } catch (e) { /* 탭 닫힘 */ }
}

function lohasSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function lohasWaitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(false); return; }
        if (tab.status === 'complete') { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(true); return; }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

async function lohasExecuteScript(tabId, func, args = []) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    }, (results) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(results && results[0] ? results[0].result : null);
    });
  });
}

async function lohasExecuteInMainWorld(tabId, func, args = []) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args,
    }, (results) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(results && results[0] ? results[0].result : null);
    });
  });
}

async function lohasInjectCrawlScript(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['crawl_lohas.js'],
    }, () => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(true);
    });
  });
}

// ──────────────────────────────────────────────
// 새 창 자동 최소화 — 다중 세션 지원
// ──────────────────────────────────────────────

let _lohasActiveSessionCount = 0;
const _lohasProtectedWindowIds = new Set();

chrome.windows.onCreated.addListener((win) => {
  if (_lohasActiveSessionCount > 0 && !_lohasProtectedWindowIds.has(win.id)) {
    chrome.windows.update(win.id, { state: 'minimized' });
  }
});

// ──────────────────────────────────────────────
// 현재 탭 ID 스냅샷 (팝업 감지용)
// ──────────────────────────────────────────────

async function lohasSnapshotTabIds() {
  const tabs = await chrome.tabs.query({});
  return new Set(tabs.map(t => t.id));
}

async function lohasFindNewTab(existingIds, urlPattern, timeoutSec = 15) {
  for (let i = 0; i < timeoutSec; i++) {
    await lohasSleep(1000);
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!existingIds.has(t.id) && t.url && t.url.includes(urlPattern)) {
        return t.id;
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────
// 메인 크롤링 흐름
// ──────────────────────────────────────────────

async function lohasRunCrawl(appTabId, lcpGroups, apiBase) {
  let lohasTabId = null;
  let crawlWindowId = null;
  const lcpResults = [];

  try {
    const currentWin = await chrome.windows.getCurrent();
    _lohasProtectedWindowIds.add(currentWin.id);
    _lohasActiveSessionCount++;

    const allLcps = [];
    for (const group of lcpGroups) {
      for (const code of group.lcpCodes) {
        allLcps.push({ lcpCode: code, folder: group.folder });
      }
    }
    const lcpTotal = allLcps.length;

    const emit = (statusLine, sub = 0) => lohasSendProgress(appTabId, {
      type: 'LOHAS_CRAWL_PROGRESS', lcpDone: 0, lcpTotal, subProgress: sub, statusLine,
    });

    // 1) 로그인 정보
    emit('로그인 정보 가져오는 중...');
    const credResp = await fetch(`${apiBase}/api/cpc/lohas/ext/cred/`);
    if (!credResp.ok) throw new Error('로그인 정보 API 실패');
    const cred = await credResp.json();

    // 2) tiedlist 열기
    emit('로하스 접속 중...');
    const tiedlistUrl = 'http://com.exponet.co.kr/manager/commercial/commercial_tiedlist';
    const win = await chrome.windows.create({ url: tiedlistUrl, focused: false, state: 'minimized' });
    crawlWindowId = win.id;
    lohasTabId = win.tabs[0].id;
    await lohasWaitForTabLoad(lohasTabId);
    await lohasSleep(2000);

    // 로그인 체크
    let curUrl = await lohasExecuteScript(lohasTabId, () => window.location.href);
    if (curUrl && curUrl.includes('/member/')) {
      emit('로그인 중...');
      const cleanLoginUrl = 'http://com.exponet.co.kr/member/login';
      await chrome.tabs.update(lohasTabId, { url: cleanLoginUrl });
      await lohasWaitForTabLoad(lohasTabId);
      await lohasSleep(2000);
      await lohasInjectCrawlScript(lohasTabId);
      const loginResult = await lohasExecuteScript(lohasTabId, (id, pw) => lohasLogin(id, pw), [cred.id, cred.pw]);
      if (!loginResult || !loginResult.ok) throw new Error(loginResult?.error || '로그인 실패');
      await lohasSleep(3000);
      await lohasWaitForTabLoad(lohasTabId, 10000);
      curUrl = await lohasExecuteScript(lohasTabId, () => window.location.href);
      if (curUrl && curUrl.includes('/member/')) throw new Error('로그인 실패');
      await chrome.tabs.update(lohasTabId, { url: tiedlistUrl });
      await lohasWaitForTabLoad(lohasTabId);
      await lohasSleep(2000);
    }

    emit(`로그인 완료 · ${lcpTotal}개 LCP 수집 시작`);

    // LCP 순차 처리
    for (let li = 0; li < allLcps.length; li++) {
      if (_lohasCancelRequested) {
        emit('사용자 중단 요청');
        break;
      }
      const { lcpCode, folder } = allLcps[li];

      try {
        const lcpResult = await lohasProcessOneLcp(appTabId, lohasTabId, lcpCode, folder, apiBase, crawlWindowId, li, lcpTotal);
        lcpResults.push({ lcpCode, itemCount: lcpResult.itemCount, imageCount: lcpResult.imageCount, status: 'success' });
      } catch (err) {
        lcpResults.push({ lcpCode, itemCount: 0, imageCount: 0, status: 'fail', errorMsg: err.message });
        lohasSendProgress(appTabId, {
          type: 'LOHAS_CRAWL_PROGRESS', lcpDone: li, lcpTotal, subProgress: 1,
          statusLine: `${lcpCode}  오류: ${err.message}`,
        });
        try {
          await chrome.tabs.update(lohasTabId, { url: tiedlistUrl });
          await lohasWaitForTabLoad(lohasTabId);
          await lohasSleep(2000);
        } catch (e) {}
      }
    }

    lohasSendProgress(appTabId, {
      type: 'LOHAS_CRAWL_DONE',
      results: {
        success: lcpResults.filter(r => r.status === 'success').length,
        fail: lcpResults.filter(r => r.status !== 'success').length,
        totalItems: lcpResults.reduce((s, r) => s + r.itemCount, 0),
        totalImages: lcpResults.reduce((s, r) => s + r.imageCount, 0),
        details: lcpResults,
      },
    });

  } catch (err) {
    lohasSendProgress(appTabId, { type: 'LOHAS_CRAWL_ERROR', error: err.message || String(err) });
  } finally {
    _lohasActiveSessionCount--;
    if (_lohasActiveSessionCount <= 0) {
      _lohasProtectedWindowIds.clear();
      _lohasActiveSessionCount = 0;
    }
    if (crawlWindowId) {
      try { chrome.windows.remove(crawlWindowId); } catch (e) {}
    }
  }
}


// ──────────────────────────────────────────────
// 개별 LCP 처리
// ──────────────────────────────────────────────

async function lohasProcessOneLcp(appTabId, lohasTabId, lcpCode, folder, apiBase, crawlWindowId, lcpIndex, lcpTotal) {
  const status = (msg, sub = 0) => lohasSendProgress(appTabId, {
    type: 'LOHAS_CRAWL_PROGRESS', lcpDone: lcpIndex, lcpTotal,
    subProgress: sub,
    statusLine: `${lcpCode}  ${msg}`,
  });

  // 1) LCP 검색
  status('검색중...', 0.1);
  await lohasInjectCrawlScript(lohasTabId);
  const searchResult = await lohasExecuteScript(lohasTabId, (code) => searchLcpCode(code), [lcpCode]);
  if (!searchResult || !searchResult.ok) throw new Error(`검색 실패: ${searchResult?.error || '알 수 없음'}`);
  await lohasSleep(1500);
  await lohasWaitForTabLoad(lohasTabId);

  // 2) Edit 2.0 클릭 전 — 현재 탭 스냅샷
  const tabsBefore = await lohasSnapshotTabIds();

  status('Edit 2.0 클릭', 0.2);
  await lohasInjectCrawlScript(lohasTabId);
  const editResult = await lohasExecuteScript(lohasTabId, () => clickEdit2Button());
  if (!editResult || !editResult.ok) throw new Error(editResult?.error || 'Edit 2.0 버튼 없음');
  await lohasSleep(1000);

  // 3) 팝업 대기
  status('팝업 대기...', 0.25);
  const popupTabId = await lohasFindNewTab(tabsBefore, 'com.exponet.co.kr');
  if (!popupTabId) throw new Error('팝업 미생성');

  await lohasWaitForTabLoad(popupTabId, 10000);
  await lohasSleep(2000);

  // 4) 상품 파싱
  status('상품 수집중...', 0.35);
  await lohasInjectCrawlScript(popupTabId);
  const items = await lohasExecuteScript(popupTabId, (code) => parsePopupProducts(code), [lcpCode]);
  const itemCount = items ? items.length : 0;

  if (!items || itemCount === 0) {
    try {
      const pt = await chrome.tabs.get(popupTabId);
      if (pt.windowId !== crawlWindowId) chrome.windows.remove(pt.windowId);
      else chrome.tabs.remove(popupTabId);
    } catch (e) { try { chrome.tabs.remove(popupTabId); } catch (e2) {} }
    throw new Error('포함상품 없음');
  }

  status(`상품 ${itemCount}개 · 이미지 수집 (0/${itemCount})`, 0.4);

  // 5) 이미지 수집
  let imgTotal = 0;

  for (let pi = 0; pi < itemCount; pi++) {
    const item = items[pi];
    const imgSub = 0.4 + 0.5 * ((pi + 1) / itemCount);
    status(`상품 ${itemCount}개 · 이미지 수집 (${pi + 1}/${itemCount})`, imgSub);

    try {
      const captureResult = await lohasExecuteInMainWorld(popupTabId, (index) => {
        const allTds = document.querySelectorAll('td');
        let productIdx = 0;
        let viewProductId = null;

        for (let i = 0; i < allTds.length; i++) {
          const txt = allTds[i].textContent.trim();
          if ((txt.startsWith('LCE_') || txt.startsWith('LCP_') || txt.startsWith('LCM_')) && i + 1 < allTds.length) {
            if (productIdx === index) {
              const nameTd = allTds[i + 1];
              const span = nameTd.querySelector('span[onclick]');
              if (span) {
                const onclickVal = span.getAttribute('onclick') || '';
                const m = onclickVal.match(/viewProduct\((\d+)\)/);
                if (m) viewProductId = m[1];
              }
              break;
            }
            productIdx++;
          }
        }

        if (!viewProductId) return { ok: false, url: '' };

        let capturedUrl = '';
        const origOpen = window.open;
        window.open = function(url) { capturedUrl = url || ''; return null; };
        try { if (typeof viewProduct === 'function') viewProduct(parseInt(viewProductId, 10)); } catch (e) {}
        window.open = origOpen;

        return { ok: true, url: capturedUrl };
      }, [pi]);

      if (!captureResult || !captureResult.ok || !captureResult.url) continue;

      const images = await lohasExecuteScript(popupTabId, async (url) => {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          const html = await resp.text();
          const imgs = [];
          const regex = /src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|gif|webp)[^"']*)/gi;
          let m;
          while ((m = regex.exec(html)) !== null) {
            const src = m[1];
            if (!imgs.includes(src) && imgs.length < 100) imgs.push(src);
          }
          return imgs;
        } catch (e) { return []; }
      }, [captureResult.url]);

      const imgCount = (images || []).length;
      imgTotal += imgCount;
      if (images && images.length > 0) item.detail_images = images;

    } catch (e) { /* skip */ }
  }

  // 6) 팝업 닫기
  try {
    const pt = await chrome.tabs.get(popupTabId);
    if (pt.windowId !== crawlWindowId) chrome.windows.remove(pt.windowId);
    else chrome.tabs.remove(popupTabId);
  } catch (e) { try { chrome.tabs.remove(popupTabId); } catch (e2) {} }

  // 7) API 저장
  status(`상품 ${itemCount}개 · 이미지 ${imgTotal}개 · DB 저장중...`, 0.95);
  const payload = {
    lcp_code: lcpCode,
    folder_name: folder,
    items: items.map(it => ({ ...it, detail_images: it.detail_images || [] })),
  };

  const saveResp = await fetch(`${apiBase}/api/cpc/lohas/ext/save/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!saveResp.ok) throw new Error('API 저장 실패');

  status(`완료 · 상품 ${itemCount}개 · 이미지 ${imgTotal}개`, 1);

  return { itemCount, imageCount: imgTotal };
}


// ──────────────────────────────────────────────
// 키워드 크롤링 메인 흐름
// ──────────────────────────────────────────────

async function lohasRunKeywordCrawl(appTabId, lcpCodes, apiBase) {
  let manageTabId = null;
  let crawlWindowId = null;
  const results = [];

  try {
    const currentWin = await chrome.windows.getCurrent();
    _lohasProtectedWindowIds.add(currentWin.id);
    _lohasActiveSessionCount++;

    const lcpTotal = lcpCodes.length;

    const emit = (statusLine, sub = 0, lcpDone = 0) => lohasSendProgress(appTabId, {
      type: 'LOHAS_KW_PROGRESS', lcpDone, lcpTotal, subProgress: sub, statusLine,
    });

    // 1) 로그인 정보
    emit('로그인 정보 가져오는 중...');
    const credResp = await fetch(`${apiBase}/api/cpc/lohas/ext/cred/`);
    if (!credResp.ok) throw new Error('로그인 정보 API 실패');
    const cred = await credResp.json();

    // 2) commercial_manage 페이지 열기
    emit('로하스 접속 중...');
    const manageUrl = 'http://com.exponet.co.kr/manager/commercial/commercial_manage/p/1';
    const win = await chrome.windows.create({ url: manageUrl, focused: true });
    crawlWindowId = win.id;
    _lohasProtectedWindowIds.add(crawlWindowId);
    manageTabId = win.tabs[0].id;
    await lohasWaitForTabLoad(manageTabId);
    await lohasSleep(2000);

    // 로그인 체크
    let curUrl = await lohasExecuteScript(manageTabId, () => window.location.href);
    emit(`현재 URL: ${curUrl}`);
    if (curUrl && curUrl.includes('/member/')) {
      emit('로그인 중...');
      const cleanLoginUrl = 'http://com.exponet.co.kr/member/login';
      await chrome.tabs.update(manageTabId, { url: cleanLoginUrl });
      await lohasWaitForTabLoad(manageTabId);
      await lohasSleep(2000);
      await lohasInjectCrawlScript(manageTabId);
      const loginResult = await lohasExecuteScript(manageTabId, (id, pw) => lohasLogin(id, pw), [cred.id, cred.pw]);
      if (!loginResult || !loginResult.ok) throw new Error(loginResult?.error || '로그인 실패');
      await lohasSleep(3000);
      await lohasWaitForTabLoad(manageTabId, 10000);
      curUrl = await lohasExecuteScript(manageTabId, () => window.location.href);
      if (curUrl && curUrl.includes('/member/')) throw new Error('로그인 실패');
      emit('로그인 성공 · manage 페이지로 이동');
      await chrome.tabs.update(manageTabId, { url: manageUrl });
      await lohasWaitForTabLoad(manageTabId);
      await lohasSleep(2000);
    }

    emit(`로그인 완료 · ${lcpTotal}개 LCP 키워드 수집 시작`);

    // 3) LCP 순차 처리
    for (let li = 0; li < lcpCodes.length; li++) {
      if (_lohasCancelRequested) {
        emit('사용자 중단 요청');
        break;
      }
      const lcpCode = lcpCodes[li];

      try {
        const kwResult = await lohasProcessOneKeyword(appTabId, manageTabId, lcpCode, apiBase, crawlWindowId, li, lcpTotal);
        results.push({ lcpCode, lineCount: kwResult.lineCount, status: 'success' });
      } catch (err) {
        results.push({ lcpCode, lineCount: 0, status: 'fail', errorMsg: err.message });
        lohasSendProgress(appTabId, {
          type: 'LOHAS_KW_PROGRESS', lcpDone: li, lcpTotal, subProgress: 1,
          statusLine: `${lcpCode}  오류: ${err.message}`,
        });
        try {
          await chrome.tabs.update(manageTabId, { url: manageUrl });
          await lohasWaitForTabLoad(manageTabId);
          await lohasSleep(2000);
        } catch (e) {}
      }
    }

    lohasSendProgress(appTabId, {
      type: 'LOHAS_KW_DONE',
      results: {
        success: results.filter(r => r.status === 'success').length,
        fail: results.filter(r => r.status !== 'success').length,
        totalKeywords: results.reduce((s, r) => s + r.lineCount, 0),
        details: results,
      },
    });

  } catch (err) {
    lohasSendProgress(appTabId, { type: 'LOHAS_KW_ERROR', error: err.message || String(err) });
  } finally {
    _lohasActiveSessionCount--;
    if (_lohasActiveSessionCount <= 0) {
      _lohasProtectedWindowIds.clear();
      _lohasActiveSessionCount = 0;
    }
    if (crawlWindowId) {
      try { chrome.windows.remove(crawlWindowId); } catch (e) {}
    }
  }
}


// ──────────────────────────────────────────────
// 개별 LCP 키워드 처리
// ──────────────────────────────────────────────

async function lohasProcessOneKeyword(appTabId, manageTabId, lcpCode, apiBase, crawlWindowId, lcpIndex, lcpTotal) {
  const status = (msg, sub = 0) => lohasSendProgress(appTabId, {
    type: 'LOHAS_KW_PROGRESS', lcpDone: lcpIndex, lcpTotal,
    subProgress: sub,
    statusLine: `${lcpCode}  ${msg}`,
  });

  // 1) LCP 검색
  status('검색중...', 0.1);
  await lohasInjectCrawlScript(manageTabId);
  const searchResult = await lohasExecuteScript(manageTabId, (code) => searchLcpInManage(code), [lcpCode]);
  if (!searchResult || !searchResult.ok) throw new Error(`검색 실패: ${searchResult?.error || '알 수 없음'}`);
  await lohasSleep(2000);
  await lohasWaitForTabLoad(manageTabId);

  // 2) 키워드입력 버튼 클릭 전 — 탭 스냅샷
  const tabsBefore = await lohasSnapshotTabIds();

  status('키워드입력 클릭', 0.3);
  await lohasInjectCrawlScript(manageTabId);

  const clickResult = await lohasExecuteInMainWorld(manageTabId, () => {
    const btn = document.evaluate(
      '//*[@id="tiedlistForm"]/table[2]/tbody/tr[2]/td[9]/span[1]/input',
      document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    if (btn) { btn.click(); return { ok: true }; }
    const allInputs = document.querySelectorAll('#tiedlistForm input');
    for (const inp of allInputs) {
      if ((inp.value || '').includes('키워드')) { inp.click(); return { ok: true }; }
    }
    return { ok: false, error: '키워드입력 버튼 없음' };
  });
  if (!clickResult || !clickResult.ok) throw new Error(clickResult?.error || '키워드입력 버튼 없음');
  await lohasSleep(1000);

  // 3) 키워드 팝업 대기
  status('팝업 대기...', 0.4);
  const popupTabId = await lohasFindNewTab(tabsBefore, 'com.exponet.co.kr', 10);
  if (!popupTabId) throw new Error('키워드 팝업 미생성');

  await lohasWaitForTabLoad(popupTabId, 10000);
  await lohasSleep(2000);

  // 4) 로하스 키워드 읽기 (읽기만! 저장 절대 X)
  status('로하스 키워드 읽는 중...', 0.5);
  await lohasInjectCrawlScript(popupTabId);
  const kwResult = await lohasExecuteScript(popupTabId, () => extractKeywordsFromPopup());

  const adKeywords = kwResult?.keywords || '';
  const adLineCount = kwResult?.lineCount || 0;

  // 5) 카테고리 키워드 수집
  status('카테고리 키워드 준비...', 0.55);
  await lohasInjectCrawlScript(popupTabId);
  await lohasExecuteScript(popupTabId, () => prepareForCategoryKeywords());
  await lohasSleep(1000);

  const tabs2Before = await lohasSnapshotTabIds();

  await lohasInjectCrawlScript(popupTabId);
  await lohasExecuteScript(popupTabId, () => clickKeywordManage2());
  await lohasSleep(1000);

  const popup2TabId = await lohasFindNewTab(tabs2Before, 'com.exponet.co.kr', 10);
  let catKeywords = '';
  let catLineCount = 0;

  if (popup2TabId) {
    await lohasWaitForTabLoad(popup2TabId, 10000);
    await lohasSleep(2000);
    status('카테고리 키워드 읽는 중...', 0.7);
    await lohasInjectCrawlScript(popup2TabId);
    const catResult = await lohasExecuteScript(popup2TabId, () => extractCategoryKeywords());
    catKeywords = catResult?.keywords || '';
    catLineCount = catResult?.lineCount || 0;
    try { chrome.tabs.remove(popup2TabId); } catch(e) {}
  }

  // 6) 팝업1 닫기 (저장 절대 X)
  try {
    const pt = await chrome.tabs.get(popupTabId);
    if (pt.windowId !== crawlWindowId) chrome.windows.remove(pt.windowId);
    else chrome.tabs.remove(popupTabId);
  } catch (e) { try { chrome.tabs.remove(popupTabId); } catch (e2) {} }

  // 7) API 저장
  const totalLines = adLineCount + catLineCount;
  if (totalLines > 0) {
    status(`로하스${adLineCount}줄 + 카테고리${catLineCount}줄 · DB 저장중...`, 0.85);
    const saveResp = await fetch(`${apiBase}/api/cpc/lohas/ext/keyword-save/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lcp_code: lcpCode,
        ad_keywords: adKeywords,
        category_keywords: catKeywords,
      }),
    });
    if (!saveResp.ok) throw new Error('키워드 저장 API 실패');
  }

  status(`완료 · 로하스${adLineCount}줄 + 카테고리${catLineCount}줄`, 1);
  return { lineCount: totalLines };
}
