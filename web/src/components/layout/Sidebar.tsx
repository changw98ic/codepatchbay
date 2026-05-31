import { useTranslation } from 'react-i18next';
import { GlassSidebar } from '@/components/glass/GlassSidebar';
import { NavLink } from './NavLink';
import { Button } from '@/components/shared/Button';
import { useWebSocketStore } from '@/app/store';
import { useUIStore } from '@/app/store';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[6],
});

const titleStyle = style({
  fontSize: fontSize.xl,
  fontWeight: fontWeight.bold,
  color: theme.text,
});

const controlsStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
});

const wsDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  display: 'inline-block',
});

const wsConnected = style({
  backgroundColor: theme.success,
  boxShadow: `0 0 6px ${theme.success}`,
});

const wsDisconnected = style({
  backgroundColor: theme.textMuted,
});

const navListStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
  flex: 1,
});

const bottomSection = style({
  marginTop: 'auto',
  paddingTop: space[4],
  borderTop: `1px solid ${theme.border}`,
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
});

const localeButtons = style({
  display: 'flex',
  gap: space[1],
});

const shortcutHint = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: space[2],
  padding: `${space[2]} ${space[3]}`,
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

const kbdStyle = style({
  padding: '1px 6px',
  borderRadius: '4px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  fontSize: fontSize.xs,
  fontFamily: 'inherit',
});

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const { t, i18n } = useTranslation();
  const connected = useWebSocketStore((s) => s.connected);
  const { resolvedTheme, setTheme, locale, setLocale } = useUIStore();


  const navItems = [
    { to: '/', label: t('nav.dashboard'), end: true },
    { to: '/new-task', label: t('nav.newTask') },
    { to: '/review', label: t('nav.review') },
    { to: '/agents', label: t('nav.agents') },
    { to: '/gates', label: t('nav.gates', 'Gates') },
    { to: '/policy', label: t('nav.policy', 'Policy') },
    { to: '/logs', label: t('nav.logs') },
  ];

  const handleNavClick = () => {
    onNavigate?.();
  };

  return (
    <GlassSidebar>
      <div className={headerStyle}>
        <h1 className={titleStyle}>{t('app.name')}</h1>
        <div className={controlsStyle}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            title={t(`theme.${resolvedTheme === 'dark' ? 'light' : 'dark'}`)}
          >
            {resolvedTheme === 'dark' ? '☀️' : '🌙'}
          </Button>
          <span
            className={`${wsDot} ${connected ? wsConnected : wsDisconnected}`}
            title={connected ? 'WebSocket Connected' : 'WebSocket Disconnected'}
          />
        </div>
      </div>

      <nav className={navListStyle}>
        {navItems.map((item) => (
          <div key={item.to} onClick={handleNavClick}>
            <NavLink to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          </div>
        ))}
      </nav>

      <div className={shortcutHint}>
        <kbd className={kbdStyle}>⌘K</kbd> <span>{t('nav.search')}</span>
      </div>

      <div className={bottomSection}>
        <div className={localeButtons}>
          <Button
            variant={locale === 'en-US' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setLocale('en-US')}
          >
            EN
          </Button>
          <Button
            variant={locale === 'zh-CN' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => { setLocale('zh-CN'); i18n.changeLanguage('zh-CN'); }}
          >
            中
          </Button>
        </div>
      </div>
    </GlassSidebar>
  );
}
