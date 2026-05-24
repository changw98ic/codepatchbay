import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

export default function useDurableTasks() {
  const [durableTasks, setDurableTasks] = useState([]);
  const { subscribe } = useWebSocket();

  const refreshDurableTasks = useCallback(() => {
    fetch('/api/tasks/durable')
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setDurableTasks(data))
      .catch(() => {});
  }, []);

  useEffect(() => { refreshDurableTasks(); }, [refreshDurableTasks]);

  useEffect(() => {
    const unsub = subscribe('job:update', refreshDurableTasks);
    return unsub;
  }, [subscribe, refreshDurableTasks]);

  return { durableTasks, refreshDurableTasks };
}
