import { style } from '@vanilla-extract/css';
import { NavLink as RouterNavLink } from 'react-router-dom';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, fontWeight, transition } from '@/design-system/tokens';

const navLinkStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[2]} ${space[4]}`,
  fontSize: fontSize.base,
  fontWeight: fontWeight.medium,
  borderRadius: radius.md,
  color: theme.textDim,
  transition: transition.fast,
  textDecoration: 'none',
  selectors: {
    '&:hover': {
      color: theme.text,
      background: theme.surfaceHover,
    },
    '&.active': {
      color: theme.accentLight,
      background: theme.accentTint,
    },
  },
});

interface NavLinkProps {
  to: string;
  children: React.ReactNode;
  end?: boolean;
}

export function NavLink({ to, children, end }: NavLinkProps) {
  return (
    <RouterNavLink
      to={to}
      end={end}
      className={({ isActive }) => `${navLinkStyle} ${isActive ? 'active' : ''}`}
    >
      {children}
    </RouterNavLink>
  );
}
