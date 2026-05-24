import React, { useEffect, useState } from 'react';
import useCappedList from '../hooks/useCappedList';
import JobArtifactPanel from './JobArtifactPanel';

export default function DurableJobs({ tasks }) {
  const { displayed, showAll, toggle, hasMore } = useCappedList(tasks, { cap: 5 });
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [artifactDetail, setArtifactDetail] = useState(null);

  useEffect(() => {
    const selected = tasks.find((job) => job.jobId === selectedJobId);
    if (!selected) {
      setArtifactDetail(null);
      return undefined;
    }
    const controller = new AbortController();
    setArtifactDetail(null);
    const project = encodeURIComponent(selected.project);
    const jobId = encodeURIComponent(selected.jobId);
    fetch(`/api/tasks/${project}/jobs/${jobId}/artifacts`, { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then(setArtifactDetail)
      .catch(() => setArtifactDetail(null));
    return () => controller.abort();
  }, [selectedJobId, tasks]);

  if (tasks.length === 0) return null;

  const statusCounts = tasks.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <section className="durable-jobs panel">
      <h2>Durable Jobs</h2>
      <p className="muted">
        {Object.entries(statusCounts).map(([status, count], i) => (
          <React.Fragment key={status}>
            {i > 0 && <span> · </span>}
            <span>{count} {status}</span>
          </React.Fragment>
        ))}
      </p>
      {displayed.map((job) => (
        <React.Fragment key={job.jobId}>
          <div className="job-row">
            <span className="job-id">{job.jobId}</span>
            <span className="job-project">{job.project}</span>
            <span className={`job-status badge badge-${job.status}`}>{job.status}</span>
            <span className="job-source">{job.source?.label || 'Manual'}</span>
            <span className="job-workflow">{job.workflow || 'standard'}</span>
            <span className="job-phase">{job.currentPhase || job.phase || '-'}</span>
            {(job.retryCount ?? 0) > 0 && (
              <span className="badge badge-retry">Retry {job.retryCount}</span>
            )}
            {job.nextHumanAction?.label && (
              <span className="job-next-action">{job.nextHumanAction.label}</span>
            )}
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
            <button
              className="btn btn-secondary btn-small"
              type="button"
              onClick={() => setSelectedJobId((current) => current === job.jobId ? null : job.jobId)}
            >
              Details
            </button>
          </div>
          {selectedJobId === job.jobId && (
            <div className="job-detail-row">
              <JobArtifactPanel detail={artifactDetail} />
            </div>
          )}
        </React.Fragment>
      ))}
      {hasMore && (
        <div className="show-more-container">
          <button className="show-more-btn" onClick={toggle} type="button">
            {showAll ? 'Show Less' : `+ ${tasks.length - 5} more durable jobs (Show All)`}
          </button>
        </div>
      )}
    </section>
  );
}
