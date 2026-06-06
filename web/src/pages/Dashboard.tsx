import { useEffect, useMemo, useCallback, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Tabs } from '@/components/shared/Tabs';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import { EmptyState } from '@/components/shared/EmptyState';
import { InitProjectModal } from '@/components/shared/InitProjectModal';
import { TodayBrief } from '@/components/dashboard/TodayBrief';
import { AttentionQueue } from '@/components/dashboard/AttentionQueue';
import { ProjectGrid } from '@/components/dashboard/ProjectGrid';
import { HubHealthPanel } from '@/components/dashboard/HubHealthPanel';
import { useProjectsStore, useHubStore, useWebSocketStore, useAgentsStore } from '@/app/store';
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

const headerActions = style({
  display: 'flex',
  gap: space[3],
});

const sectionStyle = style({
  marginTop: space[6],
});

const summaryList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
});

const summaryRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  background: theme.surfaceAlt,
  fontSize: fontSize.sm,
});

const summaryRowFailed = style({
  borderLeft: `3px solid ${theme.error}`,
  background: theme.errorDim,
});

const mutedStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.6,
});

const ATTENTION_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

function projectAttentionStatus(p: { pipelineState?: { status: string } }): string | null {
  const status = p.pipelineState?.status;
  return status && ATTENTION_STATUSES.has(status) ? status : null;
}

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [initOpen, setInitOpen] = useState(false);
  const diagnostics = searchParams.get('diagnostics') === '1' || searchParams.get('includeTest') === '1';
  const activeTab = searchParams.get('tab') || 'overview';

  const { projects, loading, fetchProjects } = useProjectsStore();
  const hubStore = useHubStore();
  const { subscribe } = useWebSocketStore();
  const { jobs, fetchJobs } = useAgentsStore();

  useEffect(() => {
    fetchProjects(diagnostics);
    hubStore.fetchHubData(diagnostics);
    fetchJobs();
  }, [diagnostics]);

  useEffect(() => {
    const unsub = subscribe('pipeline:update', () => {
      fetchProjects(diagnostics);
      hubStore.fetchHubData(diagnostics);
    });
    const unsubFile = subscribe('file:created', () => fetchProjects(diagnostics));
    return () => { unsub(); unsubFile(); };
  }, [subscribe, diagnostics]);

  const setActiveTab = useCallback((tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const hubProjects = hubStore.projects ?? [];
  const queueStatus = hubStore.queueStatus;
  const hubDispatches = hubStore.dispatches ?? [];
  const taskLedger = hubStore.taskLedger;
  const observability = hubStore.observability as Record<string, unknown> | null;

  type TaskList = Array<{ status: string; progress?: { stage: string } }>;
  type DispatchSummary = { dispatchSummary?: { failed?: number; completed?: number; running?: number; total?: number } };
  type ObsWorkers = { workers?: { details?: Array<{ id: string; ageMs: number }> } };

  const taskList = (taskLedger as { tasks?: TaskList } | null)?.tasks ?? [];
  const dispatchObs = observability as DispatchSummary | null;
  const workersObs = observability as ObsWorkers | null;

  // Dedup by sourcePath/path first, then name/id — same directory = same project
  const legacyByName = new Map(projects.map((p) => [p.name, p]));
  const legacyByPath = new Map(
    projects.filter((p) => p.path).map((p) => [p.path!, p]),
  );
  const primaryProjects = hubProjects.map((hp) => {
    const byPath = hp.sourcePath ? legacyByPath.get(hp.sourcePath) : null;
    const legacy = byPath || legacyByName.get(hp.id) || legacyByName.get(hp.name);
    return { ...hp, ...(legacy || {}), id: hp.id };
  });
  const hubPaths = new Set(hubProjects.filter((hp) => hp.sourcePath).map((hp) => hp.sourcePath!));
  const hubIds = new Set(hubProjects.map((p) => p.id));
  const hubNames = new Set(hubProjects.map((p) => p.name));
  const secondaryProjects = projects.filter((p) => {
    if (hubIds.has(p.name) || hubNames.has(p.name)) return false;
    if (p.path && hubPaths.has(p.path)) return false;
    return true;
  });

  const workerAgeById = new Map(
    (workersObs?.workers?.details ?? []).map((w) => [w.id, { ageMs: w.ageMs }] as [string, { ageMs: number }]),
  );

  const allProjects = [...primaryProjects, ...secondaryProjects];

  const activeTasksCount = taskList.filter(t => t.status === 'running' || t.progress?.stage === 'running').length;
  const failedRunsCount = (dispatchObs?.dispatchSummary?.failed ?? 0) + (queueStatus?.unretriedFailedTargets ?? queueStatus?.failed ?? 0);
  const blockedProjectsCount = allProjects.filter(projectAttentionStatus).length;
  const completedRunsCount = dispatchObs?.dispatchSummary?.completed ?? 0;

  const attentionItems = useMemo(() => {
    const items: Array<{ id: string; project: string; reason: string; impact: string; action: string; link: string }> = [];
    allProjects.forEach(p => {
      const status = projectAttentionStatus(p);
      if (status) {
        items.push({
          id: `proj-${p.id || p.name}`,
          project: p.name || p.id || 'unknown',
          reason: p.pipelineState?.error || `Pipeline status: ${status}`,
          impact: 'Downstream deployments on hold.',
          action: status === 'failed' ? 'Retry Pipeline' : 'Review Project',
          link: `/project/${p.name || p.id}?tab=overview`,
        });
      }
    });
    jobs.forEach(job => {
      if (job.status === 'failed') {
        items.push({
          id: `job-${job.jobId}`,
          project: job.project,
          reason: `Durable job failed in phase: ${job.phase}`,
          impact: 'Workspace lock active. Task incomplete.',
          action: 'View Job Logs',
          link: `/project/${job.project}?tab=overview`,
        });
      }
    });
    return items;
  }, [allProjects, jobs]);

  const recentDispatches = useMemo(() =>
    hubDispatches
      .filter((d) => d.status && d.status !== 'pending')
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
      .slice(0, 5),
    [hubDispatches],
  );

  const durableSummary = useMemo(() => {
    const counts = { running: 0, completed: 0, failed: 0 };
    jobs.forEach(j => {
      if (j.status in counts) counts[j.status as keyof typeof counts]++;
    });
    return counts;
  }, [jobs]);

  if (loading) return <div className={mutedStyle}>{t('app.loading')}</div>;

  const tabItems = [
    { key: 'overview', label: t('dashboard.overview') },
    { key: 'health', label: t('dashboard.systemHealth') },
  ];

  const hasNoData = allProjects.length === 0 && !loading;

  return (
    <div>
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('dashboard.title')}</h2>
        <div className={headerActions}>
          <Button variant="ghost" onClick={() => setInitOpen(true)}>
            + {t('project.initProject')}
          </Button>
          <Link to="/new-task">
            <Button variant="primary">+ {t('nav.newTask')}</Button>
          </Link>
        </div>
      </div>

      <Tabs items={tabItems} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'overview' && (
        <div>
          <TodayBrief
            activeTasks={activeTasksCount}
            failedRuns={failedRunsCount}
            blockedProjects={blockedProjectsCount}
            completedRuns={completedRunsCount}
          />
          <AttentionQueue items={attentionItems} onNavigate={(link) => navigate(link)} />
          {hasNoData ? (
            <EmptyState
              icon="📋"
              title={t('dashboard.noProjects')}
              description={t('dashboard.noProjectsDesc')}
              action={
                <div style={{ display: 'flex', gap: space[3] }}>
                  <Button variant="primary" onClick={() => setInitOpen(true)}>
                    + {t('project.initProject')}
                  </Button>
                  <Link to="/new-task">
                    <Button variant="default">+ {t('nav.newTask')}</Button>
                  </Link>
                </div>
              }
            />
          ) : (
            <ProjectGrid
              primaryProjects={primaryProjects}
              secondaryProjects={secondaryProjects}
              diagnostics={diagnostics}
              workerAgeById={workerAgeById}
            />
          )}
        </div>
      )}

      {activeTab === 'health' && (
        <div>
          <HubHealthPanel
            hubStatus={hubStore.status}
            hubProjects={hubProjects}
            hubAcp={hubStore.acp}
            knowledgePolicy={hubStore.knowledgePolicy as { automaticWrites?: unknown[]; forbiddenMarkdownState?: unknown[] } | null}
            observability={observability}
            projects={projects}
            queueStatus={queueStatus}
            queueEntries={hubStore.queueEntries.map(e => ({ ...e, projectId: e.projectId ?? e.project }))}
          />

          {recentDispatches.length > 0 && (
            <GlassPanel depth="medium" padding="md" className={sectionStyle}>
              <h4 style={{ marginBottom: 12, fontWeight: 600 }}>{t('dashboard.recentRuns')}</h4>
              <div className={summaryList}>
                {recentDispatches.map((d, i) => (
                  <div key={i} className={`${summaryRow} ${d.status === 'failed' ? summaryRowFailed : ''}`}>
                    <span style={{ flex: 1 }}>{d.projectId}</span>
                    <Badge variant={d.status === 'completed' ? 'success' : d.status === 'failed' ? 'error' : 'muted'}>
                      {d.status}
                    </Badge>
                    <span style={{ color: theme.textMuted, fontSize: 12, minWidth: 80, textAlign: 'right' }}>
                      {d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : '–'}
                    </span>
                  </div>
                ))}
              </div>
            </GlassPanel>
          )}

          {jobs.length > 0 && (
            <GlassPanel depth="medium" padding="md" className={sectionStyle}>
              <h4 style={{ marginBottom: 8, fontWeight: 600 }}>Durable Jobs</h4>
              <p className={mutedStyle}>
                {durableSummary.running > 0 && `${durableSummary.running} running`}
                {durableSummary.running > 0 && durableSummary.completed > 0 && ' · '}
                {durableSummary.completed > 0 && `${durableSummary.completed} completed`}
                {(durableSummary.running > 0 || durableSummary.completed > 0) && durableSummary.failed > 0 && ' · '}
                {durableSummary.failed > 0 && `${durableSummary.failed} failed`}
              </p>
            </GlassPanel>
          )}
        </div>
      )}

      <InitProjectModal
        open={initOpen}
        onClose={() => setInitOpen(false)}
        onSuccess={() => { fetchProjects(diagnostics); hubStore.fetchHubData(diagnostics); }}
      />
    </div>
  );
}
