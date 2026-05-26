import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, transition } from '@/design-system/tokens';

const trackBase = style({
  position: 'relative',
  width: '40px',
  height: '22px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: radius.full,
  cursor: 'pointer',
  transition: transition.normal,
  flexShrink: 0,
});

const trackActive = style({
  background: theme.accentSolid,
  borderColor: theme.accentSolid,
});

const thumbBase = style({
  position: 'absolute',
  top: '2px',
  left: '2px',
  width: '16px',
  height: '16px',
  background: '#fff',
  borderRadius: radius.full,
  transition: transition.normal,
  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
});

const thumbActive = style({
  left: '20px',
});

const labelStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  cursor: 'pointer',
  fontSize: '14px',
  color: theme.text,
});

interface ToggleProps {
  active: boolean;
  onChange: (active: boolean) => void;
  label?: string;
  className?: string;
}

export function Toggle({ active, onChange, label, className }: ToggleProps) {
  return (
    <label className={`${labelStyle} ${className ?? ''}`}>
      <button
        className={`${trackBase} ${active ? trackActive : ''}`}
        onClick={() => onChange(!active)}
        role="switch"
        aria-checked={active}
        type="button"
      >
        <span className={`${thumbBase} ${active ? thumbActive : ''}`} />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}
