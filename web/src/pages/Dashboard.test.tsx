import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard, { isInternalAttentionHref, resolveAttentionHref } from './Dashboard';
import type { AttentionItem } from '@/types/api';

const mocks = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  fetchHubData: vi.fn(),
  fetchJobs: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('@/app/store', () => ({
  useProjectsStore: () => ({
    projects: [],
    loading: false,
    fetchProjects: mocks.fetchProjects,
  }),
  useHubStore: () => ({
    status: null,
    projects: [],
    acp: null,
    knowledgePolicy: null,
    observability: null,
    queueStatus: null,
    queueEntries: [],
    dispatches: [],
    taskLedger: null,
    fetchHubData: mocks.fetchHubData,
  }),
  useWebSocketStore: () => ({
    subscribe: mocks.subscribe,
  }),
  useAgentsStore: () => ({
    jobs: [],
    fetchJobs: mocks.fetchJobs,
  }),
}));

function attention(overrides: Partial<AttentionItem>): AttentionItem {
  return {
    id: 'attention-1',
    severity: 'warning',
    kind: 'workflow_failed',
    project: 'flow',
    title: 'Attention',
    reason: 'needs attention',
    impact: 'work is blocked',
    ageMs: 60_000,
    updatedAt: '2026-06-11T00:00:00.000Z',
    nextHumanAction: { kind: 'inspect', label: 'Inspect', href: '/inbox/attention-1' },
    evidence: [{ type: 'job', id: 'job-1' }],
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

describe('Dashboard attention queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves canonical attention API order and renders priority attention before today brief', async () => {
    const apiItems = [
      attention({
        id: 'queue-warning',
        severity: 'warning',
        title: 'Queue warning',
        reason: 'Queue warning first',
      }),
      attention({
        id: 'job-critical',
        severity: 'critical',
        title: 'Critical job',
        reason: 'Critical second',
      }),
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: apiItems }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Queue warning first');
    expect(fetchMock).toHaveBeenCalledWith('/api/inbox?attentionOnly=1&limit=5');

    const attentionHeading = screen.getByRole('heading', { name: 'dashboard.attentionQueue' });
    const todayHeading = screen.getByRole('heading', { name: 'dashboard.todayBrief' });
    expect(attentionHeading.compareDocumentPosition(todayHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const first = screen.getByText('Queue warning first');
    const second = screen.getByText('Critical second');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await waitFor(() => {
      expect(mocks.fetchProjects).toHaveBeenCalled();
      expect(mocks.fetchHubData).toHaveBeenCalled();
      expect(mocks.fetchJobs).toHaveBeenCalled();
    });
  });

  it('maps hub attention actions to reachable UI routes', () => {
    expect(resolveAttentionHref('/hub/runtime')).toBe('/?tab=health');
    expect(resolveAttentionHref('/hub/queue')).toBe('/inbox');
    expect(resolveAttentionHref('/project/flow?tab=overview')).toBe('/project/flow?tab=overview');
    expect(isInternalAttentionHref('/inbox')).toBe(true);
    expect(isInternalAttentionHref('https://example.test')).toBe(false);
    expect(isInternalAttentionHref('//example.test')).toBe(false);
  });

  it('routes hub runtime attention clicks to the dashboard health tab', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          attention({
            id: 'runtime-warning',
            title: 'Runtime warning',
            reason: 'Runtime needs repair',
            nextHumanAction: { kind: 'repair_runtime', label: 'Open runtime', href: '/hub/runtime' },
          }),
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><Dashboard /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Open runtime' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/?tab=health');
  });
});
