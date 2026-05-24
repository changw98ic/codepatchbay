import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DurableJobs from './DurableJobs';

describe('DurableJobs', () => {
  it('renders queue readiness fields for job rows', () => {
    render(<DurableJobs tasks={[
      {
        jobId: 'job-queue-1',
        project: 'frontend',
        status: 'running',
        workflow: 'strict',
        currentPhase: 'execute',
        retryCount: 2,
        source: { label: 'GitHub issue #123' },
        nextHumanAction: { label: 'Review redirect instructions' },
      },
    ]} />);

    expect(screen.getByText('GitHub issue #123')).toBeInTheDocument();
    expect(screen.getByText('strict')).toBeInTheDocument();
    expect(screen.getByText('execute')).toBeInTheDocument();
    expect(screen.getByText('Retry 2')).toBeInTheDocument();
    expect(screen.getByText('Review redirect instructions')).toBeInTheDocument();
  });
});
