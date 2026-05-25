import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ connected: true, subscribe: () => () => {} }),
}));

function jsonResponse(data) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

function mockFetch(map) {
  return vi.fn((url) => {
    if (url.startsWith('/api/hub/dashboard-summary')) {
      const includeTest = url.includes('includeTest=true');
      const hubProjectsKey = includeTest ? '/api/hub/projects?includeTest=true' : '/api/hub/projects';
      return jsonResponse({
        status: map['/api/hub/status'] ?? null,
        registryProjects: map[hubProjectsKey] ?? map['/api/hub/projects'] ?? [],
        acp: map['/api/hub/acp'] ?? null,
        knowledgePolicy: map['/api/hub/knowledge-policy'] ?? null,
        queueStatus: map['/api/hub/queue/status'] ?? null,
        queueEntries: map['/api/hub/queue'] ?? [],
        dispatches: map['/api/hub/dispatches'] ?? [],
        observability: map['/api/hub/observability'] ?? null,
        taskLedger: map['/api/hub/task-ledger?limit=50'] ?? null,
      });
    }
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
  '/api/hub/observability': null,
  '/api/hub/task-ledger?limit=50': null,
};

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function compileDashboardSummary(includeTest) {
  return {
    status: {
      projectCount: 1,
      enabledProjectCount: 1,
      workerCount: 1,
      hubRoot: '/tmp/hub',
    },
    registryProjects: [
      { id: 'calc-test', sourcePath: '/tmp/calc-test', worker: { status: 'online' } },
    ],
    acp: {
      pools: {
        codex: { mode: 'bounded-one-shot', limit: 2, active: 0, queued: 0 },
      },
      rateLimits: {
        codex: { untilTs: '2026-05-17T10:00:00.000Z', reason: '429' },
      },
    },
    knowledgePolicy: {
      automaticWrites: ['session'],
      semiAutomaticWrites: ['project-memory'],
      explicitConfirmationWrites: ['global-memory'],
      forbiddenMarkdownState: ['queue', 'lease'],
    },
    queueStatus: null,
    queueEntries: [],
    dispatches: [],
    observability: null,
    taskLedger: null,
  };
}

describe('Dashboard Hub panel', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/projects') return jsonResponse([]);
      if (url === '/api/tasks/durable') return jsonResponse([]);
      if (url.startsWith('/api/hub/dashboard-summary')) {
        const includeTest = url.includes('includeTest=true');
        return jsonResponse(compileDashboardSummary(includeTest));
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
    expect(screen.getByLabelText('ACP provider status')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('bounded-one-shot')).toBeInTheDocument();
    expect(screen.getByText('backoff')).toBeInTheDocument();
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.getByText('1 auto')).toBeInTheDocument();
    expect(screen.getByText('2 state guards')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/dashboard-summary');
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

describe('Dashboard attention contracts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts failed, blocked, and cancelled project states and links to an existing project tab', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 3, enabledProjectCount: 3, workerCount: 0, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'failed-proj', name: 'failed-proj', pipelineState: { status: 'failed', error: 'failed pipeline' } },
        { id: 'blocked-proj', name: 'blocked-proj', pipelineState: { status: 'blocked', error: 'waiting for approval' } },
        { id: 'cancelled-proj', name: 'cancelled-proj', pipelineState: { status: 'cancelled', error: 'cancelled by operator' } },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:name" element={<LocationEcho />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByText('failed-proj').length).toBeGreaterThan(0));
    expect(screen.getAllByText('blocked-proj').length).toBeGreaterThan(0);
    expect(screen.getAllByText('cancelled-proj').length).toBeGreaterThan(0);
    expect(screen.getByText((_, node) =>
      node?.className === 'today-brief-summary' &&
      node.textContent?.includes('Currently, 3 projects are in a blocked state.')
    )).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry Pipeline' })[0]);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/project/failed-proj?tab=overview');
    });
  });

  it('caps Attention Queue to 3 items without Show All toggle', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/projects') {
        return jsonResponse([
          { id: 'p1', name: 'proj-1', pipelineState: { status: 'failed', error: 'e1' } },
          { id: 'p2', name: 'proj-2', pipelineState: { status: 'failed', error: 'e2' } },
          { id: 'p3', name: 'proj-3', pipelineState: { status: 'failed', error: 'e3' } },
          { id: 'p4', name: 'proj-4', pipelineState: { status: 'failed', error: 'e4' } },
        ]);
      }
      if (url === '/api/tasks/durable') return jsonResponse([]);
      if (url.startsWith('/api/hub/dashboard-summary')) {
        return jsonResponse({
          status: { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
          registryProjects: [
            { id: 'p1', name: 'proj-1', pipelineState: { status: 'failed', error: 'e1' } },
            { id: 'p2', name: 'proj-2', pipelineState: { status: 'failed', error: 'e2' } },
            { id: 'p3', name: 'proj-3', pipelineState: { status: 'failed', error: 'e3' } },
            { id: 'p4', name: 'proj-4', pipelineState: { status: 'failed', error: 'e4' } },
          ],
          acp: null,
          knowledgePolicy: null,
          queueStatus: null,
          queueEntries: [],
          dispatches: [],
          observability: null,
          taskLedger: null,
        });
      }
      return jsonResponse(null);
    });

    const { container } = render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=overview']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('Attention Queue')).toBeInTheDocument());
    expect(container.querySelectorAll('.attention-row').length).toBe(3);
    // No Show All toggle
    expect(screen.queryByText(/Show All/)).not.toBeInTheDocument();
    expect(screen.queryByText('Show Less')).not.toBeInTheDocument();
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

