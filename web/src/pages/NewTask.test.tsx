import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import NewTask, { formatTaskSuccessMessage } from './NewTask';

const mocks = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
}));

vi.mock('@/app/store', () => ({
  useProjectsStore: () => ({
    projects: [{ name: 'flow' }],
    fetchProjects: mocks.fetchProjects,
  }),
}));

describe('NewTask success feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes queue entry details when the API returns them', () => {
    const message = formatTaskSuccessMessage(
      {
        queued: true,
        entry: {
          id: 'q-123',
          projectId: 'flow',
          status: 'pending',
        },
      },
      'task.success',
    );

    expect(message).toContain('task.success');
    expect(message).toContain('q-123');
    expect(message).toContain('flow');
    expect(message).toContain('pending');
  });

  it('falls back to the generic success text when queue details are absent', () => {
    expect(formatTaskSuccessMessage({ queued: true }, 'task.success')).toBe('task.success');
  });

  it('submits the form and renders queue details plus an inbox link', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        queued: true,
        entry: {
          id: 'q-123',
          projectId: 'flow',
          status: 'pending',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <NewTask />
      </MemoryRouter>,
    );

    await userEvent.selectOptions(screen.getByLabelText('task.project'), 'flow');
    await userEvent.type(screen.getByLabelText('task.description'), 'Ship reliable queue updates');
    await userEvent.click(screen.getByRole('button', { name: 'task.submit' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tasks/flow/pipeline', expect.objectContaining({
        method: 'POST',
      }));
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({
      task: 'Ship reliable queue updates',
      workflow: 'standard',
      planMode: 'full',
      autoFinalize: false,
    });

    expect(await screen.findByText(/task\.success.*q-123.*flow.*pending/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'nav.inbox' })).toHaveAttribute('href', '/inbox');
  });
});
