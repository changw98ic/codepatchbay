import type { InputHTMLAttributes } from 'react';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, transition } from '@/design-system/tokens';

const inputStyle = style({
  width: '100%',
  padding: `${space[2]} ${space[4]}`,
  fontSize: fontSize.base,
  color: theme.text,
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: radius.md,
  outline: 'none',
  transition: transition.fast,
  selectors: {
    '&::placeholder': {
      color: theme.textMuted,
    },
    '&:focus': {
      borderColor: theme.accent,
      boxShadow: `0 0 0 2px ${theme.accentTint}`,
    },
  },
});

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className, id, ...props }: InputProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label htmlFor={id} style={{ fontSize: 12, color: theme.textDim, fontWeight: 500 }}>
          {label}
        </label>
      )}
      <input id={id} className={`${inputStyle} ${className ?? ''}`} {...props} />
    </div>
  );
}
