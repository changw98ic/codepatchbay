import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

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

function AgentCard({ agent }) {
  const poolActive = agent.pool?.active || 0;
  const poolLimit = agent.pool?.limit || 0;
  const rateLimited = agent.pool?.rateLimitedUntil && Date.now() < agent.pool.rateLimitedUntil;
  const statusKey = rateLimited ? 'warn' : poolActive > 0 ? 'ok' : 'idle';
  const successRate = agent.jobs.successRate;

  return (
    <div className="agent-card" style={{
      border: '1px solid #333',
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
        {successRate !== null && (
          <div style={{ color: successRate >= 80 ? '#4caf50' : successRate >= 50 ? '#ff9800' : '#f44336' }}>
            Success: {successRate}%
          </div>
        )}
      </div>

      {rateLimited && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#ff9800' }}>
          Rate limited until {new Date(agent.pool.rateLimitedUntil).toLocaleTimeString()}
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {agent.capabilities.map((cap) => (
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
        {agent.command} {agent.phases.length > 0 && `| phases: ${agent.phases.join(', ')}`}
      </div>
    </div>
  );
}

function AgentJobTable({ jobs }) {
  if (!jobs || jobs.length === 0) {
    return <div style={{ color: '#666', padding: 16 }}>No jobs found.</div>;
  }

  const statusColor = (s) => {
    if (s === 'completed') return '#4caf50';
    if (s === 'failed') return '#f44336';
    if (s === 'running') return '#2196f3';
    return '#9e9e9e';
  };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #333', color: '#888' }}>
          <th style={{ textAlign: 'left', padding: '8px 4px' }}>Job ID</th>
          <th style={{ textAlign: 'left', padding: '8px 4px' }}>Project</th>
          <th style={{ textAlign: 'left', padding: '8px 4px' }}>Phase</th>
          <th style={{ textAlign: 'left', padding: '8px 4px' }}>Status</th>
          <th style={{ textAlign: 'left', padding: '8px 4px' }}>Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.slice(0, 50).map((job) => (
          <tr key={job.jobId} style={{ borderBottom: '1px solid #222' }}>
            <td style={{ padding: '6px 4px', color: '#bbb' }}>{job.jobId?.slice(-8)}</td>
            <td style={{ padding: '6px 4px', color: '#bbb' }}>{job.project}</td>
            <td style={{ padding: '6px 4px', color: '#bbb' }}>{job.phase}</td>
            <td style={{ padding: '6px 4px', color: statusColor(job.status) }}>{job.status}</td>
            <td style={{ padding: '6px 4px', color: '#666' }}>{job.createdAt?.slice(0, 16).replace('T', ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AgentBoard() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentJobs, setAgentJobs] = useState([]);
  const [timestamp, setTimestamp] = useState(null);
  const { connected } = useWebSocket();

  const fetchAgents = useCallback(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents || []);
        setTimestamp(data.timestamp);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 15000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  useEffect(() => {
    if (!selectedAgent) { setAgentJobs([]); return; }
    fetch(`/api/agents/${selectedAgent}/jobs`)
      .then((r) => r.json())
      .then((data) => setAgentJobs(data.jobs || []))
      .catch(() => setAgentJobs([]));
  }, [selectedAgent, agents]);

  if (loading) {
    return <div className="page-loading">Loading agents...</div>;
  }

  const totals = agents.reduce((acc, a) => ({
    total: acc.total + a.jobs.total,
    running: acc.running + a.jobs.running,
    completed: acc.completed + a.jobs.completed,
    failed: acc.failed + a.jobs.failed,
  }), { total: 0, running: 0, completed: 0, failed: 0 });

  return (
    <div className="page-container">
      <h2>Agent Board</h2>

      {timestamp && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Last updated: {new Date(timestamp).toLocaleTimeString()}
          {!connected && ' (WS disconnected — polling)'}
        </div>
      )}

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 14 }}>
        <span>Agents: <strong>{agents.length}</strong></span>
        <span>Running: <strong style={{ color: '#2196f3' }}>{totals.running}</strong></span>
        <span>Completed: <strong style={{ color: '#4caf50' }}>{totals.completed}</strong></span>
        <span>Failed: <strong style={{ color: totals.failed > 0 ? '#f44336' : '#9e9e9e' }}>{totals.failed}</strong></span>
      </div>

      {/* Agent cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16, marginBottom: 24 }}>
        {agents.map((agent) => (
          <div
            key={agent.name}
            onClick={() => setSelectedAgent(selectedAgent === agent.name ? null : agent.name)}
            style={{ cursor: 'pointer' }}
          >
            <AgentCard agent={agent} />
            {selectedAgent === agent.name && (
              <div style={{
                marginTop: 8,
                border: '1px solid #333',
                borderRadius: 8,
                background: '#1a1a2e',
                padding: 12,
              }}>
                <h4 style={{ margin: '0 0 8px', color: '#aaa' }}>Recent Jobs</h4>
                <AgentJobTable jobs={agentJobs} />
              </div>
            )}
          </div>
        ))}
      </div>

      {agents.length === 0 && (
        <div style={{ color: '#888', textAlign: 'center', padding: 32 }}>
          No agents registered. Check that agent descriptors exist in core/agents/descriptors/.
        </div>
      )}
    </div>
  );
}
