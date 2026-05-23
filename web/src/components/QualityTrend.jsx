import React from 'react';

const BAR_WIDTH = 24;
const BAR_GAP = 4;
const MAX_BARS = 20;

export default function QualityTrend({ agents }) {
  if (!agents || agents.length === 0) return null;

  const data = agents
    .filter((a) => a.jobs.successRate !== null)
    .map((a) => ({ name: a.name, rate: a.jobs.successRate }));

  if (data.length === 0) {
    return (
      <div style={{ padding: 12, color: '#666', fontSize: 12 }}>
        Quality trend: no data available
      </div>
    );
  }

  const barHeight = (rate) => Math.max(4, (rate / 100) * 60);
  const barColor = (rate) => (rate >= 80 ? '#4caf50' : rate >= 50 ? '#ff9800' : '#f44336');

  return (
    <div style={{ padding: 12, border: '1px solid #333', borderRadius: 8, background: '#1a1a2e' }}>
      <h4 style={{ margin: '0 0 8px', color: '#aaa', fontSize: 13 }}>Quality Trend (Success Rate)</h4>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: BAR_GAP, height: 72 }}>
        {data.slice(0, MAX_BARS).map((d) => (
          <div key={d.name} title={`${d.name}: ${d.rate}%`} style={{
            width: BAR_WIDTH,
            height: barHeight(d.rate),
            background: barColor(d.rate),
            borderRadius: '2px 2px 0 0',
            transition: 'height 0.3s ease',
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: BAR_GAP, marginTop: 4 }}>
        {data.slice(0, MAX_BARS).map((d) => (
          <div key={d.name} style={{
            width: BAR_WIDTH,
            fontSize: 9,
            color: '#888',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {d.name.slice(0, 4)}
          </div>
        ))}
      </div>
    </div>
  );
}
