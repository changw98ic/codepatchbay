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
  const [queueStatus, setQueueStatus] = useState(null);
  const [queueEntries, setQueueEntries] = useState([]);
  const [hubDispatches, setHubDispatches] = useState([]);
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
      fetch('/api/hub/queue/status').then((r) => r.ok ? r.json() : null),
      fetch('/api/hub/queue').then((r) => r.ok ? r.json() : []),
      fetch('/api/hub/dispatches').then((r) => r.ok ? r.json() : []),
    ])
      .then(([status, registryProjects, acp, policy, qStatus, qEntries, dispatches]) => {
        setHubStatus(status);
        setHubProjects(Array.isArray(registryProjects) ? registryProjects : []);
        setHubAcp(acp);
        setKnowledgePolicy(policy);
        setQueueStatus(qStatus);
        setQueueEntries(Array.isArray(qEntries) ? qEntries : []);
        setHubDispatches(Array.isArray(dispatches) ? dispatches : []);
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

  // Merge legacy project data into hub projects by matching name/id
  const legacyByName = new Map(projects.map((p) => [p.name, p]));
  const primaryProjects = hubProjects.map((hp) => {
    const legacy = legacyByName.get(hp.id) || legacyByName.get(hp.name);
    return { ...hp, ...(legacy || {}) };
  });
  const hubIds = new Set(hubProjects.map((p) => p.id));
  const secondaryProjects = projects.filter((p) => !hubIds.has(p.name) && !hubIds.has(p.name));

  // Recent dispatches (non-pending, latest first, capped at 10)
  const recentDispatches = hubDispatches
    .filter((d) => d.status && d.status !== 'pending')
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
    .slice(0, 10);

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
          {queueStatus && queueStatus.total > 0 && (
            <div className="hub-queue-summary">
              <span>Queue</span>
              <em>{queueStatus.pending} pending</em>
              <em>{queueStatus.inProgress} active</em>
              {queueStatus.failed > 0 && <strong>{queueStatus.failed} failed</strong>}
              {queueEntries.filter((e) => e.status === 'pending' || e.status === 'in_progress').slice(0, 3).map((entry) => (
                <span className="hub-queue-pill" key={entry.id}>
                  {entry.projectId}
                  <em className={`queue-${entry.status}`}>{entry.status === 'in_progress' ? 'running' : entry.status}</em>
                </span>
              ))}
            </div>
          )}
        </section>
      )}
      {/* Primary project grid — Hub-registered projects */}
      {primaryProjects.length === 0 && secondaryProjects.length === 0 ? (
        <div className="empty-state">
          <p>No projects found. Run <code>cpb init</code> to create one, or <code>cpb attach</code> to register with the Hub.</p>
        </div>
      ) : (
        <div className="project-grid">
          {primaryProjects.map((p) => (
            <Link to={`/project/${p.name || p.id}`} key={p.id} className="project-card">
              <div className="card-header">
                <h3>{p.name || p.id}</h3>
                {(p.workerDerivedStatus || p.worker?.status) && (
                  <span className={`badge badge-worker badge-${p.workerDerivedStatus || p.worker.status}`}>
                    {p.workerDerivedStatus || p.worker.status}
                  </span>
                )}
                {p.pipelineState && (
                  <span className={`badge badge-${p.pipelineState.status}`}>
                    {p.pipelineState.status}
                  </span>
                )}
              </div>
              {p.pipelineState && <PipelineStatus state={p.pipelineState} />}
              <div className="card-stats">
                <span>Inbox: {p.inbox || 0}</span>
                <span>Outputs: {p.outputs || 0}</span>
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
          {secondaryProjects.map((p) => (
            <Link to={`/project/${p.name}`} key={p.name} className="project-card project-card-secondary">
              <div className="card-header">
                <h3>{p.name}</h3>
                <span className="badge badge-local">local</span>
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
            </Link>
          ))}
        </div>
      )}
      {/* Recent Hub dispatches / runs */}
      {recentDispatches.length > 0 && (
        <section className="hub-dispatches panel" aria-label="Recent runs">
          <h2>Recent Runs</h2>
          {recentDispatches.map((d) => (
            <div className="dispatch-row" key={d.dispatchId}>
              <span className="dispatch-id">{d.dispatchId}</span>
              <span className="dispatch-project">{d.projectId}</span>
              <span className={`dispatch-status badge badge-${d.status === 'running' ? 'running' : d.status === 'completed' ? 'completed' : d.status === 'failed' ? 'failed' : 'assigned'}`}>
                {d.status}
              </span>
              {d.workerId && <span className="dispatch-worker">{d.workerId}</span>}
              {d.updatedAt && (
                <span className="dispatch-time">{new Date(d.updatedAt).toLocaleTimeString()}</span>
              )}
            </div>
          ))}
        </section>
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
