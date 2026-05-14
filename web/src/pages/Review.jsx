import React, { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import ReviewChat from '../components/ReviewChat';

export default function Review() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [form, setForm] = useState({ project: '', intent: '' });
  const [projects, setProjects] = useState([]);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => setProjects(data.map((p) => p.name)))
      .catch(() => {});
  }, []);

  const loadSessions = useCallback(() => {
    fetch('/api/review')
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

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const unsub = subscribe('review:update', (msg) => {
      if (msg.sessionId === activeId) loadSessions();
      else loadSessions();
    });
    return unsub;
  }, [subscribe, activeId, loadSessions]);

  const selectSession = async (id) => {
    setActiveId(id);
    const res = await fetch(`/api/review/${id}`);
    if (res.ok) setActiveSession(await res.json());
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
          <h3>Sessions</h3>
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={`session-item ${s.sessionId === activeId ? 'active' : ''}`}
              onClick={() => selectSession(s.sessionId)}
            >
              <span className="session-id">{s.sessionId.slice(-8)}</span>
              <span className={`badge badge-${s.status === 'user_review' ? 'running' : s.status === 'dispatched' ? 'completed' : s.status === 'expired' ? 'failed' : 'idle'}`}>{s.status}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className="empty">No sessions</div>}
        </div>
      </div>

      <div className="review-main">
        {activeSession ? (
          <>
            <div className="review-header">
              <h2>{activeSession.sessionId}</h2>
              <span className={`badge badge-${activeSession.status === 'user_review' ? 'running' : activeSession.status === 'dispatched' ? 'completed' : activeSession.status === 'expired' ? 'failed' : 'idle'}`}>
                {activeSession.status}
              </span>
              {activeSession.status === 'idle' && (
                <button className="btn btn-primary" onClick={startReview}>
                  Start Review
                </button>
              )}
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
