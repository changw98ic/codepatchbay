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

  it('passes attentionOnly through to the server query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [],
        projects: [],
        statusCounts: {},
        total: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    useInboxStore.setState({ filters: { attentionOnly: true } });
    await useInboxStore.getState().fetchInbox();

    expect(fetchMock).toHaveBeenCalledWith('/api/inbox?attentionOnly=1');
  });
});
