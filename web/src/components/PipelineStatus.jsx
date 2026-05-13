import React from 'react';

const PHASES = ['plan', 'execute', 'verify'];
const PHASE_LABELS = { plan: 'Plan', execute: 'Execute', verify: 'Verify' };

export default function PipelineStatus({ state }) {
  if (!state) return null;

  const currentIdx = PHASES.indexOf(state.phase);

  return (
    <div className="pipeline-status">
      <div className="pipeline-phases">
        {PHASES.map((phase, i) => {
          let cls = 'phase';
          if (i < currentIdx) cls += ' completed';
          else if (i === currentIdx) cls += ` ${state.status}`;
          else cls += ' pending';
          return (
            <div key={phase} className={cls}>
              <div className="phase-dot" />
              <span>{PHASE_LABELS[phase]}</span>
            </div>
          );
        })}
      </div>
      {state.retryCount > 0 && (
        <div className="retry-info">Retry #{state.retryCount}</div>
      )}
    </div>
  );
}
