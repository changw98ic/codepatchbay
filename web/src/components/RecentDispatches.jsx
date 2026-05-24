import React from 'react';
import useCappedList from '../hooks/useCappedList';

export default function RecentDispatches({ dispatches }) {
  const { displayed, showAll, toggle, hasMore } = useCappedList(dispatches, { cap: 5 });

  if (dispatches.length === 0) return null;

  return (
    <section className="hub-dispatches panel" aria-label="Recent runs">
      <h2>Recent Runs</h2>
      {displayed.map((d) => (
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
      {hasMore && (
        <div className="show-more-container">
          <button className="show-more-btn" onClick={toggle} type="button">
            {showAll ? 'Show Less' : `+ ${dispatches.length - 5} more recent runs (Show All)`}
          </button>
        </div>
      )}
    </section>
  );
}
