import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, zIndex } from '@/design-system/tokens';
import { Sidebar } from './Sidebar';

const layoutStyle = style({
  display: 'flex',
  minHeight: '100vh',
});

const contentStyle = style({
  flex: 1,
  marginLeft: '240px',
  padding: space[6],
  background: `radial-gradient(circle at 80% 10%, ${theme.accentTint} 0%, transparent min(50%, 400px)), ${theme.bg}`,
  minHeight: '100vh',
  '@media': {
    'screen and (max-width: 768px)': {
      marginLeft: '0',
      padding: space[4],
    },
  },
});

const menuButton = style({
  display: 'none',
  position: 'fixed',
  top: space[3],
  left: space[3],
  zIndex: zIndex.sticky,
  width: 40,
  height: 40,
  borderRadius: '8px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: 18,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  '@media': {
    'screen and (max-width: 768px)': {
      display: 'flex',
    },
  },
});

const overlayStyle = style({
  display: 'none',
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  zIndex: zIndex.overlay,
  '@media': {
    'screen and (max-width: 768px)': {
      display: 'block',
    },
  },
});

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  return (
    <div className={layoutStyle}>
      <button className={menuButton} onClick={() => setSidebarOpen((v) => !v)} type="button" aria-label="Menu">
        {sidebarOpen ? '✕' : '☰'}
      </button>
      {sidebarOpen && <div className={overlayStyle} onClick={closeSidebar} />}
      <div style={{
        flexShrink: 0,
        width: 240,
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        zIndex: zIndex.sticky,
        transform: sidebarOpen ? 'translateX(0)' : undefined,
        transition: 'transform 0.2s ease',
      }}
        className={sidebarOpen ? '' : 'sidebar-collapsed-mobile'}
      >
        <Sidebar onNavigate={closeSidebar} />
      </div>
      <main className={contentStyle}>{children}</main>
      <style>{`
        @media screen and (max-width: 768px) {
          .sidebar-collapsed-mobile {
            transform: translateX(-100%);
          }
        }
      `}</style>
    </div>
  );
}
