import React from 'react';
import useCappedList from '../hooks/useCappedList';

export default function DurableJobs({ tasks }) {
  const { displayed, showAll, toggle, hasMore } = useCappedList(tasks, { cap: 5 });

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
