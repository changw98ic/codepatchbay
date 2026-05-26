import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { radius, transition } from '../tokens';

// Base glass style — the foundation of iOS 26 Liquid Glass
export const glassBase = style({
  background: theme.glassBg,
  border: `1px solid ${theme.glassBorder}`,
  backdropFilter: `blur(${theme.glassBlur}) saturate(${theme.glassSaturation}) brightness(${theme.glassBrightness})`,
  WebkitBackdropFilter: `blur(${theme.glassBlur}) saturate(${theme.glassSaturation}) brightness(${theme.glassBrightness})`,
  position: 'relative',
  overflow: 'hidden',
  borderRadius: radius.md,
  transition: transition.normal,

  selectors: {
    '&::before': {
      content: '',
      position: 'absolute',
      inset: 0,
      opacity: theme.glassNoiseOpacity,
      pointerEvents: 'none',
      backgroundImage: 'url(/glass-noise.svg)',
      backgroundRepeat: 'repeat',
      backgroundSize: '128px 128px',
      zIndex: 0,
    },
    '&::after': {
      content: '',
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: '50%',
      background: `linear-gradient(180deg, ${theme.glassSpecular} 0%, transparent 100%)`,
      pointerEvents: 'none',
      opacity: 0.4,
      zIndex: 0,
    },
  },
});

// Content wrapper — sits above pseudo-elements
export const glassContent = style({
  position: 'relative',
  zIndex: 1,
});

// Re-export theme for convenience
export { theme };
