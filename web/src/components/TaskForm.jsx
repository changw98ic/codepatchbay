import React, { useState, useEffect } from 'react';

const MODES = [
  { value: 'plan', label: 'Plan Only' },
  { value: 'pipeline', label: 'Full Pipeline (Plan → Execute → Verify)' },
];

export default function TaskForm({ projects, onSubmit }) {
  const [project, setProject] = useState(projects[0] || '');
  const [task, setTask] = useState('');
  const [mode, setMode] = useState('pipeline');
  const [maxRetries, setMaxRetries] = useState(3);
  const [taskTimeout, setTaskTimeout] = useState(30);
  const [submitting, setSubmitting] = useState(false);

  // Sync project when projects list changes
  useEffect(() => {
    if (projects.length > 0 && !projects.includes(project)) {
      setProject(projects[0]);
    }
  }, [projects]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!task.trim() || !project) return;
    setSubmitting(true);
    try {
      await onSubmit({ project, task: task.trim(), mode, maxRetries, timeout: taskTimeout });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="task-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Project</label>
        <select value={project} onChange={(e) => setProject(e.target.value)} required>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label>Task Description</label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what you want to accomplish..."
          rows={4}
          required
        />
      </div>

      <div className="form-group">
        <label>Mode</label>
        <div className="mode-select">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`mode-btn ${mode === m.value ? 'active' : ''}`}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'pipeline' && (
        <div className="form-row">
          <div className="form-group">
            <label>Max Retries</label>
            <input type="number" min={1} max={10} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} />
          </div>
          <div className="form-group">
            <label>Timeout (min)</label>
            <input type="number" min={5} max={120} value={taskTimeout} onChange={(e) => setTaskTimeout(Number(e.target.value))} />
          </div>
        </div>
      )}

      <button type="submit" className="btn btn-primary" disabled={submitting || !task.trim()}>
        {submitting ? 'Submitting...' : 'Submit Task'}
      </button>
    </form>
  );
}
