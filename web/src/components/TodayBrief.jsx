import React from 'react';

export default function TodayBrief({ activeTasks, failedRuns, blockedProjects, completedRuns }) {
  return (
    <section className="today-brief-hero">
      <div className="today-brief-header">
        <h3>Today's Brief</h3>
        <span className="badge badge-date">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        </span>
      </div>
      <p className="today-brief-summary">
        Welcome back! You have <strong className="text-accent">{activeTasks} active tasks</strong> running.
        {' '}{failedRuns > 0 ? (
          <span>There are <strong className="text-error">{failedRuns} failed runs</strong> that require your attention.</span>
        ) : (
          <span>All system runs are passing cleanly.</span>
        )}
        {' '}{blockedProjects > 0 && (
          <span>Currently, <strong className="text-warning">{blockedProjects} projects</strong> are in a blocked state.</span>
        )}
      </p>
      <div className="today-brief-grid">
        <div className="brief-card">
          <span className={`value ${activeTasks > 0 ? 'active' : ''}`}>{activeTasks}</span>
          <span className="label">Active Tasks</span>
        </div>
        <div className="brief-card">
          <span className={`value ${failedRuns > 0 ? 'alert' : ''}`}>{failedRuns}</span>
          <span className="label">Failed Runs</span>
        </div>
        <div className="brief-card">
          <span className={`value ${blockedProjects > 0 ? 'warning' : ''}`}>{blockedProjects}</span>
          <span className="label">Blocked Projects</span>
        </div>
        <div className="brief-card">
          <span className="value success">{completedRuns}</span>
          <span className="label">Completed Runs</span>
        </div>
      </div>
    </section>
  );
}
