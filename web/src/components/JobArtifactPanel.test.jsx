import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import JobArtifactPanel from './JobArtifactPanel';

describe('JobArtifactPanel', () => {
  it('renders artifact index, verdict status, and broken artifact warnings', () => {
    render(<JobArtifactPanel detail={{
      project: 'frontend',
      jobId: 'job-123',
      verdict: {
        status: 'fail',
        confidence: 0.74,
        reason: 'Missing regression test.',
        blockingCount: 1,
      },
      warnings: [
        { kind: 'diff', message: 'Artifact diff-missing.patch is missing.' },
      ],
      artifactIndex: {
        entries: [
          { kind: 'plan', id: 'plan-001', path: '/tmp/plan-001.md', broken: false, sha256: 'abc123' },
          { kind: 'verdict', id: 'verdict-001', path: '/tmp/verdict-001.md', broken: false, sha256: 'def456' },
          { kind: 'diff', id: 'diff-missing', path: '/tmp/diff-missing.patch', broken: true, reason: 'missing file', sha256: null },
        ],
      },
    }} />);

    expect(screen.getByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();
    expect(screen.getByText('Missing regression test.')).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(screen.getByText('verdict')).toBeInTheDocument();
    expect(screen.getByText('diff')).toBeInTheDocument();
    expect(screen.getByText(/Artifact diff-missing\.patch is missing/)).toBeInTheDocument();
    expect(screen.getByText('missing file')).toBeInTheDocument();
  });
});
