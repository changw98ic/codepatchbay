import React from 'react';

export default function ResourceMeter({ agents }) {
  if (!agents || agents.length === 0) return null;

  const rows = agents.map((a) => {
    const active = a.pool?.active || 0;
    const limit = a.pool?.limit || 0;
    const pct = limit > 0 ? Math.round((active / limit) * 100) : 0;
    const rateLimited = a.pool?.rateLimitedUntil && Date.now() < a.pool.rateLimitedUntil;

    return { name: a.name, active, limit, pct, rateLimited };
  });

  return (
    <div className="panel">
      <h4>Resource Utilization</h4>
      <div className="resource-row">
        {rows.map((r) => (
          <div key={r.name} className="resource-item">
            <span className="resource-name">{r.name}</span>
            <div className="resource-track">
              <div
                className="resource-fill"
                style={{
                  width: `${Math.min(r.pct, 100)}%`,
                  background: r.rateLimited ? 'var(--error)' : r.pct > 80 ? 'var(--warning)' : 'var(--success)',
                }}
              />
            </div>
            <span className="resource-count">
              {r.active}/{r.limit}
            </span>
            {r.rateLimited && (
              <span className="resource-flag">RATE-LIMITED</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
