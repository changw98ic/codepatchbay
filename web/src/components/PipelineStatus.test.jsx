import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PipelineStatus from './PipelineStatus';

describe('PipelineStatus', () => {
  it('returns null when state is null', () => {
    const { container } = render(<PipelineStatus state={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders standard phases: Plan, Execute, Verify', () => {
    render(<PipelineStatus state={{ phase: 'execute', status: 'running' }} />);
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
  });

  it('marks current phase as running', () => {
    render(<PipelineStatus state={{ phase: 'execute', status: 'running' }} />);
    const phases = screen.getAllByRole('generic').filter(
      el => el.className.includes('phase ')
    );
    const execute = phases.find(el => el.textContent.includes('Execute'));
    expect(execute.className).toContain('running');
  });

  it('marks phases before current as completed', () => {
    render(<PipelineStatus state={{ phase: 'verify', status: 'running' }} />);
    const phases = screen.getAllByRole('generic').filter(
      el => el.className.includes('phase ')
    );
    const plan = phases.find(el => el.textContent.includes('Plan'));
    expect(plan.className).toContain('completed');
  });

  it('marks all phases pending when phase is null', () => {
    render(<PipelineStatus state={{ phase: null, status: 'idle' }} />);
    const phases = screen.getAllByRole('generic').filter(
      el => el.className.includes('phase ')
    );
    for (const el of phases) {
      expect(el.className).toContain('pending');
    }
  });

  it('injects unknown phase into display', () => {
    render(<PipelineStatus state={{ phase: 'review', status: 'running' }} />);
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
  });

  it('shows retry count when > 0', () => {
    render(<PipelineStatus state={{ phase: 'execute', status: 'running', retryCount: 2 }} />);
    expect(screen.getByText('Retry #2')).toBeInTheDocument();
  });

  it('hides retry count when absent or 0', () => {
    render(<PipelineStatus state={{ phase: 'execute', status: 'running' }} />);
    expect(screen.queryByText(/Retry/)).not.toBeInTheDocument();
  });

  it('uses custom phases from workflow', () => {
    render(<PipelineStatus state={{
      phase: 'build', status: 'running', phases: ['plan', 'build', 'test', 'deploy'],
    }} />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.queryByText('Execute')).not.toBeInTheDocument();
  });

  it('renders DAG nodes when node state is available', () => {
    render(<PipelineStatus state={{
      nodes: [
        { id: 'plan', phase: 'plan', status: 'completed', durationMs: 90_000 },
        { id: 'execute', phase: 'execute', status: 'retrying', attempt: 2, reason: 'verify failed' },
        { id: 'verify', phase: 'verify', status: 'failed', error: 'quality gate failed' },
      ],
    }} />);

    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('1m 30s')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('verify failed')).toBeInTheDocument();
    expect(screen.getByText('quality gate failed')).toBeInTheDocument();
  });

  it('uses phase fallback when DAG nodes are absent', () => {
    render(<PipelineStatus state={{ phase: 'execute', status: 'running', nodes: [] }} />);
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Execute')).toBeInTheDocument();
    expect(screen.getByText('Verify')).toBeInTheDocument();
  });
});
