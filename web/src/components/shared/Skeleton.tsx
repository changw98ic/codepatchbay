import { style, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space } from '@/design-system/tokens';

const shimmer = keyframes({
  '0%': { backgroundPosition: '-200% 0' },
  '100%': { backgroundPosition: '200% 0' },
});

const baseStyle = style({
  borderRadius: '6px',
  background: `linear-gradient(90deg, ${theme.surfaceAlt} 25%, ${theme.surfaceHover} 50%, ${theme.surfaceAlt} 75%)`,
  backgroundSize: '200% 100%',
  animation: `${shimmer} 1.5s ease-in-out infinite`,
});

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  count?: number;
  gap?: number;
}

export function Skeleton({ width = '100%', height = 14, count = 1, gap = 8 }: SkeletonProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={baseStyle}
          style={{ width, height }}
        />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div style={{
      padding: space[4],
      borderRadius: '12px',
      border: `1px solid ${theme.border}`,
      display: 'flex',
      flexDirection: 'column',
      gap: space[3],
    }}>
      <Skeleton width="60%" height={18} />
      <Skeleton width="100%" height={12} />
      <Skeleton width="40%" height={12} />
    </div>
  );
}
