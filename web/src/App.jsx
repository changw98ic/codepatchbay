import React, { useEffect } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
import { ToastProvider, useToast } from './hooks/useToast';
import Dashboard from './pages/Dashboard';
import Project from './pages/Project';
import NewTask from './pages/NewTask';
import Review from './pages/Review';
import AgentBoard from './pages/AgentBoard';
import Logs from './pages/Logs';
import ThemeToggle from './components/ThemeToggle';

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/new-task', label: 'New Task' },
  { to: '/review', label: 'Review' },
  { to: '/agents', label: 'Agents' },
  { to: '/logs', label: 'Logs' },
];

function StatusIndicator() {
  const { connected } = useWebSocket();
  return (
    <span className={`ws-status ${connected ? 'connected' : 'disconnected'}`}>
      {connected ? '●' : '○'} WS
    </span>
  );
}

function AppContent() {
  const { subscribe } = useWebSocket();
  const { addToast } = useToast();

  useEffect(() => {
    const unsubPipeline = subscribe('pipeline:update', (msg) => {
      const { project, state } = msg;
      if (state) {
        if (state.status === 'completed') {
          addToast(`Project "${project}" pipeline completed successfully!`, 'success');
        } else if (state.status === 'failed') {
          addToast(`Project "${project}" pipeline failed on phase "${state.phase}".`, 'error');
        } else if (state.status === 'running') {
          addToast(`Project "${project}" is executing phase "${state.phase}".`, 'info');
        }
      }
    });

    const unsubReview = subscribe('review:update', (msg) => {
      const { sessionId, status } = msg;
      if (status === 'user_review') {
        addToast(`Review session ${sessionId.slice(-8)} requires user review!`, 'info');
      }
    });

    return () => {
      unsubPipeline();
      unsubReview();
    };
  }, [subscribe, addToast]);

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>CodePatchbay</h1>
          <div className="sidebar-controls">
            <ThemeToggle />
            <StatusIndicator />
          </div>
        </div>
        <ul className="nav-list">
          {navItems.map(({ to, label }) => (
            <li key={to}>
              <NavLink to={to} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:name" element={<Project />} />
          <Route path="/new-task" element={<NewTask />} />
          <Route path="/review" element={<Review />} />
          <Route path="/agents" element={<AgentBoard />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <WebSocketProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </WebSocketProvider>
  );
}

