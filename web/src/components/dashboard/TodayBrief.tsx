import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Badge } from '@/components/shared/Badge';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const heroStyle = style({
  marginBottom: space[6],
});

const headerRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[4],
});

const titleStyle = style({
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.bold,
  color: theme.text,
});

const summaryStyle = style({
  fontSize: fontSize.base,
  color: theme.textDim,
  lineHeight: 1.6,
  marginBottom: space[5],
});

const gridStyle = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: space[4],
  '@media': {
    '(max-width: 768px)': { gridTemplateColumns: 'repeat(2, 1fr)' },
  },
});

const statCard = style({
  textAlign: 'center' as const,
  padding: space[4],
});

const valueStyle = style({
  fontSize: fontSize['3xl'],
  fontWeight: fontWeight.extrabold,
  display: 'block',
  marginBottom: space[1],
});

const labelStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  fontWeight: fontWeight.medium,
});

const accent = style({ color: theme.accent });
const danger = style({ color: theme.error });
const warning = style({ color: theme.warning });
const success = style({ color: theme.success });

interface TodayBriefProps {
  activeTasks: number;
  failedRuns: number;
  blockedProjects: number;
  completedRuns: number;
}

export function TodayBrief({ activeTasks, failedRuns, blockedProjects, completedRuns }: TodayBriefProps) {
  const { t } = useTranslation();

  return (
    <GlassPanel depth="medium" padding="lg" className={heroStyle}>
      <div className={headerRow}>
        <h3 className={titleStyle}>{t('dashboard.todayBrief')}</h3>
        <Badge variant="muted">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        </Badge>
      </div>
      <p className={summaryStyle}>
        {t('dashboard.activeTasks')}: <strong className={accent}>{activeTasks}</strong>
        {failedRuns > 0 ? (
          <> — {t('dashboard.failedRuns')}: <strong className={danger}>{failedRuns}</strong></>
        ) : null}
        {blockedProjects > 0 ? (
          <> — {t('dashboard.blockedProjects')}: <strong className={warning}>{blockedProjects}</strong></>
        ) : null}
      </p>
      <div className={gridStyle}>
        <GlassPanel depth="shallow" padding="sm" className={statCard}>
          <span className={`${valueStyle} ${activeTasks > 0 ? accent : ''}`}>{activeTasks}</span>
          <span className={labelStyle}>{t('dashboard.activeTasks')}</span>
        </GlassPanel>
        <GlassPanel depth="shallow" padding="sm" className={statCard}>
          <span className={`${valueStyle} ${failedRuns > 0 ? danger : ''}`}>{failedRuns}</span>
          <span className={labelStyle}>{t('dashboard.failedRuns')}</span>
        </GlassPanel>
        <GlassPanel depth="shallow" padding="sm" className={statCard}>
          <span className={`${valueStyle} ${blockedProjects > 0 ? warning : ''}`}>{blockedProjects}</span>
          <span className={labelStyle}>{t('dashboard.blockedProjects')}</span>
        </GlassPanel>
        <GlassPanel depth="shallow" padding="sm" className={statCard}>
          <span className={`${valueStyle} ${success}`}>{completedRuns}</span>
          <span className={labelStyle}>{t('dashboard.completedRuns')}</span>
        </GlassPanel>
      </div>
    </GlassPanel>
  );
}
