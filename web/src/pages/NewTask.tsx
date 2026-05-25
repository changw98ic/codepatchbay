import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { Select } from '@/components/shared/Select';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { useProjectsStore } from '@/app/store';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: space[2],
});

const titleStyle = style({
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.extrabold,
  color: theme.text,
});

const formGrid = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[5],
  maxWidth: 640,
});

const rowStyle = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: space[4],
});

const textareaStyle = style({
  width: '100%',
  padding: `${space[3]} ${space[4]}`,
  fontSize: fontSize.base,
  color: theme.text,
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  borderRadius: '8px',
  outline: 'none',
  resize: 'vertical',
  minHeight: 120,
  lineHeight: 1.6,
  selectors: {
    '&::placeholder': { color: theme.textMuted },
    '&:focus': {
      borderColor: theme.accent,
      boxShadow: `0 0 0 2px ${theme.accentTint}`,
    },
  },
});

const charCount = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  textAlign: 'right',
  marginTop: space[1],
});

const statusMsg = style({
  fontSize: fontSize.sm,
  marginTop: space[3],
});

const statusSuccess = style({
  color: theme.accent,
});

const statusError = style({
  color: theme.error,
});

const emptyProjectHint = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[4]} ${space[5]}`,
  borderRadius: '8px',
  background: theme.warningDim,
  border: `1px solid ${theme.warning}`,
  fontSize: fontSize.sm,
  color: theme.text,
  marginBottom: space[4],
});

const modeCards = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: space[3],
});

const modeCard = style({
  padding: space[4],
  borderRadius: '8px',
  border: `1px solid ${theme.border}`,
  background: theme.surfaceAlt,
  cursor: 'pointer',
  transition: 'all 0.15s',
  selectors: {
    '&:hover': { borderColor: theme.textMuted },
  },
});

const modeCardActive = style({
  borderColor: theme.accent,
  background: theme.accentTint,
});

const modeCardTitle = style({
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[1],
});

const modeCardDesc = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  lineHeight: 1.5,
});

const MIN_DESC_LENGTH = 10;

export default function NewTask() {
  const { t } = useTranslation();
  const { projects, fetchProjects } = useProjectsStore();

  const [project, setProject] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('full');
  const [maxRetries, setMaxRetries] = useState(3);
  const [timeout, setTimeout_] = useState(600);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetchProjects();
  }, []);

  const projectOptions = projects.map((p) => ({ value: p.name, label: p.name }));

  const canSubmit = project && description.trim().length >= MIN_DESC_LENGTH && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    try {
      const endpoint = mode === 'plan'
        ? `/api/tasks/${project}/plan`
        : `/api/tasks/${project}/pipeline`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: description.trim(),
          maxRetries: mode === 'full' ? maxRetries : undefined,
          timeoutSeconds: mode === 'full' ? timeout : undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult({ ok: true, msg: t('task.success') });
    } catch (err) {
      setResult({ ok: false, msg: `${t('task.error')}: ${(err as Error).message}` });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, project, mode, description, maxRetries, timeout, t]);

  return (
    <div>
      <Breadcrumb items={[{ label: t('nav.dashboard'), to: '/' }, { label: t('nav.newTask') }]} />
      <div className={headerStyle}>
        <h2 className={titleStyle}>{t('task.submit')}</h2>
      </div>

      {projects.length === 0 && (
        <div className={emptyProjectHint}>
          <span>⚠️</span>
          <span>{t('task.noProjects')}</span>
        </div>
      )}

      <GlassPanel depth="medium" padding="md">
        <div className={formGrid}>
          <Select
            id="task-project"
            label={t('task.project')}
            options={[{ value: '', label: t('task.selectProject') }, ...projectOptions]}
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />

          <div>
            <label htmlFor="task-desc" style={{ fontSize: 12, color: theme.textDim, fontWeight: 500, display: 'block', marginBottom: 4 }}>
              {t('task.description')}
            </label>
            <textarea
              id="task-desc"
              className={textareaStyle}
              placeholder={t('task.placeholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className={charCount}>
              {description.trim().length < MIN_DESC_LENGTH
                ? t('task.minChars', { min: MIN_DESC_LENGTH, current: description.trim().length })
                : `${description.trim().length} chars`}
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, color: theme.textDim, fontWeight: 500, display: 'block', marginBottom: 8 }}>
              {t('task.mode')}
            </label>
            <div className={modeCards}>
              <div
                className={`${modeCard} ${mode === 'full' ? modeCardActive : ''}`}
                onClick={() => setMode('full')}
                role="button"
                tabIndex={0}
              >
                <div className={modeCardTitle}>🔄 {t('task.fullPipeline')}</div>
                <div className={modeCardDesc}>{t('task.fullPipelineDesc')}</div>
              </div>
              <div
                className={`${modeCard} ${mode === 'plan' ? modeCardActive : ''}`}
                onClick={() => setMode('plan')}
                role="button"
                tabIndex={0}
              >
                <div className={modeCardTitle}>📋 {t('task.planOnly')}</div>
                <div className={modeCardDesc}>{t('task.planOnlyDesc')}</div>
              </div>
            </div>
          </div>

          {mode === 'full' && (
            <div className={rowStyle}>
              <Select
                id="task-retries"
                label={t('task.maxRetries')}
                options={[1, 2, 3, 5].map((n) => ({ value: String(n), label: String(n) }))}
                value={String(maxRetries)}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
              />
              <Input
                id="task-timeout"
                label={t('task.timeout')}
                type="number"
                min={60}
                max={3600}
                value={timeout}
                onChange={(e) => setTimeout_(Number(e.target.value))}
              />
            </div>
          )}

          <Button variant="primary" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? t('task.submitting') : t('task.submit')}
          </Button>

          {result && (
            <div className={`${statusMsg} ${result.ok ? statusSuccess : statusError}`}>
              {result.msg}
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
