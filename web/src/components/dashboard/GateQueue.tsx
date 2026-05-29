import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import { style, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.4 },
});

const sectionStyle = style({
  marginBottom: space[6],
});

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  fontSize: fontSize.lg,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[3],
});

const pulseWarn = style({
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: theme.warning,
  display: 'inline-block',
  boxShadow: `0 0 8px ${theme.warning}`,
  animation: `${pulse} 2s infinite`,
});

const emptyStyle = style({
  color: theme.textMuted,
  fontSize: fontSize.sm,
  padding: space[2],
});

const rowStyle = style({
  padding: space[3],
  borderBottom: `1px solid ${theme.border}`,
  display: 'flex',
  alignItems: 'flex-start',
  gap: space[3],
  selectors: {
    '&:last-child': { borderBottom: 'none' },
  },
});

const jobIdStyle = style({
  fontWeight: fontWeight.semibold,
  fontSize: fontSize.sm,
  color: theme.text,
  minWidth: '140px',
  fontFamily: 'monospace',
});

const detailsStyle = style({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const taskStyle = style({
  fontSize: fontSize.sm,
  color: theme.text,
  fontWeight: fontWeight.medium,
});

const reasonStyle = style({
  fontSize: fontSize.xs,
  color: theme.textDim,
});

const metaStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

const actionsStyle = style({
  display: 'flex',
  gap: space[2],
  alignItems: 'center',
});

const loadingStyle = style({
  textAlign: 'center',
  padding: space[4],
  color: theme.textMuted,
  fontSize: fontSize.sm,
});

interface ApprovalGate {
  jobId: string;
  project: string;
  operation: string | null;
  phase: string | null;
  channels: string[];
  reason: string | null;
  requestedAt: string | null;
  timeoutAt: string | null;
  task: string | null;
}

interface GateQueueProps {
  gates: ApprovalGate[];
  onApprove: (jobId: string) => Promise<void>;
  onReject?: (jobId: string) => Promise<void>;
  loading?: boolean;
}

export function GateQueue({ gates, onApprove, onReject, loading }: GateQueueProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [processing, setProcessing] = useState<Set<string>>(new Set());

  const displayed = showAll ? gates : gates.slice(0, 3);

  const handleApprove = async (jobId: string) => {
    setProcessing((prev) => new Set(prev).add(jobId));
    try {
      await onApprove(jobId);
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const handleReject = async (jobId: string) => {
    if (!onReject) return;
    setProcessing((prev) => new Set(prev).add(jobId));
    try {
      await onReject(jobId);
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const isExpired = (timeoutAt: string | null) => {
    if (!timeoutAt) return false;
    return new Date(timeoutAt) < new Date();
  };

  const formatTime = (ts: string | null) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };

  if (loading) {
    return (
      <GlassPanel depth="medium" padding="md" className={sectionStyle}>
        <div className={loadingStyle}>Loading gates...</div>
      </GlassPanel>
    );
  }

  if (gates.length === 0) {
    return (
      <GlassPanel depth="medium" padding="md" className={sectionStyle}>
        <div className={headerStyle}>
          <span className={pulseWarn} />
          {t('dashboard.pendingGates') || 'Pending Gates'}
        </div>
        <p className={emptyStyle}>{t('dashboard.noPendingGates') || 'No pending approval gates.'}</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel depth="medium" padding="md" className={sectionStyle}>
      <div className={headerStyle}>
        <span className={pulseWarn} />
        {t('dashboard.pendingGates') || 'Pending Gates'} ({gates.length})
      </div>
      {displayed.map((gate) => (
        <div key={gate.jobId} className={rowStyle}>
          <div className={jobIdStyle}>{gate.jobId.slice(0, 16)}...</div>
          <div className={detailsStyle}>
            {gate.task && <div className={taskStyle}>{gate.task.slice(0, 80)}</div>}
            <div className={reasonStyle}>
              {gate.reason || 'approval required'}
              {gate.phase && ` (${gate.phase})`}
            </div>
            <div className={metaStyle}>
              Requested: {formatTime(gate.requestedAt)}
              {gate.timeoutAt && (
                <span
                  style={{
                    marginLeft: space[2],
                    color: isExpired(gate.timeoutAt) ? theme.error : theme.textMuted,
                  }}
                >
                  · Timeout: {formatTime(gate.timeoutAt)}
                  {isExpired(gate.timeoutAt) && ' (EXPIRED)'}
                </span>
              )}
            </div>
          </div>
          <div className={actionsStyle}>
            {isExpired(gate.timeoutAt) && (
              <Badge variant="error">expired</Badge>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleApprove(gate.jobId)}
              disabled={processing.has(gate.jobId)}
            >
              {processing.has(gate.jobId) ? '...' : 'Approve'}
            </Button>
            {onReject && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleReject(gate.jobId)}
                disabled={processing.has(gate.jobId)}
              >
                {processing.has(gate.jobId) ? '...' : 'Reject'}
              </Button>
            )}
          </div>
        </div>
      ))}
      {gates.length > 3 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('common.collapse') : `Show ${gates.length - 3} more`}
        </Button>
      )}
    </GlassPanel>
  );
}
