import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import { EmptyState } from '@/components/shared/EmptyState';
import { useGatesStore, useWebSocketStore } from '@/app/store';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[2],
});

const titleStyle = style({
  fontSize: fontSize['3xl'],
  fontWeight: fontWeight.extrabold,
  color: theme.text,
});

const gateList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[3],
  marginTop: space[4],
});

const gateCard = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[3]} ${space[4]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
});

const gateInfo = style({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const gateJobId = style({
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  fontFamily: 'monospace',
});

const gateMeta = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

const gateReason = style({
  fontSize: fontSize.xs,
  color: theme.textDim,
  fontStyle: 'italic',
});

const actionsStyle = style({
  display: 'flex',
  gap: space[2],
});

const mutedStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.6,
});

export default function Gates() {
  const { t } = useTranslation();
  const { gates, loading, fetchGates, approveGate, denyGate } = useGatesStore();
  const { subscribe } = useWebSocketStore();
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    fetchGates();
  }, []);

  useEffect(() => {
    const unsub = subscribe('gate:approved', () => fetchGates());
    const unsub2 = subscribe('gate:denied', () => fetchGates());
    const unsub3 = subscribe('pipeline:update', () => fetchGates());
    return () => { unsub(); unsub2(); unsub3(); };
  }, [subscribe, fetchGates]);

  const handleApprove = useCallback(async (jobId: string, project: string) => {
    setProcessing(jobId);
    try { await approveGate(jobId, project); } finally { setProcessing(null); }
  }, [approveGate]);

  const handleDeny = useCallback(async (jobId: string, project: string) => {
    setProcessing(jobId);
    try { await denyGate(jobId, project); } finally { setProcessing(null); }
  }, [denyGate]);

  if (loading) return <div className={mutedStyle}>{t('app.loading')}</div>;

  return (
    <div>
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('gates.title', 'Approval Gates')}</h2>
        <Badge variant={gates.length > 0 ? 'warning' : 'success'}>
          {gates.length} pending
        </Badge>
      </div>

      {gates.length === 0 ? (
        <EmptyState
          icon="✅"
          title={t('gates.none', 'No pending gates')}
          description={t('gates.noneDesc', 'All approval gates have been resolved.')}
        />
      ) : (
        <div className={gateList}>
          {gates.map((gate) => (
            <GlassPanel key={gate.jobId} depth="medium" padding="md">
              <div className={gateCard}>
                <div className={gateInfo}>
                  <span className={gateJobId}>{gate.jobId}</span>
                  <span className={gateMeta}>
                    {t('gates.project', 'Project')}: {gate.project}
                    {gate.phase && ` · ${t('gates.phase', 'Phase')}: ${gate.phase}`}
                    {' · '}
                    {new Date(gate.createdAt).toLocaleString()}
                  </span>
                  {gate.blockedReason && (
                    <span className={gateReason}>{gate.blockedReason}</span>
                  )}
                  {gate.instruction && (
                    <span className={gateMeta}>{gate.instruction}</span>
                  )}
                </div>
                <div className={actionsStyle}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={processing === gate.jobId}
                    onClick={() => handleApprove(gate.jobId, gate.project)}
                  >
                    {t('gates.approve', 'Approve')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={processing === gate.jobId}
                    onClick={() => handleDeny(gate.jobId, gate.project)}
                  >
                    {t('gates.deny', 'Deny')}
                  </Button>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
