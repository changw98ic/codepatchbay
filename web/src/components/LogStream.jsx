import React, { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

export default function LogStream({ project, initialLog }) {
  const [lines, setLines] = useState([]);
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const { subscribe } = useWebSocket();

  // Reset when project or initialLog changes
  useEffect(() => {
    setLines((initialLog || '').split('\n').filter((l) => l.trim()));
    setAutoScroll(true);
  }, [initialLog, project]);

  useEffect(() => {
    const unsub = subscribe('log:append', (msg) => {
      if (msg.project === project && msg.entry) {
        setLines((prev) => [...prev, msg.entry]);
      }
    });
    return unsub;
  }, [subscribe, project]);

  // Handle auto scrolling on new lines
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines, autoScroll]);

  // Detect manual scroll behavior
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // If user is within 35px of the bottom, keep auto-scroll active
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 35;
    if (isAtBottom !== autoScroll) {
      setAutoScroll(isAtBottom);
    }
  };

  const handleEnableAutoScroll = () => {
    setAutoScroll(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative' }}>
      <div 
        className="log-stream" 
        ref={containerRef}
        onScroll={handleScroll}
      >
        {lines.length === 0 ? (
          <p className="empty">No log entries</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="log-line">{line}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && lines.length > 0 && (
        <button 
          className="log-autoscroll-pill" 
          onClick={handleEnableAutoScroll}
          type="button"
        >
          ↓ Auto-Scroll Paused
        </button>
      )}
    </div>
  );
}

