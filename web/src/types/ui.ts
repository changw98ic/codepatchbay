export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Locale = 'en-US' | 'zh-CN';
export type GlassDepth = 'shallow' | 'medium' | 'deep';

export interface ToastItem {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  createdAt: number;
}
