import type { HTMLAttributes, ReactNode } from 'react';
import { styleVariants } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { glassBadge } from '@/design-system/liquid-glass/variants.css';
import { glassContent } from '@/design-system/liquid-glass/base.css';

const variantStyles = styleVariants({
  default: {},
  success: {
    color: theme.success,
    border: `1px solid ${theme.success}`,
    selectors: {
      '&::before': { display: 'none' },
      '&::after': { display: 'none' },
    },
    background: theme.successDim,
  },
  warning: {
    color: theme.warning,
    border: `1px solid ${theme.warning}`,
    selectors: {
      '&::before': { display: 'none' },
      '&::after': { display: 'none' },
    },
    background: theme.warningDim,
  },
  error: {
    color: theme.error,
    border: `1px solid ${theme.error}`,
    selectors: {
      '&::before': { display: 'none' },
      '&::after': { display: 'none' },
    },
    background: theme.errorDim,
  },
  accent: {
    color: theme.accentLight,
    border: `1px solid ${theme.accent}`,
  },
  muted: {
    color: theme.textDim,
    selectors: {
      '&::before': { display: 'none' },
      '&::after': { display: 'none' },
    },
    background: theme.surfaceAlt,
    border: `1px solid ${theme.border}`,
  },
});

type Variant = keyof typeof variantStyles;

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Badge({ variant = 'default', children, className, ...props }: BadgeProps) {
  return (
    <span className={`${glassBadge} ${variantStyles[variant]} ${className ?? ''}`} {...props}>
      <span className={glassContent}>{children}</span>
    </span>
  );
}