describe('Dashboard durable jobs summary (health tab)', () => {
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

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('Durable Jobs')).toBeInTheDocument());
    // Summary line: "2 running · 1 completed · 1 failed"
    expect(screen.getByText(/2 running/)).toBeInTheDocument();
    expect(screen.getByText(/1 completed/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it('does not show summary when no durable jobs', async () => {
    global.fetch = mockFetch(baseMap);

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

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

describe('Dashboard Hub dispatches / Recent Runs (health tab)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows Recent Runs summary in health tab when dispatches exist', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/dispatches': [
        {
          dispatchId: 'dispatch-abc',
          projectId: 'proj-a',
          status: 'completed',
          workerId: 'worker-1',
          createdAt: '2026-05-17T08:00:00Z',
          updatedAt: '2026-05-17T08:05:00Z',
        },
        {
          dispatchId: 'dispatch-def',
          projectId: 'proj-b',
          status: 'running',
          workerId: 'worker-2',
          createdAt: '2026-05-17T09:00:00Z',
          updatedAt: '2026-05-17T09:03:00Z',
        },
      ],
    });

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByLabelText('Recent runs summary')).toBeInTheDocument());
    expect(screen.getByText('Recent Runs')).toBeInTheDocument();
    // Summary rows show project + status + time
    expect(screen.getAllByText('proj-a').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('hides pending dispatches from Recent Runs summary', async () => {
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

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
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

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

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

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Recent Runs')).not.toBeInTheDocument();
  });

  it('caps Recent Runs to 5 entries in health tab', async () => {
    const dispatches = Array.from({ length: 7 }, (_, i) => ({
      dispatchId: `dispatch-${i}`,
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

    const { container } = render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?tab=health']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('Recent Runs')).toBeInTheDocument());
    expect(container.querySelectorAll('.health-summary-row').length).toBe(5);
  });
});

describe('Dashboard ACP lifecycle display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders pool lifecycle stats from observability endpoint', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: { online: 1, stale: 0, offline: 0, details: [] },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {
          codex: {
            active: 0, limit: 2, queued: 0,
            requestCount: 42, errorCount: 1, recycleCount: 3,
            lastSpawnAt: '2026-05-17T23:00:00Z', processAgeMs: 3600000,
            rateLimitedUntil: null, mode: 'bounded-one-shot', activeRequests: 0,
          },
        },
        rateLimits: {},
        dispatchSummary: { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByLabelText('ACP lifecycle')).toBeInTheDocument());
    expect(screen.getByText('42 req')).toBeInTheDocument();
    expect(screen.getByText('1 err')).toBeInTheDocument();
    expect(screen.getByText('3 recycled')).toBeInTheDocument();
  });

  it('renders rate-limited indicator when pool is rate-limited', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: { online: 1, stale: 0, offline: 0, details: [] },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {
          claude: {
            active: 0, limit: 1, queued: 0,
            requestCount: 0, errorCount: 0, recycleCount: 0,
            lastSpawnAt: null, processAgeMs: null,
            rateLimitedUntil: '2026-05-18T01:00:00Z', mode: 'bounded-one-shot', activeRequests: 0,
          },
        },
        rateLimits: {},
        dispatchSummary: { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('rate-limited')).toBeInTheDocument());
  });

  it('omits lifecycle section when observability has no pools', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: { online: 1, stale: 0, offline: 0, details: [] },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {},
        rateLimits: {},
        dispatchSummary: { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByLabelText('ACP lifecycle')).not.toBeInTheDocument();
  });
});

