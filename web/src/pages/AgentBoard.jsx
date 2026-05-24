import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import AgentStatusGrid from '../components/AgentStatusGrid';
import AgentJobList from '../components/AgentJobList';
import QualityTrend from '../components/QualityTrend';
import ResourceMeter from '../components/ResourceMeter';

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
  }, [selectedAgent]);

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

      {/* Resource + Quality overview */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ flex: 1 }}><ResourceMeter agents={agents} /></div>
        <div style={{ flex: 1 }}><QualityTrend agents={agents} /></div>
      </div>

      {/* Agent cards grid */}
      <AgentStatusGrid
        agents={agents}
        selectedAgent={selectedAgent}
        onSelect={setSelectedAgent}
      />

      {/* Expanded job list for selected agent */}
      {selectedAgent && (
        <div style={{
          marginTop: 16,
          border: '1px solid #333',
          borderRadius: 8,
          background: '#1a1a2e',
          padding: 12,
        }}>
          <h4 style={{ margin: '0 0 8px', color: '#aaa' }}>
            Recent Jobs — {selectedAgent}
          </h4>
          <AgentJobList jobs={agentJobs} />
        </div>
      )}
    </div>
  );
}
