import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
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
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  selectors: {
    '&:last-child': { borderBottom: 'none' },
  },
});

const projectName = style({
  fontWeight: fontWeight.semibold,
  fontSize: fontSize.base,
  color: theme.text,
  minWidth: '120px',
});

const reasonStyle = style({
  flex: 1,
  fontSize: fontSize.sm,
  color: theme.textDim,
});

interface AttentionItem {
  id: string;
  project: string;
  reason: string;
  impact: string;
  action: string;
  link: string;
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
        <div className={headerStyle}>
          <span className={pulseOk} />
          {t('dashboard.attentionQueue')}
        </div>
        <p className={emptyStyle}>{t('dashboard.noAttention')}</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel depth="medium" padding="md" className={sectionStyle}>
      <div className={headerStyle}>
        <span className={pulseError} />
        {t('dashboard.attentionQueue')}
      </div>
      {displayed.map((item) => (
        <div key={item.id} className={rowStyle}>
          <span className={projectName}>{item.project}</span>
          <span className={reasonStyle}>{item.reason}</span>
          <Button variant="ghost" size="sm" onClick={() => onNavigate(item.link)}>
            {item.action}
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
