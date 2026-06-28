/**
 * AI 편집 도구 아이콘 세트.
 * viewBox 24x24, stroke 기반 (currentColor), stroke-width 1.8, round.
 * 출처: docs/files.zip ai_icons.js + 갤러리/저장 아이콘 추가.
 */
import type { CSSProperties } from 'react';

export type AiIconName =
  // 기본 5종
  | 'bg-remove' | 'text-remove' | 'upscale' | 'rotate' | 'flip'
  // FLUX 7종
  | 'flux-bg-replace' | 'flux-prompt' | 'flux-variations'
  | 'flux-tile-upscale' | 'flux-style-ref' | 'flux-edge' | 'flux-depth'
  // 액션
  | 'gallery' | 'save-activate' | 'save-pool' | 'undo' | 'reset'
  // 후처리
  | 'adjust' | 'filter' | 'pad-square' | 'frame' | 'ocr';

export const AI_ICONS: Record<AiIconName, React.ReactNode> = {
  // ── 기본 5종 ──
  'bg-remove': (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M15 4.5h5.5v5.5" strokeDasharray="2 2" />
      <path d="M20.5 14v5.5H15" strokeDasharray="2 2" />
    </>
  ),
  'text-remove': (
    <>
      <path d="M3.5 17 8 6l4.5 11" />
      <path d="M5 13.2h6" />
      <rect x="13" y="13.5" width="8" height="5" rx="1.2" transform="rotate(-32 17 16)" />
      <path d="M14.6 14.4 18.4 18" />
    </>
  ),
  'upscale': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m20 20-4.6-4.6" />
      <path d="M10.5 8v5M8 10.5h5" />
      <path d="M3 3.5 5.5 6M3 3.5v2.2M3 3.5h2.2" />
    </>
  ),
  'rotate': (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V9h-4.5" />
      <path d="M12 9.5v-1.5M12 16v-1.5M9.5 12H8M16 12h-1.5" />
    </>
  ),
  'flip': (
    <>
      <path d="M12 3v18" strokeDasharray="2.5 2.5" />
      <path d="M9 8 5 12l4 4" />
      <path d="M15 8l4 4-4 4" />
      <path d="M5 12h4M15 12h4" />
    </>
  ),

  // ── FLUX 7종 ──
  'flux-bg-replace': (
    <>
      <rect x="3" y="4.5" width="14" height="13" rx="1.6" />
      <circle cx="8" cy="9" r="1.6" />
      <path d="M3.5 15l3.5-3.5 3 3 3.5-3.5 3.5 3.5" />
      <path d="M18.5 17.5l1.2 1.2M20.5 14v2M20.5 18v2M18.5 16h2M22.5 16h-2" />
    </>
  ),
  'flux-prompt': (
    <>
      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h12a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 16H9l-4 4v-4H6" />
      <path d="M13.5 7l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </>
  ),
  'flux-variations': (
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.2" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.2" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.2" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.2" />
      <path d="M16.75 15.2l.7 1.35 1.35.7-1.35.7-.7 1.35-.7-1.35-1.35-.7 1.35-.7z" />
    </>
  ),
  'flux-tile-upscale': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.6" />
      <path d="M4 12h16M12 4v16" strokeDasharray="2 2" />
      <path d="M14.5 9.5 19 5M19 5h-3.2M19 5v3.2" />
      <path d="M9.5 14.5 5 19M5 19h3.2M5 19v-3.2" />
    </>
  ),
  'flux-style-ref': (
    <>
      <rect x="3.5" y="5" width="11.5" height="11.5" rx="1.6" />
      <circle cx="7.3" cy="8.8" r="1.3" />
      <path d="M3.8 13.5 7 10.5l2.6 2.4 2.4-2.2 1.6 1.5" />
      <path d="M18 9.5a4.5 4.5 0 1 1-4 7.8c-.9-.5-.3-1.7.6-1.8.8-.1 1.5-.6 1.5-1.5 0-1 .9-1.6 1.9-1.5" />
    </>
  ),
  'flux-edge': (
    <>
      <path d="M7 4.5h7l5.5 5.5v7" strokeDasharray="2 2" />
      <path d="M5 8.5v9.5a1.5 1.5 0 0 0 1.5 1.5H16" strokeDasharray="2 2" />
      <path d="M9.5 9.5a3.5 3.5 0 1 1 0 5" />
      <path d="M9.5 14v-1.8h1.8" />
    </>
  ),
  'flux-depth': (
    <>
      <path d="M12 3.2 20 7.5v9L12 20.8 4 16.5v-9z" />
      <path d="M12 3.2v8.6M12 11.8 4 7.5M12 11.8 20 7.5" />
      <path d="M8 13.5v3.2M16 13.5v3.2" />
    </>
  ),

  // ── 액션 ──
  'gallery': (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.2" />
      <rect x="13" y="3" width="8" height="8" rx="1.2" />
      <rect x="3" y="13" width="8" height="8" rx="1.2" />
      <rect x="13" y="13" width="8" height="8" rx="1.2" />
      <circle cx="7" cy="7" r="1" />
      <path d="M3 11l3-3 2 2 3-3" />
    </>
  ),
  'save-activate': (
    <>
      <path d="M5 3.5h11l3 3v11.5A1.5 1.5 0 0 1 17.5 19.5h-12A1.5 1.5 0 0 1 4 18V5a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M7 3.5v5h8v-5" />
      <circle cx="11.5" cy="14" r="3.5" />
      <path d="m9.7 14 1.3 1.3 2.5-2.5" />
    </>
  ),
  'save-pool': (
    <>
      <path d="M3.5 8.5 12 4l8.5 4.5L12 13z" />
      <path d="M3.5 12.5 12 17l8.5-4.5" />
      <path d="M3.5 16.5 12 21l8.5-4.5" />
      <circle cx="19" cy="6" r="2.5" fill="currentColor" stroke="none" opacity="0.85" />
      <path d="M19 4.8v2.4M17.8 6h2.4" stroke="#fff" strokeWidth="1.4" />
    </>
  ),
  'undo': (
    <>
      <path d="M4 9.5h10a5 5 0 0 1 0 10H8" />
      <path d="M8 5.5 4 9.5l4 4" />
    </>
  ),
  'reset': (
    <>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4.5V9h4.5" />
    </>
  ),

  // ── 후처리 ──
  'adjust': (
    <>
      <circle cx="6" cy="8" r="1.5" />
      <path d="M3 8h1.5M7.5 8H21" />
      <circle cx="14" cy="13" r="1.5" />
      <path d="M3 13h9.5M15.5 13H21" />
      <circle cx="9" cy="18" r="1.5" />
      <path d="M3 18h4.5M10.5 18H21" />
    </>
  ),
  'filter': (
    <>
      <circle cx="9" cy="10" r="4.5" />
      <circle cx="15" cy="10" r="4.5" opacity="0.6" />
      <circle cx="12" cy="15" r="4.5" opacity="0.6" />
    </>
  ),
  'pad-square': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.2" />
      <rect x="7.5" y="7.5" width="9" height="9" rx="0.8" strokeDasharray="2 2" />
    </>
  ),
  'frame': (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
      <rect x="6" y="6" width="12" height="12" rx="1" opacity="0.7" />
    </>
  ),
  'ocr': (
    <>
      <path d="M4 7V5h4M16 5h4v2M20 17v2h-4M8 19H4v-2" />
      <path d="M7 16 10 8l3 8M8 13.5h4" />
      <path d="M15 11h2.5M15 14h2" />
    </>
  ),
};

interface IconProps {
  name: AiIconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function AiIcon({ name, size = 24, className = '', style }: IconProps) {
  const inner = AI_ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round"
         className={className} style={style} aria-hidden>
      {inner}
    </svg>
  );
}
