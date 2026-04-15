import { useState, useEffect, useRef } from 'react';
import { fetchProductOrders, type ProductOrdersResponse, type SiteSummary } from '../../api/smartstoreProductApi';
import { formatKRW } from '../../utils/format';

interface Props {
  code: string;
  productName: string;
  onClose: () => void;
}

const SITE_SHORT: Record<string, string> = {
  '01.지마켓': 'G마켓', '02.옥션': '옥션', '03.11번가': '11번가',
  '04.스마트스토어': '스마트', '06.쿠팡': '쿠팡',
};

const PERIOD_OPTIONS = [
  { days: 7, label: '7일' },
  { days: 30, label: '30일' },
  { days: 90, label: '90일' },
  { days: 180, label: '6개월' },
  { days: 365, label: '1년' },
  { days: 0, label: '전체' },
];

export default function ProductOrdersModal({ code, productName, onClose }: Props) {
  const [data, setData] = useState<ProductOrdersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(0); // 0=전체, 첫 로드 시 전체로 시작
  const autoDetected = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    let startStr = '';
    let endStr = '';
    if (days > 0) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days);
      startStr = start.toISOString().slice(0, 10);
      endStr = end.toISOString().slice(0, 10);
    }

    fetchProductOrders(code, startStr, endStr, code ? undefined : productName)
      .then(res => {
        if (cancelled) return;
        // 첫 전체 로드: 주문 30건 초과 시 → 30일로 자동 전환
        if (!autoDetected.current && days === 0) {
          autoDetected.current = true;
          if (res.summary.count > 30) {
            setDays(30);
            return;
          }
        }
        setData(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [code, productName, days]);

  const orders = data?.orders ?? [];
  const s = data?.summary;
  const bySite: SiteSummary[] = data?.by_site ?? [];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-[95vw] max-w-[900px] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold px-1.5 py-[1px] rounded bg-[#03c75a]/10 text-[#03c75a]">스마트스토어</span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-mono">{code || '코드없음'}</span>
            </div>
            <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100 truncate" title={productName}>{productName}</p>
          </div>
          <div className="flex items-center gap-1 ml-3 flex-wrap justify-end">
            {PERIOD_OPTIONS.map(opt => (
              <button key={opt.days} onClick={() => setDays(opt.days)}
                className={`px-2 py-1 rounded text-[11px] font-bold transition-colors ${
                  days === opt.days
                    ? 'bg-[#03c75a] text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}>{opt.label}</button>
            ))}
          </div>
          <button onClick={onClose} className="text-[18px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 ml-3 leading-none">&times;</button>
        </div>

        {/* 요약 */}
        {s && !loading && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-2.5 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-[12px] text-gray-600 dark:text-gray-300">
            <span>주문 <b className="text-gray-900 dark:text-white">{s.count}건</b></span>
            <span>수량 <b className="text-gray-900 dark:text-white">{s.total_qty}</b></span>
            <span>주문금액 <b className="text-gray-900 dark:text-white">{formatKRW(s.total_payment)}</b></span>
            <span>정산 <b className="text-gray-900 dark:text-white">{formatKRW(s.total_settle)}</b></span>
            <span>원가 <b className="text-gray-900 dark:text-white">{formatKRW(s.total_cost)}</b></span>
            <span>이익 <b className={s.total_profit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{formatKRW(s.total_profit)}</b></span>
            {bySite.length > 0 && (
              <span className="ml-auto flex items-center gap-2 text-[11px]">
                {bySite.map((site, idx) => {
                  const sn = SITE_SHORT[site.site_name] || site.site_name.replace(/^\d+\./, '');
                  const isSS = site.site_name === '04.스마트스토어';
                  return (
                    <span key={idx} className={isSS ? 'font-bold text-[#03c75a]' : 'text-gray-400 dark:text-gray-500'}>
                      {sn} {site.count}건/{site.qty}개
                    </span>
                  );
                })}
              </span>
            )}
          </div>
        )}

        {/* 주문 목록 */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="py-10 text-center text-[13px] text-gray-400 animate-pulse">불러오는 중...</div>
          ) : orders.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-gray-400">주문 내역이 없습니다.</div>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0">
                <tr className="bg-gray-50 dark:bg-gray-700">
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">#</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">주문일</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">마켓</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">상태</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">수신자</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">수량</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">주문금액</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">정산</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">원가</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">이익</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => {
                  const sn = SITE_SHORT[o.site_name] || o.site_name.replace(/^\d+\./, '');
                  return (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50/50 dark:bg-gray-750'}>
                      <td className="px-3 py-1.5 text-gray-400 border-b border-gray-100 dark:border-gray-700">{i + 1}</td>
                      <td className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 tabular-nums text-gray-700 dark:text-gray-300">{o.order_date}</td>
                      <td className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-400">{sn}</td>
                      <td className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-400">{o.order_status}</td>
                      <td className="px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 max-w-[100px] truncate text-gray-600 dark:text-gray-400">{o.receiver_name}</td>
                      <td className="px-3 py-1.5 text-right border-b border-gray-100 dark:border-gray-700 tabular-nums text-gray-700 dark:text-gray-300">{o.quantity}</td>
                      <td className="px-3 py-1.5 text-right border-b border-gray-100 dark:border-gray-700 tabular-nums font-semibold text-gray-900 dark:text-gray-100">{formatKRW(o.payment_price)}</td>
                      <td className="px-3 py-1.5 text-right border-b border-gray-100 dark:border-gray-700 tabular-nums text-gray-600 dark:text-gray-400">{formatKRW(o.settlement_price)}</td>
                      <td className="px-3 py-1.5 text-right border-b border-gray-100 dark:border-gray-700 tabular-nums text-gray-600 dark:text-gray-400">{formatKRW(o.cost)}</td>
                      <td className={`px-3 py-1.5 text-right border-b border-gray-100 dark:border-gray-700 tabular-nums font-semibold ${
                        o.profit > 0 ? 'text-green-600 dark:text-green-400' : o.profit < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-600'
                      }`}>{formatKRW(o.profit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 닫기 */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 text-right">
          <button onClick={onClose} className="px-4 py-1.5 text-[12px] bg-gray-600 text-white rounded hover:bg-gray-500 transition-colors">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
