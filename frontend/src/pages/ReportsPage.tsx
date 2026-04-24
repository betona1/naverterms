import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useTheme } from '../hooks/useTheme';
import { getReports, getReport, deleteReport, downloadReport, type Report } from '../api/naverApi';

const TYPE_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  monthly: { label: '월간보고서', bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  analysis: { label: '분석', bg: 'bg-blue-500/20', text: 'text-blue-400' },
};
const TYPE_BADGE_LIGHT: Record<string, { bg: string; text: string }> = {
  monthly: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  analysis: { bg: 'bg-blue-100', text: 'text-blue-700' },
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ReportsPage() {
  const { dark } = useTheme();
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReports(await getReports());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleOpen = async (id: number) => {
    try {
      const r = await getReport(id);
      setSelected(r);
    } catch {
      alert('보고서를 불러올 수 없습니다.');
    }
  };

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('이 보고서를 삭제하시겠습니까?')) return;
    setDeleting(id);
    try {
      await deleteReport(id);
      setReports(prev => prev.filter(r => r.id !== id));
      if (selected?.id === id) setSelected(null);
    } finally {
      setDeleting(null);
    }
  };

  const handleDownload = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    downloadReport(id);
  };

  // ── 상세 뷰 ──
  if (selected) {
    const badge = dark ? TYPE_BADGE[selected.report_type] : TYPE_BADGE_LIGHT[selected.report_type];
    return (
      <div className={`min-h-screen p-6 ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'}`}>
        <div className={`max-w-5xl mx-auto rounded-xl shadow-lg ${dark ? 'bg-[#1c1c2e]' : 'bg-white'}`}>
          {/* Header */}
          <div className={`flex items-center gap-3 px-6 py-4 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
            <button
              onClick={() => setSelected(null)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors
                ${dark ? 'bg-[#252540] text-gray-300 hover:bg-[#303050]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              &larr; 목록
            </button>
            <div className="flex-1 min-w-0">
              <h1 className={`text-lg font-bold truncate ${dark ? 'text-white' : 'text-gray-900'}`}>
                {selected.title}
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                {badge && (
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${badge.bg} ${badge.text}`}>
                    {TYPE_BADGE[selected.report_type]?.label || selected.report_type}
                  </span>
                )}
                <span className={`text-[12px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {formatDate(selected.created_at)}
                </span>
              </div>
            </div>
            <button
              onClick={() => downloadReport(selected.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              다운로드
            </button>
          </div>

          {/* Markdown Content */}
          <div className={`px-6 py-5 prose max-w-none
            ${dark
              ? 'prose-invert prose-headings:text-gray-100 prose-p:text-gray-300 prose-strong:text-gray-200 prose-li:text-gray-300 prose-td:text-gray-300 prose-th:text-gray-200 prose-a:text-blue-400'
              : 'prose-headings:text-gray-900 prose-p:text-gray-700 prose-td:text-gray-700 prose-th:text-gray-900'
            }
            prose-table:w-full prose-th:px-3 prose-th:py-2 prose-td:px-3 prose-td:py-2
            prose-th:text-left prose-th:text-[13px] prose-td:text-[13px]
            prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
            ${dark
              ? 'prose-table:border-[#2a2a40] prose-th:border-[#2a2a40] prose-td:border-[#2a2a40] prose-hr:border-[#2a2a40]'
              : 'prose-table:border-gray-200 prose-th:border-gray-200 prose-td:border-gray-200'
            }
          `}>
            <ReactMarkdown>{selected.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  // ── 게시판 목록 뷰 ──
  return (
    <div className={`min-h-screen p-6 ${dark ? 'bg-[#0f0f1a]' : 'bg-[#f7f8fa]'}`}>
      <div className={`max-w-5xl mx-auto rounded-xl shadow-lg ${dark ? 'bg-[#1c1c2e]' : 'bg-white'}`}>
        {/* Title bar */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${dark ? 'border-[#2a2a40]' : 'border-gray-200'}`}>
          <h1 className={`text-lg font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>
            <svg className="w-5 h-5 inline-block mr-2 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            보고서
          </h1>
          <span className={`text-[13px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            총 {reports.length}건
          </span>
        </div>

        {loading ? (
          <div className={`text-center py-16 text-[14px] ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            불러오는 중...
          </div>
        ) : reports.length === 0 ? (
          <div className={`text-center py-16 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-[14px]">등록된 보고서가 없습니다</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className={`text-[12px] ${dark ? 'text-gray-500 border-b border-[#2a2a40]' : 'text-gray-400 border-b border-gray-100'}`}>
                <th className="w-12 text-center py-3 font-medium">#</th>
                <th className="text-left py-3 font-medium pl-2">제목</th>
                <th className="w-24 text-center py-3 font-medium">유형</th>
                <th className="w-40 text-center py-3 font-medium">작성일</th>
                <th className="w-24 text-center py-3 font-medium">관리</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r, i) => {
                const badge = dark ? TYPE_BADGE[r.report_type] : TYPE_BADGE_LIGHT[r.report_type];
                return (
                  <tr
                    key={r.id}
                    onClick={() => handleOpen(r.id)}
                    className={`cursor-pointer transition-colors text-[13px]
                      ${dark
                        ? 'hover:bg-[#252540] border-b border-[#2a2a40]'
                        : 'hover:bg-gray-50 border-b border-gray-100'
                      }`}
                  >
                    <td className={`text-center py-3 ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {reports.length - i}
                    </td>
                    <td className={`py-3 pl-2 font-medium ${dark ? 'text-gray-200' : 'text-gray-800'}`}>
                      {r.title}
                    </td>
                    <td className="text-center py-3">
                      {badge && (
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${badge.bg} ${badge.text}`}>
                          {TYPE_BADGE[r.report_type]?.label || r.report_type}
                        </span>
                      )}
                    </td>
                    <td className={`text-center py-3 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {formatDate(r.created_at)}
                    </td>
                    <td className="text-center py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={(e) => handleDownload(r.id, e)}
                          className={`p-1.5 rounded transition-colors ${dark ? 'text-gray-500 hover:text-blue-400 hover:bg-blue-500/10' : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'}`}
                          title="다운로드"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => handleDelete(r.id, e)}
                          disabled={deleting === r.id}
                          className={`p-1.5 rounded transition-colors ${dark ? 'text-gray-500 hover:text-red-400 hover:bg-red-500/10' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}`}
                          title="삭제"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
