import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import PipelineStatus from '../components/PipelineStatus';

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [hubStatus, setHubStatus] = useState(null);
  const [hubProjects, setHubProjects] = useState([]);
  const [hubAcp, setHubAcp] = useState(null);
  const [knowledgePolicy, setKnowledgePolicy] = useState(null);
  const [durableTasks, setDurableTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const { connected, subscribe } = useWebSocket();

  const fetchProjects = useCallback(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const refreshDurableTasks = useCallback(() => {
    fetch('/api/tasks/durable')
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setDurableTasks(data))
      .catch(() => {});
  }, []);

  const refreshHub = useCallback(() => {
    Promise.all([
      fetch('/api/hub/status').then((r) => r.ok ? r.json() : null),
      fetch('/api/hub/projects').then((r) => r.ok ? r.json() : []),
      fetch('/api/hub/acp').then((r) => r.ok ? r.json() : null),
      fetch('/api/hub/knowledge-policy').then((r) => r.ok ? r.json() : null),
    ])
      .then(([status, registryProjects, acp, policy]) => {
        setHubStatus(status);
        setHubProjects(Array.isArray(registryProjects) ? registryProjects : []);
        setHubAcp(acp);
        setKnowledgePolicy(policy);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchProjects(); refreshDurableTasks(); refreshHub(); }, [fetchProjects, refreshDurableTasks, refreshHub]);

  // Polling fallback when WS disconnected
  useEffect(() => {
    if (connected) return;
    const id = setInterval(() => {
      fetchProjects();
      refreshHub();
    }, 15000);
    return () => clearInterval(id);
  }, [connected, fetchProjects, refreshHub]);

  // Targeted WS updates (no full refetch)
  useEffect(() => {
    const unsub1 = subscribe('pipeline:update', (msg) => {
      setProjects((prev) =>
        prev.map((p) => p.name === msg.project ? { ...p, pipelineState: msg.state } : p)
      );
    });
    const unsub2 = subscribe('log:append', (msg) => {
      setProjects((prev) =>
        prev.map((p) => p.name === msg.project
          ? { ...p, recentLog: [...(p.recentLog || []).slice(-4), msg.entry] }
          : p
        )
      );
    });
    const unsub3 = subscribe('file:created', (msg) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.name !== msg.project) return p;
          const isInbox = msg.path?.startsWith('inbox/');
          const isOutput = msg.path?.startsWith('outputs/');
          return {
            ...p,
            inbox: p.inbox + (isInbox ? 1 : 0),
            outputs: p.outputs + (isOutput ? 1 : 0),
          };
        })
      );
    });
    const unsub4 = subscribe('file:deleted', (msg) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.name !== msg.project) return p;
          const isInbox = msg.path?.startsWith('inbox/');
          const isOutput = msg.path?.startsWith('outputs/');
          return {
            ...p,
            inbox: Math.max(0, p.inbox - (isInbox ? 1 : 0)),
            outputs: Math.max(0, p.outputs - (isOutput ? 1 : 0)),
          };
        })
      );
    });
    const unsub5 = subscribe('job:update', () => {
      refreshDurableTasks();
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); };
  }, [subscribe]);

  if (loading) return <div className="loading">Loading projects...</div>;

  const workerCounts = hubProjects.reduce((acc, p) => {
    const s = p.workerDerivedStatus || p.worker?.status || 'offline';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const inboxTotal = projects.reduce((sum, p) => sum + (p.inbox || 0), 0);
  const outputsTotal = projects.reduce((sum, p) => sum + (p.outputs || 0), 0);
  const durableByStatus = durableTasks.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Projects</h2>
        <Link to="/new-task" className="btn btn-primary">+ New Task</Link>
      </div>
      {hubStatus && (
        <section className="hub-panel panel">
          <div>
            <div className="section-eyebrow">Global Hub</div>
            <h3>{hubStatus.projectCount} registered projects</h3>
            <p className="muted">
              {Object.entries(workerCounts).map(([status, count], i) => (
                <React.Fragment key={status}>
                  {i > 0 && <span> · </span>}
                  <span>{count} {status}</span>
                </React.Fragment>
              ))}
            </p>
          </div>
          {projects.length > 0 && (
            <p className="muted">
              <span>Inbox: {inboxTotal} · </span>
              <span>Outputs: {outputsTotal}</span>
            </p>
          )}
          <div className="hub-project-list">
            {hubProjects.length === 0 ? (
              <span className="muted">Run <code>cpb attach</code> to register a project.</span>
            ) : hubProjects.slice(0, 4).map((project) => (
              <span className="hub-project-pill" key={project.id}>
                {project.id}
                {(project.workerDerivedStatus || project.worker?.status) && (
                  <em>{project.workerDerivedStatus || project.worker.status}</em>
                )}
              </span>
            ))}
          </div>
          {hubAcp && (
            <div className="hub-acp-list" aria-label="ACP provider status">
              {Object.entries(hubAcp.pools || {}).map(([agent, info]) => {
                const limit = hubAcp.rateLimits?.[agent];
                const hasPoolStats = typeof info.active === 'number' && typeof info.limit === 'number';
                return (
                  <span className="hub-acp-pill" key={agent}>
                    {agent}
                    <em>{info.mode}</em>
                    {hasPoolStats && <span>{info.active}/{info.limit}</span>}
                    {hasPoolStats && info.queued > 0 && <span>{info.queued} queued</span>}
                    {limit?.untilTs && <strong>backoff</strong>}
                  </span>
                );
              })}
            </div>
          )}
          {knowledgePolicy && (
            <div className="hub-knowledge-summary">
              <span>Knowledge</span>
              <em>{knowledgePolicy.automaticWrites?.length || 0} auto</em>
              <em>{knowledgePolicy.forbiddenMarkdownState?.length || 0} state guards</em>
            </div>
          )}
        </section>
      )}
      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No projects found. Run <code>cpb init</code> to create one.</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <Link to={`/project/${p.name}`} key={p.name} className="project-card">
              <div className="card-header">
                <h3>{p.name}</h3>
                {p.pipelineState && (
                  <span className={`badge badge-${p.pipelineState.status}`}>
                    {p.pipelineState.status}
                  </span>
                )}
              </div>
              {p.pipelineState && <PipelineStatus state={p.pipelineState} />}
              <div className="card-stats">
                <span>Inbox: {p.inbox}</span>
                <span>Outputs: {p.outputs}</span>
              </div>
              {p.recentLog?.length > 0 && (
                <div className="card-log">
                  {p.recentLog.slice(-2).map((line, i) => (
                    <div key={i} className="log-line">{line}</div>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
      {durableTasks.length > 0 && (
        <section className="durable-jobs panel">
          <h2>Durable Jobs</h2>
          <p className="muted">
            {Object.entries(durableByStatus).map(([status, count], i) => (
              <React.Fragment key={status}>
                {i > 0 && <span> · </span>}
                <span>{count} {status}</span>
              </React.Fragment>
            ))}
          </p>
          {durableTasks.map((job) => (
            <div className="job-row" key={job.jobId}>
              <span className="job-id">{job.jobId}</span>
              <span className="job-project">{job.project}</span>
              <span className={`job-status badge badge-${job.status}`}>{job.status}</span>
              <span className="job-phase">{job.phase || '-'}</span>
              {job.cancelRequested && (
                <span className="badge badge-cancel">CANCEL REQUESTED</span>
              )}
              {job.redirectContext && (
                <span className="badge badge-redirect">REDIRECT PENDING</span>
              )}
              {job.lastActivityAt && (
                <span className="job-activity" title={job.lastActivityMessage || ''}>
                  {new Date(job.lastActivityAt).toLocaleTimeString()}
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
