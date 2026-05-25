import React, { useCallback, useMemo } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import useProjects from '../hooks/useProjects';
import useHubData from '../hooks/useHubData';
import useDurableTasks from '../hooks/useDurableTasks';
import TodayBrief from '../components/TodayBrief';
import AttentionQueue from '../components/AttentionQueue';
import ProjectGrid from '../components/ProjectGrid';
import HubHealthPanel from '../components/HubHealthPanel';

const PROJECT_ATTENTION_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

function projectAttentionStatus(project) {
  const status = project?.pipelineState?.status;
  return PROJECT_ATTENTION_STATUSES.has(status) ? status : null;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const diagnostics = searchParams.get('diagnostics') === '1' || searchParams.get('includeTest') === '1';
  const activeTab = searchParams.get('tab') || 'overview';

  const setActiveTab = useCallback((newTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const { projects, loading } = useProjects(diagnostics);
  const {
    hubStatus, hubProjects, hubAcp, knowledgePolicy,
    queueStatus, queueEntries, hubDispatches, observability,
    taskLedger,
  } = useHubData(diagnostics);
  const { durableTasks } = useDurableTasks();

  // Pre-compute health tab data (hooks must be before any early return)
  const recentDispatchesPre = useMemo(() =>
    (hubDispatches || [])
      .filter((d) => d.status && d.status !== 'pending')
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
      .slice(0, 5),
    [hubDispatches]
  );

  const dispatchSummaryRows = useMemo(() =>
    recentDispatchesPre.map(d => ({
      project: d.projectId,
      status: d.status,
      time: d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : '-',
    })),
    [recentDispatchesPre]
  );

  const durableJobsSummary = useMemo(() => {
    const counts = { running: 0, completed: 0, failed: 0 };
    (durableTasks || []).forEach(j => {
      if (counts[j.status] !== undefined) counts[j.status]++;
    });
    return counts;
  }, [durableTasks]);

  if (loading) return <div className="loading">Loading projects...</div>;

  // Merge legacy project data into hub projects
  const legacyByName = new Map(projects.map((p) => [p.name, p]));
  const primaryProjects = hubProjects.map((hp) => {
    const legacy = legacyByName.get(hp.id) || legacyByName.get(hp.name);
    return { ...hp, ...(legacy || {}) };
  });
  const hubIds = new Set(hubProjects.map((p) => p.id));
  const secondaryProjects = projects.filter((p) => !hubIds.has(p.name) && !hubIds.has(p.id));

  const workerAgeById = new Map(
    (observability?.workers?.details || []).map((w) => [w.id, w])
  );

  const allProjects = [...primaryProjects, ...secondaryProjects];
  const activeTasksCount = (taskLedger?.tasks || []).filter(t => t.status === 'running' || t.progress?.stage === 'running').length;
  const failedRunsCount = (observability?.dispatchSummary?.failed || 0) + (queueStatus?.failed || 0);
  const blockedProjectsCount = allProjects.filter(projectAttentionStatus).length;
  const completedRunsCount = observability?.dispatchSummary?.completed || 0;

  // Attention items — capped at 3, no show-all toggle
  const attentionItems = [];
  allProjects.forEach(p => {
    const status = projectAttentionStatus(p);
    if (status) {
      attentionItems.push({
        id: `proj-${p.id || p.name}`,
        project: p.name || p.id,
        reason: p.pipelineState?.error || `Pipeline status is ${status}`,
        impact: 'Downstream deployments and testing are on hold.',
        action: status === 'failed' ? 'Retry Pipeline' : 'Review Project',
        link: `/project/${p.name || p.id}?tab=overview`
      });
    }
  });
  durableTasks.forEach(job => {
    if (job.status === 'failed') {
      attentionItems.push({
        id: `job-${job.jobId}`,
        project: job.project,
        reason: `Durable job failed in phase: ${job.phase}`,
        impact: 'Workspace lock remains active. Task is incomplete.',
        action: 'View Job Logs',
        link: `/project/${job.project}?tab=overview`
      });
    }
  });
  const cappedAttentionItems = attentionItems.slice(0, 3);

  return (
    <div className="dashboard animate-fade-in">
      <div className="dashboard-header">
        <h2>Dashboard</h2>
        <Link to="/new-task" className="btn btn-primary">+ New Task</Link>
      </div>

      <div className="view-tabs" role="tablist">
        <button
          id="tab-overview"
          className={`view-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
          role="tab"
          aria-selected={activeTab === 'overview'}
          aria-controls="panel-overview"
          type="button"
        >
          Overview
        </button>
        <button
          id="tab-health"
          className={`view-tab ${activeTab === 'health' ? 'active' : ''}`}
          onClick={() => setActiveTab('health')}
          role="tab"
          aria-selected={activeTab === 'health'}
          aria-controls="panel-health"
          type="button"
        >
          System Health
        </button>
      </div>

      {/* OVERVIEW TAB */}
      <div
        id="panel-overview"
        className={activeTab === 'overview' ? '' : 'hidden'}
        role="tabpanel"
        aria-labelledby="tab-overview"
      >
        <TodayBrief
          activeTasks={activeTasksCount}
          failedRuns={failedRunsCount}
          blockedProjects={blockedProjectsCount}
          completedRuns={completedRunsCount}
        />
        <AttentionQueue items={cappedAttentionItems} onNavigate={(link) => navigate(link)} />
        <ProjectGrid
          primaryProjects={primaryProjects}
          secondaryProjects={secondaryProjects}
          diagnostics={diagnostics}
          workerAgeById={workerAgeById}
        />
      </div>

      {/* HEALTH TAB */}
      <div
        id="panel-health"
        className={activeTab === 'health' ? '' : 'hidden'}
        role="tabpanel"
        aria-labelledby="tab-health"
      >
        <HubHealthPanel
          hubStatus={hubStatus}
          hubProjects={hubProjects}
          hubAcp={hubAcp}
          knowledgePolicy={knowledgePolicy}
          observability={observability}
          projects={projects}
          queueStatus={queueStatus}
          queueEntries={queueEntries}
        />

        {dispatchSummaryRows.length > 0 && (
          <section className="panel mt-24" aria-label="Recent runs summary">
            <h4>Recent Runs</h4>
            <div className="health-summary-list">
              {dispatchSummaryRows.map((d, i) => (
                <div key={i} className="health-summary-row">
                  <span className="health-summary-project">{d.project}</span>
                  <span className={`badge badge-${d.status}`}>{d.status}</span>
                  <span className="health-summary-time">{d.time}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {durableTasks.length > 0 && (
          <section className="panel mt-24" aria-label="Durable jobs summary">
            <h4>Durable Jobs</h4>
            <p className="muted">
              {durableJobsSummary.running > 0 && <>{durableJobsSummary.running} running</>}
              {durableJobsSummary.running > 0 && durableJobsSummary.completed > 0 && <> · </>}
              {durableJobsSummary.completed > 0 && <>{durableJobsSummary.completed} completed</>}
              {(durableJobsSummary.running > 0 || durableJobsSummary.completed > 0) && durableJobsSummary.failed > 0 && <> · </>}
              {durableJobsSummary.failed > 0 && <>{durableJobsSummary.failed} failed</>}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