describe('Dashboard dispatch summary display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders dispatch summary counts from observability', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: { online: 1, stale: 0, offline: 0, details: [] },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {},
        rateLimits: {},
        dispatchSummary: { total: 5, completed: 3, failed: 1, running: 1, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Runs')).toBeInTheDocument());
    expect(screen.getByText('5 total')).toBeInTheDocument();
    expect(screen.getByText('3 done')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
  });

  it('hides dispatch summary when total is 0', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: { online: 1, stale: 0, offline: 0, details: [] },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {},
        rateLimits: {},
        dispatchSummary: { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Global Hub')).toBeInTheDocument());
    expect(screen.queryByText('Runs')).not.toBeInTheDocument();
  });
});

describe('Dashboard worker age badge', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows worker age badge on project cards from observability details', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
      ],
      '/api/hub/observability': {
        generatedAt: '2026-05-18T00:00:00Z',
        workers: {
          online: 1, stale: 0, offline: 0,
          details: [
            { id: 'proj-a', name: 'proj-a', status: 'online', workerId: 'w1', lastSeenAt: '2026-05-18T00:00:00Z', ageMs: 30000, capabilities: [] },
          ],
        },
        queue: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 },
        pools: {},
        rateLimits: {},
        dispatchSummary: { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 },
      },
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('proj-a')).toBeInTheDocument());
    expect(screen.getByText('30s')).toBeInTheDocument();
  });

  it('omits age badge when observability has no worker detail for project', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
      ],
      '/api/hub/observability': null,
    });

    const { container } = render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('proj-a')).toBeInTheDocument());
    expect(container.querySelector('.badge-age')).toBeNull();
  });
});

describe('Dashboard active projects in queue status', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows active projects with busy reason and worker ID', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 2, enabledProjectCount: 2, workerCount: 2, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
        { id: 'proj-b', sourcePath: '/b', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': {
        total: 3,
        pending: 1,
        inProgress: 1,
        completed: 0,
        failed: 1,
        cancelled: 0,
        projects: {
          'proj-a': { pending: 0, inProgress: 1, completed: 0, failed: 1, cancelled: 0, activeMutating: 1, busy: true, busyReason: 'active-mutating-task', claimedBy: 'w1', workerId: 'w1' },
          'proj-b': { pending: 1, inProgress: 0, completed: 0, failed: 0, cancelled: 0, activeMutating: 0, busy: false },
        },
        activeProjects: [
          { projectId: 'proj-a', activeMutating: 1, busy: true, busyReason: 'active-mutating-task', workerId: 'w1' },
        ],
      },
      '/api/hub/queue': [
        { id: 'q1', projectId: 'proj-a', status: 'in_progress', priority: 'P1', createdAt: '2026-05-20T08:00:00Z' },
        { id: 'q2', projectId: 'proj-b', status: 'pending', priority: 'P2', createdAt: '2026-05-20T08:01:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    // Active project with busy reason
    expect(screen.getByText('active-mutating-task')).toBeInTheDocument();
    // Worker ID shown for active project
    expect(screen.getByText('w1')).toBeInTheDocument();
    // proj-a appears in active project badge
    expect(screen.getAllByText('proj-a').length).toBeGreaterThanOrEqual(2);
  });

  it('hides active projects section when no active projects', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': {
        total: 2,
        pending: 2,
        inProgress: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        projects: {
          'proj-a': { pending: 2, inProgress: 0, completed: 0, failed: 0, cancelled: 0, activeMutating: 0, busy: false },
        },
        activeProjects: [],
      },
      '/api/hub/queue': [
        { id: 'q1', projectId: 'proj-a', status: 'pending', priority: 'P2', createdAt: '2026-05-20T08:00:00Z' },
        { id: 'q2', projectId: 'proj-b', status: 'pending', priority: 'P2', createdAt: '2026-05-20T08:01:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    expect(screen.queryByText('active-mutating-task')).not.toBeInTheDocument();
  });
});

