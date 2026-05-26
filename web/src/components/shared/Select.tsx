import type { SelectHTMLAttributes } from 'react';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, transition } from '@/design-system/tokens';

const selectStyle = style({
  width: '100%',
  padding: `${space[2]} ${space[4]}`,
  fontSize: fontSize.base,
  color: theme.text,
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: radius.md,
  outline: 'none',
  transition: transition.fast,
  appearance: 'none',
  cursor: 'pointer',
  selectors: {
    '&:focus': {
      borderColor: theme.accent,
      boxShadow: `0 0 0 2px ${theme.accentTint}`,
    },
  },
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Array<{ value: string; label: string }>;
}

export function Select({ label, options, className, id, ...props }: SelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label htmlFor={id} style={{ fontSize: 12, color: theme.textDim, fontWeight: 500 }}>
          {label}
        </label>
      )}
      <select id={id} className={`${selectStyle} ${className ?? ''}`} {...props}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}
