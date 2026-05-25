import { Link } from 'react-router-dom';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize } from '@/design-system/tokens';

const navStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  fontSize: fontSize.xs,
  color: theme.textMuted,
  marginBottom: space[4],
});

const linkStyle = style({
  color: theme.textDim,
  textDecoration: 'none',
  selectors: {
    '&:hover': { color: theme.accentLight },
  },
});

const sepStyle = style({
  color: theme.textMuted,
  userSelect: 'none',
});

const currentStyle = style({
  color: theme.text,
  fontWeight: 500,
});

interface Crumb {
  label: string;
  to?: string;
}

interface BreadcrumbProps {
  items: Crumb[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className={navStyle}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
            {i > 0 && <span className={sepStyle}>/</span>}
            {isLast || !item.to ? (
              <span className={currentStyle}>{item.label}</span>
            ) : (
              <Link to={item.to} className={linkStyle}>{item.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
