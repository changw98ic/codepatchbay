import { style, styleVariants, keyframes } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, radius, fontSize, fontWeight, zIndex } from '@/design-system/tokens';
import { glassBase, glassContent } from '@/design-system/liquid-glass/base.css';
import { useUIStore } from '@/app/store';

const slideIn = keyframes({
  '0%': { transform: 'translateX(100%)', opacity: 0 },
  '100%': { transform: 'translateX(0)', opacity: 1 },
});

const containerStyle = style({
  position: 'fixed',
  bottom: space[6],
  right: space[6],
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
  zIndex: zIndex.toast,
  maxWidth: '400px',
});

const toastBase = style([
  glassBase,
  {
    padding: `${space[3]} ${space[5]}`,
    borderRadius: radius.md,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    animation: `${slideIn} 0.3s ease`,
    selectors: {
      '&::before': { display: 'none' },
    },
  },
]);

const variantStyles = styleVariants({
  info: { borderLeft: `3px solid ${theme.accent}` },
  success: { borderLeft: `3px solid ${theme.success}` },
  warning: { borderLeft: `3px solid ${theme.warning}` },
  error: { borderLeft: `3px solid ${theme.error}` },
});

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className={containerStyle}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${toastBase} ${variantStyles[toast.type]}`}
          onClick={() => removeToast(toast.id)}
          style={{ cursor: 'pointer' }}
        >
          <div className={glassContent}>{toast.message}</div>
        </div>
      ))}
    </div>
  );
}
