import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ connected: true, subscribe: () => () => {} }),
}));

function jsonResponse(data) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

function mockFetch(map) {
  return vi.fn((url) => {
    if (map[url]) return jsonResponse(map[url]);
    return jsonResponse(null);
  });
}

const baseMap = {
  '/api/projects': [],
  '/api/tasks/durable': [],
  '/api/hub/status': null,
  '/api/hub/projects': [],
  '/api/hub/acp': null,
  '/api/hub/knowledge-policy': null,
  '/api/hub/queue/status': null,
  '/api/hub/queue': [],
  '/api/hub/dispatches': [],
};

describe('Dashboard Hub panel', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/projects') return jsonResponse([]);
      if (url === '/api/tasks/durable') return jsonResponse([]);
      if (url === '/api/hub/status') {
        return jsonResponse({
          projectCount: 1,
          enabledProjectCount: 1,
          workerCount: 1,
          hubRoot: '/tmp/hub',
        });
      }
      if (url === '/api/hub/projects') {
        return jsonResponse([
          { id: 'calc-test', sourcePath: '/tmp/calc-test', worker: { status: 'online' } },
        ]);
      }
      if (url === '/api/hub/acp') {
        return jsonResponse({
          pools: {
            codex: { mode: 'bounded-one-shot', limit: 2, active: 0, queued: 0 },
          },
          rateLimits: {
            codex: { untilTs: '2026-05-17T10:00:00.000Z', reason: '429' },
          },
        });
      }
      if (url === '/api/hub/knowledge-policy') {
        return jsonResponse({
          automaticWrites: ['session'],
          semiAutomaticWrites: ['project-memory'],
          explicitConfirmationWrites: ['global-memory'],
          forbiddenMarkdownState: ['queue', 'lease'],
        });
      }
      if (url === '/api/hub/queue/status') return jsonResponse(null);
      if (url === '/api/hub/queue') return jsonResponse([]);
      if (url === '/api/hub/dispatches') return jsonResponse([]);
      return jsonResponse(null);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders global Hub project and worker status from Hub APIs', async () => {
    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.getByText('1 registered projects')).toBeInTheDocument();
    expect(screen.getByText(/1 online/)).toBeInTheDocument();
    expect(screen.getByLabelText('ACP provider status')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('bounded-one-shot')).toBeInTheDocument();
    expect(screen.getByText('backoff')).toBeInTheDocument();
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.getByText('1 auto')).toBeInTheDocument();
    expect(screen.getByText('2 state guards')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/status');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/projects');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/acp');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/knowledge-policy');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/queue/status');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/queue');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/dispatches');
  });
});

describe('Dashboard Hub worker status aggregation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows online/offline/stale counts derived from project worker status', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 3, enabledProjectCount: 3, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
        { id: 'proj-b', sourcePath: '/b', worker: { status: 'online' }, workerDerivedStatus: 'offline' },
        { id: 'proj-c', sourcePath: '/c', worker: { status: 'online' }, workerDerivedStatus: 'stale' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());

    // Worker breakdown line: "1 online · 1 offline · 1 stale"
    expect(screen.getByText(/1 online/)).toBeInTheDocument();
    expect(screen.getByText(/1 offline/)).toBeInTheDocument();
    expect(screen.getByText(/1 stale/)).toBeInTheDocument();
  });

  it('handles projects with no worker field (counted as offline)', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 2, enabledProjectCount: 2, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
        { id: 'proj-b', sourcePath: '/b' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.getByText(/1 online/)).toBeInTheDocument();
    expect(screen.getByText(/1 offline/)).toBeInTheDocument();
  });
});

describe('Dashboard Hub projects as primary project list', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders Hub-registered projects as primary cards with worker status badges', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 2, enabledProjectCount: 2, workerCount: 2, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
        { id: 'proj-b', sourcePath: '/b', worker: { status: 'offline' }, workerDerivedStatus: 'offline' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    // Hub projects appear as primary cards (h3 headers)
    await waitFor(() => expect(screen.getByText('proj-a')).toBeInTheDocument());
    expect(screen.getByText('proj-b')).toBeInTheDocument();
    // Worker status badges on cards
    const onlineBadges = screen.getAllByText('online');
    expect(onlineBadges.length).toBeGreaterThanOrEqual(1);
    const offlineBadges = screen.getAllByText('offline');
    expect(offlineBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('merges legacy project data (inbox/outputs) into Hub project cards', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/projects': [
        { name: 'proj-a', inbox: 7, outputs: 3 },
      ],
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('proj-a')).toBeInTheDocument());
    // Inbox/outputs from legacy merged into Hub card (appears in panel summary and card stats)
    expect(screen.getAllByText(/Inbox: 7/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Outputs: 3/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows legacy-only projects as secondary cards with local badge', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/projects': [
        { name: 'legacy-only', inbox: 2, outputs: 1 },
      ],
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'hub-proj', sourcePath: '/h', worker: { status: 'online' } },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('legacy-only')).toBeInTheDocument());
    expect(screen.getByText('local')).toBeInTheDocument();
    expect(screen.getByText('hub-proj')).toBeInTheDocument();
  });

  it('shows empty state when no Hub projects and no legacy projects', async () => {
    global.fetch = mockFetch(baseMap);

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText(/No projects found/)).toBeInTheDocument());
  });
});

