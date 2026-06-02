import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInboxStore } from './inbox';

describe('useInboxStore', () => {
  beforeEach(() => {
    useInboxStore.setState({
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
    });
    vi.restoreAllMocks();
  });

  it('hydrates project options from /inbox/projects summaries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        projects: [
          { name: 'proj-a', counts: { total: 1 } },
          { name: 'proj-b', counts: { total: 2 } },
        ],
      }),
    })));

    await useInboxStore.getState().fetchProjects();

    expect(useInboxStore.getState().projectSummaries.map((p) => p.name)).toEqual(['proj-a', 'proj-b']);
    expect(useInboxStore.getState().projects).toEqual(['proj-a', 'proj-b']);
  });
});
