import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Badge } from '@/components/shared/Badge';
import { SkeletonCard } from '@/components/shared/Skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { useAgentsStore, useWebSocketStore } from '@/app/store';
import { style, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[2],
});

const titleStyle = style({
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.extrabold,
  color: theme.text,
});

const statsRow = style({
  display: 'flex',
  gap: space[4],
  marginBottom: space[6],
  flexWrap: 'wrap',
});

const agentGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: space[4],
});

const agentCard = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
});

const agentHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
});

const agentName = style({
  fontSize: fontSize.base,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
});

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.4 },
});

const pulseDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: theme.success,
  display: 'inline-block',
  animation: `${pulse} 2s ease-in-out infinite`,
});

const agentMeta = style({
  display: 'flex',
  gap: space[3],
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

const statCard = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
  padding: `${space[3]} ${space[4]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  minWidth: 120,
});

const statValue = style({
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.bold,
  color: theme.text,
});

const statLabel = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
});

const jobList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
  marginTop: space[6],
});

const jobItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
  fontSize: fontSize.xs,
});

const skeletonGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: space[4],
});

export default function AgentBoard() {
  const { t } = useTranslation();
  const { agents, jobs, loading, fetchAgents, fetchJobs } = useAgentsStore();
  const { subscribe } = useWebSocketStore();

  useEffect(() => {
    fetchAgents();
    fetchJobs();
  }, []);

  useEffect(() => {
    const unsub = subscribe('pipeline:update', () => {
      fetchAgents();
      fetchJobs();
    });
    return unsub;
  }, [subscribe]);

  const summary = useMemo(() => {
    const total = agents.length;
    const available = agents.filter((a) => a.status === 'available').length;
    const busy = agents.filter((a) => a.status === 'busy').length;
    const offline = agents.filter((a) => a.status === 'offline').length;
    const totalCompleted = agents.reduce((sum, a) => sum + a.jobsCompleted, 0);
    const totalFailed = agents.reduce((sum, a) => sum + a.jobsFailed, 0);
    return { total, available, busy, offline, totalCompleted, totalFailed };
  }, [agents]);

  return (
    <div>
      <Breadcrumb items={[{ label: t('nav.dashboard'), to: '/' }, { label: t('agents.title') }]} />
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('agents.title')}</h2>
      </div>

      <div className={statsRow}>
        <div className={statCard}>
          <span className={statValue}>{summary.total}</span>
          <span className={statLabel}>{t('agents.agents')}</span>
        </div>
        <div className={statCard}>
          <span className={statValue}>{summary.available}</span>
          <span className={statLabel}>{t('status.available')}</span>
        </div>
        <div className={statCard}>
          <span className={statValue}>{summary.totalCompleted}</span>
          <span className={statLabel}>{t('agents.completed')}</span>
        </div>
        <div className={statCard}>
          <span className={statValue}>{summary.totalFailed}</span>
          <span className={statLabel}>{t('agents.failed')}</span>
        </div>
      </div>

      {loading && agents.length === 0 ? (
        <div className={skeletonGrid}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          icon="🤖"
          title={t('agents.noAgents')}
          description={t('agents.noAgentsDesc')}
        />
      ) : (
        <div className={agentGrid}>
          {agents.map((agent) => (
            <GlassPanel key={agent.name} depth="shallow" padding="md" interactive>
              <div className={agentCard}>
                <div className={agentHeader}>
                  <span className={agentName}>
                    {agent.status === 'available' && <span className={pulseDot} />}
                    {agent.name}
                  </span>
                  <Badge variant={
                    agent.status === 'available' ? 'success' :
                    agent.status === 'busy' ? 'accent' : 'muted'
                  }>
                    {agent.status}
                  </Badge>
                </div>
                <div className={agentMeta}>
                  <span>{t('agents.completed')}: {agent.jobsCompleted}</span>
                  <span>{t('agents.failed')}: {agent.jobsFailed}</span>
                </div>
                {agent.pools.length > 0 && (
                  <div style={{ display: 'flex', gap: space[1], flexWrap: 'wrap' }}>
                    {agent.pools.map((pool) => (
                      <Badge key={pool} variant="muted">{pool}</Badge>
                    ))}
                  </div>
                )}
                {agent.lastJobAt && (
                  <span style={{ fontSize: fontSize.xs, color: theme.textMuted }}>
                    {t('agents.lastUpdated')}: {new Date(agent.lastJobAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </GlassPanel>
          ))}
        </div>
      )}

      {jobs.length > 0 && (
        <GlassPanel depth="shallow" padding="md" className={jobList}>
          <h4 style={{ marginBottom: space[3], fontWeight: 600 }}>Durable Jobs</h4>
          {jobs.slice(0, 10).map((job) => (
            <div key={job.jobId} className={jobItem}>
              <Badge variant={
                job.status === 'completed' ? 'success' :
                job.status === 'failed' ? 'error' :
                job.status === 'running' ? 'accent' : 'muted'
              }>
                {job.status}
              </Badge>
              <span style={{ color: theme.text }}>{job.project}</span>
              <span style={{ color: theme.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.instruction}
              </span>
              <span style={{ color: theme.textMuted }}>{job.agent}</span>
            </div>
          ))}
        </GlassPanel>
      )}
    </div>
  );
}
