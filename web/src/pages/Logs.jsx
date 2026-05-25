import React, { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

const LOG_LEVELS = ['all', 'info', 'warn', 'error'];
const MAX_LINES = 500;

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const viewerRef = useRef(null);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    const unsub = subscribe('log:append', (event) => {
      const entry = {
        level: event.level || 'info',
        message: event.message || event.msg || '',
        source: event.source || '',
        timestamp: event.timestamp || Date.now(),
      };
      setLogs(prev => {
        const next = [...prev, entry];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return unsub;
  }, [subscribe]);

  useEffect(() => {
    if (!autoScroll || !viewerRef.current) return;
    viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [logs, autoScroll]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);

  return (
    <div className="page-container">
      <h2>System Logs</h2>
      <div className="muted">Real-time log stream from all agents and pipelines</div>
      <div className="logs-toolbar">
        <div className="logs-filter">
          {LOG_LEVELS.map(level => (
            <button
              key={level}
              className={`filter-pill ${filter === level ? 'active' : ''}`}
              onClick={() => setFilter(level)}
            >
              {level === 'all' ? 'All' : level.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="logs-controls">
          <label className="logs-autoscroll-label">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button className="log-clear-btn" onClick={() => setLogs([])}>Clear</button>
        </div>
      </div>
      <div ref={viewerRef} className="log-viewer panel">
        {filtered.length === 0 ? (
          <div className="muted" style={{ textAlign: 'center', padding: 24 }}>No log entries</div>
        ) : (
          filtered.map((log, i) => (
            <div key={i} className={`log-page-line log-page-${log.level}`}>
              <span className="log-page-time">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''}</span>
              <span className={`log-page-level log-page-level-${log.level}`}>{log.level.toUpperCase()}</span>
              <span className="log-page-source">{log.source}</span>
              <span className="log-page-message">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
