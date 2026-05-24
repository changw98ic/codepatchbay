import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

export default function useProjects(diagnostics) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const { connected, subscribe } = useWebSocket();

  const fetchProjects = useCallback(() => {
    const url = diagnostics ? '/api/projects?includeTest=true' : '/api/projects';
    fetch(url)
      .then((r) => r.json())
      .then((data) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [diagnostics]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  useEffect(() => {
    if (connected) return;
    const id = setInterval(fetchProjects, 15000);
    return () => clearInterval(id);
  }, [connected, fetchProjects]);

  useEffect(() => {
    const u1 = subscribe('pipeline:update', (msg) => {
      setProjects((prev) =>
        prev.map((p) => p.name === msg.project ? { ...p, pipelineState: msg.state } : p)
      );
    });
    const u2 = subscribe('log:append', (msg) => {
      setProjects((prev) =>
        prev.map((p) => p.name === msg.project
          ? { ...p, recentLog: [...(p.recentLog || []).slice(-4), msg.entry] }
          : p
        )
      );
    });
    const u3 = subscribe('file:created', (msg) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.name !== msg.project) return p;
          return {
            ...p,
            inbox: p.inbox + (msg.path?.startsWith('inbox/') ? 1 : 0),
            outputs: p.outputs + (msg.path?.startsWith('outputs/') ? 1 : 0),
          };
        })
      );
    });
    const u4 = subscribe('file:deleted', (msg) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.name !== msg.project) return p;
          return {
            ...p,
            inbox: Math.max(0, p.inbox - (msg.path?.startsWith('inbox/') ? 1 : 0)),
            outputs: Math.max(0, p.outputs - (msg.path?.startsWith('outputs/') ? 1 : 0)),
          };
        })
      );
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, [subscribe]);

  return { projects, loading, fetchProjects };
}
