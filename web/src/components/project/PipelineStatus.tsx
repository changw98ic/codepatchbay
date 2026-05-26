import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize } from '@/design-system/tokens';
import { useTranslation } from 'react-i18next';

const pipelineStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
  marginTop: space[2],
});

const phasesStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
});

const phaseBase = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  fontSize: fontSize.xs,
  fontWeight: 500,
});

const dotStyle = style({ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 });

const dotCompleted = style({ background: theme.success });
const dotRunning = style({ background: theme.accent, boxShadow: `0 0 6px ${theme.accent}` });
const dotFailed = style({ background: theme.error });
const dotPending = style({ background: theme.textMuted });

const connectorStyle = style({
  width: 16,
  height: 1,
  background: theme.border,
  flexShrink: 0,
});

const retryStyle = style({
  fontSize: fontSize.xs,
  color: theme.warning,
  marginTop: space[1],
});

const KNOWN_PHASES = ['plan', 'execute', 'verify'];

interface PipelineNode {
  id: string;
  phase?: string;
  status?: string;
  durationMs?: number;
  attempt?: number;
  error?: string;
  reason?: string;
}

interface PipelineState {
  status?: string;
  phase?: string;
  phases?: string[];
  nodes?: PipelineNode[];
  retryCount?: number;
}

function getPhases(state: PipelineState): string[] {
  if (state.phases && state.phases.length > 0) return state.phases;
  if (state.phase && !KNOWN_PHASES.includes(state.phase)) {
    return [...KNOWN_PHASES.slice(0, -1), state.phase, ...KNOWN_PHASES.slice(-1)];
  }
  return KNOWN_PHASES;
}

function phaseLabel(phase: string, t: (key: string, fallback: string) => string): string {
  return t(`pipeline.${phase}`, phase.charAt(0).toUpperCase() + phase.slice(1).replace(/[-_]/g, ' '));
}

function getDotClass(status?: string): string {
  if (status === 'completed' || status === 'success') return dotCompleted;
  if (status === 'running' || status === 'executing') return dotRunning;
  if (status === 'failed' || status === 'error') return dotFailed;
  return dotPending;
}

interface PipelineStatusProps {
  state: PipelineState | null | undefined;
}

export function PipelineStatus({ state }: PipelineStatusProps) {
  const { t } = useTranslation();
  if (!state) return null;

  const statusLabel = (s?: string) => t(`status.${s ?? 'pending'}`, s ?? 'pending');

  if (state.nodes && state.nodes.length > 0) {
    return (
      <div className={pipelineStyle}>
        {state.nodes.map((node) => (
          <div key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`${dotStyle} ${getDotClass(node.status)}`} />
            <span style={{ fontSize: 12 }}>{phaseLabel(node.phase ?? node.id, t)}</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{statusLabel(node.status)}</span>
          </div>
        ))}
        {(state.retryCount ?? 0) > 0 && (
          <div className={retryStyle}>{t('pipeline.retry', 'Retry')} #{state.retryCount}</div>
        )}
      </div>
    );
  }

  const phases = getPhases(state);
  const currentIdx = phases.indexOf(state.phase ?? '');

  return (
    <div className={pipelineStyle}>
      <div className={phasesStyle}>
        {phases.map((phase, i) => {
          let dotClass = dotPending;
          if (currentIdx >= 0) {
            if (i < currentIdx) dotClass = dotCompleted;
            else if (i === currentIdx) dotClass = getDotClass(state.status);
          }
          return (
            <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {i > 0 && <span className={connectorStyle} />}
              <span className={`${dotStyle} ${dotClass}`} />
              <span className={phaseBase} style={{ color: i <= currentIdx || currentIdx < 0 ? theme.text : theme.textMuted }}>
                {phaseLabel(phase, t)}
              </span>
            </div>
          );
        })}
      </div>
      {(state.retryCount ?? 0) > 0 && (
        <div className={retryStyle}>{t('pipeline.retry', 'Retry')} #{state.retryCount}</div>
      )}
    </div>
  );
}
