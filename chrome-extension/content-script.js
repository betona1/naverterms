// content-script.js v3.0.26 — ISOLATED world
// 인간 행동 시뮬레이션 (스크롤/마우스/키보드) + CAPTCHA 감지
(function () {
  'use strict';

  const TAG = '__nd';
  const TRACE = '__ndt';
  const DEBUG = false; // 디버그 로그 (메모리 절약 — 문제 진단 시에만 true)
  const dlog = (...a) => { if (DEBUG) console.log('[nc]', ...a); };
  let currentExpectedTab = null; // bg가 알려주는 현재 수집 중인 탭
  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function sendBg(data, retries) {
    if (retries === undefined) retries = 2;
    try {
      chrome.runtime.sendMessage(data, () => {
        if (chrome.runtime.lastError && retries > 0) {
          setTimeout(() => sendBg(data, retries - 1), 500);
        }
      });
    } catch (e) {}
  }

  // ── injected.js 디버그 메시지 → 친화적 로그로 번역 후 바에 표시 ──
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d[TRACE]) return;
    const raw = String(d.msg || '');
    // 노이즈 차단 (fetch/XHR 원문은 사용자에게 숨김)
    if (/^fetch#\d+/.test(raw) || raw.startsWith('XHR:')) return;
    // 번역
    const mStar = raw.match(/\[(\S+?)\]\s+상품\s+(\d+)개/);
    if (mStar) {
      const tab = mStar[1], n = mStar[2];
      pushLog(`✓ [${tab}] 데이터 수집 (${n}개의 상품정보 수집)`);
      return;
    }
    if (raw.includes('예비데이터')) { pushLog('상품정보 수집중...'); return; }
    if (raw.includes('폴링 시작') || raw.includes('추출 성공')) { pushLog('페이지 분석중...'); return; }
    if (raw.includes('폴링 타임아웃')) { pushLog('상품정보 대기중...'); return; }
    // 나머지는 바에서 숨김 (console 에만 남음)
  });

  // ── injected.js → background 데이터 전달 (postMessage) ──
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d[TAG]) return;
    if (!d.products || !d.products.length) return;
    // bg가 지정한 expected tab으로 덮어쓰기 (URL 타이밍 이슈 해결)
    const urlPs = d.productSet || 'total';
    const ps = currentExpectedTab || urlPs;
    if (urlPs !== ps) dlog(`productSet 교정: ${urlPs} → ${ps}`);
    const tabName = { total: '전체', model: '가격비교', checkout: '네이버페이' }[ps] || ps;

    // 필드별 개수 집계
    const c = (fn) => d.products.filter(fn).length;
    const mallCount = c(p => p.mallName) + c(p => p.lowMallList && p.lowMallList.length > 0);
    const tagCount = c(p => p.manuTag && p.manuTag.length > 0);
    const attrCount = c(p => p.attributeValue);
    const reviewCount = c(p => p.reviewCount > 0);
    const catCount = c(p => p.category1Name);
    const termsStr = (d.terms && d.terms.length) ? d.terms.slice(0, 4).join('|') : '(term없음)';

    // 첫 상품의 전체 필드명 목록 (진단) — Naver가 이름 바꿨을 수 있음
    const firstProductKeys = Object.keys(d.products[0] || {}).slice(0, 25).join(',');
    dlog(`[${tabName}] ${d.products.length}개, 스토어${mallCount} 태그${tagCount} 속성${attrCount} 리뷰${reviewCount} 카테${catCount}, term:${termsStr}`);
    dlog(`[${tabName}] 첫상품 필드: ${firstProductKeys}`);
    pushLog(`✓ [${tabName}] 데이터 수집 (${d.products.length}개의 상품정보 수집)`);

    sendBg({
      type: 'NAVER_SHOPPING_DATA',
      url: d.url,
      productSet: ps, // expected tab으로 교정된 값
      query: d.query,
      terms: d.terms,
      termCount: d.termCount,
      total: d.total,
      products: d.products,
    });
  });

  // ── 상세페이지 구매수 데이터 전달 (injected.js → background) ──
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__nd_purchase) return;
    dlog('구매수 데이터:', d.nvMid, d.purchaseCnt);
    sendBg({
      type: 'PURCHASE_DETAIL_DATA',
      nvMid: d.nvMid,
      purchaseCnt: d.purchaseCnt,
      reviewCount: d.reviewCount,
      keepCnt: d.keepCnt,
      price: d.price,
      success: d.success,
    });
  });

  // 페이지 이탈 시 expected tab 초기화
  window.addEventListener('beforeunload', () => { currentExpectedTab = null; });

  // ══════════════════════════════════════════
  // CAPTCHA/차단 감지 (오탐 방지: 실제 보이는 UI 또는 리다이렉트만)
  // ══════════════════════════════════════════
  function isActuallyVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  }

  function detectCaptcha() {
    // 1) URL 리다이렉트 (ncpt.naver.com 등) — 가장 확실
    const u = location.href;
    if (u.includes('ncpt.naver.com') || /\/captcha(\?|\/|$)/i.test(u)) return 'url_captcha';

    // 2) 영수증 풀이 (Naver receipt puzzle)
    const body = document.body ? document.body.textContent || '' : '';
    if (/영수증에?\s*(있는|나오는|표시된)?\s*(숫자|금액)/.test(body) ||
        /영수증\s*풀이/.test(body)) return 'receipt_puzzle';

    // 3) 실제 보이는 CAPTCHA iframe/이미지
    const iframes = document.querySelectorAll('iframe[src*="captcha"],iframe[src*="ncpt"]');
    for (const f of iframes) if (isActuallyVisible(f)) return 'iframe_captcha';

    // 4) 명시적 차단 문구
    if (body.includes('비정상적인 접근') || body.includes('접속이 일시적으로 제한')) return 'block_text';

    // 5) CAPTCHA 전용 페이지 (title) — script 로드만으로는 트리거하지 않음
    const title = (document.title || '').toLowerCase();
    if (title.includes('captcha') || title.includes('보안문자')) return 'title_captcha';

    return null;
  }

  let wasCaptcha = false;
  let lastCaptchaCheck = 0;
  function checkCaptcha() {
    // 쓰로틀: 800ms 내 중복 호출 방지
    const now = Date.now();
    if (now - lastCaptchaCheck < 800) return;
    lastCaptchaCheck = now;
    const t = detectCaptcha();
    if (t && !wasCaptcha) {
      wasCaptcha = true;
      sendBg({ type: 'CAPTCHA_DETECTED', captchaType: t, url: location.href });
    } else if (!t && wasCaptcha) {
      wasCaptcha = false;
      sendBg({ type: 'CAPTCHA_RESOLVED' });
    }
  }

  // ❌ MutationObserver(subtree:true) 폐기 — 네이버쇼핑의 잦은 DOM 변경으로 CPU/메모리 폭주 원인
  // ✅ 가벼운 트리거: 페이지 로드 1회 + URL 변경 + 5초 주기 체크
  setTimeout(checkCaptcha, 1500); // 초기 1회
  let captchaInterval = setInterval(checkCaptcha, 5000);
  // 페이지 떠날 때 정리 (메모리 누수 방지)
  window.addEventListener('beforeunload', () => {
    if (captchaInterval) { clearInterval(captchaInterval); captchaInterval = null; }
  });

  // ══════════════════════════════════════════
  // 인간 행동 시뮬레이션
  // ══════════════════════════════════════════
  let humanRunning = false;

  async function humanMouse(count) {
    if (count === undefined) count = Math.floor(rand(4, 10));
    const w = window.innerWidth, h = window.innerHeight;
    let x = rand(w * 0.3, w * 0.7), y = rand(h * 0.3, h * 0.7);
    for (let i = 0; i < count; i++) {
      x += rand(-120, 120);
      y += rand(-120, 120);
      x = Math.max(10, Math.min(w - 10, x));
      y = Math.max(10, Math.min(h - 10, y));
      const ev = new MouseEvent('mousemove', {
        clientX: x, clientY: y, screenX: x, screenY: y,
        bubbles: true, cancelable: true, view: window,
      });
      (document.elementFromPoint(x, y) || document).dispatchEvent(ev);
      await sleep(rand(80, 320));
    }
  }

  // rAF 기반 부드러운 스크롤 (가속-감속 곡선)
  function smoothScrollTo(targetY, duration) {
    return new Promise(resolve => {
      const startY = window.scrollY;
      const distance = targetY - startY;
      const startTime = performance.now();
      function frame(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / duration);
        // easeInOutCubic
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        window.scrollTo(0, startY + distance * eased);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  async function humanScroll() {
    const max = Math.max((document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight, 300);
    const steps = Math.floor(rand(4, 8));
    let y = window.scrollY;
    for (let i = 0; i < steps; i++) {
      const delta = rand(250, 600);
      y = Math.min(max, y + delta);
      // 거리 비례 애니메이션 시간 (400~900ms) — 실제 마우스 휠에 가까움
      const dur = rand(420, 900);
      await smoothScrollTo(y, dur);
      // 사람이 읽는 듯한 정지 (500~1600ms)
      await sleep(rand(500, 1600));
    }
    // 가끔 살짝 위로 (읽다가 돌아가보는 느낌)
    if (Math.random() < 0.45) {
      await sleep(rand(300, 900));
      const back = Math.max(0, y - rand(200, 600));
      await smoothScrollTo(back, rand(500, 900));
      await sleep(rand(400, 1100));
    }
  }

  async function humanBehavior() {
    if (humanRunning) return;
    humanRunning = true;
    try {
      // 여러 루틴 중 랜덤 선택 — 매번 다르게
      const routines = [
        () => routineScrollDown(),
        () => routineScrollExplore(),
        () => routineHoverProducts(),
        () => routineDwellThenScan(),
        () => routineQuickScan(),
      ];
      const routine = routines[Math.floor(Math.random() * routines.length)];
      await sleep(rand(400, 1400));
      humanMouse().catch(() => {});
      await routine();
    } finally {
      humanRunning = false;
    }
  }

  // 루틴 1: 차분히 아래로 스크롤하며 읽기
  async function routineScrollDown() {
    await humanScroll();
  }

  // 루틴 2: 탐색적 — 스크롤하다 위로 돌아가기 반복
  async function routineScrollExplore() {
    const max = Math.max((document.documentElement.scrollHeight || 0) - window.innerHeight, 300);
    for (let i = 0; i < Math.floor(rand(2, 4)); i++) {
      const down = Math.min(max, window.scrollY + rand(400, 900));
      await smoothScrollTo(down, rand(500, 1000));
      await sleep(rand(700, 1800));
      if (Math.random() < 0.5) {
        const back = Math.max(0, window.scrollY - rand(200, 500));
        await smoothScrollTo(back, rand(400, 800));
        await sleep(rand(500, 1200));
      }
    }
  }

  // 루틴 3: 상품들 위에 마우스 호버 (관심 표현)
  async function routineHoverProducts() {
    await humanScroll();
    const items = document.querySelectorAll('li, [class*="product"], [class*="item"]');
    const sample = Array.from(items).slice(0, 30);
    if (!sample.length) return;
    const hovers = Math.floor(rand(2, 5));
    for (let i = 0; i < hovers; i++) {
      const el = sample[Math.floor(Math.random() * sample.length)];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('mouseover', { clientX: cx, clientY: cy, bubbles: true, view: window }));
      await sleep(rand(400, 1200));
      el.dispatchEvent(new MouseEvent('mouseout', { clientX: cx, clientY: cy, bubbles: true, view: window }));
      await sleep(rand(200, 800));
    }
  }

  // 루틴 4: 머뭇거리다 빠르게 스캔
  async function routineDwellThenScan() {
    await sleep(rand(1500, 3500));
    humanMouse(Math.floor(rand(3, 7))).catch(() => {});
    await humanScroll();
  }

  // 루틴 5: 재빠르게 훑기
  async function routineQuickScan() {
    const max = Math.max((document.documentElement.scrollHeight || 0) - window.innerHeight, 300);
    await smoothScrollTo(Math.min(max, window.scrollY + rand(600, 1200)), rand(400, 700));
    await sleep(rand(400, 900));
    await smoothScrollTo(Math.min(max, window.scrollY + rand(400, 800)), rand(350, 600));
    await sleep(rand(600, 1400));
  }

  // ══════════════════════════════════════════
  // 키보드 입력 시뮬레이션
  // ══════════════════════════════════════════
  function findSearchInput() {
    const sels = [
      'input[name="query"]',
      'input[placeholder*="검색"]',
      'input[type="search"]',
      'form input[type="text"]',
      '#gnb_search_text',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  async function humanType(input, text) {
    input.focus();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    await sleep(rand(200, 600));

    // 기존 값 제거 (Ctrl+A, Delete)
    if (input.value) {
      input.select();
      await sleep(rand(80, 200));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(rand(120, 300));
    }

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

    for (const ch of text) {
      const code = ch.charCodeAt(0);
      const opts = { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: code, which: code, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keypress', opts));
      setter.call(input, input.value + ch);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));
      // 한글/영문/숫자마다 딜레이 다르게 (자연스럽게)
      await sleep(rand(70, 260));
    }
    await sleep(rand(300, 900));
  }

  async function typeAndNavigate(keyword, nextUrl) {
    const input = findSearchInput();
    if (input) {
      try {
        await humanType(input, keyword);
        // Enter 키 이벤트 (form submit 전 지문용)
        const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
        input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
        await sleep(rand(200, 600));
      } catch (e) {}
    }
    // 실제 네비는 URL로 (referer 보존)
    if (nextUrl) {
      await sleep(rand(300, 900));
      window.location.href = nextUrl;
    }
  }

  async function navigateOnly(nextUrl) {
    // 탭 전환용: 스크롤/마우스 → 페이지 이동
    humanMouse(Math.floor(rand(2, 5))).catch(() => {});
    await sleep(rand(500, 1500));
    window.location.href = nextUrl;
  }

  // ══════════════════════════════════════════
  // 탭 클릭 (파이썬 CDP 방식 대응 — 클릭→XHR→fetch훅 캡처)
  // ══════════════════════════════════════════
  async function clickTab(tabKey) {
    const labels = { total: '전체', model: '가격비교', checkout: '네이버페이' };
    const label = labels[tabKey];
    if (!label) return { ok: false, reason: 'unknown-tab' };

    await sleep(rand(400, 1100));

    // 파이썬 XPath (betonaTerms2.py)
    const xpaths = {
      total: '//*[@id="content"]/div[1]/div[1]/ul/li[1]/a',
      model: '//*[@id="content"]/div[1]/div[1]/ul/li[2]/a',
      checkout: '//*[@id="content"]/div[1]/div[1]/ul/li[3]/a',
    };
    let el = null;
    try {
      const r = document.evaluate(xpaths[tabKey], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      el = r.singleNodeValue;
    } catch (e) {}

    // 폴백: 탭 라벨 텍스트로 찾기
    if (!el) {
      const candidates = document.querySelectorAll('ul[role="tablist"] a, ul[role="tablist"] button, [class*="tab"] a, [class*="tab"] button, nav a, ul li a');
      for (const c of candidates) {
        const t = (c.textContent || '').trim();
        if (t === label || t.startsWith(label)) { el = c; break; }
      }
    }
    if (!el) {
      dlog('탭 버튼 못찾음:', label);
      return { ok: false, reason: 'no-tab-btn' };
    }

    // 클릭 시뮬레이션 (mouseover → mousedown → mouseup → click)
    try {
      el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    } catch (e) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mkMouse = (type) => new MouseEvent(type, {
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      bubbles: true, cancelable: true, view: window, button: 0,
    });
    el.dispatchEvent(mkMouse('mouseover'));
    await sleep(rand(80, 220));
    el.dispatchEvent(mkMouse('mousedown'));
    await sleep(rand(40, 120));
    el.dispatchEvent(mkMouse('mouseup'));
    el.dispatchEvent(mkMouse('click'));
    el.click(); // 안전하게 네이티브 click도
    dlog('탭 클릭 완료:', label);

    // 탭 클릭 후 스크롤 등 인간 행동 — Naver의 lazy XHR 트리거
    await sleep(rand(800, 1500));
    humanBehavior().catch(() => {});

    return { ok: true };
  }

  // ══════════════════════════════════════════
  // background 메시지 핸들러
  // ══════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'HUMAN_TYPE_NAV') {
      typeAndNavigate(msg.keyword, msg.url).then(() => reply({ ok: true })).catch(e => reply({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'HUMAN_NAV') {
      navigateOnly(msg.url).then(() => reply({ ok: true })).catch(e => reply({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'HUMAN_BEHAVIOR') {
      humanBehavior().then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
      return true;
    }
    if (msg.type === 'SHOW_PROGRESS') {
      showProgress(msg);
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'HIDE_PROGRESS') {
      hideProgress();
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'LOG_LINE') {
      pushLog(msg.msg);
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'SHOW_RESTART') {
      try {
        const els = ensureBar();
        els.restart.classList.add('show');
        els.bar.classList.add('paused');
        els.cmds.classList.add('hide');
        if (msg.msg) els.logEl.textContent = msg.msg;
      } catch (e) {}
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'HIDE_RESTART') {
      try {
        if (barEls) {
          barEls.restart.classList.remove('show');
          barEls.bar.classList.remove('paused');
          barEls.bar.classList.remove('receipt');
        }
      } catch (e) {}
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'SHOW_RECEIPT_PUZZLE') {
      try {
        const els = ensureBar();
        els.bar.classList.remove('paused');
        els.bar.classList.add('receipt');
        els.cmds.classList.add('hide');
        els.status.textContent = '🧾 네이버 영수증 풀이 — 직접 풀어주세요';
        if (msg.msg) els.logEl.textContent = msg.msg;
        els.restart.classList.add('show');
      } catch (e) {}
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'SHOW_COMPLETE') {
      showCompleteMini(msg.resultsUrl);
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'PHASE_UPDATE') {
      showPhase(msg.phase, msg.label, { reCollect: !!msg.reCollect });
      reply({ ok: true });
      return false;
    }
    if (msg.type === 'HUMAN_CLICK_TAB') {
      currentExpectedTab = msg.tabKey;
      clickTab(msg.tabKey).then(r => reply(r)).catch(e => reply({ ok: false, reason: e.message }));
      return true;
    }
    if (msg.type === 'SET_EXPECTED_TAB') {
      currentExpectedTab = msg.tabKey;
      reply({ ok: true });
      return false;
    }
  });

  // ══════════════════════════════════════════
  // 수집 진행바 + 실시간 로그 (Shadow DOM — 페이지 스크립트가 못 봄)
  // ══════════════════════════════════════════
  let barHost = null;
  let barRoot = null;
  let barEls = null;
  let currentStatus = { kw: '', tab: '', kwIdx: 0, total: 0, pct: 0 };

  function ensureBar() {
    if (barHost && barEls) return barEls;
    barHost = document.createElement('div');
    // 우측상단 작은 floating widget
    barHost.style.cssText = 'all:initial;position:fixed;top:8px;right:8px;z-index:2147483647';
    barRoot = barHost.attachShadow({ mode: 'closed' });
    barRoot.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; margin: 0; padding: 0; }
        .bar {
          display: inline-flex; align-items: center; gap: 6px;
          height: 30px; padding: 0 10px;
          background: linear-gradient(90deg,#03c75a 0%,#02a04a 100%);
          color: #fff; font: 700 11px/1 -apple-system,'Malgun Gothic',sans-serif;
          border-radius: 16px;
          box-shadow: 0 4px 14px rgba(0,0,0,0.28);
          transition: transform 0.2s, background 0.2s, opacity 0.2s;
          user-select: none;
        }
        .bar.paused { background: linear-gradient(90deg,#f59e0b 0%,#d97706 100%); }
        .bar.receipt { background: linear-gradient(90deg,#8b5cf6 0%,#6d28d9 100%); }
        .bar.complete { background: linear-gradient(90deg,#10b981 0%,#059669 100%); }
        .phase { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 8px;
                 background: rgba(0,0,0,0.20); flex-shrink: 0; }
        .status { font-size: 11px; opacity: 0.98; white-space: nowrap;
                  max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #fff;
               animation: blink 1.1s ease-in-out infinite; flex-shrink: 0; }
        .restart { display: none; padding: 3px 8px; border: none; border-radius: 10px;
                   background: #fff; color: #d97706; font: 700 10px/1 sans-serif;
                   cursor: pointer; flex-shrink: 0; }
        .restart:hover { background: #fef3c7; }
        .restart.show { display: inline-block; }
        .results { display: none; padding: 3px 10px; border: none; border-radius: 10px;
                   background: #fff; color: #059669; font: 700 11px/1 sans-serif;
                   cursor: pointer; flex-shrink: 0; }
        .results:hover { background: #d1fae5; }
        .results.show { display: inline-block; }
        .cmds { display: flex; gap: 3px; flex-shrink: 0; }
        .cmds.hide { display: none; }
        .cbtn { padding: 3px 7px; border: none; border-radius: 10px;
                background: rgba(255,255,255,0.18); color: #fff;
                font: 700 10px/1 -apple-system,'Malgun Gothic',sans-serif;
                cursor: pointer; white-space: nowrap;
                transition: background 0.15s; }
        .cbtn:hover:not(:disabled) { background: rgba(255,255,255,0.35); }
        .cbtn:active:not(:disabled) { transform: scale(0.94); }
        .cbtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .cbtn-all { background: rgba(255,140,0,0.65); }
        .cbtn-all:hover:not(:disabled) { background: rgba(255,140,0,0.85); }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      </style>
      <div class="bar" id="bar">
        <span class="dot"></span>
        <span class="phase" id="phase" style="display:none"></span>
        <span class="status" id="status">🛍️ 가격비교</span>
        <div class="cmds" id="cmds">
          <button class="cbtn cbtn-all" id="cAll" title="3개 탭 일괄 수집">🔥All</button>
          <button class="cbtn" id="cTotal" title="전체수집">📦전체</button>
          <button class="cbtn" id="cModel" title="가격비교수집">💰비교</button>
          <button class="cbtn" id="cCheckout" title="네이버페이수집">N페이</button>
        </div>
        <button class="restart" id="restart">🔄 다시시작</button>
        <button class="results" id="results">📊 결과보기</button>
      </div>
    `;
    barEls = {
      bar: barRoot.querySelector('.bar'),
      phase: barRoot.getElementById('phase'),
      status: barRoot.getElementById('status'),
      // 호환: 옛 메시지(LOG_LINE/SHOW_PROGRESS) 가 들어와도 깨지지 않게 더미 객체
      logEl: { textContent: '', style: { display: 'none' } },
      fill: { style: { width: '0%' } },
      pct: { textContent: '' },
      restart: barRoot.getElementById('restart'),
      results: barRoot.getElementById('results'),
      cmds: barRoot.getElementById('cmds'),
      cAll: barRoot.getElementById('cAll'),
      cTotal: barRoot.getElementById('cTotal'),
      cModel: barRoot.getElementById('cModel'),
      cCheckout: barRoot.getElementById('cCheckout'),
    };
    barEls.restart.addEventListener('click', () => {
      sendBg({ type: 'RESTART_CURRENT' });
      barEls.restart.classList.remove('show');
      barEls.bar.classList.remove('paused');
      barEls.bar.classList.remove('receipt');
    });
    barEls.results.addEventListener('click', () => {
      // 새 탭 대신 현재 페이지에 모달 표시 (검색어 있으면)
      const kw = getCurrentKeyword() || (barEls.results.dataset.keyword || '');
      if (kw) {
        showResultsModal(kw);
        return;
      }
      // 검색어 없으면 fallback: 새 탭
      const url = barEls.results.dataset.url;
      if (!url) return;
      if (url.startsWith('chrome-extension://')) {
        sendBg({ type: 'OPEN_RESULTS_PAGE', url });
      } else {
        window.open(url, '_blank');
      }
    });
    barEls.cAll.addEventListener('click', () => triggerManualCollectAll());
    barEls.cTotal.addEventListener('click', () => triggerManualCollect('total'));
    barEls.cModel.addEventListener('click', () => triggerManualCollect('model'));
    barEls.cCheckout.addEventListener('click', () => triggerManualCollect('checkout'));
    (document.body || document.documentElement).appendChild(barHost);
    return barEls;
  }

  // 현재 URL 의 ?query= 추출
  function getCurrentKeyword() {
    try {
      const u = new URL(location.href);
      return (u.searchParams.get('query') || '').trim();
    } catch (e) { return ''; }
  }

  // idle 명령바 (작은 우측상단 widget)
  function showIdleBar() {
    const els = ensureBar();
    els.bar.classList.remove('paused');
    els.bar.classList.remove('receipt');
    els.bar.classList.remove('complete');
    els.restart.classList.remove('show');
    els.results.classList.remove('show');
    els.cmds.classList.remove('hide');
    els.phase.style.display = 'none';
    const kw = getCurrentKeyword();
    els.status.textContent = '🛍️ 가격비교';
    els.cAll.disabled = !kw;
    els.cTotal.disabled = !kw;
    els.cModel.disabled = !kw;
    els.cCheckout.disabled = !kw;
    els.bar.style.transform = 'translateY(0)';
  }

  function triggerManualCollectAll() {
    const kw = getCurrentKeyword();
    if (!kw) { pushLog('검색어를 먼저 입력하세요'); return; }
    sendBg({ type: 'MANUAL_COLLECT_ALL', keyword: kw });
  }

  function triggerManualCollect(tabKey) {
    const kw = getCurrentKeyword();
    if (!kw) {
      pushLog('검색어를 먼저 입력하세요');
      return;
    }
    sendBg({ type: 'MANUAL_COLLECT_TAB', keyword: kw, tabKey });
  }

  // ══════════════════════════════════════════
  // 결과 모달 (Shadow DOM 풀스크린 오버레이)
  // ══════════════════════════════════════════
  let modalHost = null;
  let modalRoot = null;
  let modalEls = null;

  function ensureModal() {
    if (modalHost && modalEls) return modalEls;
    modalHost = document.createElement('div');
    modalHost.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646';
    modalRoot = modalHost.attachShadow({ mode: 'closed' });
    modalRoot.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; margin: 0; padding: 0; }
        .overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.6);
          display: none; align-items: center; justify-content: center;
          font: 13px -apple-system,'Malgun Gothic',sans-serif;
        }
        .overlay.show { display: flex; }
        .card {
          background: #1c1c2e; color: #ddd;
          border-radius: 12px; max-width: 95vw; max-height: 92vh;
          width: 1200px; height: 760px;
          display: flex; flex-direction: column;
          box-shadow: 0 20px 60px rgba(0,0,0,0.55);
          overflow: hidden;
        }
        .hdr {
          padding: 12px 18px; display: flex; align-items: center; gap: 10px;
          background: #15152a; border-bottom: 1px solid #2a2a40;
        }
        .hdr-title { flex: 1; font-size: 14px; font-weight: 800; color: #fff; }
        .hdr-meta { font-size: 11px; color: #888; font-weight: 500; }
        .hdr-close {
          width: 30px; height: 30px; border: none; border-radius: 15px;
          background: rgba(255,255,255,0.08); color: #aaa;
          font-size: 18px; cursor: pointer; line-height: 1;
        }
        .hdr-close:hover { background: rgba(255,255,255,0.18); color: #fff; }
        .hdr-btn {
          padding: 6px 12px; border: none; border-radius: 6px;
          background: #03c75a; color: #fff; font-weight: 700; font-size: 11px;
          cursor: pointer; white-space: nowrap;
        }
        .hdr-btn:hover { background: #02a34a; }
        .hdr-btn:disabled { opacity: 0.5; cursor: progress; }
        .hdr-btn-img { background: #8b5cf6; }
        .hdr-btn-img:hover { background: #7c3aed; }
        .tabs { display: flex; gap: 4px; padding: 8px 18px; background: #1c1c2e;
                border-bottom: 1px solid #2a2a40; }
        .tab { padding: 6px 14px; border: none; border-radius: 6px;
               background: #2a2a40; color: #aaa;
               font-size: 12px; font-weight: 700; cursor: pointer; }
        .tab.active { background: #03c75a; color: #fff; }
        .tab:hover:not(.active) { background: #333355; color: #ddd; }
        .body { flex: 1; overflow: auto; padding: 8px 12px; }
        .empty { text-align: center; padding: 80px 0; color: #666; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        thead th {
          position: sticky; top: 0; z-index: 1;
          text-align: left; padding: 6px 8px;
          background: #15152a; color: #888; font-weight: 700;
          border-bottom: 1px solid #2a2a40; white-space: nowrap;
        }
        thead th.r { text-align: right; }
        tbody td {
          padding: 4px 8px; border-bottom: 1px solid #1a1a2e;
          vertical-align: middle; max-width: 250px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        tbody td.r { text-align: right; font-variant-numeric: tabular-nums; }
        tbody tr:hover { background: #22223a; }
        .pname { color: #fff; max-width: 280px; }
        .store { color: #aaa; max-width: 130px; }
        .cat { color: #9ca3af; max-width: 160px; font-size: 10px; }
        .attr { color: #fbbf24; max-width: 150px; font-size: 10px; }
        .tag { color: #60a5fa; max-width: 160px; font-size: 10px; }
        .rank { color: #f59e0b; font-weight: 700; text-align: center; }
        .thumb { width: 32px; height: 32px; object-fit: cover;
                 border-radius: 4px; border: 1px solid #2a2a40; }
        .empty-actions { margin-top: 16px; }
        .recollect-btn {
          padding: 10px 20px; border: none; border-radius: 8px;
          background: #03c75a; color: #fff;
          font: 700 12px/1 sans-serif; cursor: pointer;
        }
        .recollect-btn:hover { background: #02a04a; }
        .track-btn {
          padding: 2px 6px; border: none; border-radius: 4px;
          background: rgba(96,165,250,0.15); color: #60a5fa;
          font-size: 10px; cursor: pointer;
        }
        .track-btn:hover { background: rgba(96,165,250,0.35); }
        /* 시계열 패널 (오른쪽 슬라이드) */
        .panel {
          position: absolute; top: 0; right: -460px; bottom: 0;
          width: 440px; background: #15152a; color: #ddd;
          border-left: 1px solid #2a2a40;
          display: flex; flex-direction: column;
          transition: right 0.25s;
          box-shadow: -4px 0 16px rgba(0,0,0,0.3);
        }
        .panel.show { right: 0; }
        .panel-hdr {
          padding: 10px 14px; display: flex; align-items: center; gap: 8px;
          background: #0f0f1a; border-bottom: 1px solid #2a2a40;
        }
        .panel-title { flex: 1; font-size: 12px; font-weight: 800; color: #fff;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .panel-close {
          width: 24px; height: 24px; border: none; border-radius: 12px;
          background: rgba(255,255,255,0.08); color: #aaa; font-size: 14px;
          cursor: pointer; line-height: 1;
        }
        .panel-close:hover { background: rgba(255,255,255,0.18); color: #fff; }
        .panel-body { flex: 1; overflow: auto; padding: 8px; font-size: 11px; }
        .hist-row {
          padding: 8px; margin-bottom: 6px; border-radius: 6px;
          background: #1c1c2e; border: 1px solid #2a2a40;
        }
        .hist-time { font-size: 10px; color: #888; }
        .hist-rank {
          display: inline-block; padding: 2px 8px; border-radius: 4px;
          background: #03c75a; color: #fff; font-weight: 800; margin-right: 6px;
        }
        .hist-delta { font-size: 10px; margin-left: 6px; }
        .delta-up { color: #ef4444; }    /* 순위 ↑ = 빨강(상승) */
        .delta-down { color: #3b82f6; }  /* 순위 ↓ = 파랑(하락) */
        .delta-flat { color: #888; }
        .hist-name { color: #fff; font-size: 11px; font-weight: 600; margin: 4px 0 2px; }
        .hist-changed { color: #f59e0b; font-size: 10px; margin-left: 4px; }
        .hist-meta { font-size: 10px; color: #aaa; }
        .hist-imgs { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
        .hist-img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px;
                    border: 1px solid #2a2a40; }
        .hist-img.diff { border-color: #f59e0b; }
      </style>
      <div class="overlay" id="overlay">
        <div class="card" style="position:relative">
          <div class="hdr">
            <span class="hdr-title" id="title">결과</span>
            <span class="hdr-meta" id="meta"></span>
            <button class="hdr-btn" id="dlXls" title="Excel 다운로드 (이미지 없음 — 빠름)">📊 xls</button>
            <button class="hdr-btn hdr-btn-img" id="dlXlsImg" title="Excel + 이미지 (40개 상품 이미지 임베드)">📊🖼 xls+이미지</button>
            <button class="hdr-close" id="close">×</button>
          </div>
          <div class="tabs" id="tabs"></div>
          <div class="body" id="body"></div>
          <div class="panel" id="panel">
            <div class="panel-hdr">
              <span class="panel-title" id="panelTitle">상품 변동 추적</span>
              <button class="panel-close" id="panelClose">×</button>
            </div>
            <div class="panel-body" id="panelBody"></div>
          </div>
        </div>
      </div>
    `;
    modalEls = {
      overlay: modalRoot.getElementById('overlay'),
      title: modalRoot.getElementById('title'),
      meta: modalRoot.getElementById('meta'),
      tabs: modalRoot.getElementById('tabs'),
      body: modalRoot.getElementById('body'),
      close: modalRoot.getElementById('close'),
      dlXls: modalRoot.getElementById('dlXls'),
      dlXlsImg: modalRoot.getElementById('dlXlsImg'),
      panel: modalRoot.getElementById('panel'),
      panelTitle: modalRoot.getElementById('panelTitle'),
      panelBody: modalRoot.getElementById('panelBody'),
      panelClose: modalRoot.getElementById('panelClose'),
    };
    modalEls.close.addEventListener('click', hideModal);
    modalEls.panelClose.addEventListener('click', () => {
      modalEls.panel.classList.remove('show');
    });
    modalEls.dlXls.addEventListener('click', () => downloadExcel(false));
    modalEls.dlXlsImg.addEventListener('click', () => downloadExcel(true));
    modalEls.overlay.addEventListener('click', e => {
      if (e.target === modalEls.overlay) hideModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modalEls.overlay.classList.contains('show')) {
        hideModal();
      }
    });
    document.body.appendChild(modalHost);
    return modalEls;
  }

  function hideModal() {
    if (modalEls) modalEls.overlay.classList.remove('show');
  }

  let currentModalKeyword = null;

  function showResultsModal(keyword) {
    const els = ensureModal();
    currentModalKeyword = keyword;
    els.title.textContent = `📊 "${keyword}"`;
    els.meta.textContent = '로딩 중...';
    els.tabs.innerHTML = '';
    els.body.innerHTML = '<div class="empty">데이터 가져오는 중...</div>';
    els.overlay.classList.add('show');

    chrome.runtime.sendMessage({ type: 'GET_RESULTS_FOR_KEYWORD', keyword }, (data) => {
      if (chrome.runtime.lastError || !data) {
        els.body.innerHTML = '<div class="empty">데이터를 불러올 수 없습니다.</div>';
        return;
      }
      if (data.error) {
        els.body.innerHTML = `<div class="empty">에러: ${escHtml(data.error)}</div>`;
        return;
      }
      renderModalContent(els, keyword, data);
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderModalContent(els, keyword, data) {
    const tabKeys = [
      { key: 'total', label: '전체' },
      { key: 'model', label: '가격비교' },
      { key: 'checkout', label: '네이버페이' },
    ];
    const cnt = (k) => (data[k] && data[k].products) ? data[k].products.length : 0;
    const tot = (k) => (data[k] && data[k].total) ? data[k].total : 0;

    els.meta.textContent = `전체 ${cnt('total')}/${tot('total').toLocaleString()} · 가격비교 ${cnt('model')}/${tot('model').toLocaleString()} · 네이버페이 ${cnt('checkout')}/${tot('checkout').toLocaleString()}`;

    let tabsHtml = '';
    for (const t of tabKeys) {
      const c = cnt(t.key);
      tabsHtml += `<button class="tab" data-tab="${t.key}">${t.label} <span style="opacity:0.7">${c}</span></button>`;
    }
    els.tabs.innerHTML = tabsHtml;

    let activeTab = 'total';
    for (const t of tabKeys) {
      if (cnt(t.key) > 0) { activeTab = t.key; break; }
    }

    function setTab(tabKey) {
      activeTab = tabKey;
      Array.from(els.tabs.children).forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabKey);
      });
      // 패널 닫기 (탭 전환 시)
      els.panel.classList.remove('show');
      const d = data[tabKey];
      if (!d || !d.products || !d.products.length) {
        const tabLabel = ({ total: '전체', model: '가격비교', checkout: '네이버페이' })[tabKey] || tabKey;
        els.body.innerHTML = `
          <div class="empty">
            <div>"${escHtml(keyword)}" 의 ${tabLabel} 탭에 수집된 상품이 없습니다.</div>
            <div class="empty-actions">
              <button class="recollect-btn" data-recollect-tab="${tabKey}">🔄 ${tabLabel} 다시수집</button>
            </div>
          </div>
        `;
        const btn = els.body.querySelector('.recollect-btn');
        if (btn) btn.addEventListener('click', () => {
          sendBg({ type: 'MANUAL_COLLECT_TAB', keyword, tabKey });
          hideModal();
        });
        return;
      }
      els.body.innerHTML = renderProductsTable(d.products);
      // 📈 추적 버튼 클릭 핸들러
      els.body.querySelectorAll('.track-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const pid = btn.dataset.pid;
          const pname = btn.dataset.pname;
          openHistoryPanel(keyword, tabKey, pid, pname);
        });
      });
    }
    Array.from(els.tabs.children).forEach(btn => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    setTab(activeTab);
  }

  function renderProductsTable(products) {
    const fmtCat = p => [p.category1Name, p.category2Name, p.category3Name, p.category4Name].filter(Boolean).join(' > ');
    const fmtPipe = v => !v ? '' : (Array.isArray(v) ? v.join('|') : String(v));
    const fmtTag = p => {
      const v = p.manuTag;
      if (!v) return '';
      if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x && (x.name || x.value || x.text) || '')).filter(Boolean).join(',');
      return String(v);
    };
    let html = `<table>
      <thead><tr>
        <th class="r" style="width:32px">#</th>
        <th style="width:36px">추적</th>
        <th style="width:50px">이미지</th>
        <th>상품명</th><th>스토어</th><th>카테고리</th>
        <th>속성항목</th><th>속성값</th><th>태그</th>
        <th>브랜드</th><th>제조사</th>
        <th class="r">리뷰수</th><th class="r">가격</th>
      </tr></thead><tbody>`;
    products.forEach((p, i) => {
      const img = p.imageUrl || '';
      const name = p.productName || p.productTitle || '';
      const cat = fmtCat(p);
      const attr = fmtPipe(p.attributeValue);
      const attrV = fmtPipe(p.characterValue);
      const tag = fmtTag(p);
      const review = Number(p.reviewCount || 0);
      const price = Number(p.lowPrice || p.price || 0);
      const pid = p.nvMid || p.id || '';
      html += `<tr>
        <td class="rank">${i + 1}</td>
        <td>${pid ? `<button class="track-btn" data-pid="${escHtml(pid)}" data-pname="${escHtml(name)}" title="시간대별 순위/가격/이름/이미지 변동">📈</button>` : '-'}</td>
        <td>${img ? `<a href="${escHtml(img)}" target="_blank"><img src="${escHtml(img)}" class="thumb"></a>` : '-'}</td>
        <td class="pname" title="${escHtml(name)}">${escHtml(name) || '-'}</td>
        <td class="store">${escHtml(p.mallName || '-')}</td>
        <td class="cat" title="${escHtml(cat)}">${escHtml(cat || '-')}</td>
        <td class="attr" title="${escHtml(attr)}">${escHtml(attr || '-')}</td>
        <td class="attr" title="${escHtml(attrV)}">${escHtml(attrV || '-')}</td>
        <td class="tag" title="${escHtml(tag)}">${escHtml(tag || '-')}</td>
        <td>${escHtml(p.brand || '-')}</td>
        <td>${escHtml(p.maker || '-')}</td>
        <td class="r">${review.toLocaleString()}</td>
        <td class="r">${price ? price.toLocaleString() : '-'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    return html;
  }

  // ── 시계열 변동 패널 ──
  function openHistoryPanel(keyword, tab, productId, productName) {
    const els = ensureModal();
    els.panel.classList.add('show');
    els.panelTitle.textContent = `📈 "${productName || productId}" 변동 추적`;
    els.panelBody.innerHTML = '<div class="empty" style="padding:20px;text-align:center;color:#666">로딩 중...</div>';
    chrome.runtime.sendMessage({
      type: 'GET_PRODUCT_HISTORY',
      keyword, tab, productId,
    }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        els.panelBody.innerHTML = '<div class="empty" style="padding:20px;text-align:center;color:#888">데이터를 불러올 수 없습니다.</div>';
        return;
      }
      if (resp.error) {
        els.panelBody.innerHTML = `<div class="empty" style="padding:20px;text-align:center;color:#ef4444">${escHtml(resp.error)}</div>`;
        return;
      }
      renderHistoryPanel(els, resp);
    });
  }

  // ── Excel 다운로드 ──
  function downloadExcel(withImages) {
    const kw = currentModalKeyword;
    if (!kw) { pushLog('키워드 없음'); return; }
    const els = modalEls;
    const btn = withImages ? els.dlXlsImg : els.dlXls;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = withImages ? '다운로드 중... (~10초)' : '다운로드 중...';
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_EXCEL',
      keyword: kw,
      withImages,
    }, (resp) => {
      btn.disabled = false;
      btn.textContent = orig;
      if (chrome.runtime.lastError || !resp) {
        alert('다운로드 실패: 메시지 전송 실패');
        return;
      }
      if (resp.error) {
        alert('다운로드 실패: ' + resp.error);
      }
    });
  }

  function renderHistoryPanel(els, resp) {
    const history = resp.history || [];
    if (history.length === 0) {
      els.panelBody.innerHTML = '<div class="empty" style="padding:20px;text-align:center;color:#888">시계열 데이터가 없습니다.<br>여러번 수집해야 변동이 보입니다.</div>';
      return;
    }
    // 최신 → 오래된 순으로 표시
    const reversed = [...history].reverse();
    let html = '';
    for (const h of reversed) {
      const time = new Date(h.collected_at).toLocaleString('ko-KR', { hour12: false });
      const d = h.delta || {};
      const rd = d.rank || 0;
      let rankDelta = '<span class="hist-delta delta-flat">−</span>';
      if (rd > 0) rankDelta = `<span class="hist-delta delta-up">▲ ${rd}</span>`;
      else if (rd < 0) rankDelta = `<span class="hist-delta delta-down">▼ ${-rd}</span>`;
      const pd = d.price || 0;
      let priceDelta = '';
      if (pd > 0) priceDelta = ` <span class="hist-delta delta-down">+${pd.toLocaleString()}원</span>`;
      else if (pd < 0) priceDelta = ` <span class="hist-delta delta-up">${pd.toLocaleString()}원</span>`;
      const nameChanged = d.name_changed ? ' <span class="hist-changed">📝 상품명 변경</span>' : '';
      const imageChanged = d.image_changed ? ' <span class="hist-changed">🖼️ 이미지 변경</span>' : '';
      const price = Number(h.lowPrice || 0);
      html += `<div class="hist-row">
        <div class="hist-time">${escHtml(time)}</div>
        <div style="margin:4px 0">
          <span class="hist-rank">${h.rank}위</span>${rankDelta}
          ${nameChanged}${imageChanged}
        </div>
        <div class="hist-name" title="${escHtml(h.productName)}">${escHtml(h.productName || '-')}</div>
        <div class="hist-meta">
          🏪 ${escHtml(h.mallName || '-')} ·
          💰 ${price ? price.toLocaleString() : '-'}원${priceDelta} ·
          ⭐ ${Number(h.reviewCount || 0).toLocaleString()}
        </div>
        ${h.imageUrl ? `<div class="hist-imgs"><img src="${escHtml(h.imageUrl)}" class="hist-img${d.image_changed ? ' diff' : ''}"></div>` : ''}
      </div>`;
    }
    els.panelBody.innerHTML = html;
  }

  // 호환: 옛 SHOW_PROGRESS 메시지가 와도 무시 (PHASE_UPDATE 으로 대체됨)
  function showProgress(m) {
    try {
      const els = ensureBar();
      els.cmds.classList.add('hide');
      els.results.classList.remove('show');
      // overrideStatus 만 status 에 반영 (BG 호환)
      if (m && m.overrideStatus) {
        els.status.textContent = m.overrideStatus;
      }
      els.bar.style.transform = 'translateY(0)';
    } catch (e) {}
  }

  // ── 새 phase 기반 표시 (0/3 회피, 1/3 첫탭버림, 2/3 타겟수집) ──
  function showPhase(phase, label, opts) {
    try {
      const els = ensureBar();
      els.bar.classList.remove('paused');
      els.bar.classList.remove('receipt');
      els.bar.classList.remove('complete');
      els.cmds.classList.add('hide');
      els.results.classList.remove('show');
      els.restart.classList.remove('show');
      const o = opts || {};
      const total = 3;
      const cap = Math.min(Math.max(0, phase | 0), total);
      els.phase.style.display = 'inline-block';
      els.phase.textContent = `${cap}/${total}`;
      let stateText;
      if (cap === 0) stateText = '회피작업중';
      else if (cap === 1) stateText = '첫탭 그냥보냄';
      else if (cap === 2) stateText = label || '수집중';
      else stateText = '완료';
      const prefix = o.reCollect ? '🔄전체다시수집·' : '';
      els.status.textContent = prefix + stateText;
      els.bar.style.transform = 'translateY(0)';
    } catch (e) {}
  }

  function showCompleteMini(resultsUrl) {
    try {
      const els = ensureBar();
      els.bar.classList.remove('paused');
      els.bar.classList.remove('receipt');
      els.bar.classList.add('complete');
      els.cmds.classList.add('hide');
      els.restart.classList.remove('show');
      els.phase.style.display = 'none';
      els.status.textContent = '✓ 완료';
      if (resultsUrl) {
        els.results.dataset.url = resultsUrl;
        els.results.classList.add('show');
      }
      els.bar.style.transform = 'translateY(0)';
    } catch (e) {}
  }

  function pushLog(msg) {
    try {
      const els = ensureBar();
      if (els.logEl) els.logEl.textContent = msg || '-';
      els.bar.style.transform = 'translateY(0)';
    } catch (e) {}
  }

  function hideProgress() {
    if (!barEls) return;
    barEls.bar.style.transform = 'translateY(-100%)';
    setTimeout(() => {
      if (barHost) { barHost.remove(); barHost = null; barRoot = null; barEls = null; }
    }, 300);
  }

  // ══════════════════════════════════════════
  // 페이지 준비 + idle 명령바 표시 (자동 humanBehavior 제거)
  // ══════════════════════════════════════════
  function onReady() {
    dlog('페이지 준비:', location.href);
    sendBg({ type: 'NAVER_PAGE_READY', url: location.href });
    // 명령바를 idle 상태로 노출 — 사용자가 버튼 눌러야 수집 시작
    showIdleBar();
  }

  if (document.readyState === 'complete') {
    setTimeout(onReady, rand(400, 900));
  } else {
    window.addEventListener('load', () => setTimeout(onReady, rand(400, 900)));
  }

  // SPA 네비 후크 — 검색어 바뀌면 idle 바 갱신
  let _lastUrl = location.href;
  function onUrlChange() {
    if (location.href === _lastUrl) return;
    _lastUrl = location.href;
    // 수집 중이면 (paused/receipt 클래스 있으면) 건드리지 않음
    if (barEls && (barEls.bar.classList.contains('paused') ||
                    barEls.bar.classList.contains('receipt'))) return;
    setTimeout(showIdleBar, 300);
  }
  const _origPush = history.pushState;
  const _origReplace = history.replaceState;
  history.pushState = function () { const r = _origPush.apply(this, arguments); onUrlChange(); return r; };
  history.replaceState = function () { const r = _origReplace.apply(this, arguments); onUrlChange(); return r; };
  window.addEventListener('popstate', onUrlChange);
})();
