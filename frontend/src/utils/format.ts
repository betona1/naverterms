export function formatKRW(n: number | null | undefined): string {
  if (n == null) return '0';
  return Math.round(n).toLocaleString('ko-KR');
}
