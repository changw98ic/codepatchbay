import React from 'react';

function UserBubble({ intent }) {
  return (
    <div className="chat-bubble user-bubble">
      <div className="bubble-label">User Intent</div>
      <div className="bubble-content">{intent}</div>
    </div>
  );
}

function ResearchBubble({ research }) {
  if (!research || (!research.codex && !research.claude)) return null;
  return (
    <div className="chat-bubble system-bubble">
      <div className="bubble-label">Research</div>
      <div className="research-columns">
        {research.codex && (
          <details className="research-panel" open>
            <summary>Codex Analysis</summary>
            <pre>{research.codex}</pre>
          </details>
        )}
        {research.claude && (
          <details className="research-panel" open>
            <summary>Claude Analysis</summary>
            <pre>{research.claude}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function PlanBubble({ plan }) {
  if (!plan) return null;
  return (
    <div className="chat-bubble system-bubble">
      <div className="bubble-label">Implementation Plan</div>
      <details open>
        <summary>Plan details</summary>
        <pre className="plan-content">{plan}</pre>
      </details>
    </div>
  );
}

function severityClass(sev) {
  if (sev >= 2) return 'sev-high';
  return 'sev-low';
}

function ReviewBubble({ reviews }) {
  if (!reviews || reviews.length === 0) return null;
  return (
    <div className="review-rounds">
      {reviews.map((r) => (
        <div key={r.round} className="chat-bubble system-bubble review-round">
          <div className="bubble-label">Review Round {r.round}</div>
          <div className="review-panels">
            <div className="review-panel">
              <div className="reviewer-name">Codex</div>
              <pre className="review-text">{r.codex}</pre>
              {r.codexIssues && r.codexIssues.length > 0 && (
                <div className="issue-list">
                  {r.codexIssues.map((iss, i) => (
                    <span key={i} className={`issue-badge ${severityClass(iss.severity)}`}>
                      P{iss.severity}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="review-panel">
              <div className="reviewer-name">Claude</div>
              <pre className="review-text">{r.claude}</pre>
              {r.claudeIssues && r.claudeIssues.length > 0 && (
                <div className="issue-list">
                  {r.claudeIssues.map((iss, i) => (
                    <span key={i} className={`issue-badge ${severityClass(iss.severity)}`}>
                      P{iss.severity}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionBubble({ status, onApprove, onReject }) {
  if (status !== 'user_review') return null;
  return (
    <div className="chat-bubble action-bubble">
      <div className="bubble-label">Awaiting Your Decision</div>
      <div className="action-buttons">
        <button className="btn btn-approve" onClick={onApprove}>Approve & Dispatch</button>
        <button className="btn btn-reject" onClick={onReject}>Reject</button>
      </div>
    </div>
  );
}

function StatusBubble({ status, round }) {
  const labels = {
    idle: 'Waiting to start...',
    researching: 'Researching (Codex + Claude)...',
    planning: 'Generating plan...',
    reviewing: `Reviewing (round ${round || '?'})...`,
    revising: 'Revising plan based on feedback...',
    dispatched: 'Pipeline dispatched!',
    expired: 'Session expired (review did not converge)',
  };
  const label = labels[status];
  if (!label) return null;
  return (
    <div className={`chat-bubble status-bubble ${status === 'expired' ? 'expired' : ''}`}>
      {label}
    </div>
  );
}

export default function ReviewChat({ session, onApprove, onReject }) {
  if (!session) return null;
  return (
    <div className="review-chat">
      <UserBubble intent={session.intent} />
      <StatusBubble status={session.status} round={session.round} />
      <ResearchBubble research={session.research} />
      <PlanBubble plan={session.plan} />
      <ReviewBubble reviews={session.reviews} />
      <ActionBubble status={session.status} onApprove={onApprove} onReject={onReject} />
    </div>
  );
}
