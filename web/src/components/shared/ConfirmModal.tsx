import { GlassModal } from '@/components/glass/GlassModal';
import { Button } from '@/components/shared/Button';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const titleStyle = style({
  fontSize: fontSize.lg,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[2],
});

const msgStyle = style({
  fontSize: fontSize.sm,
  color: theme.textDim,
  lineHeight: 1.6,
  marginBottom: space[6],
});

const actionsStyle = style({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: space[3],
});

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'primary',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <GlassModal open={open} onClose={onCancel}>
      <div className={titleStyle}>{title}</div>
      <div className={msgStyle}>{message}</div>
      <div className={actionsStyle}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant={variant} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </GlassModal>
  );
}
