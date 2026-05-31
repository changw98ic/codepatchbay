import { create } from 'zustand';
import type {
  WorkspaceConfig,
  WorkspaceIndexEntry,
  WorkspacePrepareResult,
  WorkspaceStatusResult,
  BackendHealthResult,
} from '@/types/api';

interface WorkspacesStore {
  workspaces: WorkspaceIndexEntry[];
  activeWorkspace: WorkspaceConfig | null;
  prepareResult: WorkspacePrepareResult | null;
  statusResult: WorkspaceStatusResult | null;
  backendHealth: Record<string, BackendHealthResult> | null;
  loading: boolean;
  error: string | null;

  fetchWorkspaces: () => Promise<void>;
  fetchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (config: Partial<WorkspaceConfig> & { id: string; projectId: string }) => Promise<WorkspaceConfig | null>;
  updateWorkspace: (id: string, updates: Partial<WorkspaceConfig>) => Promise<WorkspaceConfig | null>;
  deleteWorkspace: (id: string) => Promise<boolean>;
  prepareWorkspace: (id: string, sourcePath?: string) => Promise<WorkspacePrepareResult | null>;
  teardownWorkspace: (id: string) => Promise<void>;
  fetchStatus: (id: string) => Promise<void>;
  fetchBackendHealth: () => Promise<void>;
  clearError: () => void;
}

export const useWorkspacesStore = create<WorkspacesStore>((set) => ({
  workspaces: [],
  activeWorkspace: null,
  prepareResult: null,
  statusResult: null,
  backendHealth: null,
  loading: false,
  error: null,

  fetchWorkspaces: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/workspaces');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const workspaces: WorkspaceIndexEntry[] = await res.json();
      set({ workspaces, loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  fetchWorkspace: async (id) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/workspaces/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const activeWorkspace: WorkspaceConfig = await res.json();
      set({ activeWorkspace, loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  createWorkspace: async (config) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      const workspace: WorkspaceConfig = await res.json();
      set((state) => ({
        workspaces: [...state.workspaces, { id: workspace.id, projectId: workspace.projectId, type: workspace.type, createdAt: workspace.createdAt }],
        activeWorkspace: workspace,
        loading: false,
      }));
      return workspace;
    } catch (err: any) {
      set({ error: err.message, loading: false });
      return null;
    }
  },

  updateWorkspace: async (id, updates) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const workspace: WorkspaceConfig = await res.json();
      set({ activeWorkspace: workspace, loading: false });
      return workspace;
    } catch (err: any) {
      set({ error: err.message, loading: false });
      return null;
    }
  },

  deleteWorkspace: async (id) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        activeWorkspace: state.activeWorkspace?.id === id ? null : state.activeWorkspace,
        loading: false,
      }));
      return true;
    } catch (err: any) {
      set({ error: err.message, loading: false });
      return false;
    }
  },

  prepareWorkspace: async (id, sourcePath) => {
    set({ loading: true, error: null });
    try {
      const body: any = {};
      if (sourcePath) body.sourcePath = sourcePath;
      const res = await fetch(`/api/workspaces/${id}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: WorkspacePrepareResult = await res.json();
      set({ prepareResult: result, loading: false });
      return result;
    } catch (err: any) {
      set({ error: err.message, loading: false });
      return null;
    }
  },

  teardownWorkspace: async (id) => {
    set({ loading: true, error: null });
    try {
      await fetch(`/api/workspaces/${id}/teardown`, { method: 'POST' });
      set({ prepareResult: null, loading: false });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  fetchStatus: async (id) => {
    try {
      const res = await fetch(`/api/workspaces/${id}/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const statusResult: WorkspaceStatusResult = await res.json();
      set({ statusResult });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchBackendHealth: async () => {
    try {
      const res = await fetch('/api/workspaces/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const backendHealth: Record<string, BackendHealthResult> = await res.json();
      set({ backendHealth });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  clearError: () => set({ error: null }),
}));
