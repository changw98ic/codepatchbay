import type { ReactNode, HTMLAttributes } from 'react';
import { style } from '@vanilla-extract/css';
import { glassBase, glassContent, theme } from '@/design-system/liquid-glass/base.css';
import { space, transition } from '@/design-system/tokens';

const cardStyle = style([
  glassBase,
  {
    padding: space[5],
    transition: transition.normal,
    selectors: {
      '&:hover': {
        transform: 'translateY(-2px)',
        boxShadow: `0 12px 32px ${theme.glassShadowAmbient}, 0 2px 8px ${theme.glassShadowLight}`,
      },
    },
  },
]);

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
}

export function GlassCard({ children, className, ...props }: GlassCardProps) {
  return (
    <div className={`${cardStyle} ${className ?? ''}`} {...props}>
      <div className={glassContent}>{children}</div>
    </div>
  );
}
