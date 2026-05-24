import React from 'react';
import useCappedList from '../hooks/useCappedList';

export default function AttentionQueue({ items, onNavigate }) {
  const { displayed, showAll, toggle, hasMore } = useCappedList(items, { cap: 3 });

  if (items.length === 0) {
    return (
      <section className="attention-queue-section">
        <h3>
          <span className="attention-pulse-indicator pulse-ok" />
          Attention Queue
        </h3>
        <div className="empty-state attention-clear">
          <p className="text-success-bold">✓ All clear! No issues or blocked items require your attention.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="attention-queue-section">
      <h3>
        <span className="attention-pulse-indicator pulse-error" />
        Attention Queue
      </h3>
      <div className="attention-list">
        {displayed.map((item) => (
          <div key={item.id} className="attention-row">
            <div className="attention-project">{item.project}</div>
            <div className="attention-reason">{item.reason}</div>
            <div className="attention-impact">{item.impact}</div>
            <button className="attention-action-btn" onClick={() => onNavigate(item.link)}>
              {item.action}
            </button>
          </div>
        ))}
      </div>
      {hasMore && (
        <div className="show-more-container">
          <button className="show-more-btn" onClick={toggle} type="button">
            {showAll ? 'Show Less' : `+ ${items.length - 3} more critical failures (Show All)`}
          </button>
        </div>
      )}
    </section>
  );
}
