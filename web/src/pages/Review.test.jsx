import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Review from './Review';

// Mock useWebSocket hook
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const mockSessions = [
  { sessionId: 'session-00000001', status: 'user_review' },
  { sessionId: 'session-00000002', status: 'dispatched' },
  { sessionId: 'session-00000003', status: 'expired' },
  { sessionId: 'session-00000004', status: 'idle' },
  { sessionId: 'session-00000005', status: 'user_review' },
  { sessionId: 'session-00000006', status: 'dispatched' },
  { sessionId: 'session-00000007', status: 'user_review' },
];

describe('Review Page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Setup global fetch mock
    vi.spyOn(global, 'fetch').mockImplementation((url) => {
      if (url.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ name: 'proj-1' }, { name: 'proj-2' }]),
        });
      }
      if (url.includes('/api/review/session-00000007')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: 'session-00000007', status: 'user_review', history: [] }),
        });
      }
      if (url.includes('/api/review/session-')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: 'session-00000001', status: 'user_review', history: [] }),
        });
      }
      if (url.includes('/api/review')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockSessions),
        });
      }
      if (url.includes('/api/evolve/status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ running: false }),
        });
      }
      if (url.includes('/api/evolve/history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${url}`));
    });
  });

  it('renders sessions list with capping', async () => {
    render(<Review />);

    // Wait for sessions to load
    await waitFor(() => {
      expect(screen.getByText('00000001')).toBeInTheDocument();
    });

    // Defaults to capping to 5 items
    expect(screen.getByText('00000001')).toBeInTheDocument();
    expect(screen.getByText('00000005')).toBeInTheDocument();
    expect(screen.queryByText('00000006')).not.toBeInTheDocument();

    // Show All button should be rendered
    const showAllBtn = screen.getByRole('button', { name: /Show All \(7\)/ });
    expect(showAllBtn).toBeInTheDocument();

    // Expand the list
    fireEvent.click(showAllBtn);
    await waitFor(() => {
      expect(screen.getByText('00000006')).toBeInTheDocument();
    });
    expect(screen.getByText('00000007')).toBeInTheDocument();

    // Collapse the list
    const showLessBtn = screen.getByRole('button', { name: /Show Less/ });
    fireEvent.click(showLessBtn);
    await waitFor(() => {
      expect(screen.queryByText('00000006')).not.toBeInTheDocument();
    });
  });

  it('filters sessions list by query input and clears query', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('00000001')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search sessions.../i);
    expect(searchInput).toBeInTheDocument();

    // Filter by 'expired' status
    fireEvent.change(searchInput, { target: { value: 'expired' } });
    
    await waitFor(() => {
      expect(screen.getByText('00000003')).toBeInTheDocument();
    });
    expect(screen.queryByText('00000001')).not.toBeInTheDocument();

    // Clear search using clear button
    const clearBtn = screen.getByRole('button', { name: '✕' });
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(screen.getByText('00000001')).toBeInTheDocument();
    });
  });

  it('retains active session in visible list when collapsed', async () => {
    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText('00000001')).toBeInTheDocument();
    });

    // Expand the sessions
    const showAllBtn = screen.getByRole('button', { name: /Show All \(7\)/ });
    fireEvent.click(showAllBtn);

    const session7Button = await waitFor(() => screen.getByRole('button', { name: /00000007/ }));
    fireEvent.click(session7Button);

    // Now collapse sessions list
    const showLessBtn = screen.getByRole('button', { name: /Show Less/ });
    fireEvent.click(showLessBtn);

    // State retention logic: should show session 1-4, and selected session-00000007
    await waitFor(() => {
      expect(screen.getByText('00000007')).toBeInTheDocument();
    });
    expect(screen.getByText('00000001')).toBeInTheDocument();
    expect(screen.getByText('00000002')).toBeInTheDocument();
    expect(screen.getByText('00000003')).toBeInTheDocument();
    expect(screen.getByText('00000004')).toBeInTheDocument();

    // Session 5 and 6 are omitted
    expect(screen.queryByText('00000005')).not.toBeInTheDocument();
    expect(screen.queryByText('00000006')).not.toBeInTheDocument();
  });
});
