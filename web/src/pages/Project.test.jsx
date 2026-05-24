import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Project from './Project';

// Mock useWebSocket hook
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const mockProjectData = {
  name: 'test-project',
  displayName: 'Test Project',
  tasks: `- [ ] First backlog task
- [/] In-progress item
- [x] Finished verification task`,
  pipelineState: {
    phase: 'execute',
    status: 'running',
  },
  projectIndex: {
    state: 'ready',
    branch: 'main',
    fileCount: 42,
    symbolCount: 318,
  },
  log: 'Log line 1\nLog line 2',
  context: 'Project context files content',
  decisions: 'Architecture decisions content',
};

const mockFilesInbox = [
  'file-1.json',
  'file-2.json',
  'file-3.json',
  'file-4.json',
  'file-5.json',
  'file-6.json',
  'file-7.json',
];

const mockFilesOutputs = [
  'output-1.json',
  'output-2.json',
];

describe('Project Page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    
    // Setup fetch mock
    vi.spyOn(global, 'fetch').mockImplementation((url) => {
      if (url.includes('/api/projects/test-project/inbox')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockFilesInbox),
        });
      }
      if (url.includes('/api/projects/test-project/outputs')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockFilesOutputs),
        });
      }
      if (url.includes('/api/projects/test-project/files/inbox/file-7.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ content: '{"status": "test file 7 content"}' }),
        });
      }
      if (url.includes('/api/projects/test-project/files/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ content: '{"status": "some mock content"}' }),
        });
      }
      if (url.includes('/api/projects/test-project')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockProjectData),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${url}`));
    });
  });

  const renderComponent = () => {
    return render(
      <MemoryRouter initialEntries={['/project/test-project']}>
        <Routes>
          <Route path="/project/:name" element={<Project />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('renders the project page loading state, then content', async () => {
    renderComponent();

    expect(screen.getByText('Loading...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    expect(screen.getByText('Project Narrative Summary')).toBeInTheDocument();
    expect(screen.getByText('Live Feed')).toBeInTheDocument();
  });

  it('renders the Codebase Index summary from projectIndex', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    expect(screen.getByText('Codebase Index')).toBeInTheDocument();

    // State badge
    const stateBadges = screen.getAllByText('ready');
    expect(stateBadges.length).toBeGreaterThanOrEqual(1);

    // Branch appears in badge and Codebase Index section
    expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);

    // Indexed counts from mock
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('318')).toBeInTheDocument();
  });

  it('switches to tasks tab and displays files with list capping', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    // Click 'tasks' tab button
    const tasksTab = screen.getByRole('button', { name: 'tasks' });
    fireEvent.click(tasksTab);

    // Verify task lists render correctly
    await waitFor(() => {
      expect(screen.getByText('First backlog task')).toBeInTheDocument();
    });
    expect(screen.getByText('Generated Deliverables & Inbox Files')).toBeInTheDocument();

    // Files list defaults to Inbox files with > 5 items capped to 5
    await waitFor(() => {
      expect(screen.getByText('file-1.json')).toBeInTheDocument();
    });
    expect(screen.getByText('file-5.json')).toBeInTheDocument();
    expect(screen.queryByText('file-6.json')).not.toBeInTheDocument();

    // Show more button
    const showMoreBtn = screen.getByRole('button', { name: /Show All Files/ });
    expect(showMoreBtn).toBeInTheDocument();

    // Expand list
    fireEvent.click(showMoreBtn);
    await waitFor(() => {
      expect(screen.getByText('file-6.json')).toBeInTheDocument();
    });
    expect(screen.getByText('file-7.json')).toBeInTheDocument();

    // Toggle back to collapse
    const showLessBtn = screen.getByRole('button', { name: /Show Less Files/ });
    fireEvent.click(showLessBtn);
    await waitFor(() => {
      expect(screen.queryByText('file-6.json')).not.toBeInTheDocument();
    });
  });

  it('retains active file selection in the visible capped subset whencollapsed', async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'test-project' })).toBeInTheDocument();
    });

    const tasksTab = screen.getByRole('button', { name: 'tasks' });
    fireEvent.click(tasksTab);

    // Wait for files to load
    await waitFor(() => {
      expect(screen.getByText('file-1.json')).toBeInTheDocument();
    });

    // Expand to select file-7.json (index 6, which is beyond index 4)
    const showMoreBtn = screen.getByRole('button', { name: /Show All Files/ });
    fireEvent.click(showMoreBtn);

    const file7 = await waitFor(() => screen.getByRole('button', { name: 'file-7.json' }));
    fireEvent.click(file7);

    // Now collapse the list
    const showLessBtn = screen.getByRole('button', { name: /Show Less Files/ });
    fireEvent.click(showLessBtn);

    // State retention logic: should show file-1.json through file-4.json, AND the selected file-7.json
    await waitFor(() => {
      expect(screen.getByText('file-7.json')).toBeInTheDocument();
    });
    expect(screen.getByText('file-1.json')).toBeInTheDocument();
    expect(screen.getByText('file-2.json')).toBeInTheDocument();
    expect(screen.getByText('file-3.json')).toBeInTheDocument();
    expect(screen.getByText('file-4.json')).toBeInTheDocument();
    
    // file-5.json and file-6.json are omitted
    expect(screen.queryByText('file-5.json')).not.toBeInTheDocument();
    expect(screen.queryByText('file-6.json')).not.toBeInTheDocument();
  });
});
