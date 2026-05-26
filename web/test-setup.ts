import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import React from 'react';

// Mock react-i18next — return keys as display text
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      let result = key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(`{{${k}}}`, String(v));
        }
      }
      return result;
    },
    i18n: {
      changeLanguage: vi.fn(),
      language: 'en',
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock Vanilla Extract — returns class names as-is in tests
vi.mock('@vanilla-extract/css', () => {
  const handler = {
    get(_target: unknown, prop: string) {
      if (typeof prop === 'string') return prop;
      return undefined;
    },
  };
  return {
    style: (obj: unknown) => `ve_${JSON.stringify(obj)}`,
    styleVariants: (map: Record<string, unknown>) => {
      const result: Record<string, string> = {};
      for (const key of Object.keys(map)) {
        result[key] = `ve_var_${key}`;
      }
      return result;
    },
    createThemeContract: () => new Proxy({}, handler),
    createGlobalTheme: (_sel: unknown, tokens: Record<string, string>) => {
      const result: Record<string, string> = {};
      for (const key of Object.keys(tokens)) {
        result[key] = `var(--${key})`;
      }
      return result;
    },
    globalStyle: vi.fn(),
    globalKeyframes: vi.fn(),
    assignVars: vi.fn(() => ({})),
    createVar: () => 'var(--mock)',
    fontFace: vi.fn(() => ''),
    keyframes: (obj: unknown) => `kf_${JSON.stringify(obj)}`,
  };
});

vi.mock('@vanilla-extract/recipes', () => ({
  recipe: (obj: unknown) => {
    const variants = (obj as Record<string, unknown>)?.variants as Record<string, Record<string, string>> | undefined;
    const base = (obj as Record<string, unknown>)?.base as string | undefined;
    return (params: Record<string, string>) => {
      const classes = [base];
      if (variants) {
        for (const [vKey, vMap] of Object.entries(variants)) {
          const selected = params[vKey];
          if (selected && vMap[selected]) classes.push(vMap[selected]);
        }
      }
      return classes.filter(Boolean).join(' ');
    };
  },
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock scrollIntoView
if (typeof window !== 'undefined' && window.HTMLElement) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(global, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(global, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});
