import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { Tabs } from '@/components/shared/Tabs';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { useReviewStore, useWebSocketStore } from '@/app/store';
import { getStatusInfo, formatRelativeTime, truncateId } from '@/utils/format';
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
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.extrabold,
  color: theme.text,
});

const sessionList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[3],
});

const sessionCard = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[3]} ${space[4]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  cursor: 'pointer',
  transition: 'border-color 0.15s',
  selectors: { '&:hover': { borderColor: theme.textMuted } },
});

const sessionCardSelected = style({
  borderColor: theme.accent,
});

const sessionInfo = style({
  flex: 1,
  minWidth: 0,
});

const sessionProject = style({
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
});

const sessionInstruction = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  marginTop: space[1],
});

const sessionMeta = style({
  display: 'flex',
  gap: space[2],
  alignItems: 'center',
  flexShrink: 0,
});

const detailPanel = style({
  marginTop: space[6],
});

const detailHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: space[4],
});

const sectionTitle = style({
  fontSize: fontSize.base,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[2],
});

const preBlock = style({
  padding: space[4],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  fontSize: fontSize.xs,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap' as const,
  maxHeight: 320,
  overflowY: 'auto' as const,
  color: theme.textDim,
});

const actionsStyle = style({
  display: 'flex',
  gap: space[2],
  flexWrap: 'wrap',
});

const roundCard = style({
  padding: space[3],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  marginBottom: space[3],
});

const issueItem = style({
  display: 'flex',
  gap: space[2],
  fontSize: fontSize.xs,
  padding: `${space[1]} 0`,
  color: theme.textDim,
});

const paginationStyle = style({
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: space[3],
  marginTop: space[4],
  fontSize: fontSize.sm,
  color: theme.textMuted,
});

function statusVariant(status: string): 'success' | 'warning' | 'error' | 'accent' | 'muted' {
  if (status === 'approved') return 'success';
  if (status === 'rejected' || status === 'cancelled') return 'error';
  if (status === 'user_review') return 'warning';
  if (status === 'researching') return 'accent';
  return 'muted';
}

