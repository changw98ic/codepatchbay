import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Review from './Review';

const socketMock = vi.hoisted(() => ({
  reviewUpdateHandler: null,
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: vi.fn((topic, handler) => {
      if (topic === 'review:update') {
        socketMock.reviewUpdateHandler = handler;
      }
      return vi.fn();
    }),
  }),
}));

const mockSessions = [
  { sessionId: 'session-00000001', status: 'user_review', project: 'proj-a', intent: 'Fix auth bug' },
  { sessionId: 'session-00000002', status: 'dispatched', project: 'proj-b', intent: 'Ship feature' },
  { sessionId: 'session-00000003', status: 'expired', project: 'proj-c', intent: 'Old review' },
  { sessionId: 'session-00000004', status: 'idle', project: 'proj-d', intent: 'Waiting task' },
  { sessionId: 'session-00000005', status: 'user_review', project: 'proj-e', intent: 'Another review' },
  { sessionId: 'session-00000006', status: 'researching', project: 'proj-f', intent: 'Active research' },
];

function createMockSessions(count, baseStatus = 'user_review') {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `session-${String(i + 1).padStart(8, '0')}`,
    status: baseStatus,
    project: `proj-${i}`,
    intent: `Task ${i}`,
  }));
}

describe('Review Page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    socketMock.reviewUpdateHandler = null;
    vi.spyOn(global, 'fetch').mockImplementation((url) => {
      if (url.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ name: 'proj-1' }, { name: 'proj-2' }]),
        });
      }
      if (url.includes('/api/review/session-')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: url.split('/').pop(), status: 'user_review', project: 'proj-a', intent: 'Fix auth bug', history: [] }),
        });
      }
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSessions),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${url}`));
    });
  });

  it('renders sessions grouped by status', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText(/Needs Action/)).toBeInTheDocument();
    });

    expect(screen.getByText(/In Progress/)).toBeInTheDocument();
    expect(screen.getByText(/Done/)).toBeInTheDocument();
    expect(screen.getByText(/Queued/)).toBeInTheDocument();

    // Cards show project names
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('proj-b')).toBeInTheDocument();
    expect(screen.getByText('proj-f')).toBeInTheDocument();
  });

  it('filters sessions by search query', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search sessions/i);
    fireEvent.change(searchInput, { target: { value: 'expired' } });

    await waitFor(() => {
      expect(screen.getByText('proj-c')).toBeInTheDocument();
    });
    expect(screen.queryByText('proj-a')).not.toBeInTheDocument();
  });

  it('expands session detail on card click', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('proj-a'));

    // Detail panel should appear with action buttons (card already has them too)
    await waitFor(() => {
      const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
      expect(approveButtons.length).toBeGreaterThanOrEqual(2); // card + detail
    });
    const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
    expect(rejectButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('exposes review lifecycle actions for a dispatched session', async () => {
    const calls = [];
    global.fetch.mockImplementation((url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ name: 'proj-1' }]),
        });
      }
      if (url === '/api/review/session-00000002') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            sessionId: 'session-00000002',
            status: 'dispatched',
            project: 'proj-b',
            intent: 'Ship feature',
            history: [],
          }),
        });
      }
      if (url === '/api/review/session-00000002/accept' || url === '/api/review/session-00000002/auto-approve') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accepted: true }),
        });
      }
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ sessionId: 'session-00000002', status: 'dispatched', project: 'proj-b', intent: 'Ship feature' }]),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${url}`));
    });

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('proj-b'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Accept Changes' })).toBeInTheDocument();
    });

    const autoApproveButton = screen.getByRole('button', { name: 'Auto-Approve' });
    fireEvent.click(autoApproveButton);
    await waitFor(() => {
      expect(calls).toContainEqual({ url: '/api/review/session-00000002/auto-approve', method: 'POST' });
    });

    const acceptButton = screen.getByRole('button', { name: 'Accept Changes' });
    fireEvent.click(acceptButton);
    await waitFor(() => {
      expect(calls).toContainEqual({ url: '/api/review/session-00000002/accept', method: 'POST' });
    });
  });

  it('does not show Accept Changes for user_review session', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('proj-a'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.queryByRole('button', { name: 'Accept Changes' })).not.toBeInTheDocument();
  });

  it('does not show create form (sessions are system-created)', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    // No create form or + New button — sessions are created by system triggers
    expect(screen.queryByPlaceholderText(/What should the review accomplish/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New' })).not.toBeInTheDocument();
  });

  it('paginates sessions with 10 per page', async () => {
    const manySessions = createMockSessions(15, 'user_review');
    global.fetch.mockImplementation((url) => {
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(manySessions),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    });

    render(<Review />);

    // Wait for first page to load — should show 10 cards
    await waitFor(() => {
      expect(screen.getByText('proj-0')).toBeInTheDocument();
    });

    // First page: proj-0 through proj-9 (10 items)
    expect(screen.getByText('proj-0')).toBeInTheDocument();
    expect(screen.getByText('proj-9')).toBeInTheDocument();
    expect(screen.queryByText('proj-10')).not.toBeInTheDocument();
    expect(screen.queryByText('proj-14')).not.toBeInTheDocument();

    // Pagination controls should be visible
    expect(screen.getByText('2')).toBeInTheDocument();

    // Click page 2
    fireEvent.click(screen.getByText('2'));

    await waitFor(() => {
      expect(screen.getByText('proj-10')).toBeInTheDocument();
    });

    // Second page: proj-10 through proj-14 (5 items)
    expect(screen.queryByText('proj-0')).not.toBeInTheDocument();
    expect(screen.getByText('proj-14')).toBeInTheDocument();
  });

  it('keeps the selected page when review updates refresh sessions', async () => {
    let reviewFetches = 0;
    global.fetch.mockImplementation((url) => {
      if (url === '/api/review') {
        reviewFetches += 1;
        const suffix = reviewFetches > 1 ? '-refresh' : '';
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(createMockSessions(15, 'user_review').map((session, index) => ({
            ...session,
            project: `proj-${index}${suffix}`,
          }))),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    });

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-0')).toBeInTheDocument();
      expect(socketMock.reviewUpdateHandler).toBeTypeOf('function');
    });

    fireEvent.click(screen.getByText('2'));

    await waitFor(() => {
      expect(screen.getByText('proj-10')).toBeInTheDocument();
    });

    socketMock.reviewUpdateHandler();

    await waitFor(() => {
      expect(screen.getByText('proj-10-refresh')).toBeInTheDocument();
    });
    expect(screen.queryByText('proj-0-refresh')).not.toBeInTheDocument();
  });

  it('shows action buttons on cards for actionable statuses', async () => {
    global.fetch.mockImplementation((url) => {
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSessions),
        });
      }
      if (url.includes('/api/review/session-')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: url.split('/').pop(), status: 'user_review', project: 'proj-a', intent: 'Fix auth bug', history: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    });

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    // user_review cards should have Approve and Reject buttons on the card
    const allApproveButtons = screen.getAllByRole('button', { name: 'Approve' });
    const allRejectButtons = screen.getAllByRole('button', { name: 'Reject' });

    // There should be card-level buttons (at least 2 user_review sessions: proj-a and proj-e)
    expect(allApproveButtons.length).toBeGreaterThanOrEqual(2);
    expect(allRejectButtons.length).toBeGreaterThanOrEqual(2);

    // idle card should have Start button on the card
    const startButtons = screen.getAllByRole('button', { name: 'Start' });
    expect(startButtons.length).toBeGreaterThanOrEqual(1);

    // dispatched card should have Accept button on the card
    const acceptButtons = screen.getAllByRole('button', { name: 'Accept' });
    expect(acceptButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('card action buttons trigger API calls', async () => {
    const calls = [];
    global.fetch.mockImplementation((url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSessions),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    });

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    // Click Approve on card for proj-a (user_review)
    const allApproveButtons = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(allApproveButtons[0]);

    await waitFor(() => {
      expect(calls).toContainEqual({ url: '/api/review/session-00000001/approve', method: 'POST' });
    });
  });

  it('resets page to 1 when search query changes', async () => {
    const manySessions = createMockSessions(15, 'user_review');
    global.fetch.mockImplementation((url) => {
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(manySessions),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    });

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-0')).toBeInTheDocument();
    });

    // Go to page 2
    fireEvent.click(screen.getByText('2'));

    await waitFor(() => {
      expect(screen.getByText('proj-10')).toBeInTheDocument();
    });

    // Search for a specific project that only matches one session — resets to page 1
    const searchInput = screen.getByPlaceholderText(/Search sessions/i);
    fireEvent.change(searchInput, { target: { value: 'proj-3' } });

    await waitFor(() => {
      // Only proj-3 should remain, page 2 content gone
      expect(screen.queryByText('proj-14')).not.toBeInTheDocument();
      expect(screen.queryByText('proj-10')).not.toBeInTheDocument();
    });

    expect(screen.getByText('proj-3')).toBeInTheDocument();
  });
});
