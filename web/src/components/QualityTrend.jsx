import React from 'react';

const MAX_BARS = 20;

export default function QualityTrend({ agents }) {
  if (!agents || agents.length === 0) return null;

  const data = agents
    .filter((a) => a.jobs.successRate !== null)
    .map((a) => ({ name: a.name, rate: a.jobs.successRate }));

  if (data.length === 0) {
    return (
      <div className="panel muted">
        Quality trend: no data available
      </div>
    );
  }

  const barHeight = (rate) => Math.max(4, (rate / 100) * 110);
  const barColor = (rate) => (rate >= 80 ? 'var(--success)' : rate >= 50 ? 'var(--warning)' : 'var(--error)');

  const visible = data.slice(0, MAX_BARS);

  return (
    <div className="panel">
      <h4>Quality Trend (Success Rate)</h4>
      <div className="quality-chart">
        {visible.map((d) => (
          <div
            key={d.name}
            className="quality-bar"
            data-label={`${d.name}: ${d.rate}%`}
            style={{
              height: barHeight(d.rate),
              background: barColor(d.rate),
            }}
          />
        ))}
      </div>
      <div className="quality-labels">
        {visible.map((d) => (
          <span key={d.name}>{d.name.slice(0, 4)}</span>
        ))}
      </div>
    </div>
  );
}