describe('Dashboard project card index-status display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders index file and symbol count when indexStatus is ready', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        {
          id: 'idx-ready-proj',
          sourcePath: '/tmp/idx-ready',
          indexStatus: { status: 'ready', fileCount: 42, symbolCount: 17, commandCount: 3, contentHash: 'abc123', updatedAt: '2026-05-22T00:00:00Z' },
        },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('idx-ready-proj')).toBeInTheDocument());
    expect(screen.getByText(/Index: 42 files · 17 symbols/)).toBeInTheDocument();
  });

  it('renders stale index badge when indexStatus is stale', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        {
          id: 'idx-stale-proj',
          sourcePath: '/tmp/idx-stale',
          indexStatus: { status: 'stale', fileCount: 10, symbolCount: 5, commandCount: 2, contentHash: null, updatedAt: '2026-05-20T00:00:00Z' },
        },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('idx-stale-proj')).toBeInTheDocument());
    expect(screen.getByText('Index: stale')).toBeInTheDocument();
  });

  it('does not render index status when indexStatus is missing', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'idx-none-proj', sourcePath: '/tmp/idx-none' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('idx-none-proj')).toBeInTheDocument());
    expect(screen.queryByText(/Index:/)).not.toBeInTheDocument();
  });
});

describe('Dashboard eligible queued work display', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows eligible queued work count and project names', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 2, enabledProjectCount: 2, workerCount: 2, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
        { id: 'proj-b', sourcePath: '/b', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': {
        total: 3,
        pending: 2,
        inProgress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        eligibleQueued: 1,
        eligibleProjects: ['proj-b'],
        projects: {
          'proj-a': { pending: 1, inProgress: 1, completed: 0, failed: 0, cancelled: 0, activeMutating: 1, busy: true, busyReason: 'active-mutating-task', claimedBy: 'w1', workerId: 'w1', eligiblePending: 0, eligibleEntryIds: [] },
          'proj-b': { pending: 1, inProgress: 0, completed: 0, failed: 0, cancelled: 0, activeMutating: 0, busy: false, eligiblePending: 1, eligibleEntryIds: ['q2'] },
        },
        activeProjects: [
          { projectId: 'proj-a', activeMutating: 1, busy: true, busyReason: 'active-mutating-task', workerId: 'w1' },
        ],
      },
      '/api/hub/queue': [
        { id: 'q1', projectId: 'proj-a', status: 'in_progress', priority: 'P1', createdAt: '2026-05-20T08:00:00Z' },
        { id: 'q2', projectId: 'proj-b', status: 'pending', priority: 'P2', createdAt: '2026-05-20T08:01:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    // Active project A shows busy reason and worker
    expect(screen.getByText('active-mutating-task')).toBeInTheDocument();
    expect(screen.getByText('w1')).toBeInTheDocument();
    // Eligible queued work visible
    expect(screen.getByText('1 eligible')).toBeInTheDocument();
    // proj-b appears in eligible-project span, queue pill, and project card
    expect(screen.getAllByText('proj-b').length).toBeGreaterThanOrEqual(1);
    // The eligible section has aria label
    expect(screen.getByLabelText('Eligible queued work')).toBeInTheDocument();
  });

  it('hides eligible section when no eligible queued work', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'proj-a', sourcePath: '/a', worker: { status: 'online' } },
      ],
      '/api/hub/queue/status': {
        total: 2,
        pending: 1,
        inProgress: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        eligibleQueued: 0,
        eligibleProjects: [],
        projects: {
          'proj-a': { pending: 1, inProgress: 1, completed: 0, failed: 0, cancelled: 0, activeMutating: 1, busy: true, busyReason: 'active-mutating-task', eligiblePending: 0, eligibleEntryIds: [] },
        },
        activeProjects: [
          { projectId: 'proj-a', activeMutating: 1, busy: true, busyReason: 'active-mutating-task', workerId: 'w1' },
        ],
      },
      '/api/hub/queue': [
        { id: 'q1', projectId: 'proj-a', status: 'in_progress', priority: 'P1', createdAt: '2026-05-20T08:00:00Z' },
        { id: 'q2', projectId: 'proj-a', status: 'pending', priority: 'P2', createdAt: '2026-05-20T08:01:00Z' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Queue')).toBeInTheDocument());
    expect(screen.queryByText('eligible')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Eligible queued work')).not.toBeInTheDocument();
  });
});

