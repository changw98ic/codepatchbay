import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Inbox from './Inbox';

vi.mock('@/app/store', () => ({
  useInboxStore: () => ({
    items: [
      {
        id: 'job-test-001',
        type: 'pipeline',
        project: 'demo',
        task: 'Test task',
        status: 'failed',
        rawStatus: 'failed',
        priority: 'P0',
        phase: 'execute',
        currentPhase: 'execute',
        retryCount: 1,
        source: { type: 'manual', label: 'Manual' },
        nextHumanAction: { kind: 'retry', label: 'Review failure and retry' },
        pr: null,
        failureCode: 'RECOVERABLE',
        failurePhase: 'execute',
        cancelRequested: false,
        redirectContext: null,
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T00:01:00.000Z',
        lastActivityAt: '2026-06-02T00:01:00.000Z',
        lastActivityMessage: 'execution failed',
      },
      {
        id: 'job-test-002',
        type: 'pipeline',
        project: 'demo',
        task: 'Running task',
        status: 'running',
        rawStatus: 'running',
        priority: 'P1',
        phase: 'plan',
        currentPhase: 'plan',
        retryCount: 0,
        source: { type: 'manual', label: 'Manual' },
        nextHumanAction: null,
        pr: null,
        failureCode: null,
        failurePhase: null,
        cancelRequested: false,
        redirectContext: null,
        createdAt: '2026-06-02T00:02:00.000Z',
        updatedAt: '2026-06-02T00:03:00.000Z',
        lastActivityAt: null,
        lastActivityMessage: null,
      },
    ],
    projects: ['demo'],
    statusCounts: { failed: 1, running: 1 },
    total: 2,
    filters: {},
    selectedId: null,
    detail: null,
    detailLoading: false,
    loading: false,
    setFilter: vi.fn(),
    clearFilters: vi.fn(),
    fetchInbox: vi.fn(),
    fetchProjects: vi.fn(),
    selectRequest: vi.fn(),
  }),
  useWebSocketStore: () => ({
    subscribe: vi.fn(() => vi.fn()),
    connected: true,
  }),
}));

describe('Inbox Page', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders inbox title', async () => {
    render(<Inbox />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('inbox.title')).toBeInTheDocument();
    });
  });

  it('renders request rows with status and priority badges', async () => {
    render(<Inbox />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('Test task')).toBeInTheDocument();
    });
    expect(screen.getByText('Running task')).toBeInTheDocument();
    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('running').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('P0')).toHaveLength(1);
    expect(screen.getAllByText('P1')).toHaveLength(1);
  });

  it('shows project name for each request', async () => {
    render(<Inbox />, { wrapper: MemoryRouter });

    await waitFor(() => {
      const demos = screen.getAllByText('demo');
      expect(demos.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows status count bar', async () => {
    render(<Inbox />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText(/inbox\.requestCount/)).toBeInTheDocument();
    });
  });
});
