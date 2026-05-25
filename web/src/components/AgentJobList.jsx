import React from 'react';

function statusColor(s) {
  if (s === 'completed') return 'var(--success)';
  if (s === 'failed') return 'var(--error)';
  if (s === 'running') return 'var(--accent)';
  return 'var(--text-muted)';
}

export default function AgentJobList({ jobs }) {
  if (!jobs || jobs.length === 0) {
    return <p className="empty">No jobs found.</p>;
  }

  return (
    <table className="job-table">
      <thead>
        <tr>
          <th>Job ID</th>
          <th>Project</th>
          <th>Phase</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.slice(0, 50).map((job) => (
          <tr key={job.jobId}>
            <td>{job.jobId?.slice(-8)}</td>
            <td>{job.project}</td>
            <td>{job.phase}</td>
            <td style={{ color: statusColor(job.status) }}>{job.status}</td>
            <td className="cell-time">{job.createdAt?.slice(0, 16).replace('T', ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
