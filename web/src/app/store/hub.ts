import { create } from 'zustand';
import type { HubDashboard, HubProject } from '@/types/api';

interface HubStore {
  status: HubDashboard['status'] | null;
  projects: HubProject[];
  acp: HubDashboard['acp'] | null;
  queueStatus: HubDashboard['queueStatus'] | null;
  queueEntries: HubDashboard['queueEntries'];
  dispatches: HubDashboard['dispatches'];
  taskLedger: HubDashboard['taskLedger'];
  observability: unknown;
  knowledgePolicy: unknown;
  loading: boolean;
  fetchHubData: (includeTest?: boolean) => Promise<void>;
}

export const useHubStore = create<HubStore>((set) => ({
  status: null,
  projects: [],
  acp: null,
  queueStatus: null,
  queueEntries: [],
  dispatches: [],
  taskLedger: null,
  observability: null,
  knowledgePolicy: null,
  loading: true,

  fetchHubData: async (includeTest = false) => {
    set({ loading: true });
    try {
      const qs = includeTest ? '?includeTest=true' : '';
      const res = await fetch(`/api/hub/dashboard-summary${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HubDashboard = await res.json();
      set({
        status: data.status,
        projects: data.registryProjects ?? [],
        acp: data.acp,
        queueStatus: data.queueStatus,
        queueEntries: data.queueEntries ?? [],
        dispatches: data.dispatches ?? [],
        taskLedger: data.taskLedger ?? null,
        observability: data.observability ?? null,
        knowledgePolicy: data.knowledgePolicy ?? null,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },
}));
