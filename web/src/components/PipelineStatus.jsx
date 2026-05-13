import React from 'react';

const KNOWN_PHASES = ['plan', 'execute', 'verify'];
const PHASE_LABELS = { plan: 'Plan', execute: 'Execute', verify: 'Verify' };

function getPhases(state) {
  // If the workflow provides phases, use them; otherwise fall back to standard
  if (state.phases && state.phases.length > 0) return state.phases;
  // If phase is unknown (not in KNOWN_PHASES), inject it into the display
  if (state.phase && !KNOWN_PHASES.includes(state.phase)) {
    return [...KNOWN_PHASES.slice(0, -1), state.phase, ...KNOWN_PHASES.slice(-1)];
  }
  return KNOWN_PHASES;
}

function phaseLabel(phase) {
  if (PHASE_LABELS[phase]) return PHASE_LABELS[phase];
  return phase.charAt(0).toUpperCase() + phase.slice(1).replace(/[-_]/g, ' ');
}

export default function PipelineStatus({ state }) {
  if (!state) return null;

  const phases = getPhases(state);
  const currentIdx = phases.indexOf(state.phase);

  return (
    <div className="pipeline-status">
      <div className="pipeline-phases">
        {phases.map((phase, i) => {
          let cls = 'phase';
          if (currentIdx === -1) {
            cls += ' pending';
          } else if (i < currentIdx) {
            cls += ' completed';
          } else if (i === currentIdx) {
            cls += ` ${state.status}`;
          } else {
            cls += ' pending';
          }
          return (
            <div key={phase} className={cls}>
              <div className="phase-dot" />
              <span>{phaseLabel(phase)}</span>
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
