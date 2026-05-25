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
  const [setupAgents, setSetupAgents] = useState([]);
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

  const fetchSetupReadiness = useCallback(() => {
    fetch('/api/agents/setup-readiness')
      .then((r) => r.json())
      .then((data) => setSetupAgents(data.agents || []))
      .catch(() => setSetupAgents([]));
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchSetupReadiness();
    const interval = setInterval(fetchAgents, 15000);
    const setupInterval = setInterval(fetchSetupReadiness, 60000);
    return () => {
      clearInterval(interval);
      clearInterval(setupInterval);
    };
  }, [fetchAgents, fetchSetupReadiness]);

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
        <div className="muted">
          Last updated: {new Date(timestamp).toLocaleTimeString()}
          {!connected && ' (WS disconnected — polling)'}
        </div>
      )}

      {/* Summary bar */}
      <div className="agent-summary-bar">
        <div className="metric-card">
          <span className="metric-label">Agents</span>
          <span className="metric-value">{agents.length}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Running</span>
          <span className="metric-value" style={{ color: 'var(--accent)' }}>{totals.running}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Completed</span>
          <span className="metric-value" style={{ color: 'var(--success)' }}>{totals.completed}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Failed</span>
          <span className="metric-value" style={{ color: totals.failed > 0 ? 'var(--error)' : 'var(--text-muted)' }}>{totals.failed}</span>
        </div>
      </div>

      {/* Resource + Quality overview */}
      <div className="agent-overview-row">
        <div><ResourceMeter agents={agents} /></div>
        <div><QualityTrend agents={agents} /></div>
      </div>

      {/* Agent cards grid */}
      <AgentStatusGrid
        agents={agents}
        setupAgents={setupAgents}
        selectedAgent={selectedAgent}
        onSelect={setSelectedAgent}
      />

      {/* Expanded job list for selected agent */}
      {selectedAgent && (
        <div className="agent-jobs-panel panel">
          <h4>Recent Jobs — {selectedAgent}</h4>
          <AgentJobList jobs={agentJobs} />
        </div>
      )}
    </div>
  );
}
