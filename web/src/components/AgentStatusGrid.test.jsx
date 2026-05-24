import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AgentStatusGrid from './AgentStatusGrid';

const MOCK_AGENTS = [
  {
    name: 'coder-agent',
    displayName: 'Coder Agent',
    stability: 'stable',
    pool: { active: 1, limit: 3 },
    jobs: { total: 10, running: 1, successRate: 90 },
    command: 'node run.js',
    capabilities: ['write_code', 'run_tests'],
    defaultRoles: ['developer']
  },
  {
    name: 'review-agent',
    displayName: 'Review Agent',
    stability: 'experimental',
    pool: { active: 0, limit: 2 },
    jobs: { total: 5, running: 0, successRate: 40 },
    command: 'python eval.py',
    capabilities: ['code_review'],
    defaultRoles: ['reviewer']
  }
];

describe('AgentStatusGrid', () => {
  it('renders fallback when no agents are registered', () => {
    render(<AgentStatusGrid agents={[]} />);
    expect(screen.getByText(/No agents registered/)).toBeInTheDocument();
  });

  it('renders list of registered agents with displayName and stability', () => {
    render(<AgentStatusGrid agents={MOCK_AGENTS} />);
    expect(screen.getByText('Coder Agent')).toBeInTheDocument();
    expect(screen.getByText('Review Agent')).toBeInTheDocument();
    expect(screen.getByText('stable')).toBeInTheDocument();
    expect(screen.getByText('experimental')).toBeInTheDocument();
  });

  it('correctly maps success rates and shows low success warning', () => {
    render(<AgentStatusGrid agents={MOCK_AGENTS} />);
    const coderRate = screen.getByText('90%');
    const reviewerRate = screen.getByText('40%');
    expect(coderRate.className).toContain('high');
    expect(reviewerRate.className).toContain('low');
  });

  it('applies selected class to the active agent card', () => {
    const { container } = render(<AgentStatusGrid agents={MOCK_AGENTS} selectedAgent="coder-agent" />);
    const activeCard = container.querySelector('.agent-card.selected');
    expect(activeCard).toBeInTheDocument();
    expect(activeCard.textContent).toContain('Coder Agent');
  });

  it('triggers onSelect callback when clicking on an agent card', () => {
    const onSelectSpy = vi.fn();
    render(<AgentStatusGrid agents={MOCK_AGENTS} onSelect={onSelectSpy} />);
    const firstCard = screen.getByText('Coder Agent').closest('.agent-card');
    fireEvent.click(firstCard);
    expect(onSelectSpy).toHaveBeenCalledWith('coder-agent');
  });

  it('triggers onSelect(null) when clicking an already selected card', () => {
    const onSelectSpy = vi.fn();
    render(<AgentStatusGrid agents={MOCK_AGENTS} onSelect={onSelectSpy} selectedAgent="coder-agent" />);
    const firstCard = screen.getByText('Coder Agent').closest('.agent-card');
    fireEvent.click(firstCard);
    expect(onSelectSpy).toHaveBeenCalledWith(null);
  });
});
