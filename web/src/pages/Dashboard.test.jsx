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
    expect(screen.getByText('calc-test')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
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
