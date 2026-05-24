import React, { useState, useCallback } from 'react';
import useCappedList from '../hooks/useCappedList';

function formatTimestamp(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const s = d.toISOString();
    return s.slice(0, 10) + ' ' + s.slice(11, 16) + ' UTC';
  } catch {
    return null;
  }
}

export default function TaskLedger({ taskLedger, selectedTaskId, onSelectedTaskIdChange }) {
  const [taskSearch, setTaskSearch] = useState('');
  const [taskStatusFilter, setTaskStatusFilter] = useState('all');
  const [taskProjFilter, setTaskProjFilter] = useState('all');

  const ledgerTasks = taskLedger?.tasks || [];

  const filteredTasks = ledgerTasks.filter((task) => {
    if (taskSearch) {
      const q = taskSearch.toLowerCase();
      const fields = [task.title, task.human?.summary, task.human?.description, task.id]
        .map((v) => (v || '').toLowerCase());
      if (!fields.some((f) => f.includes(q))) return false;
    }
    if (taskStatusFilter !== 'all') {
      const status = task.status;
      const stage = task.progress?.stage;
      if (taskStatusFilter === 'running' && status !== 'running' && stage !== 'running') return false;
      if (taskStatusFilter === 'ready' && status !== 'ready' && stage !== 'ready') return false;
      if (taskStatusFilter === 'failed' && status !== 'failed' && stage !== 'failed') return false;
      if (taskStatusFilter === 'open' && status !== 'open' && stage !== 'open') return false;
      if (taskStatusFilter === 'archived' && status !== 'archived' && stage !== 'archived') return false;
    }
    if (taskProjFilter !== 'all' && task.projectId !== taskProjFilter) return false;
    return true;
  });

  const selectedTask = filteredTasks.find((t) => t.id === selectedTaskId) || filteredTasks[0] || null;
  const ledgerProjects = Array.from(new Set(ledgerTasks.map((t) => t.projectId).filter(Boolean)));

  const { displayed, showAll, toggle, hasMore } = useCappedList(filteredTasks, {
    cap: 5,
    selectedKey: selectedTask?.id,
    keyFn: (t) => t.id,
  });

  const resetFilters = useCallback(() => {
    setTaskSearch('');
    setTaskStatusFilter('all');
    setTaskProjFilter('all');
  }, []);

  if (ledgerTasks.length === 0) return null;

  return (
    <section className="task-ledger panel" aria-label="Task ledger">
      <div className="section-header">
        <h2>Task Ledger</h2>
        <p className="muted">
          {taskLedger.summary?.total || ledgerTasks.length} total
          {taskLedger.summary?.visible != null && (
            <span> · {taskLedger.summary.visible} shown</span>
          )}
        </p>
      </div>
      <div className="task-ledger-summary">
        {taskLedger.summary?.ready > 0 && <em>{taskLedger.summary.ready} ready</em>}
        {taskLedger.summary?.running > 0 && <em>{taskLedger.summary.running} running</em>}
        {taskLedger.summary?.open > 0 && <em>{taskLedger.summary.open} source-only</em>}
        {taskLedger.summary?.failed > 0 && <strong>{taskLedger.summary.failed} failed</strong>}
        {taskLedger.summary?.archived > 0 && <span>{taskLedger.summary.archived} archived</span>}
      </div>

      <div className="dashboard-filter-bar" aria-label="Task ledger filters" style={{ marginTop: '16px' }}>
        <div className="filter-search-wrapper">
          <span className="filter-search-icon">🔍</span>
          <input
            type="text"
            className="filter-search-input"
            placeholder="Search tasks by title, ID, desc..."
            value={taskSearch}
            onChange={(e) => setTaskSearch(e.target.value)}
          />
        </div>
        <div className="filter-pills">
          <span className="filter-label">Status:</span>
          {['all', 'running', 'ready', 'failed', 'open', 'archived'].map((status) => (
            <button
              key={status}
              className={`filter-pill ${taskStatusFilter === status ? 'active' : ''}`}
              onClick={() => setTaskStatusFilter(status)}
              type="button"
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
        {ledgerProjects.length > 0 && (
          <div className="filter-pills">
            <span className="filter-label">Project:</span>
            <select
              className="filter-select"
              value={taskProjFilter}
              onChange={(e) => setTaskProjFilter(e.target.value)}
            >
              <option value="all">All Projects</option>
              {ledgerProjects.map((pId) => (
                <option key={pId} value={pId}>{pId}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="task-ledger-layout">
        {filteredTasks.length === 0 ? (
          <div className="empty-state" style={{ width: '100%', padding: '40px', textAlign: 'center' }}>
            <p>No tasks match your filter criteria.</p>
            <button className="btn btn-secondary" onClick={resetFilters} style={{ marginTop: '12px' }}>
              Reset Task Filters
            </button>
          </div>
        ) : (
          <>
            <div className="task-ledger-list">
              {displayed.map((task) => {
                const source = task.source || {};
                const statusClass = String(task.progress?.stage || task.status || 'unknown').replace(/[^a-z0-9_-]/gi, '-');
                const active = selectedTask?.id === task.id;
                return (
                  <button
                    className={`ledger-row ${active ? 'active' : ''}`}
                    key={task.id}
                    type="button"
                    onClick={() => onSelectedTaskIdChange(task.id)}
                  >
                    <span className={`ledger-progress-dot progress-${statusClass}`} />
                    <span className="ledger-main">
                      <span className="ledger-title">{task.title}</span>
                      <span className="ledger-meta">
                        {task.progress?.label || task.status}
                        {task.projectId && <span> · {task.projectId}</span>}
                        {task.priority && <span> · {task.priority}</span>}
                      </span>
                    </span>
                    <span className="ledger-source">{source.label || source.kind || 'source'}</span>
                    <span className="ledger-updated">
                      {formatTimestamp(task.updatedAt || task.createdAt) && (
                        <time dateTime={task.updatedAt || task.createdAt}>
                          {formatTimestamp(task.updatedAt || task.createdAt)}
                        </time>
                      )}
                    </span>
                  </button>
                );
              })}
              {hasMore && (
                <div className="show-more-container" style={{ width: '100%' }}>
                  <button className="show-more-btn" onClick={toggle} style={{ width: '100%', justifyContent: 'center' }} type="button">
                    {showAll ? 'Show Less' : `+ ${filteredTasks.length - 5} more tasks (Show All)`}
                  </button>
                </div>
              )}
            </div>
            {selectedTask && (
              <div className="task-detail" aria-label="Task detail">
                <div className="task-detail-header">
                  <div>
                    <div className="section-eyebrow">{selectedTask.source?.label || 'Task source'}</div>
                    <h3>{selectedTask.title}</h3>
                  </div>
                  <span className={`badge badge-${String(selectedTask.progress?.stage || selectedTask.status).replace(/[^a-z0-9_-]/gi, '-')}`}>
                    {selectedTask.progress?.label || selectedTask.status}
                  </span>
                </div>
                <div className="task-progress-bar" aria-label="Task progress">
                  <span style={{ width: `${selectedTask.progress?.percent ?? 0}%` }} />
                </div>
                <div className="task-detail-grid">
                  <section className="task-view">
                    <h4>Human View</h4>
                    <p>{selectedTask.human?.summary}</p>
                    <dl>
                      <dt>Progress</dt>
                      <dd>{selectedTask.human?.progress}</dd>
                      <dt>Source</dt>
                      <dd>
                        {selectedTask.source?.url ? (
                          <a href={selectedTask.source.url} target="_blank" rel="noreferrer">{selectedTask.human?.source}</a>
                        ) : selectedTask.human?.source}
                      </dd>
                      <dt>Next</dt>
                      <dd>{selectedTask.human?.nextAction}</dd>
                    </dl>
                  </section>
                  <section className="task-view agent-view">
                    <h4>Agent View</h4>
                    <pre>{JSON.stringify(selectedTask.agent, null, 2)}</pre>
                  </section>
                  {selectedTask.agent?.execution && (
                    <section className="task-view execution-detail" aria-label="Execution detail">
                      <h4>Execution Detail</h4>
                      <dl>
                        {selectedTask.agent.execution.workerId && (
                          <><dt>Worker</dt><dd>{selectedTask.agent.execution.workerId}</dd></>
                        )}
                        {selectedTask.agent.execution.jobId && (
                          <><dt>Job</dt><dd>{selectedTask.agent.execution.jobId}</dd></>
                        )}
                        {selectedTask.agent.execution.dispatchId && (
                          <><dt>Dispatch</dt><dd>{selectedTask.agent.execution.dispatchId}</dd></>
                        )}
                        {selectedTask.agent.execution.queueEntryId && (
                          <><dt>Queue Entry</dt><dd>{selectedTask.agent.execution.queueEntryId}</dd></>
                        )}
                        {selectedTask.agent.execution.executor && (
                          <><dt>Executor</dt><dd>{typeof selectedTask.agent.execution.executor === 'string' ? selectedTask.agent.execution.executor : JSON.stringify(selectedTask.agent.execution.executor)}</dd></>
                        )}
                        {selectedTask.agent.execution.releaseSnapshot && Object.entries(selectedTask.agent.execution.releaseSnapshot).map(([key, value]) => (
                          <React.Fragment key={`release-${key}`}>
                            <dt>{`Release ${key}`}</dt>
                            <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                          </React.Fragment>
                        ))}
                        {selectedTask.agent.execution.indexSnapshot && Object.entries(selectedTask.agent.execution.indexSnapshot).map(([key, value]) => (
                          <React.Fragment key={`index-${key}`}>
                            <dt>{`Index ${key}`}</dt>
                            <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    </section>
                  )}
                </div>
                {selectedTask.human?.description && (
                  <details className="task-description">
                    <summary>Full description</summary>
                    <p>{selectedTask.human.description}</p>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
