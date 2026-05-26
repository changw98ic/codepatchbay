import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Project } from '@/types/api';

interface ProjectsStore {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: (diagnostics?: boolean, includeTest?: boolean) => Promise<void>;
  updateProject: (name: string, updates: Partial<Project>) => void;
  getProject: (name: string) => Project | undefined;
}

export const useProjectsStore = create<ProjectsStore>()(
  subscribeWithSelector((set, get) => ({
    projects: [],
    loading: true,
    error: null,

    fetchProjects: async (diagnostics = false, includeTest = false) => {
      set({ loading: true, error: null });
      try {
        const params = new URLSearchParams();
        if (diagnostics) params.set('diagnostics', '1');
        if (includeTest) params.set('includeTest', '1');
        const qs = params.toString();
        const res = await fetch(`/api/projects${qs ? `?${qs}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        set({ projects: data, loading: false });
      } catch (err) {
        set({ error: (err as Error).message, loading: false });
      }
    },

    updateProject: (name, updates) => {
      set((state) => ({
        projects: state.projects.map((p) =>
          p.name === name ? { ...p, ...updates } : p,
        ),
      }));
    },

    getProject: (name) => get().projects.find((p) => p.name === name),
  })),
);