export default function Review() {
  const { t } = useTranslation();
  const store = useReviewStore();
  const { subscribe } = useWebSocketStore();

  const [activeGroup, setActiveGroup] = useState('all');
  const [confirmAction, setConfirmAction] = useState<{
    type: 'approve' | 'reject' | 'cancel';
    sessionId: string;
  } | null>(null);

  useEffect(() => {
    store.fetchSessions();
  }, []);

  useEffect(() => {
    const unsub = subscribe('review:update', () => {
      store.fetchSessions();
    });
    return unsub;
  }, [subscribe]);

  const selectedSession = useMemo(
    () => store.sessions.find((s) => s.id === store.selectedId),
    [store.sessions, store.selectedId],
  );

  const grouped = useMemo(() => {
    const groups: Record<string, typeof store.sessions> = { all: store.sessions };
    groups.needsAction = store.sessions.filter((s) => s.status === 'user_review');
    groups.inProgress = store.sessions.filter((s) => s.status === 'researching' || s.status === 'queued');
    groups.done = store.sessions.filter((s) => ['approved', 'rejected', 'cancelled'].includes(s.status));
    return groups;
  }, [store.sessions]);

  const displayed = grouped[activeGroup] ?? store.sessions;

  const tabItems = [
    { key: 'all', label: `${t('review.queued')} (${grouped.all?.length ?? 0})` },
    { key: 'needsAction', label: `${t('review.needsAction')} (${grouped.needsAction?.length ?? 0})` },
    { key: 'inProgress', label: `${t('review.inProgress')} (${grouped.inProgress?.length ?? 0})` },
    { key: 'done', label: `${t('review.done')} (${grouped.done?.length ?? 0})` },
  ];

  const handleConfirm = () => {
    if (!confirmAction) return;
    const { type, sessionId } = confirmAction;
    if (type === 'approve') store.approve(sessionId);
    else if (type === 'reject') store.reject(sessionId);
    else if (type === 'cancel') store.cancel(sessionId);
    setConfirmAction(null);
  };

  return (
    <div>
      <Breadcrumb items={[{ label: t('nav.dashboard'), to: '/' }, { label: t('review.title') }]} />
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('review.title')}</h2>
      </div>

      <div style={{ marginBottom: space[4] }}>
        <Input
          placeholder={t('review.searchPlaceholder')}
          value={store.query}
          onChange={(e) => { store.setQuery(e.target.value); store.setPage(1); }}
        />
      </div>

      <Tabs items={tabItems} active={activeGroup} onChange={setActiveGroup} />

      {displayed.length === 0 ? (
        <EmptyStateInline message={t('review.noSessions')} />
      ) : (
        <div className={sessionList}>
          {displayed.map((session) => (
            <div
              key={session.id}
              className={`${sessionCard} ${store.selectedId === session.id ? sessionCardSelected : ''}`}
              onClick={() => store.selectSession(session.id)}
            >
              <div className={sessionInfo}>
                <div className={sessionProject}>{session.project}</div>
                <div className={sessionInstruction}>{session.instruction}</div>
              </div>
              <div className={sessionMeta}>
                <Badge variant={statusVariant(session.status)}>
                  {getStatusInfo(session.status).icon} {getStatusInfo(session.status).label}
                </Badge>
                <span style={{ fontSize: fontSize.xs, color: theme.textMuted }}>
                  {formatRelativeTime(session.createdAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {store.totalPages > 1 && (
        <div className={paginationStyle}>
          <Button variant="ghost" disabled={store.page <= 1} onClick={() => store.setPage(store.page - 1)}>
            {t('review.prev')}
          </Button>
          <span>{t('review.page', { current: store.page, total: store.totalPages })}</span>
          <Button variant="ghost" disabled={store.page >= store.totalPages} onClick={() => store.setPage(store.page + 1)}>
            {t('review.next')}
          </Button>
        </div>
      )}

      {selectedSession && (
        <GlassPanel depth="medium" padding="md" className={detailPanel}>
          <div className={detailHeader}>
            <div>
              <h3 className={sectionTitle}>{selectedSession.project}</h3>
              <p style={{ fontSize: fontSize.xs, color: theme.textMuted }}>
                {truncateId(selectedSession.id)} · {selectedSession.instruction}
              </p>
            </div>
            <Badge variant={statusVariant(selectedSession.status)}>
              {getStatusInfo(selectedSession.status).icon} {getStatusInfo(selectedSession.status).label}
            </Badge>
          </div>

          <div className={actionsStyle}>
            {selectedSession.status === 'queued' && (
              <Button variant="primary" onClick={() => store.startReview(selectedSession.id)}>
                {t('review.start')}
              </Button>
            )}
            {selectedSession.status === 'user_review' && (
              <>
                <Button variant="primary" onClick={() => setConfirmAction({ type: 'approve', sessionId: selectedSession.id })}>
                  {t('review.approve')}
                </Button>
                <Button variant="danger" onClick={() => setConfirmAction({ type: 'reject', sessionId: selectedSession.id })}>
                  {t('review.reject')}
                </Button>
              </>
            )}
            {['queued', 'researching', 'user_review'].includes(selectedSession.status) && (
              <Button variant="ghost" onClick={() => setConfirmAction({ type: 'cancel', sessionId: selectedSession.id })}>
                {t('review.cancel')}
              </Button>
            )}
            {selectedSession.status === 'user_review' && (
              <>
                <Button variant="ghost" onClick={() => store.autoApprove(selectedSession.id)}>
                  {t('review.autoApprove')}
                </Button>
                <Button variant="ghost" onClick={() => store.analyze(selectedSession.id)}>
                  {t('review.analyze')}
                </Button>
              </>
            )}
          </div>

          {selectedSession.research && (
            <div style={{ marginTop: space[4] }}>
              <h4 className={sectionTitle}>Research</h4>
              {(selectedSession.research.codex || selectedSession.research.claude) && (
                <pre className={preBlock}>
                  {selectedSession.research.codex && `## Codex\n${selectedSession.research.codex}\n\n`}
                  {selectedSession.research.claude && `## Claude\n${selectedSession.research.claude}`}
                </pre>
              )}
            </div>
          )}

          {selectedSession.plan && (
            <div style={{ marginTop: space[4] }}>
              <h4 className={sectionTitle}>Plan</h4>
              <pre className={preBlock}>{selectedSession.plan}</pre>
            </div>
          )}

          {selectedSession.reviewRounds && selectedSession.reviewRounds.length > 0 && (
            <div style={{ marginTop: space[4] }}>
              <h4 className={sectionTitle}>Review Rounds</h4>
              {selectedSession.reviewRounds.map((round) => (
                <div key={round.round} className={roundCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: space[2] }}>
                    <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
                      {t('review.round', { n: round.round })}
                    </span>
                    <Badge variant={round.verdict === 'PASS' ? 'success' : round.verdict === 'FAIL' ? 'error' : 'warning'}>
                      {round.verdict}
                    </Badge>
                  </div>
                  {round.issues.map((issue, i) => (
                    <div key={i} className={issueItem}>
                      <Badge variant={issue.severity === 'critical' ? 'error' : issue.severity === 'major' ? 'warning' : 'muted'}>
                        {issue.severity}
                      </Badge>
                      <span>{issue.file}{issue.line ? `:${issue.line}` : ''}</span>
                      <span style={{ flex: 1 }}>{issue.message}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </GlassPanel>
      )}

      <ConfirmModal
        open={confirmAction !== null}
        title={
          confirmAction?.type === 'approve' ? t('review.confirmApprove') :
          confirmAction?.type === 'reject' ? t('review.confirmReject') :
          t('review.confirmCancel')
        }
        message={
          confirmAction?.type === 'approve' ? t('review.confirmApproveMsg') :
          confirmAction?.type === 'reject' ? t('review.confirmRejectMsg') :
          t('review.confirmCancelMsg')
        }
        confirmLabel={
          confirmAction?.type === 'approve' ? t('review.approve') :
          confirmAction?.type === 'reject' ? t('review.reject') :
          t('review.cancel')
        }
        variant={confirmAction?.type === 'reject' ? 'danger' : 'primary'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

function EmptyStateInline({ message }: { message: string }) {
  const emptyStyle = style({
    textAlign: 'center' as const,
    padding: space[8],
    color: theme.textMuted,
    fontSize: fontSize.sm,
  });
  return <div className={emptyStyle}>{message}</div>;
}
