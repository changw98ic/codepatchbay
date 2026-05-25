import type { ReactNode } from 'react';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize } from '@/design-system/tokens';

const containerStyle = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: `${space[10]} ${space[6]}`,
  textAlign: 'center',
});

const iconStyle = style({
  fontSize: '40px',
  lineHeight: 1,
  marginBottom: space[4],
  opacity: 0.5,
});

const titleStyle = style({
  fontSize: fontSize.base,
  fontWeight: 600,
  color: theme.text,
  marginBottom: space[2],
});

const descStyle = style({
  fontSize: fontSize.sm,
  color: theme.textMuted,
  maxWidth: 320,
  lineHeight: 1.6,
  marginBottom: space[5],
});

const actionStyle = style({
  display: 'flex',
  gap: space[3],
});

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = '📭', title, description, action }: EmptyStateProps) {
  return (
    <div className={containerStyle}>
      <div className={iconStyle}>{icon}</div>
      <div className={titleStyle}>{title}</div>
      {description && <div className={descStyle}>{description}</div>}
      {action && <div className={actionStyle}>{action}</div>}
    </div>
  );
}
