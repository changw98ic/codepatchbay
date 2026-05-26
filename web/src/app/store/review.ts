import { create } from 'zustand';
import type { ReviewSession } from '@/types/api';

interface ReviewStore {
  sessions: ReviewSession[];
  selectedId: string | null;
  page: number;
  query: string;
  loading: boolean;
  totalPages: number;
  fetchSessions: () => Promise<void>;
  selectSession: (id: string | null) => void;
  setPage: (page: number) => void;
  setQuery: (query: string) => void;
  approve: (id: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  startReview: (id: string) => Promise<void>;
  autoApprove: (id: string) => Promise<void>;
  analyze: (id: string) => Promise<void>;
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  sessions: [],
  selectedId: null,
  page: 1,
  query: '',
  loading: true,
  totalPages: 1,

  fetchSessions: async () => {
    set({ loading: true });
    try {
      const { page, query } = get();
      const params = new URLSearchParams({ page: String(page), limit: '10' });
      if (query) params.set('q', query);
      const res = await fetch(`/api/review?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw: Record<string, unknown>[] = Array.isArray(data) ? data : (data.sessions ?? []);
      const sessions: ReviewSession[] = raw.map((s) => {
        const reviews = (s.reviews ?? []) as Record<string, unknown>[];
        return {
          id: (s.sessionId as string) ?? '',
          project: (s.project as string) ?? '',
          status: (s.status as ReviewSession['status']) ?? 'queued',
          instruction: (s.intent as string) ?? '',
          research: s.research as { codex?: string; claude?: string } | undefined,
          plan: s.plan as string | undefined,
          reviewRounds: reviews.map((r) => {
            const codexIssues = ((r.codexIssues ?? []) as Record<string, unknown>[]).map((i) => ({
              severity: (['critical', 'major', 'minor'][i.severity as number] ?? 'minor') as 'critical' | 'major' | 'minor',
              file: '',
              message: (i.description as string) ?? '',
            }));
            const claudeIssues = ((r.claudeIssues ?? []) as Record<string, unknown>[]).map((i) => ({
              severity: (['critical', 'major', 'minor'][i.severity as number] ?? 'minor') as 'critical' | 'major' | 'minor',
              file: '',
              message: (i.description as string) ?? '',
            }));
            return {
              round: (r.round as number) ?? 0,
              issues: [...codexIssues, ...claudeIssues],
              verdict: ((r.codex as string) ?? '').includes('PASS') ? 'PASS' as const : 'FAIL' as const,
            };
          }),
          createdAt: (s.createdAt as string) ?? '',
          updatedAt: (s.updatedAt as string) ?? '',
        };
      });
      set({
        sessions,
        totalPages: data.totalPages ?? (Math.ceil(raw.length / 10) || 1),
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  selectSession: (id) => set({ selectedId: id }),
  setPage: (page) => { set({ page }); get().fetchSessions(); },
  setQuery: (query) => { set({ query, page: 1 }); get().fetchSessions(); },

  approve: async (id) => {
    await fetch(`/api/review/${id}/approve`, { method: 'POST' });
    get().fetchSessions();
  },

  reject: async (id, reason) => {
    await fetch(`/api/review/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    get().fetchSessions();
  },

  cancel: async (id) => {
    await fetch(`/api/review/${id}/cancel`, { method: 'POST' });
    get().fetchSessions();
  },

  startReview: async (id) => {
    await fetch(`/api/review/${id}/start`, { method: 'POST' });
    get().fetchSessions();
  },

  autoApprove: async (id) => {
    await fetch(`/api/review/${id}/auto-approve`, { method: 'POST' });
    get().fetchSessions();
  },

  analyze: async (id) => {
    await fetch(`/api/review/${id}/analyze`, { method: 'POST' });
    get().fetchSessions();
  },
}));
