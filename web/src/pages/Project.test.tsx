import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Project from './Project';

const mockFetchProjects = vi.fn();

const mockProject = {
  name: 'test-project',
  displayName: 'Test Project',
  pipelineState: { phase: 'execute', status: 'running' },
  projectIndex: { state: 'indexed', branch: 'main', fileCount: 42 },
  recentLog: ['Log line 1', 'Log line 2'],
};

vi.mock('@/app/store', () => ({
  useProjectsStore: Object.assign(() => ({
    loading: false,
    getProject: () => mockProject,
    fetchProjects: mockFetchProjects,
  }), {
    getState: () => ({ fetchProjects: mockFetchProjects }),
  }),
  useWebSocketStore: () => ({
    subscribe: vi.fn(() => vi.fn()),
    connected: true,
  }),
}));

describe('Project Page', () => {
  beforeEach(() => {
    mockFetchProjects.mockClear();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/inbox')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(['file-1.json', 'file-2.json']) } as Response);
      }
      if (u.includes('/outputs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(['out-1.json']) } as Response);
      }
      if (u.includes('/files/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: 'mock content' }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(null) } as Response);
    });
  });

  const renderProject = () =>
    render(
      <MemoryRouter initialEntries={['/project/test-project']}>
        <Routes>
          <Route path="/project/:name" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    );

  it('renders project name heading', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });
  });

  it('renders tab navigation', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'project.overview' })).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: 'project.tasks' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'project.knowledge' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'project.settings' })).toBeInTheDocument();
  });

  it('switches to tasks tab and shows file browser', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'project.tasks' }));

    await waitFor(() => {
      expect(screen.getByText('project.inbox')).toBeInTheDocument();
    });
  });

  it('switches to settings tab with toggles', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'project.settings' }));

    await waitFor(() => {
      expect(screen.getByText('project.autoSync')).toBeInTheDocument();
    });
    expect(screen.getByText('project.writeback')).toBeInTheDocument();
    expect(screen.getByText('project.diagnostics')).toBeInTheDocument();
  });

  it('shows codebase index info in overview', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    expect(screen.getByText('project.codebaseIndex')).toBeInTheDocument();
  });

  it('refreshes the code index through the Hub index endpoint', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /project\.refreshIndex/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/hub/projects/test-project/index/refresh', { method: 'POST' });
    });
  });

  it('runs project task actions through the backend pipeline route contract', async () => {
    renderProject();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /project\.runPipeline/ }));
    fireEvent.click(screen.getByRole('button', { name: /project\.planOnly/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/tasks/test-project/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'Full pipeline run for test-project',
          workflow: 'standard',
          planMode: 'full',
          autoFinalize: false,
        }),
      });
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/tasks/test-project/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'Plan for test-project',
        workflow: 'standard',
        planMode: 'light',
        autoFinalize: false,
      }),
    });
  });
});
