import React from 'react';

export default function HubHealthPanel({ hubStatus, hubProjects, hubAcp, knowledgePolicy, observability, projects, queueStatus, queueEntries }) {
  if (!hubStatus) return null;

  const workerCounts = hubProjects.reduce((acc, p) => {
    const s = p.workerDerivedStatus || p.worker?.status || 'offline';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const inboxTotal = projects.reduce((sum, p) => sum + (p.inbox || 0), 0);
  const outputsTotal = projects.reduce((sum, p) => sum + (p.outputs || 0), 0);

  return (
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
      {observability && Object.keys(observability.pools || {}).length > 0 && (
        <div className="hub-lifecycle" aria-label="ACP lifecycle">
          {Object.entries(observability.pools).map(([agent, pool]) => (
            <span className="lifecycle-pill" key={agent}>
              <em className="lifecycle-agent">{agent}</em>
              {pool.requestCount > 0 && <span>{pool.requestCount} req</span>}
              {pool.errorCount > 0 && <strong>{pool.errorCount} err</strong>}
              {pool.recycleCount > 0 && <span>{pool.recycleCount} recycled</span>}
              {pool.processAgeMs != null && (
                <span className="lifecycle-age">
                  {pool.processAgeMs < 60000
                    ? `${Math.round(pool.processAgeMs / 1000)}s`
                    : pool.processAgeMs < 3600000
                      ? `${Math.round(pool.processAgeMs / 60000)}m`
                      : `${(pool.processAgeMs / 3600000).toFixed(1)}h`}
                </span>
              )}
              {pool.rateLimitedUntil && <strong>rate-limited</strong>}
            </span>
          ))}
        </div>
      )}
      {observability?.dispatchSummary && observability.dispatchSummary.total > 0 && (
        <div className="hub-dispatch-summary">
          <span>Runs</span>
          <em>{observability.dispatchSummary.total} total</em>
          {observability.dispatchSummary.completed > 0 && <em>{observability.dispatchSummary.completed} done</em>}
          {observability.dispatchSummary.failed > 0 && <strong>{observability.dispatchSummary.failed} failed</strong>}
          {observability.dispatchSummary.running > 0 && <em>{observability.dispatchSummary.running} active</em>}
        </div>
      )}
      {queueStatus && queueStatus.total > 0 && (
        <div className="hub-queue-summary">
          <span>Queue</span>
          <em>{queueStatus.pending} pending</em>
          <em>{queueStatus.inProgress} active</em>
          {queueStatus.failed > 0 && <strong>{queueStatus.failed} failed</strong>}
          {queueStatus.activeProjects?.length > 0 && (
            <span className="hub-active-projects">
              {queueStatus.activeProjects.map((ap) => (
                <span className="hub-active-project" key={ap.projectId}>
                  {ap.projectId}
                  <em className="queue-busy">{ap.busyReason || 'busy'}</em>
                  {ap.workerId && <em className="queue-worker">{ap.workerId}</em>}
                </span>
              ))}
            </span>
          )}
          {queueStatus.eligibleQueued > 0 && (
            <span className="hub-eligible-queued" aria-label="Eligible queued work">
              <em>{queueStatus.eligibleQueued} eligible</em>
              {queueStatus.eligibleProjects.map((pid) => (
                <span className="hub-eligible-project" key={pid}>{pid}</span>
              ))}
            </span>
          )}
          {queueEntries.filter((e) => e.status === 'pending' || e.status === 'in_progress').slice(0, 3).map((entry) => (
            <span className="hub-queue-pill" key={entry.id}>
              {entry.projectId}
              <em className={`queue-${entry.status}`}>{entry.status === 'in_progress' ? 'running' : entry.status}</em>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
