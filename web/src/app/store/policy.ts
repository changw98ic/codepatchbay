import { create } from 'zustand';
import type { PhasePolicy, PolicyValidationResult, KnowledgePolicySummary } from '@/types/api';

interface PolicyStore {
  phasePolicy: PhasePolicy | null;
  knowledgePolicy: KnowledgePolicySummary | null;
  rolesPolicies: Record<string, PhasePolicy> | null;
  validation: PolicyValidationResult | null;
  loading: boolean;
  selectedRole: string;
  setSelectedRole: (role: string) => void;
  fetchPhasePolicy: (role: string, project?: string) => Promise<void>;
  fetchKnowledgePolicy: () => Promise<void>;
  fetchRolesPolicies: (project?: string) => Promise<void>;
  validatePolicy: (policy: unknown) => Promise<void>;
}

export const usePolicyStore = create<PolicyStore>((set) => ({
  phasePolicy: null,
  knowledgePolicy: null,
  rolesPolicies: null,
  validation: null,
  loading: true,
  selectedRole: 'executor',

  setSelectedRole: (role) => set({ selectedRole: role }),

  fetchPhasePolicy: async (role, project) => {
    set({ loading: true });
    try {
      const qs = project ? `?role=${role}&project=${project}` : `?role=${role}`;
      const res = await fetch(`/api/policy/phase${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ phasePolicy: data, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  fetchKnowledgePolicy: async () => {
    try {
      const res = await fetch('/api/policy/knowledge');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ knowledgePolicy: data });
    } catch {}
  },

  fetchRolesPolicies: async (project) => {
    set({ loading: true });
    try {
      const qs = project ? `?project=${project}` : '';
      const res = await fetch(`/api/policy/roles${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ rolesPolicies: data.policies, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  validatePolicy: async (policy) => {
    try {
      const res = await fetch('/api/policy/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ validation: data });
    } catch {
      set({ validation: { valid: false, errors: ['Request failed'], approvalRequiredFor: [] } });
    }
  },
}));
