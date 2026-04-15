import { useState, useCallback } from 'react';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'app-theme';

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'light';
    } catch {
      return 'light';
    }
  });

  const toggle = useCallback(() => {
    setMode(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* */ }
      return next;
    });
  }, []);

  const dark = mode === 'dark';

  return { mode, dark, toggle };
}
