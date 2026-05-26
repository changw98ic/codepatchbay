import { create } from 'zustand';
import type { Agent, DurableJob, Artifact } from '@/types/api';

interface AgentsStore {
  agents: Agent[];
  setupReadiness: Record<string, boolean>;
  jobs: DurableJob[];
  loading: boolean;
  fetchAgents: () => Promise<void>;
  fetchSetupReadiness: () => Promise<void>;
  fetchJobs: () => Promise<void>;
}

function mapApiAgent(a: Record<string, unknown>): Agent {
  const pool = a.pool as { limit?: number; active?: number } | undefined;
  const jobs = a.jobs as { total?: number; completed?: number; failed?: number } | undefined;
  return {
    name: a.name as string,
    type: (a.command as string) ?? 'unknown',
    status: (pool?.active ?? 0) > 0 ? 'busy' : 'available',
    pools: [],
    jobsCompleted: jobs?.completed ?? 0,
    jobsFailed: jobs?.failed ?? 0,
    lastJobAt: undefined,
  };
}

function mapApiJob(j: Record<string, unknown>): DurableJob {
  const executor = j.executor as { packageName?: string } | undefined;
  return {
    jobId: j.jobId as string,
    project: j.project as string,
    agent: executor?.packageName ?? 'unknown',
    instruction: (j.task as string) ?? '',
    status: (j.status as DurableJob['status']) ?? 'pending',
    phase: j.phase as string | undefined,
    createdAt: j.createdAt as string,
    updatedAt: j.updatedAt as string,
    leaseId: j.leaseId as string | undefined,
    artifacts: j.artifacts as Artifact[] | undefined,
  };
}

export const useAgentsStore = create<AgentsStore>((set) => ({
  agents: [],
  setupReadiness: {},
  jobs: [],
  loading: true,

  fetchAgents: async () => {
    set({ loading: true });
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const raw = (data.agents ?? data) as Record<string, unknown>[];
      set({ agents: raw.map(mapApiAgent), loading: false });
    } catch {
      set({ loading: false });
    }
  },

  fetchSetupReadiness: async () => {
    try {
      const res = await fetch('/api/agents/setup-readiness');
      if (!res.ok) return;
      const data = await res.json();
      set({ setupReadiness: data });
    } catch {
      // ignore
    }
  },

  fetchJobs: async () => {
    try {
      const res = await fetch('/api/tasks/durable');
      if (!res.ok) return;
      const data = await res.json();
      const raw = Array.isArray(data) ? data : [];
      set({ jobs: raw.map(mapApiJob) });
    } catch {
      // ignore
    }
  },
}));
