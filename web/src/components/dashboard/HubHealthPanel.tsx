import { GlassPanel } from '@/components/glass/GlassPanel';
import { Badge } from '@/components/shared/Badge';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const panelStyle = style({
  marginBottom: space[6],
});

const eyebrow = style({
  fontSize: fontSize.xs,
  fontWeight: fontWeight.semibold,
  color: theme.accent,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  marginBottom: space[1],
});

const titleStyle = style({
  fontSize: fontSize.xl,
  fontWeight: fontWeight.bold,
  color: theme.text,
  marginBottom: space[1],
});

const mutedText = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.6,
});

const pillRow = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: space[2],
  marginTop: space[3],
});

const pill = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: space[1],
  padding: `${space[1]} ${space[2]}`,
  fontSize: fontSize.xs,
  borderRadius: '6px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  color: theme.textDim,
});

const pillLabel = style({
  fontStyle: 'italic',
  color: theme.textMuted,
  fontSize: fontSize.xs,
});

const sectionGap = style({
  marginTop: space[4],
  paddingTop: space[4],
  borderTop: `1px solid ${theme.border}`,
});

interface HubHealthPanelProps {
  hubStatus: { projectCount: number } | null;
  hubProjects: Array<{ id: string; name: string; workerDerivedStatus?: string; worker?: { status: string } }>;
  hubAcp?: { pools?: Record<string, { mode?: string; active?: number; limit?: number; queued?: number }>; rateLimits?: Record<string, { untilTs?: number }> } | null;
  knowledgePolicy?: { automaticWrites?: unknown[]; forbiddenMarkdownState?: unknown[] } | null;
  observability?: {
    pools?: Record<string, { requestCount?: number; errorCount?: number; recycleCount?: number; processAgeMs?: number; rateLimitedUntil?: number }>;
    dispatchSummary?: { total?: number; completed?: number; failed?: number; running?: number };
    workers?: { details: Array<{ id: string; ageMs: number }> };
  } | null;
  projects: Array<{ inbox?: number; outputs?: number }>;
  queueStatus?: { total?: number; pending?: number; inProgress?: number; failed?: number; activeProjects?: Array<{ projectId: string; busyReason?: string; workerId?: string }>; eligibleQueued?: number; eligibleProjects?: string[] } | null;
  queueEntries?: Array<{ id: string; projectId: string; status: string }>;
}

export function HubHealthPanel({ hubStatus, hubProjects, hubAcp, knowledgePolicy: _kp, observability, projects, queueStatus, queueEntries = [] }: HubHealthPanelProps) {
  if (!hubStatus) return null;

  const workerCounts = hubProjects.reduce<Record<string, number>>((acc, p) => {
    const s = p.workerDerivedStatus || p.worker?.status || 'offline';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const inboxTotal = projects.reduce((sum, p) => sum + (p.inbox ?? 0), 0);
  const outputsTotal = projects.reduce((sum, p) => sum + (p.outputs ?? 0), 0);

  return (
    <GlassPanel depth="medium" padding="lg" className={panelStyle}>
      <div className={eyebrow}>Global Hub</div>
      <h3 className={titleStyle}>{hubStatus.projectCount} registered projects</h3>
      <p className={mutedText}>
        {Object.entries(workerCounts).map(([status, count], i) => (
          <span key={status}>
            {i > 0 && ' · '}
            {count} {status}
          </span>
        ))}
      </p>

      {projects.length > 0 && (
        <p className={mutedText}>Inbox: {inboxTotal} · Outputs: {outputsTotal}</p>
      )}

      {hubAcp?.pools && Object.keys(hubAcp.pools).length > 0 && (
        <div className={`${pillRow} ${sectionGap}`}>
          {Object.entries(hubAcp.pools).map(([agent, info]) => (
            <span key={agent} className={pill}>
              {agent}
              {info.mode && <em className={pillLabel}>{info.mode}</em>}
              {typeof info.active === 'number' && typeof info.limit === 'number' && (
                <span>{info.active}/{info.limit}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {observability?.dispatchSummary && observability.dispatchSummary.total && observability.dispatchSummary.total > 0 && (
        <div className={`${pillRow} ${sectionGap}`}>
          <Badge variant="muted">Runs: {observability.dispatchSummary.total} total</Badge>
          {observability.dispatchSummary.completed ? <Badge variant="success">{observability.dispatchSummary.completed} done</Badge> : null}
          {observability.dispatchSummary.failed ? <Badge variant="error">{observability.dispatchSummary.failed} failed</Badge> : null}
        </div>
      )}

      {queueStatus && queueStatus.total && queueStatus.total > 0 && (
        <div className={`${pillRow} ${sectionGap}`}>
          <Badge variant="muted">Queue: {queueStatus.pending} pending · {queueStatus.inProgress} active</Badge>
          {queueStatus.failed ? <Badge variant="error">{queueStatus.failed} failed</Badge> : null}
        </div>
      )}

      {queueEntries.filter(e => e.status === 'pending' || e.status === 'in_progress').length > 0 && (
        <div className={pillRow}>
          {queueEntries.filter(e => e.status === 'pending' || e.status === 'in_progress').slice(0, 3).map(entry => (
            <span key={entry.id} className={pill}>
              {entry.projectId}
              <em className={pillLabel}>{entry.status === 'in_progress' ? 'running' : entry.status}</em>
            </span>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
