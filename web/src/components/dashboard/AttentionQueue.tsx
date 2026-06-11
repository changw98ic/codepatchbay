import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
import { Badge } from '@/components/shared/Badge';
import type { AttentionItem, AttentionSeverity } from '@/types/api';
import { style, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.4 },
});

const sectionStyle = style({
  marginBottom: space[6],
});

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  fontSize: fontSize.lg,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginTop: 0,
  marginBottom: space[3],
});

const pulseOk = style({
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: theme.success,
  display: 'inline-block',
  boxShadow: `0 0 8px ${theme.success}`,
});

const pulseError = style({
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: theme.error,
  display: 'inline-block',
  boxShadow: `0 0 8px ${theme.error}`,
  animation: `${pulse} 2s infinite`,
});

const emptyStyle = style({
  color: theme.success,
  fontSize: fontSize.base,
  fontWeight: fontWeight.medium,
});

const rowStyle = style({
  padding: space[3],
  borderBottom: `1px solid ${theme.border}`,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'start',
  gap: space[4],
  selectors: {
    '&:last-child': { borderBottom: 'none' },
  },
});

const itemMain = style({
  minWidth: 0,
});

const itemMeta = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  flexWrap: 'wrap',
  marginBottom: space[1],
});

const projectName = style({
  fontWeight: fontWeight.semibold,
  fontSize: fontSize.sm,
  color: theme.text,
});

const reasonStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.5,
  marginBottom: space[1],
});

const impactStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  lineHeight: 1.5,
});

const ageStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

function severityVariant(severity: AttentionSeverity): 'error' | 'warning' | 'muted' {
  if (severity === 'critical') return 'error';
  if (severity === 'warning') return 'warning';
  return 'muted';
}

function formatAge(item: AttentionItem): string {
  const ageMs = typeof item.ageMs === 'number'
    ? item.ageMs
    : item.updatedAt
      ? Date.now() - new Date(item.updatedAt).getTime()
      : null;
  if (ageMs === null || Number.isNaN(ageMs) || ageMs < 0) return 'age unknown';
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m old`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h old`;
  return `${Math.floor(ageMs / 86_400_000)}d old`;
}

interface AttentionQueueProps {
  items: AttentionItem[];
  onNavigate: (link: string) => void;
}

export function AttentionQueue({ items, onNavigate }: AttentionQueueProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? items : items.slice(0, 3);

  if (items.length === 0) {
    return (
      <GlassPanel depth="medium" padding="md" className={sectionStyle}>
        <h3 className={headerStyle}>
          <span className={pulseOk} />
          {t('dashboard.attentionQueue')}
        </h3>
        <p className={emptyStyle}>{t('dashboard.noAttention')}</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel depth="medium" padding="md" className={sectionStyle}>
      <h3 className={headerStyle}>
        <span className={pulseError} />
        {t('dashboard.attentionQueue')}
      </h3>
      {displayed.map((item) => (
        <div key={item.id} className={rowStyle}>
          <div className={itemMain}>
            <div className={itemMeta}>
              <Badge variant={severityVariant(item.severity)}>{item.severity}</Badge>
              <span className={projectName}>
                {item.project ? `${item.project} - ${item.title}` : item.title}
              </span>
              <span className={ageStyle}>{formatAge(item)}</span>
            </div>
            <div className={reasonStyle}>{item.reason}</div>
            <div className={impactStyle}>{item.impact}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigate(item.nextHumanAction.href)}>
            {item.nextHumanAction.label}
          </Button>
        </div>
      ))}
      {items.length > 3 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? t('common.collapse') : t('dashboard.showMore', { count: items.length - 3 })}
        </Button>
      )}
    </GlassPanel>
  );
}
