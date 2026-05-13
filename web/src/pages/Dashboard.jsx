import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import PipelineStatus from '../components/PipelineStatus';

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
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

  useEffect(() => { fetchProjects(); refreshDurableTasks(); }, [fetchProjects, refreshDurableTasks]);

  // Polling fallback when WS disconnected
  useEffect(() => {
    if (connected) return;
    const id = setInterval(fetchProjects, 15000);
    return () => clearInterval(id);
  }, [connected, fetchProjects]);

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

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Projects</h2>
        <Link to="/new-task" className="btn btn-primary">+ New Task</Link>
      </div>
      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No projects found. Run <code>flow init</code> to create one.</p>
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
          {durableTasks.map((job) => (
            <div className="job-row" key={job.jobId}>
              <span className="job-id">{job.jobId}</span>
              <span className="job-project">{job.project}</span>
              <span className={`job-status badge badge-${job.status}`}>{job.status}</span>
              <span className="job-phase">{job.phase || '-'}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
