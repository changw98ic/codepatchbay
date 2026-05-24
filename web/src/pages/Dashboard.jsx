import React, { useCallback } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import useProjects from '../hooks/useProjects';
import useHubData from '../hooks/useHubData';
import useDurableTasks from '../hooks/useDurableTasks';
import TodayBrief from '../components/TodayBrief';
import AttentionQueue from '../components/AttentionQueue';
import ProjectGrid from '../components/ProjectGrid';
import HubHealthPanel from '../components/HubHealthPanel';
import RecentDispatches from '../components/RecentDispatches';
import DurableJobs from '../components/DurableJobs';
import TaskLedger from '../components/TaskLedger';

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const diagnostics = searchParams.get('diagnostics') === '1' || searchParams.get('includeTest') === '1';
  const selectedTaskId = searchParams.get('taskId') || null;
  const activeTab = searchParams.get('tab') || 'overview';

  const setSelectedTaskId = useCallback((idOrFn) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = next.get('taskId');
      const nextId = typeof idOrFn === 'function' ? idOrFn(current) : idOrFn;
      if (nextId) { next.set('taskId', nextId); } else { next.delete('taskId'); }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const handleInitialTask = useCallback((id) => {
    setSelectedTaskId((current) => current || id);
  }, [setSelectedTaskId]);

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
  } = useHubData(diagnostics, handleInitialTask);
  const { durableTasks } = useDurableTasks();

  if (loading) return <div className="loading">Loading projects...</div>;

  // Merge legacy project data into hub projects
  const legacyByName = new Map(projects.map((p) => [p.name, p]));
  const primaryProjects = hubProjects.map((hp) => {
    const legacy = legacyByName.get(hp.id) || legacyByName.get(hp.name);
    return { ...hp, ...(legacy || {}) };
  });
  const hubIds = new Set(hubProjects.map((p) => p.id));
  const secondaryProjects = projects.filter((p) => !hubIds.has(p.name));

  const workerAgeById = new Map(
    (observability?.workers?.details || []).map((w) => [w.id, w])
  );

  const recentDispatches = hubDispatches
    .filter((d) => d.status && d.status !== 'pending')
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
    .slice(0, 10);

  const activeTasksCount = (taskLedger?.tasks || []).filter(t => t.status === 'running' || t.progress?.stage === 'running').length;
  const failedRunsCount = (observability?.dispatchSummary?.failed || 0) + (queueStatus?.failed || 0);
  const blockedProjectsCount = primaryProjects.filter(p => p.pipelineState?.status === 'failed').length + secondaryProjects.filter(p => p.pipelineState?.status === 'failed').length;
  const completedRunsCount = observability?.dispatchSummary?.completed || 0;

  // Attention items
  const attentionItems = [];
  primaryProjects.forEach(p => {
    if (p.pipelineState?.status === 'failed') {
      attentionItems.push({
        id: `proj-${p.id}`,
        project: p.name || p.id,
        reason: p.pipelineState?.error || 'Pipeline execution failed',
        impact: 'Downstream deployments and testing are on hold.',
        action: 'Retry Pipeline',
        link: `/project/${p.name || p.id}?tab=log`
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
        link: `/project/${job.project}?tab=log`
      });
    }
  });
  (taskLedger?.tasks || []).forEach(task => {
    if (task.status === 'failed' || task.progress?.stage === 'failed') {
      attentionItems.push({
        id: `task-${task.id}`,
        project: task.projectId || 'Global',
        reason: task.human?.summary || 'Task failed during agent execution',
        impact: 'Proposed fixes and branch commits were not written back.',
        action: 'Review Task',
        link: task.projectId ? `/project/${task.projectId}?tab=tasks` : `/?taskId=${task.id}`
      });
    }
  });

  return (
    <div className="dashboard animate-fade-in">
      <div className="dashboard-header">
        <h2>Dashboard</h2>
        <Link to="/new-task" className="btn btn-primary">+ New Task</Link>
      </div>

      <div className="view-tabs">
        <button
          className={`view-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`view-tab ${activeTab === 'health' ? 'active' : ''}`}
          onClick={() => setActiveTab('health')}
        >
          System Health
        </button>
      </div>

      {/* OVERVIEW TAB */}
      <div className={activeTab === 'overview' ? '' : 'hidden'}>
        <TodayBrief
          activeTasks={activeTasksCount}
          failedRuns={failedRunsCount}
          blockedProjects={blockedProjectsCount}
          completedRuns={completedRunsCount}
        />
        <AttentionQueue items={attentionItems} onNavigate={(link) => navigate(link)} />
        <ProjectGrid
          primaryProjects={primaryProjects}
          secondaryProjects={secondaryProjects}
          diagnostics={diagnostics}
          workerAgeById={workerAgeById}
        />
      </div>

      {/* HEALTH TAB */}
      <div className={activeTab === 'health' ? '' : 'hidden'}>
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
        <RecentDispatches dispatches={recentDispatches} />
        <DurableJobs tasks={durableTasks} />
      </div>

      {/* TASK LEDGER (visible in overview) */}
      <div className={activeTab === 'overview' ? '' : 'hidden'}>
        <TaskLedger
          taskLedger={taskLedger}
          selectedTaskId={selectedTaskId}
          onSelectedTaskIdChange={setSelectedTaskId}
        />
      </div>
    </div>
  );
}
