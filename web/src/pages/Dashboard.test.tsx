import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

vi.mock('@/app/store', () => ({
  useProjectsStore: () => ({
    projects: [],
    loading: false,
    fetchProjects: vi.fn(),
    getProject: vi.fn(),
  }),
  useHubStore: () => ({
    status: null,
    projects: [],
    acp: null,
    knowledgePolicy: null,
    queueStatus: null,
    queueEntries: [],
    dispatches: [],
    taskLedger: null,
    observability: null,
    fetchHubData: vi.fn(),
  }),
  useWebSocketStore: () => ({
    subscribe: vi.fn(() => vi.fn()),
    connected: true,
  }),
  useAgentsStore: () => ({
    agents: [],
    jobs: [],
    loading: false,
    fetchAgents: vi.fn(),
    fetchJobs: vi.fn(),
  }),
}));

describe('Dashboard Page', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders dashboard title and overview tab', async () => {
    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('dashboard.title')).toBeInTheDocument();
    });
    expect(screen.getByText('dashboard.overview')).toBeInTheDocument();
    expect(screen.getByText('dashboard.systemHealth')).toBeInTheDocument();
  });

  it('renders new task button', async () => {
    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getAllByText(/nav\.newTask/)[0]).toBeInTheDocument();
    });
  });

  it('shows dashboard today brief section', async () => {
    render(<Dashboard />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('dashboard.title')).toBeInTheDocument();
    });
    expect(screen.getByText('dashboard.todayBrief')).toBeInTheDocument();
  });
});
