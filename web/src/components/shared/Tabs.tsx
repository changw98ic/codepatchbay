import { type ReactNode } from 'react';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, fontWeight, transition } from '@/design-system/tokens';

const tabBarStyle = style({
  display: 'flex',
  gap: space[1],
  padding: space[1],
  background: theme.surfaceAlt,
  borderRadius: radius.md,
  width: 'fit-content',
});

const tabStyle = style({
  padding: `${space[2]} ${space[4]}`,
  fontSize: fontSize.sm,
  fontWeight: fontWeight.medium,
  borderRadius: radius.sm,
  cursor: 'pointer',
  transition: transition.fast,
  color: theme.textDim,
  border: 'none',
  background: 'transparent',
  selectors: {
    '&:hover': {
      color: theme.text,
      background: theme.surfaceHover,
    },
  },
});

const activeTabStyle = style({
  color: theme.text,
  background: theme.surface,
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
});

export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number;
}

interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ items, active, onChange, className }: TabsProps) {
  return (
    <div className={`${tabBarStyle} ${className ?? ''}`}>
      {items.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={active === item.key}
          className={`${tabStyle} ${active === item.key ? activeTabStyle : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count !== undefined && (
            <span style={{ marginLeft: 4, opacity: 0.6, fontSize: 11 }}>{item.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
