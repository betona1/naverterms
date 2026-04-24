// results.js v3.0.0 — 외부용 결과 뷰어
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const TAB_NAME = { total: '전체', model: '가격비교', checkout: '네이버페이' };

  function loadResults() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (!r?.results?.length) {
        $('summary').textContent = '';
        $('content').innerHTML = '<div class="empty">수집된 데이터가 없습니다.<br>팝업에서 키워드를 입력하고 수집을 시작하세요.</div>';
        return;
      }

      const results = r.results;
      $('summary').textContent = `키워드 ${results.length}개`;

      let html = '';
      results.forEach((kw, ki) => {
        // 탭 배지
        const allTabs = ['total', 'model', 'checkout'];
        const badges = allTabs.map(t => {
          const done = kw.tabs[t] ? 'done' : '';
          return `<span class="kw-tab-badge ${done}">${TAB_NAME[t]}</span>`;
        }).join('');

        // total 카운트
        const totalData = kw.tabs.total;
        const totalCount = totalData ? totalData.total : 0;

        html += `<div class="kw-card">
          <div class="kw-hdr" data-idx="${ki}">
            <span class="kw-arrow" id="arrow${ki}">▶</span>
            <span class="kw-name">"${esc(kw.keyword)}"</span>
            <span class="kw-total">(${totalCount.toLocaleString()})</span>
            <div class="kw-tabs">${badges}</div>
          </div>
          <div class="kw-body" id="body${ki}">`;

        // Terms 표시 (total 탭 기준)
        if (totalData?.terms?.length) {
          html += '<div class="terms-row"><div class="terms-label">Terms</div>';
          totalData.terms.forEach((t, ti) => {
            const val = typeof t === 'string' ? t : (t.value || t.text || JSON.stringify(t));
            html += `<span class="term-chip">${esc(val)}<span class="term-idx">#${ti + 1}</span></span>`;
          });
          html += '</div>';
        }

        // 탭별 상품 테이블
        for (const [tabType, data] of Object.entries(kw.tabs)) {
          const products = data.products || [];
          html += `<div class="tab-section">
            <div class="tab-label">${TAB_NAME[tabType] || tabType}<span class="tab-total">전체 ${(data.total || 0).toLocaleString()}개 / 수집 ${products.length}개</span></div>`;

          if (products.length > 0) {
            html += `<table>
              <thead><tr>
                <th style="width:30px">#</th>
                <th>상품명</th>
                <th>스토어</th>
                <th class="r">가격</th>
                <th class="r">리뷰</th>
                <th>카테고리</th>
              </tr></thead><tbody>`;

            products.forEach((p, pi) => {
              const name = p.productName || p.productTitle || '-';
              const price = parseInt(p.lowPrice || p.price || 0, 10);
              const review = p.reviewCount || 0;
              const cat = [p.category1Name, p.category2Name, p.category3Name].filter(Boolean).join(' > ');
              html += `<tr>
                <td class="rank">${pi + 1}</td>
                <td class="pname" title="${esc(name)}">${esc(name)}</td>
                <td class="store">${esc(p.mallName || '-')}</td>
                <td class="r">${price ? price.toLocaleString() : '-'}</td>
                <td class="r">${review.toLocaleString()}</td>
                <td class="store">${esc(cat || '-')}</td>
              </tr>`;
            });

            html += '</tbody></table>';
          } else {
            html += '<div style="padding:8px;color:#555;font-size:11px">상품 없음</div>';
          }
          html += '</div>';
        }

        html += '</div></div>';
      });

      $('content').innerHTML = html;

      // 토글 이벤트
      document.querySelectorAll('.kw-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
          const idx = hdr.dataset.idx;
          const body = $('body' + idx);
          const arrow = $('arrow' + idx);
          body.classList.toggle('open');
          arrow.classList.toggle('open');
        });
      });

      // 첫번째 키워드 자동 열기
      if (results.length > 0) {
        $('body0')?.classList.add('open');
        $('arrow0')?.classList.add('open');
      }
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // CSV 내보내기
  function exportCsv() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (!r?.results?.length) { alert('내보낼 데이터 없음'); return; }

      const BOM = '\uFEFF';
      const headers = ['키워드', '탭', '전체수', 'Term수', 'Terms', '순위', '상품명', '스토어', '가격', '리뷰수', '카테고리', '상품ID'];
      const rows = [headers.join(',')];

      for (const kw of r.results) {
        for (const [tabType, data] of Object.entries(kw.tabs)) {
          const termsStr = (data.terms || []).map(t => typeof t === 'string' ? t : (t.value || t.text || '')).join('|');
          const products = data.products || [];
          if (products.length === 0) {
            rows.push(csvRow([kw.keyword, tabType, data.total, data.termCount, termsStr, '', '', '', '', '', '', '']));
          } else {
            products.forEach((p, i) => {
              const cat = [p.category1Name, p.category2Name, p.category3Name].filter(Boolean).join(' > ');
              rows.push(csvRow([
                kw.keyword, tabType, data.total, data.termCount, termsStr,
                i + 1,
                p.productName || p.productTitle || '',
                p.mallName || '',
                p.lowPrice || p.price || '',
                p.reviewCount || 0,
                cat,
                p.nvMid || p.id || '',
              ]));
            });
          }
        }
      }

      const csv = BOM + rows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `term-수집-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function csvRow(vals) {
    return vals.map(v => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  }

  // 이벤트
  $('refresh').addEventListener('click', loadResults);
  $('csvBtn').addEventListener('click', exportCsv);
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('수집된 모든 데이터를 삭제합니다.\n\n진행하시겠습니까?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => loadResults());
  });

  // 초기 로드
  loadResults();
});
