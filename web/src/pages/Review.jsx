import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { reviewBadgeClass } from '../utils/badge';

const STATUS_GROUPS = [
  { name: 'Needs Action', statuses: ['user_review', 'merge_failed'] },
  { name: 'In Progress', statuses: ['researching', 'planning', 'reviewing', 'revising'] },
  { name: 'Queued', statuses: ['idle'] },
  { name: 'Done', statuses: ['completed', 'dispatched', 'expired', 'cancelled'] },
];

const TERMINAL = new Set(['expired', 'cancelled', 'completed']);
const CAN_APPROVE = new Set(['user_review']);
const CAN_START = new Set(['idle']);
const CAN_CANCEL = (s) => !TERMINAL.has(s) && s !== 'dispatched';

function groupLabel(count, name) {
  return `${name} (${count})`;
}

const PAGE_SIZE = 10;

export default function Review() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const { subscribe } = useWebSocket();

  const filteredSessions = useMemo(() =>
    sessions.filter(s =>
      s.sessionId.toLowerCase().includes(query.toLowerCase()) ||
      s.status.toLowerCase().includes(query.toLowerCase()) ||
      (s.project || '').toLowerCase().includes(query.toLowerCase()) ||
      (s.intent || '').toLowerCase().includes(query.toLowerCase())
    ), [sessions, query]
  );

  const totalPages = Math.ceil(filteredSessions.length / PAGE_SIZE);

  const pagedGroups = useMemo(() => {
    const pagedSessions = filteredSessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return STATUS_GROUPS.map(g => ({
      ...g,
      items: pagedSessions.filter(s => g.statuses.includes(s.status)),
    })).filter(g => g.items.length > 0);
  }, [filteredSessions, page]);

  useEffect(() => { setPage(1); }, [query]);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(1, totalPages)));
  }, [totalPages]);


  const loadSessions = useCallback(() => {
    fetch('/api/review')
      .then((r) => r.json())
      .then((data) => {
        setSessions(data);
        if (selectedId) {
          const cur = data.find(s => s.sessionId === selectedId);
          if (cur) setSelectedSession(cur);
        }
      })
      .catch(() => {});
  }, [selectedId]);

  const loadDetail = useCallback((id) => {
    if (!id) return;
    fetch(`/api/review/${id}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setSelectedSession(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 10000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  useEffect(() => {
    const unsub = subscribe('review:update', () => loadSessions());
    return unsub;
  }, [subscribe, loadSessions]);

  const selectSession = (id) => {
    if (selectedId === id) {
      setSelectedId(null);
      setSelectedSession(null);
      setAnalysis(null);
      return;
    }
    setSelectedId(id);
    loadDetail(id);
    setAnalysis(null);
  };

  const startReview = async (id) => {
    await fetch(`/api/review/${id}/start`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const approve = async (id) => {
    await fetch(`/api/review/${id}/approve`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const reject = async (id) => {
    await fetch(`/api/review/${id}/reject`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const accept = async (id) => {
    await fetch(`/api/review/${id}/accept`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const cancel = async (id) => {
    await fetch(`/api/review/${id}/cancel`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const autoApprove = async (id) => {
    await fetch(`/api/review/${id}/auto-approve`, { method: 'POST' });
    loadSessions();
    loadDetail(id);
  };

  const runAnalysis = async () => {
    if (!selectedId) return;
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const res = await fetch(`/api/review/${selectedId}/analyze`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data);
      } else {
        const err = await res.json().catch(() => ({}));
        setAnalysis({ error: err.message || 'Analysis failed' });
      }
    } catch (e) {
      setAnalysis({ error: e.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const s = selectedSession;

  return (
    <div className="review-inbox">
      <div className="review-inbox-header">
        <h2>Review Inbox</h2>
        <div className="review-inbox-toolbar">
          <input
            type="text"
            placeholder="Search sessions..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); }}
            className="review-search-input"
          />
        </div>
      </div>

      {pagedGroups.length === 0 && (
        <div className="empty" style={{ margin: '40px 0' }}>No review sessions</div>
      )}

      {pagedGroups.map(group => (
        <div key={group.name} className="review-group">
          <h3 className="review-group-title">{groupLabel(group.items.length, group.name)}</h3>
          <div className="review-group-list">
            {group.items.map(session => (
              <div
                key={session.sessionId}
                className={`review-card ${session.sessionId === selectedId ? 'active' : ''}`}
                onClick={() => selectSession(session.sessionId)}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectSession(session.sessionId); }}
              >
                <div className="review-card-top">
                  <span className="review-card-project">{session.project || '—'}</span>
                  <span className={`badge badge-${reviewBadgeClass(session.status)}`}>{session.status}</span>
                </div>
                <div className="review-card-intent">{session.intent || '—'}</div>
                <div className="review-card-meta">
                  <span>{session.sessionId.slice(-8)}</span>
                  <span>{session.updatedAt ? new Date(session.updatedAt).toLocaleString() : ''}</span>
                </div>
                <div className="review-card-actions">
                  {CAN_START.has(session.status) && (
                    <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); startReview(session.sessionId); }}>Start</button>
                  )}
                  {CAN_APPROVE.has(session.status) && (
                    <>
                      <button className="btn btn-sm btn-approve" onClick={(e) => { e.stopPropagation(); approve(session.sessionId); }}>Approve</button>
                      <button className="btn btn-sm btn-reject" onClick={(e) => { e.stopPropagation(); reject(session.sessionId); }}>Reject</button>
                    </>
                  )}
                  {session.status === 'dispatched' && (
                    <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); accept(session.sessionId); }}>Accept</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="pagination-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >&lt;</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              className={`pagination-btn ${p === page ? 'active' : ''}`}
              onClick={() => setPage(p)}
            >{p}</button>
          ))}
          <button
            className="pagination-btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          >&gt;</button>
        </div>
      )}

      {s && (
        <div className="review-detail panel mt-24 animate-fade-in">
          <div className="review-detail-header">
            <div>
              <h3>{s.project} — {s.intent}</h3>
              <div className="muted" style={{ marginBottom: 0 }}>
                {s.sessionId} · Created {new Date(s.createdAt).toLocaleString()}
                {s.updatedAt && ` · Updated ${new Date(s.updatedAt).toLocaleString()}`}
                {s.round > 0 && ` · Round ${s.round}`}
              </div>
            </div>
            <div className="review-detail-actions">
              {CAN_START.has(s.status) && (
                <button className="btn btn-primary" onClick={() => startReview(s.sessionId)}>Start Review</button>
              )}
              {CAN_APPROVE.has(s.status) && (
                <>
                  <button className="btn btn-approve" onClick={() => approve(s.sessionId)}>Approve</button>
                  <button className="btn btn-reject" onClick={() => reject(s.sessionId)}>Reject</button>
                </>
              )}
              {s.status === 'dispatched' && (
                <button className="btn btn-primary" onClick={() => accept(s.sessionId)}>Accept Changes</button>
              )}
              {['user_review', 'dispatched'].includes(s.status) && (
                <button className="btn btn-secondary" onClick={() => autoApprove(s.sessionId)}>Auto-Approve</button>
              )}
              {CAN_CANCEL(s.status) && (
                <button className="btn btn-reject" onClick={() => cancel(s.sessionId)}>Cancel</button>
              )}
              <span className={`badge badge-${reviewBadgeClass(s.status)}`}>{s.status}</span>
            </div>
          </div>

          {/* ACP Analysis */}
          {(CAN_APPROVE.has(s.status) || s.status === 'dispatched') && (
            <div className="review-analysis-section">
              <div className="review-analysis-header">
                <h4>ACP Analysis</h4>
                <button
                  className="btn btn-secondary"
                  onClick={runAnalysis}
                  disabled={analyzing}
                >
                  {analyzing ? 'Analyzing...' : 'Analyze for Approval'}
                </button>
              </div>
              {analysis && (
                <div className="review-analysis-result animate-fade-in">
                  {analysis.error ? (
                    <div className="review-analysis-error">{analysis.error}</div>
                  ) : (
                    <>
                      {analysis.summary && (
                        <div className="review-analysis-block">
                          <h5>Summary</h5>
                          <p>{analysis.summary}</p>
                        </div>
                      )}
                      {analysis.changes && analysis.changes.length > 0 && (
                        <div className="review-analysis-block">
                          <h5>Key Changes</h5>
                          <ul>{analysis.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                        </div>
                      )}
                      {analysis.risks && analysis.risks.length > 0 && (
                        <div className="review-analysis-block">
                          <h5>Risks & Concerns</h5>
                          <ul>{analysis.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        </div>
                      )}
                      {analysis.recommendation && (
                        <div className="review-analysis-block">
                          <h5>Recommendation</h5>
                          <p>{analysis.recommendation}</p>
                        </div>
                      )}
                      {analysis.raw && (
                        <details>
                          <summary>Raw Analysis</summary>
                          <pre className="review-analysis-raw">{analysis.raw}</pre>
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session Content */}
          <div className="review-detail-content">
            {s.research && (s.research.codex || s.research.claude) && (
              <details open className="review-detail-section">
                <summary>Research</summary>
                <div className="review-research-grid">
                  {s.research.codex && (
                    <div className="review-research-panel">
                      <h5>Codex Analysis</h5>
                      <pre>{s.research.codex}</pre>
                    </div>
                  )}
                  {s.research.claude && (
                    <div className="review-research-panel">
                      <h5>Claude Analysis</h5>
                      <pre>{s.research.claude}</pre>
                    </div>
                  )}
                </div>
              </details>
            )}

            {s.plan && (
              <details open className="review-detail-section">
                <summary>Implementation Plan</summary>
                <pre className="review-plan-content">{s.plan}</pre>
              </details>
            )}

            {s.reviews && s.reviews.length > 0 && (
              <details open className="review-detail-section">
                <summary>Reviews ({s.reviews.length} round{s.reviews.length > 1 ? 's' : ''})</summary>
                {s.reviews.map(r => (
                  <div key={r.round} className="review-round">
                    <h5>Round {r.round}</h5>
                    <div className="review-research-grid">
                      {r.codex && (
                        <div className="review-research-panel">
                          <div className="review-reviewer">Codex</div>
                          <pre>{r.codex}</pre>
                          {r.codexIssues && r.codexIssues.length > 0 && (
                            <div className="review-issues">
                              {r.codexIssues.map((iss, i) => (
                                <span key={i} className={`issue-badge ${iss.severity >= 2 ? 'sev-high' : 'sev-low'}`}>
                                  P{iss.severity}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {r.claude && (
                        <div className="review-research-panel">
                          <div className="review-reviewer">Claude</div>
                          <pre>{r.claude}</pre>
                          {r.claudeIssues && r.claudeIssues.length > 0 && (
                            <div className="review-issues">
                              {r.claudeIssues.map((iss, i) => (
                                <span key={i} className={`issue-badge ${iss.severity >= 2 ? 'sev-high' : 'sev-low'}`}>
                                  P{iss.severity}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </details>
            )}

            {!s.research && !s.plan && (!s.reviews || s.reviews.length === 0) && (
              <div className="muted" style={{ textAlign: 'center', padding: 24 }}>
                Session is in <strong>{s.status}</strong> state. Content will appear here as the review progresses.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
