import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NewTask from './NewTask';

const mockFetchProjects = vi.fn();

vi.mock('@/app/store', () => ({
  useProjectsStore: () => ({
    projects: [{ name: 'proj-a' }],
    fetchProjects: mockFetchProjects,
  }),
}));

describe('NewTask Page', () => {
  beforeEach(() => {
    mockFetchProjects.mockClear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ queued: true }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits tasks to the backend pipeline route with the current body contract', async () => {
    render(<NewTask />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('task.project'), { target: { value: 'proj-a' } });
    fireEvent.change(screen.getByLabelText('task.description'), {
      target: { value: 'Run a reliable frontend task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'task.submit' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/tasks/proj-a/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Run a reliable frontend task',
        workflow: 'standard',
        planMode: 'full',
        autoFinalize: false,
        maxRetries: 3,
        timeoutSeconds: 600,
      }),
    });
  });

  it('shows backend error messages for failed submissions', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: 'task required' }),
    } as Response);

    render(<NewTask />, { wrapper: MemoryRouter });

    fireEvent.change(screen.getByLabelText('task.project'), { target: { value: 'proj-a' } });
    fireEvent.change(screen.getByLabelText('task.description'), {
      target: { value: 'Run a reliable frontend task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'task.submit' }));

    await waitFor(() => {
      expect(screen.getByText('task.error: task required')).toBeInTheDocument();
    });
  });
});
