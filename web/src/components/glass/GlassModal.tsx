import { type ReactNode, useEffect, useCallback } from 'react';
import { style } from '@vanilla-extract/css';
import { zIndex, space } from '@/design-system/tokens';
import { glassModalStyle } from '@/design-system/liquid-glass/variants.css';
import { glassContent } from '@/design-system/liquid-glass/base.css';

const overlayStyle = style({
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: zIndex.modal,
  padding: space[6],
});

const contentStyle = style([
  glassModalStyle,
  {
    width: '100%',
    maxWidth: '560px',
    maxHeight: '80vh',
    overflow: 'auto',
  },
]);

interface GlassModalProps {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}

export function GlassModal({ children, open, onClose }: GlassModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className={overlayStyle} onClick={onClose}>
      <div className={contentStyle} onClick={(e) => e.stopPropagation()}>
        <div className={glassContent}>{children}</div>
      </div>
    </div>
  );
}
