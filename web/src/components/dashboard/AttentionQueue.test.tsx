import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttentionQueue } from './AttentionQueue';
import type { AttentionItem } from '@/types/api';

function attention(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'attention-1',
    severity: 'critical',
    kind: 'workflow_failed',
    project: 'flow',
    title: 'Workflow failed',
    reason: 'Executor stopped during verify.',
    impact: 'Release is blocked until the run is repaired.',
    ageMs: 3_600_000,
    updatedAt: '2026-06-11T00:00:00.000Z',
    nextHumanAction: {
      label: 'Inspect run',
      href: '/project/flow?tab=overview',
      kind: 'inspect',
    },
    evidence: [{ type: 'job', id: 'job-1' }],
    ...overrides,
  };
}

describe('AttentionQueue', () => {
  it('renders canonical attention fields without a hand-built view model', async () => {
    const onNavigate = vi.fn();
    render(<AttentionQueue items={[attention()]} onNavigate={onNavigate} />);

    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('flow - Workflow failed')).toBeInTheDocument();
    expect(screen.getByText('Executor stopped during verify.')).toBeInTheDocument();
    expect(screen.getByText('Release is blocked until the run is repaired.')).toBeInTheDocument();
    expect(screen.getByText('1h old')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Inspect run' }));
    expect(onNavigate).toHaveBeenCalledWith('/project/flow?tab=overview');
  });
});
