import { create } from 'zustand';
import type { ApprovalGate } from '@/types/api';

interface GatesStore {
  gates: ApprovalGate[];
  loading: boolean;
  fetchGates: () => Promise<void>;
  approveGate: (jobId: string, project: string) => Promise<void>;
  denyGate: (jobId: string, project: string, reason?: string) => Promise<void>;
}

export const useGatesStore = create<GatesStore>((set, get) => ({
  gates: [],
  loading: true,

  fetchGates: async () => {
    set({ loading: true });
    try {
      const res = await fetch('/api/gates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ gates: data.gates ?? [], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  approveGate: async (jobId, project) => {
    const res = await fetch(`/api/gates/${jobId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().fetchGates();
  },

  denyGate: async (jobId, project, reason) => {
    const res = await fetch(`/api/gates/${jobId}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, reason }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().fetchGates();
  },
}));