describe('Dashboard default mode hides test projects', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches /api/projects without includeTest by default', async () => {
    global.fetch = mockFetch(baseMap);

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => {
      const projectsCall = global.fetch.mock.calls.find((c) => c[0] === '/api/projects');
      expect(projectsCall).toBeTruthy();
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/projects');
    expect(global.fetch).not.toHaveBeenCalledWith('/api/projects?includeTest=true');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/dashboard-summary');
    expect(global.fetch).not.toHaveBeenCalledWith('/api/hub/dashboard-summary?includeTest=true');
  });

  it('does not render test badge in default mode', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/hub/status': { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
      '/api/hub/projects': [
        { id: 'prod-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
      ],
    });

    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('prod-a')).toBeInTheDocument());
    expect(screen.queryByText('test')).not.toBeInTheDocument();
  });
});

describe('Dashboard diagnostics mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches includeTest endpoints in diagnostics mode', async () => {
    global.fetch = mockFetch({
      ...baseMap,
      '/api/projects?includeTest=true': [],
      '/api/hub/projects?includeTest=true': [],
    });

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?diagnostics=1']}>{children}</MemoryRouter>,
    });

    await waitFor(() => {
      const projectsCall = global.fetch.mock.calls.find((c) => c[0] === '/api/projects?includeTest=true');
      expect(projectsCall).toBeTruthy();
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/projects?includeTest=true');
    expect(global.fetch).toHaveBeenCalledWith('/api/hub/dashboard-summary?includeTest=true');
  });

  it('renders test badge on hidden projects in diagnostics mode', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/projects?includeTest=true') {
        return jsonResponse([
          { name: 'prod-a', id: 'prod-a', inbox: 0, outputs: 0, _pollution: { visibility: 'production', reasons: [] } },
          { name: 'test-fixture', id: 'test-fixture', inbox: 0, outputs: 0, _pollution: { visibility: 'test', reasons: ['metadata.visibility=test'] } },
        ]);
      }
      if (url === '/api/tasks/durable') return jsonResponse([]);
      if (url.startsWith('/api/hub/dashboard-summary')) {
        return jsonResponse({
          status: { projectCount: 2, enabledProjectCount: 2, workerCount: 2, hubRoot: '/tmp/hub' },
          registryProjects: [
            { id: 'prod-a', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
            { id: 'test-fixture', sourcePath: '/t', _pollution: { visibility: 'test', reasons: ['metadata.visibility=test'] } },
          ],
          acp: null,
          knowledgePolicy: null,
          queueStatus: null,
          queueEntries: [],
          dispatches: [],
          observability: null,
          taskLedger: null,
        });
      }
      return jsonResponse(null);
    });

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?diagnostics=1']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('test-fixture')).toBeInTheDocument());
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('does not render test badge on production projects', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/projects?includeTest=true') {
        return jsonResponse([
          { name: 'prod-clean', id: 'prod-clean', inbox: 0, outputs: 0, _pollution: { visibility: 'production', reasons: [] } },
        ]);
      }
      if (url === '/api/tasks/durable') return jsonResponse([]);
      if (url.startsWith('/api/hub/dashboard-summary')) {
        return jsonResponse({
          status: { projectCount: 1, enabledProjectCount: 1, workerCount: 1, hubRoot: '/tmp/hub' },
          registryProjects: [
            { id: 'prod-clean', sourcePath: '/a', worker: { status: 'online' }, workerDerivedStatus: 'online' },
          ],
          acp: null,
          knowledgePolicy: null,
          queueStatus: null,
          queueEntries: [],
          dispatches: [],
          observability: null,
          taskLedger: null,
        });
      }
      return jsonResponse(null);
    });

    render(<Dashboard />, {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/?diagnostics=1']}>{children}</MemoryRouter>,
    });

    await waitFor(() => expect(screen.getByText('prod-clean')).toBeInTheDocument());
    const testBadges = screen.queryAllByText('test');
    expect(testBadges.length).toBe(0);
  });
});

