import React from 'react';

const STABILITY_COLORS = {
  stable: '#4caf50',
  experimental: '#ff9800',
  unknown: '#9e9e9e',
};

const STATUS_COLORS = {
  ok: '#4caf50',
  warn: '#ff9800',
  error: '#f44336',
  idle: '#9e9e9e',
};

export default function AgentStatusGrid({ agents, onSelect, selectedAgent }) {
  if (!agents || agents.length === 0) {
    return (
      <div style={{ color: '#888', textAlign: 'center', padding: 32 }}>
        No agents registered. Check that agent descriptors exist in core/agents/descriptors/.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
      {agents.map((agent) => {
        const poolActive = agent.pool?.active || 0;
        const poolLimit = agent.pool?.limit || 0;
        const rateLimited = agent.pool?.rateLimitedUntil && Date.now() < agent.pool.rateLimitedUntil;
        const statusKey = rateLimited ? 'warn' : poolActive > 0 ? 'ok' : 'idle';
        const isSelected = selectedAgent === agent.name;

        return (
          <div
            key={agent.name}
            onClick={() => onSelect?.(isSelected ? null : agent.name)}
            style={{ cursor: 'pointer' }}
          >
            <div style={{
              border: `1px solid ${isSelected ? '#2196f3' : '#333'}`,
              borderRadius: 8,
              padding: 16,
              background: '#1a1a2e',
              minWidth: 280,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, color: '#e0e0e0' }}>{agent.displayName}</h3>
                <span style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: STABILITY_COLORS[agent.stability] || STABILITY_COLORS.unknown,
                  color: '#fff',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}>
                  {agent.stability}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#bbb' }}>
                <div>
                  <span style={{ color: STATUS_COLORS[statusKey] }}>&#9679;</span>
                  {' '}Pool: {poolActive}/{poolLimit} active
                </div>
                <div>
                  Jobs: {agent.jobs.total} ({agent.jobs.running} running)
                </div>
                {agent.jobs.successRate !== null && (
                  <div style={{
                    color: agent.jobs.successRate >= 80 ? '#4caf50' : agent.jobs.successRate >= 50 ? '#ff9800' : '#f44336',
                  }}>
                    Success: {agent.jobs.successRate}%
                  </div>
                )}
              </div>

              {rateLimited && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#ff9800' }}>
                  Rate limited until {new Date(agent.pool.rateLimitedUntil).toLocaleTimeString()}
                </div>
              )}

              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(agent.capabilities || []).map((cap) => (
                  <span key={cap} style={{
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: '#2a2a4a',
                    color: '#aaa',
                  }}>
                    {cap}
                  </span>
                ))}
              </div>

              <div style={{ marginTop: 8, fontSize: 11, color: '#666' }}>
                {agent.command} {agent.phases?.length > 0 && `| phases: ${agent.phases.join(', ')}`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
