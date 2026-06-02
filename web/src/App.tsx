import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/components/layout/AppLayout';
import { ToastContainer } from '@/components/shared/Toast';
import { SearchPalette } from '@/components/shared/SearchPalette';
import { useWebSocketStore, useUIStore } from '@/app/store';
import { injectGlassFilters } from '@/design-system';
import Dashboard from '@/pages/Dashboard';
import Project from '@/pages/Project';
import ReviewPage from '@/pages/Review';
import AgentBoard from '@/pages/AgentBoard';
import NewTaskPage from '@/pages/NewTask';
import LogsPage from '@/pages/Logs';
import InboxPage from '@/pages/Inbox';

function AppContent() {
  const { subscribe } = useWebSocketStore();
  const addToast = useUIStore((s) => s.addToast);

  useEffect(() => {
    injectGlassFilters();

    const unsubPipeline = subscribe('pipeline:update', (msg) => {
      const data = msg as unknown as { project: string; state: { status: string; phase?: string } };
      if (data.state?.status === 'completed') {
        addToast(`"${data.project}" pipeline completed!`, 'success');
      } else if (data.state?.status === 'failed') {
        addToast(`"${data.project}" failed on "${data.state.phase}".`, 'error');
      }
    });

    const unsubReview = subscribe('review:update', (msg) => {
      const data = msg as unknown as { sessionId: string; status: string };
      if (data.status === 'user_review') {
        addToast(`Review ${data.sessionId.slice(-8)} needs attention`, 'info');
      }
    });

    return () => {
      unsubPipeline();
      unsubReview();
    };
  }, [subscribe, addToast]);

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/project/:name" element={<Project />} />
        <Route path="/new-task" element={<NewTaskPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/agents" element={<AgentBoard />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  const connect = useWebSocketStore((s) => s.connect);
  const locale = useUIStore((s) => s.locale);
  const { i18n } = useTranslation();

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    i18n.changeLanguage(locale);
  }, [locale, i18n]);

  return (
    <>
      <AppContent />
      <ToastContainer />
      <SearchPalette />
    </>
  );
}
