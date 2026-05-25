import { style, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';

const spin = keyframes({
  '0%': { transform: 'rotate(0deg)' },
  '100%': { transform: 'rotate(360deg)' },
});

const spinnerStyle = style({
  border: `2px solid ${theme.border}`,
  borderTopColor: theme.accent,
  borderRadius: '50%',
  animation: `${spin} 0.6s linear infinite`,
  display: 'inline-block',
});

interface SpinnerProps {
  size?: number;
  className?: string;
}

export function Spinner({ size = 20, className }: SpinnerProps) {
  return (
    <span
      className={`${spinnerStyle} ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  );
}
