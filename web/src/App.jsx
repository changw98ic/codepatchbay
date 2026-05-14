import React, { useState, useEffect } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket';
import Dashboard from './pages/Dashboard';
import Project from './pages/Project';
import NewTask from './pages/NewTask';
import Review from './pages/Review';

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/new-task', label: 'New Task' },
  { to: '/review', label: 'Review' },
];

function StatusIndicator() {
  const { connected } = useWebSocket();
  return (
    <span className={`ws-status ${connected ? 'connected' : 'disconnected'}`}>
      {connected ? '●' : '○'} WS
    </span>
  );
}

export default function App() {
  return (
    <WebSocketProvider>
      <div className="app-layout">
        <nav className="sidebar">
          <div className="sidebar-header">
            <h1>Flow</h1>
            <StatusIndicator />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </WebSocketProvider>
  );
}
