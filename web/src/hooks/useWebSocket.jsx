import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

const WSContext = createContext(null);

export function useWebSocket() {
  return useContext(WSContext);
}

export function WebSocketProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Map());
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = 1000;
    };
    ws.onclose = () => {
      setConnected(false);
      if (intentionalClose.current) return;
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 30000);
      reconnectTimer.current = setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = (raw) => {
      try {
        const msg = JSON.parse(raw.data);
        if (msg.type === 'pong') return;
        const fns = listeners.current.get(msg.type);
        if (fns) fns.forEach((fn) => fn(msg));
        const allFns = listeners.current.get('*');
        if (allFns) allFns.forEach((fn) => fn(msg));
      } catch {}
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((type, fn) => {
    if (!listeners.current.has(type)) listeners.current.set(type, new Set());
    listeners.current.get(type).add(fn);
    return () => {
      const cbs = listeners.current.get(type);
      if (!cbs) return;
      cbs.delete(fn);
      if (cbs.size === 0) listeners.current.delete(type);
    };
  }, []);

  const value = { connected, send, subscribe };
  return <WSContext.Provider value={value}>{children}</WSContext.Provider>;
}
