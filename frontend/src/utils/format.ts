export function formatKRW(n: number | null | undefined): string {
  if (n == null) return '0';
  return Math.round(n).toLocaleString('ko-KR');
}

export function formatKoreanWon(n: number | null | undefined): string {
  if (n == null) return '0원';
  const v = Math.round(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}억원`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000).toLocaleString()}만원`;
  return `${v.toLocaleString()}원`;
}

export function formatKoreanShort(n: number | null | undefined): string {
  if (n == null) return '0';
  const v = Math.round(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}억`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000)}만`;
  return v.toLocaleString();
}
