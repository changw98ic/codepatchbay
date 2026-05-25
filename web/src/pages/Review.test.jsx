import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Review from './Review';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: vi.fn(() => vi.fn()),
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

describe('Review Page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Accept Changes' })).not.toBeInTheDocument();
  });

  it('toggles create form with + New button', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    // Create form hidden initially
    expect(screen.queryByPlaceholderText(/What should the review accomplish/)).not.toBeInTheDocument();

    // Show form
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(screen.getByPlaceholderText(/What should the review accomplish/)).toBeInTheDocument();

    // Hide form
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText(/What should the review accomplish/)).not.toBeInTheDocument();
  });
});
