import { create } from 'zustand';
import type {
  InboxRequestRow,
  InboxResponse,
  InboxRequestDetail,
  InboxProjectSummary,
} from '@/types/api';

interface InboxFilters {
  status?: string;
  priority?: string;
  project?: string;
  type?: string;
  sort?: 'newest' | 'oldest';
  search?: string;
  attentionOnly?: boolean;
}

interface InboxStore {
  items: InboxRequestRow[];
  projects: string[];
  statusCounts: Record<string, number>;
  projectSummaries: InboxProjectSummary[];
  total: number;
  filters: InboxFilters;
  selectedId: string | null;
  detail: InboxRequestDetail | null;
  loading: boolean;
  detailLoading: boolean;

  setFilter: <K extends keyof InboxFilters>(key: K, value: InboxFilters[K] | undefined) => void;
  clearFilters: () => void;
  fetchInbox: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  selectRequest: (id: string | null) => Promise<void>;
  acceptReviewBundle: (id: string, feedback?: string) => Promise<void>;
  rejectReviewBundle: (id: string, feedback: string) => Promise<void>;
}

function buildQueryString(filters: InboxFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.project) params.set('project', filters.project);
  if (filters.type) params.set('type', filters.type);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.attentionOnly) params.set('attentionOnly', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const useInboxStore = create<InboxStore>((set, get) => ({
  items: [],
  projects: [],
  statusCounts: {},
  projectSummaries: [],
  total: 0,
  filters: {},
  selectedId: null,
  detail: null,
  loading: false,
  detailLoading: false,

  setFilter: (key, value) => {
    set((state) => ({
      filters: { ...state.filters, [key]: value || undefined },
    }));
  },

  clearFilters: () => {
    set({ filters: {} });
  },

  fetchInbox: async () => {
    set({ loading: true });
    try {
      const qs = buildQueryString(get().filters);
      const res = await fetch(`/api/inbox${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: InboxResponse = await res.json();

      let items = data.items;
      const search = get().filters.search?.toLowerCase();
      if (search) {
        items = items.filter(
          (r) =>
            r.task?.toLowerCase().includes(search) ||
            r.project?.toLowerCase().includes(search) ||
            r.id?.toLowerCase().includes(search),
        );
      }

      set({
        items,
        projects: data.projects,
        statusCounts: data.statusCounts,
        total: search ? items.length : data.total,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  fetchProjects: async () => {
    try {
      const res = await fetch('/api/inbox/projects');
      if (!res.ok) return;
      const data = await res.json();
      const summaries: InboxProjectSummary[] = data.projects ?? [];
      set({
        projectSummaries: summaries,
        projects: summaries.map((p) => p.name),
      });
    } catch {
      // ignore
    }
  },

  selectRequest: async (id) => {
    if (id === null) {
      set({ selectedId: null, detail: null });
      return;
    }
    set({ selectedId: id, detailLoading: true, detail: null });
    try {
      const res = await fetch(`/api/inbox/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: InboxRequestDetail = await res.json();
      set({ detail: data, detailLoading: false });
    } catch {
      set({ detailLoading: false });
    }
  },

  acceptReviewBundle: async (id, feedback = '') => {
    const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/review-bundle/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'inbox', feedback }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().selectRequest(id);
    await get().fetchInbox();
  },

  rejectReviewBundle: async (id, feedback) => {
    const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/review-bundle/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'inbox', feedback }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().selectRequest(id);
    await get().fetchInbox();
  },
}));
