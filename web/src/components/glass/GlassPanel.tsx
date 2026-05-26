import type { ReactNode, HTMLAttributes } from 'react';
import { glassPanel } from '@/design-system/liquid-glass/variants.css';
import { glassContent } from '@/design-system/liquid-glass/base.css';
import type { GlassDepth } from '@/types/ui';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  depth?: GlassDepth;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
  interactive?: boolean;
}

export function GlassPanel({
  children,
  depth = 'medium',
  padding = 'md',
  rounded = 'md',
  interactive = false,
  className,
  ...props
}: GlassPanelProps) {
  return (
    <div
      className={`${glassPanel({ depth, padding, rounded, interactive })} ${className ?? ''}`}
      {...props}
    >
      <div className={glassContent}>{children}</div>
    </div>
  );
}
