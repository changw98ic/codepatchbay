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
    <div style={{ padding: 12, border: '1px solid #333', borderRadius: 8, background: '#1a1a2e' }}>
      <h4 style={{ margin: '0 0 8px', color: '#aaa', fontSize: 13 }}>Resource Utilization</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 60, color: '#bbb', textAlign: 'right' }}>{r.name}</span>
            <div style={{ flex: 1, height: 8, background: '#2a2a4a', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.min(r.pct, 100)}%`,
                height: '100%',
                background: r.rateLimited ? '#f44336' : r.pct > 80 ? '#ff9800' : '#4caf50',
                borderRadius: 4,
                transition: 'width 0.3s ease',
              }} />
            </div>
            <span style={{ width: 50, color: '#888' }}>
              {r.active}/{r.limit}
            </span>
            {r.rateLimited && (
              <span style={{ fontSize: 10, color: '#f44336' }}>RATE-LIMITED</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
