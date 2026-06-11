import { useEffect, useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import { EmptyState } from '@/components/shared/EmptyState';
import { Select } from '@/components/shared/Select';
import { Input } from '@/components/shared/Input';
import { Skeleton } from '@/components/shared/Skeleton';
import { ArtifactPanel } from '@/components/shared/ArtifactPanel';
import { useInboxStore, useWebSocketStore } from '@/app/store';
import type { InboxRequestDetail, RetryChainEntry } from '@/types/api';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

// --- styles ---

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

const subtitleStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  marginBottom: space[4],
});

const filterBar = style({
  display: 'flex',
  gap: space[3],
  marginBottom: space[4],
  flexWrap: 'wrap',
  alignItems: 'flex-end',
});

const filterItem = style({
  minWidth: 140,
});

const listContainer = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const rowStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  cursor: 'pointer',
  transition: 'background 0.15s',
  selectors: {
    '&:hover': { background: theme.surfaceAlt },
  },
});

const rowSelected = style({
  background: theme.accentTint,
  borderLeft: `3px solid ${theme.accent}`,
});

const taskIdStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  fontFamily: 'monospace',
  minWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const taskNameStyle = style({
  flex: 1,
  fontSize: fontSize.sm,
  color: theme.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const projectBadge = style({
  fontSize: fontSize.xs,
  minWidth: 80,
});

const timeStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  minWidth: 60,
  textAlign: 'right',
});

const splitLayout = style({
  display: 'flex',
  gap: space[4],
  minHeight: 'calc(100vh - 200px)',
});

const listPanel = style({
  flex: 1,
  minWidth: 0,
  overflow: 'auto',
});

const detailPanel = style({
  width: 420,
  flexShrink: 0,
  overflow: 'auto',
});

const detailSection = style({
  marginBottom: space[4],
});

const detailLabel = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  fontWeight: fontWeight.medium,
  marginBottom: space[1],
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
});

const detailValue = style({
  fontSize: fontSize.sm,
  color: theme.text,
  lineHeight: 1.6,
});

const codeBlock = style({
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: '6px',
  padding: space[3],
  fontSize: fontSize.xs,
  fontFamily: 'monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 200,
  overflow: 'auto',
});

const retryChainStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const retryEntry = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[1]} ${space[2]}`,
  borderRadius: '4px',
  fontSize: fontSize.xs,
  fontFamily: 'monospace',
});

const retryCurrent = style({
  background: theme.accentTint,
  border: `1px solid ${theme.accent}`,
});

const retryPast = style({
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
});

const countsBar = style({
  display: 'flex',
  gap: space[3],
  marginBottom: space[3],
  fontSize: fontSize.xs,
  color: theme.textDim,
});

// --- helpers ---

function statusVariant(status: string): 'success' | 'error' | 'warning' | 'muted' | 'accent' | 'default' {
  if (['completed', 'passed'].includes(status)) return 'success';
  if (['failed'].includes(status)) return 'error';
  if (['blocked', 'cancelled'].includes(status)) return 'warning';
  if (['running', 'in_progress'].includes(status)) return 'accent';
  return 'muted';
}

function priorityVariant(priority: string): 'error' | 'warning' | 'muted' | 'default' {
  if (priority === 'P0') return 'error';
  if (priority === 'P1') return 'warning';
  return 'muted';
}

function typeLabel(type: string): string {
  if (type === 'pipeline') return 'Pipeline';
  if (type === 'queued') return 'Queue';
  if (type === 'review') return 'Review';
  return type;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '–';
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatEvidence(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function hasJobArtifactDetail(detail: InboxRequestDetail): boolean {
  return (
    detail.type === 'pipeline' &&
    typeof detail.project === 'string' &&
    /^job-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(detail.id || '')
  );
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
  { value: 'queued', label: 'Queued' },
  { value: 'passed', label: 'Passed' },
  { value: 'pr-opened', label: 'PR Opened' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS = [
  { value: '', label: 'All Priorities' },
  { value: 'P0', label: 'P0 — Critical' },
  { value: 'P1', label: 'P1 — High' },
  { value: 'P2', label: 'P2 — Normal' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'queued', label: 'Queue' },
  { value: 'review', label: 'Review' },
];

const REVIEWABLE_PIPELINE_STATUSES = new Set(['passed', 'pr-opened', 'completed', 'failed', 'blocked', 'cancelled']);

// --- detail ---

function RequestDetail({ detail }: { detail: InboxRequestDetail | null; loading: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { acceptReviewBundle, rejectReviewBundle } = useInboxStore();
  const [feedback, setFeedback] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    setFeedback('');
    setReviewError(null);
  }, [detail?.id]);

  if (!detail) {
    return (
      <GlassPanel depth="medium" padding="md" className={detailPanel}>
        <p className={detailValue} style={{ color: theme.textMuted }}>Select a request to view details</p>
      </GlassPanel>
    );
  }

  const latestReviewVerdict = detail.reviewLoop?.latest?.verdict;
  const alreadyReviewedBundle = latestReviewVerdict === 'accepted' || latestReviewVerdict === 'rejected';
  const canReviewBundle =
    detail.type === 'pipeline' &&
    Boolean(detail.reviewBundle) &&
    !detail.reviewBundle?.error &&
    REVIEWABLE_PIPELINE_STATUSES.has(String(detail.status)) &&
    !alreadyReviewedBundle;

  async function submitAccept() {
    if (!detail) return;
    setSubmittingReview(true);
    setReviewError(null);
    try {
      await acceptReviewBundle(detail.id, feedback);
      setFeedback('');
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setSubmittingReview(false);
    }
  }

  async function submitReject() {
    if (!detail) return;
    if (!feedback.trim()) {
      setReviewError('Feedback required');
      return;
    }
    setSubmittingReview(true);
    setReviewError(null);
    try {
      await rejectReviewBundle(detail.id, feedback);
      setFeedback('');
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setSubmittingReview(false);
    }
  }

  return (
    <GlassPanel depth="medium" padding="md" className={detailPanel}>
      <div className={detailSection}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space[2], marginBottom: space[2] }}>
          <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
          <Badge variant={priorityVariant(detail.priority)}>{detail.priority}</Badge>
          <Badge variant="muted">{typeLabel(detail.type)}</Badge>
        </div>
        <div className={detailValue} style={{ fontWeight: fontWeight.semibold }}>{detail.task}</div>
        <div className={taskIdStyle}>{detail.id}</div>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${detail.project}`)}>
          {detail.project}
        </Button>
      </div>

      {detail.currentPhase && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.phase')}</div>
          <div className={detailValue}>{detail.currentPhase}</div>
        </div>
      )}

      {detail.source && detail.source.type !== 'manual' && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.source')}</div>
          <div className={detailValue}>{detail.source.label}</div>
          {detail.source.issueNumber && (
            <div className={taskIdStyle}>#{detail.source.issueNumber} {detail.source.repo}</div>
          )}
        </div>
      )}

      {detail.workflow && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.workflow')}</div>
          <div className={detailValue}>{detail.workflow}</div>
        </div>
      )}

      {detail.retryCount > 0 && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.retryCount')}</div>
          <div className={detailValue}>{detail.retryCount}</div>
        </div>
      )}

      {detail.nextHumanAction && (
        <div className={detailSection}>
          <div className={detailLabel}>Next Action</div>
          <div className={detailValue}>{detail.nextHumanAction.label}</div>
        </div>
      )}

      {detail.failureCode && (
        <div className={detailSection}>
          <div className={detailLabel}>Failure</div>
          <div className={detailValue}>
            {detail.failureCode} {detail.failurePhase && `in ${detail.failurePhase}`}
          </div>
        </div>
      )}

      {detail.pr?.url && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.pr')}</div>
          <a href={detail.pr.url} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent, fontSize: fontSize.sm }}>
            PR #{detail.pr.number || 'view'}
          </a>
        </div>
      )}

      {hasJobArtifactDetail(detail) && detail.project && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.artifacts')}</div>
          <ArtifactPanel project={detail.project} jobId={detail.id} />
        </div>
      )}

      {detail.lastActivityMessage && (
        <div className={detailSection}>
          <div className={detailLabel}>Activity</div>
          <div className={detailValue}>{detail.lastActivityMessage}</div>
          {detail.lastActivityAt && (
            <div className={timeStyle}>{timeAgo(detail.lastActivityAt)}</div>
          )}
        </div>
      )}

      {detail.retryChain && detail.retryChain.length > 1 && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.retryChain')}</div>
          <div className={retryChainStyle}>
            {detail.retryChain.map((entry: RetryChainEntry) => (
              <div key={entry.jobId} className={`${retryEntry} ${entry.isCurrent ? retryCurrent : retryPast}`}>
                <Badge variant={statusVariant(entry.status)}>{entry.status}</Badge>
                <span>{entry.jobId.slice(-12)}</span>
                {entry.failureCode && <span style={{ color: theme.error }}>{entry.failureCode}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.plan && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.plan')}</div>
          <pre className={codeBlock}>{detail.plan}</pre>
        </div>
      )}

      {detail.research && (detail.research.codex || detail.research.claude) && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.research')}</div>
          {detail.research.codex && (
            <details style={{ marginBottom: space[2] }}>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>Codex</summary>
              <pre className={codeBlock}>{detail.research.codex}</pre>
            </details>
          )}
          {detail.research.claude && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>Claude</summary>
              <pre className={codeBlock}>{detail.research.claude}</pre>
            </details>
          )}
        </div>
      )}

      {detail.reviewRounds && detail.reviewRounds.length > 0 && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.reviews')}</div>
          {detail.reviewRounds.map((round) => (
            <div key={round.round} style={{ marginBottom: space[2] }}>
              <div style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: theme.textDim, marginBottom: space[1] }}>
                {t('inbox.detail.round', { n: round.round })}
              </div>
              {round.issues.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
                  {round.issues.map((issue, i) => (
                    <div key={i} style={{ display: 'flex', gap: space[2], fontSize: fontSize.xs }}>
                      <Badge variant={issue.severity === 'critical' ? 'error' : issue.severity === 'major' ? 'warning' : 'muted'}>
                        {issue.severity}
                      </Badge>
                      <span className={detailValue} style={{ flex: 1 }}>{issue.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {detail.reviewBundle && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.reviewBundle')}</div>
          {detail.reviewBundle.error && (
            <div className={detailValue} style={{ color: theme.error }}>{detail.reviewBundle.error}</div>
          )}
          {detail.reviewBundle.evidence?.plan?.content && (
            <details style={{ marginBottom: space[2] }}>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>{t('inbox.detail.plan')}</summary>
              <pre className={codeBlock}>{detail.reviewBundle.evidence.plan.content}</pre>
            </details>
          )}
          {detail.reviewBundle.evidence?.deliverable?.content && (
            <details style={{ marginBottom: space[2] }}>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>{t('inbox.detail.deliverable')}</summary>
              <pre className={codeBlock}>{detail.reviewBundle.evidence.deliverable.content}</pre>
            </details>
          )}
          {detail.reviewBundle.evidence?.verdict != null && (
            <details style={{ marginBottom: space[2] }}>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>{t('inbox.detail.verdict')}</summary>
              <pre className={codeBlock}>{formatEvidence(detail.reviewBundle.evidence.verdict)}</pre>
            </details>
          )}
          {detail.reviewBundle.evidence?.changedFiles?.length > 0 && (
            <details style={{ marginBottom: space[2] }}>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>{t('inbox.detail.changedFiles')}</summary>
              <pre className={codeBlock}>{detail.reviewBundle.evidence.changedFiles.join('\n')}</pre>
            </details>
          )}
          {detail.reviewBundle.artifacts?.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: fontSize.xs, color: theme.textDim }}>{t('inbox.detail.artifacts')}</summary>
              <pre className={codeBlock}>
                {detail.reviewBundle.artifacts.map((a) => `${a.kind || 'artifact'} ${a.broken ? 'broken' : 'ok'} ${a.path || ''}`).join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}

      {canReviewBundle && (
        <div className={detailSection}>
          <div className={detailLabel}>Review Action</div>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Feedback"
            rows={4}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              marginBottom: space[2],
              borderRadius: 6,
              border: `1px solid ${theme.border}`,
              background: theme.surfaceAlt,
              color: theme.text,
              padding: space[2],
              fontSize: fontSize.sm,
              resize: 'vertical',
            }}
          />
          {reviewError && (
            <div className={detailValue} style={{ color: theme.error, marginBottom: space[2] }}>{reviewError}</div>
          )}
          <div style={{ display: 'flex', gap: space[2], flexWrap: 'wrap' }}>
            <Button size="sm" variant="primary" disabled={submittingReview} onClick={submitAccept}>Accept</Button>
            <Button size="sm" variant="danger" disabled={submittingReview || !feedback.trim()} onClick={submitReject}>Reject</Button>
          </div>
        </div>
      )}

      {detail.reviewLoop?.rounds && detail.reviewLoop.rounds.length > 0 && (
        <div className={detailSection}>
          <div className={detailLabel}>Review Rounds</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
            {detail.reviewLoop.rounds.map((round) => (
              <div key={`${round.round}-${round.createdAt || ''}`} style={{ fontSize: fontSize.xs, color: theme.text }}>
                <Badge variant={round.verdict === 'accepted' ? 'success' : round.verdict === 'rejected' ? 'error' : 'muted'}>
                  {round.verdict}
                </Badge>
                <span style={{ marginLeft: space[2] }}>R{round.round}</span>
                {round.retryQueueEntryId && (
                  <span style={{ marginLeft: space[2], color: theme.textMuted, fontFamily: 'monospace' }}>
                    {round.retryQueueEntryId}
                  </span>
                )}
                {round.feedback && <div className={detailValue}>{round.feedback}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.budget && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.budget')}</div>
          <div className={detailValue}>
            {detail.budget.usedAcpCalls}/{detail.budget.maxAcpCalls} ACP calls,{' '}
            {Math.round((detail.budget.usedPromptBytes / 1024))}/{Math.round((detail.budget.maxPromptBytes / 1024))}KB prompt
          </div>
        </div>
      )}

      {detail.userVerdict && (
        <div className={detailSection}>
          <div className={detailLabel}>{t('inbox.detail.verdict')}</div>
          <Badge variant={detail.userVerdict === 'approved' ? 'success' : detail.userVerdict === 'rejected' ? 'error' : 'muted'}>
            {detail.userVerdict}
          </Badge>
        </div>
      )}

      {detail.pipelineState?.nodes && detail.pipelineState.nodes.length > 0 && (
        <div className={detailSection}>
          <div className={detailLabel}>Pipeline Nodes</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[1] }}>
            {detail.pipelineState.nodes.map((node) => (
              <div key={node.id} style={{ display: 'flex', alignItems: 'center', gap: space[2], fontSize: fontSize.xs }}>
                <Badge variant={statusVariant(node.status || 'pending')}>{node.status || 'pending'}</Badge>
                <span className={detailValue}>{node.phase || node.id}</span>
                {node.durationMs != null && (
                  <span className={timeStyle}>{(node.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </GlassPanel>
  );
}

// --- main page ---

export default function Inbox() {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState('');

  const {
    items, projects, statusCounts, total,
    filters, selectedId, detail, detailLoading, loading,
    setFilter, clearFilters, fetchInbox, fetchProjects, selectRequest,
  } = useInboxStore();
  const { subscribe } = useWebSocketStore();

  useEffect(() => {
    fetchInbox();
    fetchProjects();
  }, [filters.status, filters.priority, filters.project, filters.type, filters.sort]);

  useEffect(() => {
    const unsub = subscribe('pipeline:update', () => fetchInbox());
    const unsubFile = subscribe('file:created', () => fetchInbox());
    return () => { unsub(); unsubFile(); };
  }, [subscribe]);

  const projectOptions = useMemo(() => [
    { value: '', label: t('inbox.allProjects') },
    ...projects.map((p) => ({ value: p, label: p })),
  ], [projects, t]);

  const handleSelect = useCallback((id: string) => {
    selectRequest(id === selectedId ? null : id);
  }, [selectedId, selectRequest]);

  const handleSearch = useCallback(() => {
    useInboxStore.setState({ filters: { ...filters, search: searchInput || undefined } });
    fetchInbox();
  }, [searchInput, filters, fetchInbox]);

  const countsEntries = Object.entries(statusCounts).filter(([, v]) => v > 0);

  return (
    <div>
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('inbox.title')}</h2>
        <Button variant="ghost" onClick={() => { fetchInbox(); fetchProjects(); }}>
          {t('common.refresh')}
        </Button>
      </div>
      <p className={subtitleStyle}>{t('inbox.subtitle')}</p>

      <div className={filterBar}>
        <div className={filterItem}>
          <Select
            label={t('inbox.allStatuses')}
            options={STATUS_OPTIONS}
            value={filters.status || ''}
            onChange={(e) => setFilter('status', e.target.value || undefined)}
          />
        </div>
        <div className={filterItem}>
          <Select
            label={t('inbox.allPriorities')}
            options={PRIORITY_OPTIONS}
            value={filters.priority || ''}
            onChange={(e) => setFilter('priority', e.target.value || undefined)}
          />
        </div>
        <div className={filterItem}>
          <Select
            label={t('inbox.allProjects')}
            options={projectOptions}
            value={filters.project || ''}
            onChange={(e) => setFilter('project', e.target.value || undefined)}
          />
        </div>
        <div className={filterItem}>
          <Select
            label={t('inbox.allTypes')}
            options={TYPE_OPTIONS}
            value={filters.type || ''}
            onChange={(e) => setFilter('type', e.target.value || undefined)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input
            placeholder={t('inbox.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={() => { clearFilters(); setSearchInput(''); }}>
            {t('common.reset')}
          </Button>
        </div>
      </div>

      {countsEntries.length > 0 && (
        <div className={countsBar}>
          {countsEntries.map(([status, count]) => (
            <span key={status}>
              <Badge variant={statusVariant(status)}>{status}</Badge> {count}
            </span>
          ))}
          <span style={{ color: theme.textDim }}>{t('inbox.requestCount', { count: total })}</span>
        </div>
      )}

      {items.length === 0 && !loading ? (
        <EmptyState
          icon="📥"
          title={t('inbox.noRequests')}
          description={t('inbox.noRequestsDesc')}
        />
      ) : (
        <div className={splitLayout}>
          <div className={listPanel}>
            <div className={listContainer}>
              {loading ? (
                <GlassPanel depth="medium" padding="md">
                  <Skeleton count={5} />
                </GlassPanel>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className={`${rowStyle} ${selectedId === item.id ? rowSelected : ''}`}
                    onClick={() => handleSelect(item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && handleSelect(item.id)}
                  >
                    <Badge variant={priorityVariant(item.priority)}>{item.priority}</Badge>
                    <span className={projectBadge}>{item.project}</span>
                    <span className={taskNameStyle}>{item.task || item.id}</span>
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                    {item.retryCount > 0 && (
                      <Badge variant="warning">R{item.retryCount}</Badge>
                    )}
                    <span className={timeStyle}>{timeAgo(item.updatedAt)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <RequestDetail detail={detail} loading={detailLoading} />
        </div>
      )}
    </div>
  );
}
