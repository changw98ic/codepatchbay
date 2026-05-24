import React from 'react';

function SetupReadiness({ setupAgents }) {
  if (!setupAgents || setupAgents.length === 0) return null;
  return (
    <section className="agent-setup-readiness" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>Setup readiness</h3>
      <div className="agent-grid">
        {setupAgents.map((agent) => {
          const statusKey = agent.installed ? 'ok' : agent.recommended ? 'warn' : 'idle';
          return (
            <div key={agent.id} className={`agent-card setup-agent-card ${agent.installed ? 'installed' : 'missing'}`}>
              <div className="agent-card-header">
                <h3 className="agent-display-name">{agent.displayName}</h3>
                <span className={`agent-stability-badge ${agent.installed ? 'stable' : 'experimental'}`}>
                  {agent.status}
                </span>
              </div>
              <div className="agent-metrics">
                <div className="agent-metric-item">
                  <span className={`agent-status-dot ${statusKey}`} />
                  <span>{agent.vendor} {agent.version ? `| ${agent.version}` : ''}</span>
                </div>
                <div className="agent-metric-item">
                  <span>Install: {agent.install?.label || agent.install?.method || 'ready'}</span>
                </div>
                {agent.adapter?.command && (
                  <div className="agent-metric-item">
                    <span>Adapter: {agent.adapter.command}</span>
                  </div>
                )}
              </div>
              {!agent.installed && agent.install?.safePlanCommand && (
                <div className="agent-info-footer">
                  <code>{agent.install.safePlanCommand}</code>
                </div>
              )}
              <div className="agent-capability-pills">
                {(agent.roles || []).map((role) => (
                  <span key={role} className="agent-capability-pill">
                    {role}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function AgentStatusGrid({ agents, onSelect, selectedAgent, setupAgents = [] }) {
  if ((!agents || agents.length === 0) && (!setupAgents || setupAgents.length === 0)) {
    return (
      <div className="empty-agents-container" style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '48px 32px' }}>
        No agents registered. Check that agent descriptors exist in core/agents/descriptors/.
      </div>
    );
  }

  return (
    <>
      <SetupReadiness setupAgents={setupAgents} />
      <div className="agent-grid">
        {(agents || []).map((agent) => {
        const poolActive = agent.pool?.active || 0;
        const poolLimit = agent.pool?.limit || 0;
        const rateLimited = agent.pool?.rateLimitedUntil && Date.now() < agent.pool.rateLimitedUntil;
        const statusKey = rateLimited ? 'warn' : poolActive > 0 ? 'ok' : 'idle';
        const isSelected = selectedAgent === agent.name;

        const successRateClass = agent.jobs.successRate >= 80 
          ? 'high' 
          : agent.jobs.successRate >= 50 
            ? 'mid' 
            : 'low';

        return (
          <div
            key={agent.name}
            className={`agent-card ${isSelected ? 'selected' : ''}`}
            onClick={() => onSelect?.(isSelected ? null : agent.name)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onSelect?.(isSelected ? null : agent.name);
              }
            }}
          >
            <div className="agent-card-header">
              <h3 className="agent-display-name">{agent.displayName}</h3>
              <span className={`agent-stability-badge ${agent.stability || 'unknown'}`}>
                {agent.stability}
              </span>
            </div>

            <div className="agent-metrics">
              <div className="agent-metric-item">
                <span className={`agent-status-dot ${statusKey}`} />
                <span>Pool: {poolActive}/{poolLimit} active</span>
              </div>
              <div className="agent-metric-item">
                <span>Jobs: {agent.jobs.total} ({agent.jobs.running} running)</span>
              </div>
              {agent.jobs.successRate !== null && (
                <div className="agent-metric-item">
                  <span>Success: <span className={`agent-success-rate ${successRateClass}`}>{agent.jobs.successRate}%</span></span>
                </div>
              )}
            </div>

            {rateLimited && (
              <div className="agent-rate-limited" style={{ marginTop: '8px', fontSize: '12px', color: 'var(--warning)', fontWeight: 600 }}>
                Rate limited until {new Date(agent.pool.rateLimitedUntil).toLocaleTimeString()}
              </div>
            )}

            <div className="agent-capability-pills">
              {(agent.capabilities || []).map((cap) => (
                <span key={cap} className="agent-capability-pill">
                  {cap}
                </span>
              ))}
            </div>

            <div className="agent-info-footer">
              {agent.command} {agent.defaultRoles?.length > 0 && `| roles: ${agent.defaultRoles.join(', ')}`}
            </div>
          </div>
        );
      })}
      </div>
    </>
  );
}
