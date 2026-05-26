import { style, createVar } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { glassBase, theme } from './base.css';
import { radius, space } from '../tokens';

// Dynamic override vars for depth variants
const blurOverride = createVar();
const noiseOverride = createVar();
const bgOverride = createVar();
const specularOverride = createVar();

// Depth-based glass panel recipe
export const glassPanel = recipe({
  base: [
    glassBase,
    {
      boxShadow: `0 4px 24px ${theme.glassShadowAmbient}, 0 1px 4px ${theme.glassShadowLight}`,
    },
  ],
  variants: {
    depth: {
      shallow: {
        vars: {
          [blurOverride]: '16px',
          [noiseOverride]: '0.02',
        },
        backdropFilter: `blur(${blurOverride}) saturate(${theme.glassSaturation}) brightness(${theme.glassBrightness})`,
        WebkitBackdropFilter: `blur(${blurOverride}) saturate(${theme.glassSaturation}) brightness(${theme.glassBrightness})`,
        boxShadow: `0 2px 12px ${theme.glassShadowAmbient}, 0 1px 2px ${theme.glassShadowLight}`,
      },
      medium: {}, // uses theme defaults
      deep: {
        vars: {
          [blurOverride]: '40px',
          [noiseOverride]: '0.06',
          [bgOverride]: 'rgba(14, 16, 20, 0.8)',
          [specularOverride]: 'rgba(255, 255, 255, 0.12)',
        },
        background: bgOverride,
        boxShadow: `0 12px 40px ${theme.glassShadowAmbient}, 0 2px 8px ${theme.glassShadowLight}`,
      },
    },
    padding: {
      none: { padding: '0' },
      sm: { padding: space[3] },
      md: { padding: space[5] },
      lg: { padding: space[6] },
    },
    rounded: {
      none: { borderRadius: radius.none },
      sm: { borderRadius: radius.sm },
      md: { borderRadius: radius.md },
      lg: { borderRadius: radius.lg },
      xl: { borderRadius: radius.xl },
      full: { borderRadius: radius.full },
    },
    interactive: {
      true: {
        cursor: 'pointer',
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        selectors: {
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: `0 8px 32px ${theme.glassShadowAmbient}, 0 2px 8px ${theme.glassShadowLight}`,
          },
        },
      },
    },
  },
  defaultVariants: {
    depth: 'medium',
    padding: 'md',
    rounded: 'md',
    interactive: false,
  },
});

// Sidebar glass
export const glassSidebarStyle = style([
  glassBase,
  {
    borderRadius: 0,
    boxShadow: `2px 0 24px ${theme.glassShadowAmbient}`,
    minHeight: '100vh',
  },
]);

// Modal glass
export const glassModalStyle = style([
  glassBase,
  {
    borderRadius: radius.xl,
    boxShadow: `0 25px 60px ${theme.glassShadowAmbient}, 0 0 0 1px ${theme.glassBorder}`,
  },
]);

// Badge/tag glass
export const glassBadge = style([
  glassBase,
  {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    padding: `${space[1]} ${space[3]}`,
    borderRadius: radius.full,
    fontSize: '12px',
    fontWeight: 500,
  },
]);