describe('Dashboard ACP pool active/queued display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders active and queued counts per provider', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/acp': {
        pools: {
          codex: { mode: 'bounded-one-shot', limit: 2, active: 1, queued: 3 },
          claude: { mode: 'bounded-one-shot', limit: 1, active: 0, queued: 0 },
        },
        rateLimits: {},
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    // codex: active 1, queued 3
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('3 queued')).toBeInTheDocument();
    // claude: active 0, queued 0
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });

  it('omits active/queued when pool info missing', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/acp': {
        pools: { codex: { mode: 'bounded-one-shot' } },
        rateLimits: {},
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.getByText('codex')).toBeInTheDocument();
    // Should not crash — active/queued just not shown
    expect(screen.queryByText(/queued/)).not.toBeInTheDocument();
  });
});

describe('Dashboard durable jobs summary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows summary counts grouped by status when durable jobs exist', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/tasks/durable': [
        { jobId: 'j1', project: 'a', status: 'running', phase: 'execute' },
        { jobId: 'j2', project: 'b', status: 'running', phase: 'plan' },
        { jobId: 'j3', project: 'c', status: 'completed', phase: 'verify' },
        { jobId: 'j4', project: 'd', status: 'failed', phase: 'execute' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Durable Jobs')).toBeInTheDocument());
    // Summary line: "2 running · 1 completed · 1 failed"
    expect(screen.getByText(/2 running/)).toBeInTheDocument();
    expect(screen.getByText(/1 completed/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it('does not show summary when no durable jobs', async () => {
    global.fetch = mockFetch(baseMap);

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Loading projects...')).toBeInTheDocument());
    expect(screen.queryByText('Durable Jobs')).not.toBeInTheDocument();
  });
});

describe('Dashboard queue/backlog compact summary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows inbox total across projects in Hub panel', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/projects': [
        { name: 'a', inbox: 5, outputs: 3 },
        { name: 'b', inbox: 2, outputs: 1 },
      ],
      '/api/hub/status': { projectCount: 2, enabledProjectCount: 2, workerCount: 2, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'a', sourcePath: '/a', worker: { status: 'online' } },
        { id: 'b', sourcePath: '/b', worker: { status: 'online' } },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    // Compact queue summary: "Inbox: 7 · Outputs: 4"
    expect(screen.getByText(/Inbox: 7/)).toBeInTheDocument();
    expect(screen.getByText(/Outputs: 4/)).toBeInTheDocument();
  });

  it('omits queue summary when no projects', async () => {
    global.fetch = mockFetch(baseMap);

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText(/No projects found/)).toBeInTheDocument());
    expect(screen.queryByText(/Inbox:/)).not.toBeInTheDocument();
  });
});

