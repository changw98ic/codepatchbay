import React from 'react';

function shortHash(value) {
  return value ? value.slice(0, 10) : '-';
}

export default function JobArtifactPanel({ detail }) {
  if (!detail) return null;

  const entries = detail.artifactIndex?.entries || [];
  const verdict = detail.verdict;
  const warnings = detail.warnings || [];

  return (
    <section className="job-artifact-panel">
      <div className="job-artifact-header">
        <h3>Artifacts</h3>
        {verdict?.status && (
          <span className={`badge badge-${verdict.status}`}>
            {verdict.status}
          </span>
        )}
      </div>

      {verdict && (
        <div className="job-verdict-summary">
          {verdict.reason && <p>{verdict.reason}</p>}
          <dl>
            <dt>Confidence</dt>
            <dd>{verdict.confidence ?? '-'}</dd>
            <dt>Blocking</dt>
            <dd>{verdict.blockingCount ?? 0}</dd>
          </dl>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="artifact-warnings">
          {warnings.map((warning) => (
            <div key={`${warning.kind}-${warning.path || warning.id}`} className="artifact-warning">
              {warning.message}
            </div>
          ))}
        </div>
      )}

      <div className="artifact-table" role="table" aria-label="Job artifacts">
        <div className="artifact-row artifact-row-head" role="row">
          <span role="columnheader">Kind</span>
          <span role="columnheader">Artifact</span>
          <span role="columnheader">State</span>
          <span role="columnheader">Hash</span>
        </div>
        {entries.map((entry) => (
          <div key={`${entry.kind}-${entry.id}-${entry.path}`} className={`artifact-row ${entry.broken ? 'broken' : ''}`} role="row">
            <span role="cell">{entry.kind}</span>
            <span role="cell">{entry.id || entry.path}</span>
            <span role="cell">{entry.broken ? entry.reason || 'broken' : 'ready'}</span>
            <span role="cell">{shortHash(entry.sha256)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
