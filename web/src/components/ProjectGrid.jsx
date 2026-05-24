import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PipelineStatus from './PipelineStatus';

function formatAge(ageMs) {
  if (ageMs == null) return null;
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m`;
  return `${(ageMs / 3600000).toFixed(1)}h`;
}

export default function ProjectGrid({ primaryProjects, secondaryProjects, diagnostics, workerAgeById }) {
  const navigate = useNavigate();
  const [projSearch, setProjSearch] = useState('');
  const [projFilter, setProjFilter] = useState('all');

  const filterProject = (p) => {
    if (projSearch) {
      const q = projSearch.toLowerCase();
      if (!(p.name || p.id || '').toLowerCase().includes(q)) return false;
    }
    if (projFilter !== 'all') {
      const pStatus = p.pipelineState?.status;
      const wStatus = p.workerDerivedStatus || p.worker?.status;
      if (projFilter === 'active') {
        return pStatus === 'running' || pStatus === 'verifying' || pStatus === 'executing' || wStatus === 'working' || wStatus === 'running';
      } else if (projFilter === 'failed') {
        return pStatus === 'failed' || wStatus === 'failed';
      } else if (projFilter === 'completed') {
        return pStatus === 'completed' || pStatus === 'done' || pStatus === 'success';
      } else if (projFilter === 'blocked') {
        return pStatus === 'failed' || pStatus === 'blocked';
      }
    }
    return true;
  };

  const filteredPrimary = primaryProjects.filter(filterProject);
  const filteredSecondary = secondaryProjects.filter(filterProject);

  const renderPrimaryCard = (p) => (
    <Link to={`/project/${p.name || p.id}`} key={p.id} className="project-card">
      <div className="card-header">
        <h3>{p.name || p.id}</h3>
        {(p.workerDerivedStatus || p.worker?.status) && (
          <span className={`badge badge-worker badge-${p.workerDerivedStatus || p.worker.status}`}>
            {p.workerDerivedStatus || p.worker.status}
          </span>
        )}
        {diagnostics && p._pollution && p._pollution.visibility === 'test' && (
          <span className="badge badge-diagnostic">test</span>
        )}
        {workerAgeById.get(p.id)?.ageMs != null && (
          <span className="badge badge-age">{formatAge(workerAgeById.get(p.id).ageMs)}</span>
        )}
        {p.pipelineState && (
          <span className={`badge badge-${p.pipelineState.status}`}>{p.pipelineState.status}</span>
        )}
      </div>
      {p.pipelineState && <PipelineStatus state={p.pipelineState} />}
      <details className="summary-collapsible" onClick={(e) => e.stopPropagation()}>
        <summary>View Details & Logs</summary>
        <div className="card-stats">
          <span>Inbox: {p.inbox || 0}</span>
          <span>Outputs: {p.outputs || 0}</span>
          {p.indexStatus?.status === 'ready' && (
            <span className="index-status">Index: {p.indexStatus.fileCount} files · {p.indexStatus.symbolCount} symbols</span>
          )}
          {p.indexStatus?.status === 'stale' && (
            <span className="index-status index-stale">Index: stale</span>
          )}
        </div>
        {p.recentLog?.length > 0 && (
          <div className="card-log">
            {p.recentLog.slice(-2).map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        )}
      </details>
      <div className="card-cta" onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(`/project/${p.name || p.id}`);
      }}>
        Open Project
      </div>
    </Link>
  );

  const renderSecondaryCard = (p) => (
    <Link to={`/project/${p.name}`} key={p.name} className="project-card project-card-secondary">
      <div className="card-header">
        <h3>{p.name}</h3>
        <span className="badge badge-local">local</span>
        {p.pipelineState && (
          <span className={`badge badge-${p.pipelineState.status}`}>{p.pipelineState.status}</span>
        )}
      </div>
      {p.pipelineState && <PipelineStatus state={p.pipelineState} />}
      <details className="summary-collapsible" onClick={(e) => e.stopPropagation()}>
        <summary>View Details</summary>
        <div className="card-stats">
          <span>Inbox: {p.inbox}</span>
          <span>Outputs: {p.outputs}</span>
        </div>
      </details>
      <div className="card-cta" onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(`/project/${p.name}`);
      }}>
        Open Project
      </div>
    </Link>
  );

  return (
    <>
      {(primaryProjects.length > 0 || secondaryProjects.length > 0) && (
        <div className="dashboard-filter-bar" aria-label="Project filters">
          <div className="filter-search-wrapper">
            <span className="filter-search-icon">🔍</span>
            <input
              type="text"
              className="filter-search-input"
              placeholder="Search projects..."
              value={projSearch}
              onChange={(e) => setProjSearch(e.target.value)}
            />
          </div>
          <div className="filter-pills">
            <span className="filter-label">Filter:</span>
            {['all', 'active', 'failed', 'completed', 'blocked'].map((filter) => (
              <button
                key={filter}
                className={`filter-pill ${projFilter === filter ? 'active' : ''}`}
                onClick={() => setProjFilter(filter)}
                type="button"
              >
                {filter.charAt(0).toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}
      {primaryProjects.length === 0 && secondaryProjects.length === 0 ? (
        <div className="empty-state">
          <p>No projects found. Run <code>cpb init</code> to create one, or <code>cpb attach</code> to register with the Hub.</p>
        </div>
      ) : filteredPrimary.length === 0 && filteredSecondary.length === 0 ? (
        <div className="empty-state">
          <p>No projects match your filter criteria.{' '}
            <button className="btn-link" onClick={() => { setProjSearch(''); setProjFilter('all'); }}>
              Reset filters
            </button>
          </p>
        </div>
      ) : (
        <div className="project-grid">
          {filteredPrimary.map(renderPrimaryCard)}
          {filteredSecondary.map(renderSecondaryCard)}
        </div>
      )}
    </>
  );
}
