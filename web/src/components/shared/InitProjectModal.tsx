import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassModal } from '@/components/glass/GlassModal';
import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const titleStyle = style({
  fontSize: fontSize.lg,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[4],
});

const formStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[4],
  marginBottom: space[6],
});

const msgStyle = style({
  fontSize: fontSize.sm,
  lineHeight: 1.6,
});

const msgSuccess = style({ color: theme.success });
const msgError = style({ color: theme.error });

const actionsStyle = style({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: space[3],
});

interface InitProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function InitProjectModal({ open, onClose, onSuccess }: InitProjectModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const canSubmit = name.trim() && path.trim() && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/projects/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), path: path.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult({ ok: true, msg: t('project.initSuccess') });
      onSuccess();
    } catch (err) {
      setResult({ ok: false, msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, name, path, t, onSuccess]);

  const handleClose = () => {
    setName('');
    setPath('');
    setResult(null);
    onClose();
  };

  return (
    <GlassModal open={open} onClose={handleClose}>
      <div className={titleStyle}>{t('project.initProject')}</div>
      <div className={formStyle}>
        <Input
          id="init-name"
          label={t('project.initName')}
          placeholder="my-project"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          id="init-path"
          label={t('project.initPath')}
          placeholder="/path/to/project"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </div>
      {result && (
        <div className={`${msgStyle} ${result.ok ? msgSuccess : msgError}`}>
          {result.msg}
        </div>
      )}
      <div className={actionsStyle}>
        <Button variant="ghost" onClick={handleClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? t('task.submitting') : t('project.initProject')}
        </Button>
      </div>
    </GlassModal>
  );
}
