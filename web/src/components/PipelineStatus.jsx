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

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function nodeLabel(node) {
  return phaseLabel(node.phase || node.id);
}

export default function PipelineStatus({ state }) {
  if (!state) return null;

  if (state.nodes?.length > 0) {
    return (
      <div className="pipeline-status">
        <div className="pipeline-nodes">
          {state.nodes.map((node) => {
            const duration = formatDuration(node.durationMs);
            const reason = node.error || node.reason;
            return (
              <div key={node.id} className={`pipeline-node ${node.status || 'pending'}`}>
                <div className="phase-dot" />
                <div className="pipeline-node-main">
                  <span>{nodeLabel(node)}</span>
                  <span className="pipeline-node-status">{node.status || 'pending'}</span>
                  {node.attempt > 1 && <span className="pipeline-node-meta">Attempt {node.attempt}</span>}
                  {duration && <span className="pipeline-node-meta">{duration}</span>}
                </div>
                {reason && <div className="pipeline-node-reason">{reason}</div>}
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
