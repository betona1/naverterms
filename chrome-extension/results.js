// results.js v3.0.26 — 외부용 결과 뷰어 (속성/태그/브랜드/제조사/등록일/이미지 포함)
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const TAB_NAME = { total: '전체', model: '가격비교', checkout: '네이버페이' };
  const TAB_ORDER = ['total', 'model', 'checkout'];

  const COLS = [
    '상품ID', '상품명', '스토어명', '카테고리명',
    '속성항목', '속성값', '태그',
    '브랜드', '제조사', '리뷰수', '리뷰요약', '찜수', '등록일',
    '가격', '배송비', '추가이미지수', '쇼핑몰수', '이미지URL'
  ];

  // ── 필드 포매터 ──
  function fmtStore(p) {
    return p.mallName
      || (p.lowMallList && p.lowMallList[0] && (p.lowMallList[0].name || p.lowMallList[0].mallName))
      || '';
  }
  function fmtCategory(p) {
    return [p.category1Name, p.category2Name, p.category3Name, p.category4Name]
      .filter(Boolean).join(' > ');
  }
  function fmtAttrKey(p) {
    const v = p.attributeValue;
    if (!v) return '';
    if (Array.isArray(v)) return v.join('|');
    return String(v);
  }
  function fmtAttrVal(p) {
    const v = p.characterValue;
    if (!v) return '';
    if (Array.isArray(v)) return v.join('|');
    return String(v);
  }
  function fmtTag(p) {
    const v = p.manuTag;
    if (!v) return '';
    if (Array.isArray(v)) {
      return v.map(x => typeof x === 'string' ? x : (x && (x.name || x.value || x.text) || '')).filter(Boolean).join(',');
    }
    return String(v);
  }
  function fmtDate(d) {
    if (!d) return '';
    const s = String(d);
    if (/^\d{14}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    return s;
  }
  function fmtPid(p) { return p.nvMid || p.id || ''; }
  function fmtDlvry(p) { const v = p.dlvryPrice ?? p.dlvryLowPrice; return v != null ? Number(v) : ''; }
  function fmtSmryReview(p) {
    const v = p.smryReview;
    if (!v) return '';
    if (Array.isArray(v)) return v.join(',');
    return String(v);
  }

  function productRow(p) {
    return [
      fmtPid(p),
      p.productName || p.productTitle || '',
      fmtStore(p),
      fmtCategory(p),
      fmtAttrKey(p),
      fmtAttrVal(p),
      fmtTag(p),
      p.brand || '',
      p.maker || '',
      Number(p.reviewCount || 0),
      fmtSmryReview(p),
      Number(p.keepCnt || 0),
      fmtDate(p.openDate),
      Number(p.lowPrice || 0),
      fmtDlvry(p),
      Number(p.additionalImageCount || 0),
      Number(p.mallCount || 0),
      p.imageUrl || '',
    ];
  }

  // ══════════════════════════════════════════
  // 화면 렌더
  // ══════════════════════════════════════════
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
        const badges = TAB_ORDER.map(t => {
          const done = kw.tabs[t] ? 'done' : '';
          return `<span class="kw-tab-badge ${done}">${TAB_NAME[t]}</span>`;
        }).join('');

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

        if (totalData?.terms?.length) {
          html += '<div class="terms-row"><div class="terms-label">Terms</div>';
          totalData.terms.forEach((t, ti) => {
            const val = typeof t === 'string' ? t : (t.value || t.text || JSON.stringify(t));
            html += `<span class="term-chip">${esc(val)}<span class="term-idx">#${ti + 1}</span></span>`;
          });
          html += '</div>';
        }

        for (const tabType of TAB_ORDER) {
          const data = kw.tabs[tabType];
          if (!data) continue;
          const products = data.products || [];
          html += `<div class="tab-section">
            <div class="tab-label">${TAB_NAME[tabType]}<span class="tab-total">전체 ${(data.total || 0).toLocaleString()}개 / 수집 ${products.length}개</span></div>`;

          if (products.length > 0) {
            html += `<div class="tbl-wrap"><table>
              <thead><tr>
                <th class="c rank">#</th>
                <th>상품ID</th>
                <th>상품명</th>
                <th>스토어</th>
                <th>카테고리</th>
                <th>속성항목</th>
                <th>속성값</th>
                <th>태그</th>
                <th>브랜드</th>
                <th>제조사</th>
                <th class="r">리뷰수</th>
                <th>리뷰요약</th>
                <th class="r">찜수</th>
                <th>등록일</th>
                <th class="r">가격</th>
                <th class="r">배송비</th>
                <th class="r">추가IMG</th>
                <th class="r">쇼핑몰수</th>
                <th class="c">이미지</th>
              </tr></thead><tbody>`;

            products.forEach((p, pi) => {
              const r = productRow(p);
              html += `<tr>
                <td class="rank">${pi + 1}</td>
                <td class="pid">${esc(r[0] || '-')}</td>
                <td class="pname" title="${esc(r[1])}">${esc(r[1])}</td>
                <td class="store">${esc(r[2] || '-')}</td>
                <td class="cat" title="${esc(r[3])}">${esc(r[3] || '-')}</td>
                <td class="attr" title="${esc(r[4])}">${esc(r[4] || '-')}</td>
                <td class="attr" title="${esc(r[5])}">${esc(r[5] || '-')}</td>
                <td class="tag" title="${esc(r[6])}">${esc(r[6] || '-')}</td>
                <td>${esc(r[7] || '-')}</td>
                <td>${esc(r[8] || '-')}</td>
                <td class="r">${Number(r[9]).toLocaleString()}</td>
                <td class="tag" title="${esc(r[10])}">${esc(r[10] || '-')}</td>
                <td class="r">${Number(r[11]).toLocaleString()}</td>
                <td class="store">${esc(r[12] || '-')}</td>
                <td class="r">${r[13] ? Number(r[13]).toLocaleString() : '-'}</td>
                <td class="r">${r[14] !== '' ? Number(r[14]).toLocaleString() : '-'}</td>
                <td class="r">${r[15] || '-'}</td>
                <td class="r">${r[16] || '-'}</td>
                <td class="c">${r[17] ? `<img src="${esc(r[17])}" class="thumb">` : '-'}</td>
              </tr>`;
            });

            html += '</tbody></table></div>';
          } else {
            html += '<div style="padding:8px;color:#555;font-size:11px">상품 없음</div>';
          }
          html += '</div>';
        }

        html += '</div></div>';
      });

      $('content').innerHTML = html;

      document.querySelectorAll('.kw-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
          const idx = hdr.dataset.idx;
          $('body' + idx).classList.toggle('open');
          $('arrow' + idx).classList.toggle('open');
        });
      });

      if (results.length > 0) {
        $('body0')?.classList.add('open');
        $('arrow0')?.classList.add('open');
      }

      // 이미지 hover 이벤트 (이벤트 위임)
      setupImageHover();
    });
  }

  // ══════════════════════════════════════════
  // 이미지 hover → 확대 모달
  // ══════════════════════════════════════════
  let hoverTimer = null;
  function setupImageHover() {
    const content = $('content');
    const zoom = $('imgZoom');
    const zoomImg = $('imgZoomImg');

    content.addEventListener('mouseover', e => {
      const thumb = e.target.closest('.thumb');
      if (!thumb) return;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      const src = thumb.src;
      if (!src) return;
      const rect = thumb.getBoundingClientRect();
      zoomImg.src = src;
      zoom.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
      zoom.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 320)) + 'px';
      zoom.classList.add('show');
    });

    content.addEventListener('mouseout', e => {
      const thumb = e.target.closest('.thumb');
      if (!thumb) return;
      hoverTimer = setTimeout(() => {
        zoom.classList.remove('show');
      }, 150);
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  // ══════════════════════════════════════════
  // Excel 내보내기 (SpreadsheetML 2003 — 다중 시트)
  // .xls 확장자로 Excel이 그대로 열림, 참조 xlsx와 동일 컬럼
  // ══════════════════════════════════════════
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function buildWorkbookXml(sheets) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<?mso-application progid="Excel.Sheet"?>\n';
    xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
    xml += 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ';
    xml += 'xmlns:x="urn:schemas-microsoft-com:office:excel" ';
    xml += 'xmlns:html="http://www.w3.org/TR/REC-html40">\n';
    xml += '<Styles>\n';
    xml += '<Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/>';
    xml += '<Interior ss:Color="#03C75A" ss:Pattern="Solid"/>';
    xml += '<Alignment ss:Vertical="Center" ss:Horizontal="Center"/></Style>\n';
    xml += '<Style ss:ID="kw"><Font ss:Bold="1"/><Interior ss:Color="#E8F5E9" ss:Pattern="Solid"/></Style>\n';
    xml += '</Styles>\n';

    for (const s of sheets) {
      xml += `<Worksheet ss:Name="${xmlEsc(s.name)}">\n<Table>\n`;
      // 컬럼 너비
      const widths = [120, 260, 140, 200, 180, 180, 200, 100, 100, 80, 140, 80, 100, 90, 80, 80, 80, 300];
      widths.forEach(w => { xml += `<Column ss:Width="${w}"/>`; });
      xml += '\n';
      // 헤더
      xml += '<Row>';
      xml += '<Cell ss:StyleID="hdr"><Data ss:Type="String">키워드</Data></Cell>';
      for (const h of COLS) {
        xml += `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`;
      }
      xml += '</Row>\n';
      // 데이터
      for (const row of s.rows) {
        xml += '<Row>';
        row.forEach((v, i) => {
          const isNum = typeof v === 'number';
          const type = isNum ? 'Number' : 'String';
          const val = isNum ? v : xmlEsc(v);
          const style = i === 0 ? ' ss:StyleID="kw"' : '';
          xml += `<Cell${style}><Data ss:Type="${type}">${val}</Data></Cell>`;
        });
        xml += '</Row>\n';
      }
      xml += '</Table>\n</Worksheet>\n';
    }
    xml += '</Workbook>';
    return xml;
  }

  function exportExcel() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (!r?.results?.length) { alert('내보낼 데이터 없음'); return; }

      const sheets = TAB_ORDER.map(tabType => ({
        name: TAB_NAME[tabType],
        rows: [],
      }));

      for (const kw of r.results) {
        for (let i = 0; i < TAB_ORDER.length; i++) {
          const tabType = TAB_ORDER[i];
          const data = kw.tabs[tabType];
          if (!data || !data.products) continue;
          for (const p of data.products) {
            sheets[i].rows.push([kw.keyword, ...productRow(p)]);
          }
        }
      }

      // 빈 시트는 header-only 로 두지 말고 안내 행 1개
      for (const s of sheets) {
        if (s.rows.length === 0) s.rows.push(['(수집된 데이터 없음)', '', '', '', '', '', '', '', '', '', 0, '', 0, '', 0, '', 0, 0, '']);
      }

      const xml = buildWorkbookXml(sheets);
      const BOM = '﻿';
      const blob = new Blob([BOM + xml], { type: 'application/vnd.ms-excel' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      const kwNames = r.results.map(k => k.keyword).slice(0, 3).join('_');
      const suffix = r.results.length > 3 ? `_외${r.results.length - 3}개` : '';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kwNames}${suffix}_상품목록_${ds}.xls`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // ══════════════════════════════════════════
  // 태그 Excel 내보내기 (SpreadsheetML — 키워드별 태그 통계)
  // ══════════════════════════════════════════
  function exportTagExcel() {
    chrome.runtime.sendMessage({ type: 'GET_RESULTS' }, r => {
      if (!r?.results?.length) { alert('내보낼 데이터 없음'); return; }

      const sheets = [];

      for (const kw of r.results) {
        const tagMap = {};
        for (const tabType of TAB_ORDER) {
          const data = kw.tabs[tabType];
          if (!data || !data.products) continue;
          for (const p of data.products) {
            const tag = fmtTag(p);
            if (!tag) continue;
            tag.split(',').forEach(t => {
              const tt = t.trim();
              if (tt) tagMap[tt] = (tagMap[tt] || 0) + 1;
            });
          }
        }
        const sorted = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);
        const rows = sorted.map(([tag, count]) => [kw.keyword, tag, count]);
        if (rows.length === 0) rows.push([kw.keyword, '(태그 없음)', 0]);
        sheets.push({ name: kw.keyword.slice(0, 31), rows });
      }

      // 모든 키워드 합산 시트
      const allTagMap = {};
      for (const kw of r.results) {
        for (const tabType of TAB_ORDER) {
          const data = kw.tabs[tabType];
          if (!data || !data.products) continue;
          for (const p of data.products) {
            const tag = fmtTag(p);
            if (!tag) continue;
            tag.split(',').forEach(t => {
              const tt = t.trim();
              if (tt) allTagMap[tt] = (allTagMap[tt] || 0) + 1;
            });
          }
        }
      }
      const allSorted = Object.entries(allTagMap).sort((a, b) => b[1] - a[1]);
      const allRows = allSorted.map(([tag, count]) => ['전체', tag, count]);
      if (allRows.length === 0) allRows.push(['전체', '(태그 없음)', 0]);

      const tagCols = ['키워드', '태그', '중복수'];

      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml += '<?mso-application progid="Excel.Sheet"?>\n';
      xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ';
      xml += 'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
      xml += '<Styles>\n';
      xml += '<Style ss:ID="hdr"><Font ss:Bold="1" ss:Color="#FFFFFF"/>';
      xml += '<Interior ss:Color="#8B5CF6" ss:Pattern="Solid"/>';
      xml += '<Alignment ss:Vertical="Center" ss:Horizontal="Center"/></Style>\n';
      xml += '</Styles>\n';

      // 전체 합산 시트 먼저
      xml += `<Worksheet ss:Name="전체합산">\n<Table>\n`;
      xml += '<Row>';
      for (const h of tagCols) xml += `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`;
      xml += '</Row>\n';
      for (const row of allRows) {
        xml += '<Row>';
        row.forEach(v => {
          const isNum = typeof v === 'number';
          xml += `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${isNum ? v : xmlEsc(v)}</Data></Cell>`;
        });
        xml += '</Row>\n';
      }
      xml += '</Table>\n</Worksheet>\n';

      // 키워드별 시트
      for (const s of sheets) {
        xml += `<Worksheet ss:Name="${xmlEsc(s.name)}">\n<Table>\n`;
        xml += '<Row>';
        for (const h of tagCols) xml += `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`;
        xml += '</Row>\n';
        for (const row of s.rows) {
          xml += '<Row>';
          row.forEach(v => {
            const isNum = typeof v === 'number';
            xml += `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${isNum ? v : xmlEsc(v)}</Data></Cell>`;
          });
          xml += '</Row>\n';
        }
        xml += '</Table>\n</Worksheet>\n';
      }

      xml += '</Workbook>';
      const BOM = '\uFEFF';
      const blob = new Blob([BOM + xml], { type: 'application/vnd.ms-excel' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      const kwNames = r.results.map(k => k.keyword).slice(0, 3).join('_');
      const suffix = r.results.length > 3 ? `_외${r.results.length - 3}개` : '';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kwNames}${suffix}_태그통계_${ds}.xls`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // 이벤트
  $('refresh').addEventListener('click', loadResults);
  $('xlsBtn').addEventListener('click', exportExcel);
  $('tagBtn').addEventListener('click', exportTagExcel);
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('수집된 모든 데이터를 삭제합니다.\n\n진행하시겠습니까?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_RESULTS' }, () => loadResults());
  });

  loadResults();
});
