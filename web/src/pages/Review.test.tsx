import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Review from './Review';

const mockSessions = [
  { id: 's1', project: 'proj-a', instruction: 'Fix auth bug', status: 'user_review', createdAt: '2026-05-17T08:00:00Z', reviewRounds: [] },
  { id: 's2', project: 'proj-b', instruction: 'Ship feature', status: 'queued', createdAt: '2026-05-17T09:00:00Z', reviewRounds: [] },
  { id: 's3', project: 'proj-c', instruction: 'Research task', status: 'researching', createdAt: '2026-05-17T10:00:00Z', reviewRounds: [] },
  { id: 's4', project: 'proj-d', instruction: 'Done task', status: 'approved', createdAt: '2026-05-17T11:00:00Z', reviewRounds: [] },
];

const mockStore = {
  sessions: mockSessions,
  selectedId: null,
  page: 1,
  totalPages: 1,
  query: '',
  loading: false,
  fetchSessions: vi.fn(),
  selectSession: vi.fn(),
  setQuery: vi.fn(),
  setPage: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  startReview: vi.fn(),
  autoApprove: vi.fn(),
  analyze: vi.fn(),
};

vi.mock('@/app/store', () => ({
  useReviewStore: () => mockStore,
  useWebSocketStore: () => ({
    subscribe: vi.fn(() => vi.fn()),
    connected: true,
  }),
}));

describe('Review Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title and session cards', async () => {
    render(<Review />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getAllByText('review.title')[0]).toBeInTheDocument();
    });
    expect(screen.getByText('proj-a')).toBeInTheDocument();
    expect(screen.getByText('proj-b')).toBeInTheDocument();
    expect(screen.getByText('proj-c')).toBeInTheDocument();
    expect(screen.getByText('proj-d')).toBeInTheDocument();
  });

  it('renders status group tabs with counts', async () => {
    render(<Review />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText(/review\.all/)).toBeInTheDocument();
    });
    expect(screen.getByText(/review\.needsAction/)).toBeInTheDocument();
    expect(screen.getByText(/review\.inProgress/)).toBeInTheDocument();
    expect(screen.getByText(/review\.done/)).toBeInTheDocument();
  });

  it('renders search input', async () => {
    render(<Review />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('review.searchPlaceholder')).toBeInTheDocument();
    });
  });

  it('selects session on card click', async () => {
    render(<Review />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('proj-a'));
    expect(mockStore.selectSession).toHaveBeenCalledWith('s1');
  });

  it('shows status badges on cards', async () => {
    render(<Review />, { wrapper: MemoryRouter });

    await waitFor(() => {
      expect(screen.getByText('proj-a')).toBeInTheDocument();
    });

    expect(screen.getByText(/Needs Review/)).toBeInTheDocument();
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
    expect(screen.getByText(/Researching/)).toBeInTheDocument();
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
  });
});
