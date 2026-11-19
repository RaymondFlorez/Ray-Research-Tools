import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'geoglobe.theme';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Storage blocked (private mode, sandboxed iframe) — fall through to the OS preference.
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches)
    return 'light';
  return 'dark';
}

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Non-fatal: the theme simply won't persist.
  }
}

/** UI-only state (not part of Scene State): theme and the command palette. */
interface UiStore {
  theme: Theme;
  paletteOpen: boolean;
  toggleTheme: () => void;
  setPaletteOpen: (open: boolean) => void;
}

const initialTheme = readTheme();
applyTheme(initialTheme);

export const useUiStore = create<UiStore>((set, get) => ({
  theme: initialTheme,
  paletteOpen: false,
  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    set({ theme });
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));
