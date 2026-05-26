import type { ReactNode } from 'react';
import { glassSidebarStyle } from '@/design-system/liquid-glass/variants.css';
import { glassContent } from '@/design-system/liquid-glass/base.css';
import { style } from '@vanilla-extract/css';
import { space, zIndex } from '@/design-system/tokens';

const sidebarClass = style([
  glassSidebarStyle,
  {
    position: 'fixed',
    left: 0,
    top: 0,
    bottom: 0,
    width: '240px',
    display: 'flex',
    flexDirection: 'column',
    zIndex: zIndex.sticky,
  },
]);

const innerClass = style({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  padding: space[5],
});

interface GlassSidebarProps {
  children: ReactNode;
  className?: string;
}

export function GlassSidebar({ children, className }: GlassSidebarProps) {
  return (
    <aside className={`${sidebarClass} ${className ?? ''}`}>
      <div className={glassContent}>
        <div className={innerClass}>{children}</div>
      </div>
    </aside>
  );
}