describe('Dashboard Hub queue status display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows queue counts and recent pending/in_progress entries', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': { total: 4, pending: 2, inProgress: 1, completed: 0, failed: 1, cancelled: 0 },
      '/api/hub/queue': [
        { id: 'q1', projectId: 'proj-a', status: 'in_progress', priority: 'P1', createdAt: '2026-05-17T08:00:00Z' },
        { id: 'q2', projectId: 'proj-b', status: 'pending', priority: 'P2', createdAt: '2026-05-17T08:01:00Z' },
        { id: 'q3', projectId: 'proj-c', status: 'pending', priority: 'P2', createdAt: '2026-05-17T08:02:00Z' },
        { id: 'q4', projectId: 'proj-d', status: 'failed', priority: 'P3', createdAt: '2026-05-17T08:03:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    expect(screen.getByText('2 pending')).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    // Only pending/in_progress entries shown as pills; proj-a appears in both project list and queue
    expect(screen.getAllByText('proj-a').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('proj-b')).toBeInTheDocument();
    expect(screen.getAllByText('pending').length).toBeGreaterThanOrEqual(2);
    // proj-c is the 3rd entry shown; proj-d is failed so no pill
    expect(screen.getByText('proj-c')).toBeInTheDocument();
    expect(screen.queryByText('proj-d')).not.toBeInTheDocument();
  });

  it('hides queue section when queue is empty', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
      '/api/hub/queue': [],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Queue')).not.toBeInTheDocument();
  });

  it('caps displayed entries to 3', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`, projectId: `proj-${i}`, status: 'pending', priority: 'P2', createdAt: `2026-05-17T08:0${i}:00Z`,
    }));
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [{ id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } }],
      '/api/hub/queue/status': { total: 5, pending: 5, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
      '/api/hub/queue': entries,
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    // First 3 shown, rest hidden
    expect(screen.getByText('proj-0')).toBeInTheDocument();
    expect(screen.getByText('proj-2')).toBeInTheDocument();
    expect(screen.queryByText('proj-3')).not.toBeInTheDocument();
    expect(screen.queryByText('proj-4')).not.toBeInTheDocument();
  });
});

describe('Dashboard Hub dispatches / Recent Runs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows Recent Runs section when dispatches exist', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': [
        {
          dispatchId: 'dispatch-20260517-080000-abc',
          projectId: 'proj-a',
          status: 'completed',
          workerId: 'worker-1',
          createdAt: '2026-05-17T08:00:00Z',
          updatedAt: '2026-05-17T08:05:00Z',
        },
        {
          dispatchId: 'dispatch-20260517-090000-def',
          projectId: 'proj-b',
          status: 'running',
          workerId: 'worker-2',
          createdAt: '2026-05-17T09:00:00Z',
          updatedAt: '2026-05-17T09:03:00Z',
        },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByLabelText('Recent runs')).toBeInTheDocument());
    expect(screen.getByText('Recent Runs')).toBeInTheDocument();
    expect(screen.getByText('dispatch-20260517-080000-abc')).toBeInTheDocument();
    expect(screen.getByText('dispatch-20260517-090000-def')).toBeInTheDocument();
    // proj-a and proj-b appear in both project cards and dispatch rows
    expect(screen.getAllByText('proj-a').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('proj-b').length).toBeGreaterThanOrEqual(1);
    // Status badges
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    // Worker IDs
    expect(screen.getByText('worker-1')).toBeInTheDocument();
    expect(screen.getByText('worker-2')).toBeInTheDocument();
  });

  it('shows failed dispatch with failed badge', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': [
        {
          dispatchId: 'dispatch-20260517-100000-xyz',
          projectId: 'proj-a',
          status: 'failed',
          createdAt: '2026-05-17T10:00:00Z',
          updatedAt: '2026-05-17T10:02:00Z',
        },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Recent Runs')).toBeInTheDocument());
    expect(screen.getByText('failed')).toBeInTheDocument();
    // No worker ID displayed when absent
    expect(screen.queryByText('worker-')).not.toBeInTheDocument();
  });

  it('hides pending dispatches from Recent Runs', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': [
        {
          dispatchId: 'dispatch-20260517-110000-pend',
          projectId: 'proj-a',
          status: 'pending',
          createdAt: '2026-05-17T11:00:00Z',
          updatedAt: '2026-05-17T11:00:00Z',
        },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
    expect(screen.queryByText('dispatch-20260517-110000-pend')).not.toBeInTheDocument();
  });

  it('caps Recent Runs to 10 entries sorted by updatedAt desc', async () => {
    const dispatches = Array.from({ length: 12 }, (_, i) => ({
      dispatchId: `dispatch-20260517-${String(i).padStart(6, '0')}-xx`,
      projectId: `proj-${i}`,
      status: 'completed',
      createdAt: `2026-05-17T${String(i).padStart(2, '0')}:00:00Z`,
      updatedAt: `2026-05-17T${String(i).padStart(2, '0')}:05:00Z`,
    }));
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': dispatches,
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Recent Runs')).toBeInTheDocument());
    // Latest dispatch (index 11, sorted desc by updatedAt) should be present
    expect(screen.getByText('dispatch-20260517-000011-xx')).toBeInTheDocument();
    // The earliest (index 0, 1) should be hidden (only 10 shown)
    expect(screen.queryByText('dispatch-20260517-000000-xx')).not.toBeInTheDocument();
    expect(screen.queryByText('dispatch-20260517-000001-xx')).not.toBeInTheDocument();
  });

  it('hides Recent Runs section when all dispatches are pending', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': [
        { dispatchId: 'd1', projectId: 'proj-a', status: 'pending', createdAt: '2026-05-17T08:00:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
  });

  it('gracefully handles null dispatches response', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': null,
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
  });
});
