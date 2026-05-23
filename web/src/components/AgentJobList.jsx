import React from 'react';

function statusColor(s) {
  if (s === 'completed') return '#4caf50';
  if (s === 'failed') return '#f44336';
  if (s === 'running') return '#2196f3';
  return '#9e9e9e';
}

export default function AgentJobList({ jobs }) {
  if (!jobs || jobs.length === 0) {
    return <div style={{ color: '#666', padding: 16 }}>No jobs found.</div>;
  }

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
