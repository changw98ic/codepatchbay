import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import TaskForm from '../components/TaskForm';

export default function NewTask() {
  const [projects, setProjects] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => setProjects(data.map((p) => p.name)))
      .catch(() => {});
  }, []);

  const handleSubmit = async ({ project, task, mode, maxRetries, timeout }) => {
    const endpoints = {
      plan: { path: `/api/tasks/${project}/plan`, body: { task } },
      pipeline: { path: `/api/tasks/${project}/pipeline`, body: { task, maxRetries: String(maxRetries), timeout: String(timeout) } },
    };

    const { path, body } = endpoints[mode] || endpoints.pipeline;

    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        navigate(`/project/${project}`);
      } else {
        const err = await res.json();
        alert(err.message || 'Failed to submit task');
      }
    } catch (e) {
      alert('Network error: ' + e.message);
    }
  };

  return (
    <div className="new-task">
      <h2>Submit New Task</h2>
      <TaskForm projects={projects} onSubmit={handleSubmit} />
    </div>
  );
}
