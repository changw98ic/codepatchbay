import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { style, styleVariants } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, fontWeight, transition } from '@/design-system/tokens';
import { glassBase, glassContent } from '@/design-system/liquid-glass/base.css';

const base = style([
  glassBase,
  {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    padding: `${space[2]} ${space[4]}`,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    borderRadius: radius.md,
    cursor: 'pointer',
    transition: transition.fast,
    border: `1px solid ${theme.glassBorder}`,
    selectors: {
      '&:hover': {
        background: theme.surfaceHover,
      },
      '&:active': {
        transform: 'scale(0.97)',
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed',
      },
    },
  },
]);

const variantStyles = styleVariants({
  default: {},
  primary: {
    background: theme.accentSolid,
    color: '#fff',
    border: 'none',
    selectors: {
      '&:hover': {
        background: theme.accentDim,
      },
    },
  },
  danger: {
    border: `1px solid ${theme.error}`,
    color: theme.error,
    selectors: {
      '&:hover': {
        background: theme.errorDim,
      },
    },
  },
  ghost: {
    background: 'transparent',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    border: 'none',
    selectors: {
      '&::before': { display: 'none' },
      '&::after': { display: 'none' },
      '&:hover': { background: theme.surfaceAlt },
    },
  },
});

const sizeStyles = styleVariants({
  sm: { padding: `${space[1]} ${space[3]}`, fontSize: fontSize.xs },
  md: {},
  lg: { padding: `${space[3]} ${space[6]}`, fontSize: fontSize.base },
});

type Variant = keyof typeof variantStyles;
type Size = keyof typeof sizeStyles;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export function Button({ variant = 'default', size = 'md', children, className, ...props }: ButtonProps) {
  return (
    <button
      className={`${base} ${variantStyles[variant]} ${sizeStyles[size]} ${className ?? ''}`}
      {...props}
    >
      <span className={glassContent}>{children}</span>
    </button>
  );
}
