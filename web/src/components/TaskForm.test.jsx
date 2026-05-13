import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskForm from './TaskForm';

describe('TaskForm', () => {
  it('renders project select and task textarea', () => {
    render(<TaskForm projects={['demo']} onSubmit={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe what you want/i)).toBeInTheDocument();
  });

  it('disables submit when task is empty', () => {
    render(<TaskForm projects={['demo']} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('enables submit when task is filled', async () => {
    render(<TaskForm projects={['demo']} onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/describe what you want/i), 'Add dark mode');
    expect(screen.getByRole('button', { name: /submit/i })).not.toBeDisabled();
  });

  it('calls onSubmit with form values', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm projects={['demo', 'other']} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByPlaceholderText(/describe what you want/i), 'Add tests');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'Add tests', project: 'demo', mode: 'pipeline' }),
    );
  });

  it('shows retry/timeout fields in pipeline mode', () => {
    render(<TaskForm projects={['demo']} onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('spinbutton').length).toBe(2);
  });

  it('hides retry/timeout fields in plan-only mode', async () => {
    render(<TaskForm projects={['demo']} onSubmit={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /plan only/i }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('syncs project select when projects list changes', () => {
    const { rerender } = render(
      <TaskForm projects={['old']} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('old');

    rerender(<TaskForm projects={['new']} onSubmit={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('new');
  });

  it('shows "No projects" option when empty', () => {
    render(<TaskForm projects={[]} onSubmit={vi.fn()} />);
    expect(screen.getByText('No projects')).toBeInTheDocument();
  });
});
