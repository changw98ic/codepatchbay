import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';

export default function useHubData(diagnostics, onInitialTask) {
  const [hubStatus, setHubStatus] = useState(null);
  const [hubProjects, setHubProjects] = useState([]);
  const [hubAcp, setHubAcp] = useState(null);
  const [knowledgePolicy, setKnowledgePolicy] = useState(null);
  const [queueStatus, setQueueStatus] = useState(null);
  const [queueEntries, setQueueEntries] = useState([]);
  const [hubDispatches, setHubDispatches] = useState([]);
  const [observability, setObservability] = useState(null);
  const [taskLedger, setTaskLedger] = useState(null);
  const { connected } = useWebSocket();

  const refreshHub = useCallback(() => {
    const url = diagnostics ? '/api/hub/dashboard-summary?includeTest=true' : '/api/hub/dashboard-summary';
    fetch(url)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setHubStatus(data.status);
        setHubProjects(Array.isArray(data.registryProjects) ? data.registryProjects : []);
        setHubAcp(data.acp);
        setKnowledgePolicy(data.knowledgePolicy);
        setQueueStatus(data.queueStatus);
        setQueueEntries(Array.isArray(data.queueEntries) ? data.queueEntries : []);
        setHubDispatches(Array.isArray(data.dispatches) ? data.dispatches : []);
        setObservability(data.observability);
        setTaskLedger(
          data.taskLedger && Array.isArray(data.taskLedger.tasks) ? data.taskLedger : null
        );
        if (data.taskLedger?.tasks?.length > 0 && onInitialTask) {
          onInitialTask(data.taskLedger.tasks[0].id);
        }
      })
      .catch(() => {});
  }, [diagnostics, onInitialTask]);

  useEffect(() => { refreshHub(); }, [refreshHub]);

  useEffect(() => {
    if (connected) return;
    const id = setInterval(refreshHub, 15000);
    return () => clearInterval(id);
  }, [connected, refreshHub]);

  return {
    hubStatus, hubProjects, hubAcp, knowledgePolicy,
    queueStatus, queueEntries, hubDispatches, observability,
    taskLedger, refreshHub,
  };
}
