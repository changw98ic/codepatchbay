import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import ReviewChat from '../components/ReviewChat';
import { reviewBadgeClass } from '../utils/badge';
import useCappedList from '../hooks/useCappedList';

export default function Review() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [form, setForm] = useState({ project: '', intent: '' });
  const [projects, setProjects] = useState([]);
  const [evolveStatus, setEvolveStatus] = useState(null);
  const [evolveHistory, setEvolveHistory] = useState([]);
  const [sessionQuery, setSessionQuery] = useState('');
  const { subscribe } = useWebSocket();
  const terminalStatuses = new Set(['expired', 'cancelled', 'completed']);

  const filteredSessions = useMemo(() =>
    sessions.filter(s =>
      s.sessionId.toLowerCase().includes(sessionQuery.toLowerCase()) ||
      s.status.toLowerCase().includes(sessionQuery.toLowerCase())
    ), [sessions, sessionQuery]
  );

  const { displayed: displaySessions, showAll: showAllSessions, toggle: toggleSessions, hasMore: hasMoreSessions } = useCappedList(filteredSessions, {
    cap: 5,
    selectedKey: activeId,
    keyFn: (s) => s.sessionId,
    deps: [sessionQuery],
  });

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => setProjects(data.map((p) => p.name)))
      .catch(() => {});
  }, []);

  const loadSessions = useCallback(() => {
    return fetch('/api/review')
      .then((r) => r.json())
      .then((data) => {
        setSessions(data);
        if (activeId) {
          const cur = data.find((s) => s.sessionId === activeId);
          if (cur) setActiveSession(cur);
        }
      })
      .catch(() => {});
  }, [activeId]);

  const loadActiveSession = useCallback((id = activeId) => {
    if (!id) return Promise.resolve();
    return fetch(`/api/review/${id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setActiveSession(data);
      })
      .catch(() => {});
  }, [activeId]);

  const loadEvolve = useCallback(() => {
    Promise.all([
      fetch('/api/evolve/status'),
      fetch('/api/evolve/history'),
    ])
      .then(async ([statusRes, historyRes]) => {
        if (statusRes.ok) setEvolveStatus(await statusRes.json());
        if (historyRes.ok) setEvolveHistory(await historyRes.json());
      })
      .catch(() => {});
  }, []);

  const startEvolve = async () => {
    await fetch('/api/evolve/start', { method: 'POST' });
    await loadEvolve();
  };

  const stopEvolve = async () => {
    await fetch('/api/evolve/stop', { method: 'POST' });
    await loadEvolve();
  };

  const isEvolveRunning = !!evolveStatus?.running;
  const evolveStatusLabel = isEvolveRunning ? 'running' : 'stopped';
  const evolveProjectCount = Array.isArray(evolveStatus?.projects) ? evolveStatus.projects.length : 0;

  useEffect(() => {
    loadSessions();
    loadEvolve();
    const timer = setInterval(loadEvolve, 5000);
    return () => clearInterval(timer);
  }, [loadSessions, loadEvolve]);

  useEffect(() => {
    const unsub = subscribe('review:update', () => {
      loadSessions();
    });
    return unsub;
  }, [subscribe, activeId, loadSessions]);

  const selectSession = async (id) => {
    setActiveId(id);
    await loadActiveSession(id);
  };

  const createSession = async (e) => {
    e.preventDefault();
    if (!form.project || !form.intent.trim()) return;
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: form.project, intent: form.intent.trim() }),
    });
    if (res.ok) {
      const session = await res.json();
      setActiveId(session.sessionId);
      setActiveSession(session);
      setForm({ project: '', intent: '' });
      loadSessions();
    }
  };

  const startReview = async () => {
    if (!activeId) return;
    await fetch(`/api/review/${activeId}/start`, { method: 'POST' });
    loadSessions();
  };

  const runReviewAction = async (action) => {
    if (!activeId) return;
    await fetch(`/api/review/${activeId}/${action}`, { method: 'POST' });
    await loadSessions();
    await loadActiveSession(activeId);
  };

  const approve = async () => {
    if (!activeId) return;
    await fetch(`/api/review/${activeId}/approve`, { method: 'POST' });
    loadSessions();
  };

  const reject = async () => {
    if (!activeId) return;
    await fetch(`/api/review/${activeId}/reject`, { method: 'POST' });
    loadSessions();
  };

  const canAcceptChanges = activeSession?.status === 'dispatched';
  const canAutoApprove = activeSession && ['user_review', 'dispatched'].includes(activeSession.status);
  const canCancel = activeSession && !terminalStatuses.has(activeSession.status);

  return (
    <div className="review-page">
      <div className="review-sidebar">
        <form className="review-form" onSubmit={createSession}>
          <h3>New Review</h3>
          <div className="form-group">
            <label>Project</label>
            <select
              value={form.project}
              onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Intent</label>
            <textarea
              rows={3}
              placeholder="Describe what you want to accomplish..."
              value={form.intent}
              onChange={(e) => setForm((f) => ({ ...f, intent: e.target.value }))}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={!form.project || !form.intent.trim()}>
            Create Session
          </button>
        </form>

        <div className="session-list">
          <h3>Self-Evolve</h3>
          {evolveStatus ? (
            <>
              <div className="evolve-status">Status: {evolveStatusLabel}</div>
              <div className="evolve-status">PID: {evolveStatus?.pid || 'n/a'}</div>
              <div className="evolve-status">Projects: {evolveProjectCount}</div>
              <div className="action-buttons">
                <button className="btn btn-primary" onClick={startEvolve} disabled={isEvolveRunning}>Start</button>
                <button className="btn btn-reject" onClick={stopEvolve} disabled={!isEvolveRunning}>Stop</button>
              </div>
            </>
          ) : (
            <div className="empty">Self-Evolve status unavailable</div>
          )}
        </div>

        <div className="session-list">
          <h3>Self-Evolve History</h3>
          {evolveHistory.length > 0 ? (
            evolveHistory.slice(-5).reverse().map((entry) => (
              <div key={`${entry.timestamp}-${entry.round}-${entry.action}`} className="session-item">
                <span className="session-id">{entry.action}</span>
                <span className="session-id">{entry.result}</span>
              </div>
            ))
          ) : (
            <div className="empty">No history yet</div>
          )}
        </div>

        <div className="session-list">
          <div className="session-list-header">
            <h3>Sessions</h3>
            <span className="session-list-count">{sessions.length} total</span>
          </div>

          <div className="session-search-wrapper">
            <input
              type="text"
              placeholder="Search sessions..."
              value={sessionQuery}
              onChange={(e) => setSessionQuery(e.target.value)}
              className="session-search-input"
            />
            {sessionQuery && (
              <button
                onClick={() => setSessionQuery('')}
                className="session-search-clear"
                type="button"
              >
                ✕
              </button>
            )}
          </div>

          <div className="session-list-body">
            {filteredSessions.length === 0 ? (
              <div className="empty">No sessions found</div>
            ) : (
              <>
                {displaySessions.map((s) => (
                  <button
                    key={s.sessionId}
                    className={`session-item ${s.sessionId === activeId ? 'active' : ''}`}
                    onClick={() => selectSession(s.sessionId)}
                    type="button"
                  >
                    <span className="session-id">{s.sessionId.slice(-8)}</span>
                    <span className={`badge badge-${reviewBadgeClass(s.status)}`}>{s.status}</span>
                  </button>
                ))}
                {hasMoreSessions && (
                  <div className="show-more-container">
                    <button
                      className="show-more-btn show-more-btn-full"
                      onClick={toggleSessions}
                      type="button"
                    >
                      {showAllSessions ? '▲ Show Less' : `▼ Show All (${filteredSessions.length})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="review-main">
        {activeSession ? (
          <>
            <div className="review-header">
              <h2>{activeSession.sessionId}</h2>
              <span className={`badge badge-${reviewBadgeClass(activeSession.status)}`}>
                {activeSession.status}
              </span>
              <div className="action-buttons">
                {activeSession.status === 'idle' && (
                  <button className="btn btn-primary" onClick={startReview}>
                    Start Review
                  </button>
                )}
                {canAcceptChanges && (
                  <button className="btn btn-primary" onClick={() => runReviewAction('accept')}>
                    Accept Changes
                  </button>
                )}
                {canAutoApprove && (
                  <button className="btn btn-secondary" onClick={() => runReviewAction('auto-approve')}>
                    Auto-Approve
                  </button>
                )}
                {canCancel && (
                  <button className="btn btn-reject" onClick={() => runReviewAction('cancel')}>
                    Cancel Session
                  </button>
                )}
              </div>
            </div>
            <ReviewChat
              session={activeSession}
              onApprove={approve}
              onReject={reject}
            />
          </>
        ) : (
          <div className="empty">Create or select a review session</div>
        )}
      </div>
    </div>
  );
}
