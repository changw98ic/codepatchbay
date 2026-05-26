import { create } from 'zustand';
import type { Theme, ResolvedTheme, Locale, ToastItem } from '@/types/ui';

interface UIStore {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  sidebarCollapsed: boolean;
  locale: Locale;
  toasts: ToastItem[];
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setLocale: (locale: Locale) => void;
  addToast: (message: string, type?: ToastItem['type']) => void;
  removeToast: (id: string) => void;
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
}

let toastCounter = 0;

export const useUIStore = create<UIStore>((set) => ({
  theme: (localStorage.getItem('cpb-theme') as Theme) || 'dark',
  resolvedTheme: resolveTheme((localStorage.getItem('cpb-theme') as Theme) || 'dark'),
  sidebarCollapsed: false,
  locale: (localStorage.getItem('cpb-locale') as Locale) || 'en-US',
  toasts: [],

  setTheme: (theme) => {
    const resolved = resolveTheme(theme);
    localStorage.setItem('cpb-theme', theme);
    applyTheme(resolved);
    set({ theme, resolvedTheme: resolved });
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setLocale: (locale) => {
    localStorage.setItem('cpb-locale', locale);
    set({ locale });
  },

  addToast: (message, type = 'info') => {
    const id = `toast-${++toastCounter}`;
    const toast: ToastItem = { id, message, type, createdAt: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },

  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

// Apply theme on load
if (typeof window !== 'undefined') {
  const initial = (localStorage.getItem('cpb-theme') as Theme) || 'dark';
  applyTheme(resolveTheme(initial));
}
