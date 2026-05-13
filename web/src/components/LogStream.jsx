import React, { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

export default function LogStream({ project, initialLog }) {
  const [lines, setLines] = useState([]);
  const bottomRef = useRef(null);
  const { subscribe } = useWebSocket();

  // Reset when project or initialLog changes
  useEffect(() => {
    setLines((initialLog || '').split('\n').filter((l) => l.trim()));
  }, [initialLog, project]);

  useEffect(() => {
    const unsub = subscribe('log:append', (msg) => {
      if (msg.project === project && msg.entry) {
        setLines((prev) => [...prev, msg.entry]);
      }
    });
    return unsub;
  }, [subscribe, project]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="log-stream">
      {lines.length === 0 ? (
        <p className="empty">No log entries</p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="log-line">{line}</div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
