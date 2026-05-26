import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Input } from '@/components/shared/Input';
import { Badge } from '@/components/shared/Badge';
import { PipelineStatus } from '@/components/project/PipelineStatus';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight, radius, transition } from '@/design-system/tokens';

const filterBarStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  marginBottom: space[5],
  flexWrap: 'wrap',
});

const pillsStyle = style({
  display: 'flex',
  gap: space[1],
  alignItems: 'center',
});

const pillBase = style({
  padding: `${space[1]} ${space[3]}`,
  fontSize: fontSize.xs,
  fontWeight: fontWeight.medium,
  borderRadius: radius.full,
  border: `1px solid ${theme.border}`,
  background: 'transparent',
  color: theme.textDim,
  cursor: 'pointer',
  transition: transition.fast,
  selectors: {
    '&.active': {
      background: theme.accentTint,
      borderColor: theme.accent,
      color: theme.accentLight,
    },
    '&:hover': {
      borderColor: theme.textMuted,
    },
  },
});

const gridStyle = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: space[4],
});

const cardLink = style({
  textDecoration: 'none',
  color: 'inherit',
  display: 'block',
  height: '100%',
});

const cardHeaderStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  marginBottom: space[2],
  flexWrap: 'wrap',
});

const cardTitle = style({
  fontSize: fontSize.base,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  flex: 1,
});

const cardStats = style({
  display: 'flex',
  gap: space[4],
  fontSize: fontSize.xs,
  color: theme.textMuted,
  marginTop: space[3],
});

const emptyStyle = style({
  textAlign: 'center',
  padding: space[8],
  color: theme.textMuted,
  fontSize: fontSize.base,
});

function formatAge(ageMs: number | undefined | null): string | null {
  if (ageMs == null) return null;
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m`;
  return `${(ageMs / 3600000).toFixed(1)}h`;
}

interface ProjectData {
  id?: string;
  name: string;
  pipelineState?: { status: string; phase?: string; error?: string; nodes?: Array<{ id: string; phase?: string; status?: string; durationMs?: number; attempt?: number; error?: string; reason?: string }>; phases?: string[]; retryCount?: number };
  workerDerivedStatus?: string;
  worker?: { status: string };
  inbox?: number;
  outputs?: number;
  _pollution?: { visibility: string };
}

interface ProjectGridProps {
  primaryProjects: ProjectData[];
  secondaryProjects: ProjectData[];
  diagnostics?: boolean;
  workerAgeById?: Map<string, { ageMs: number }>;
}

type FilterKey = 'all' | 'active' | 'failed' | 'completed' | 'blocked';

export function ProjectGrid({ primaryProjects, secondaryProjects, diagnostics, workerAgeById }: ProjectGridProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');

  const filters: { key: FilterKey; label: string }[] = [
    { key: 'all', label: t('dashboard.all') },
    { key: 'active', label: t('dashboard.running') },
    { key: 'failed', label: t('dashboard.failed') },
    { key: 'completed', label: t('dashboard.completedRuns') },
    { key: 'blocked', label: t('dashboard.blockedProjects') },
  ];

  const filterProject = (p: ProjectData): boolean => {
    if (search) {
      const q = search.toLowerCase();
      if (!(p.name || p.id || '').toLowerCase().includes(q)) return false;
    }
    if (filter !== 'all') {
      const ps = p.pipelineState?.status;
      const ws = p.workerDerivedStatus || p.worker?.status;
      if (filter === 'active') return ps === 'running' || ps === 'executing' || ws === 'working';
      if (filter === 'failed') return ps === 'failed' || ws === 'failed';
      if (filter === 'completed') return ps === 'completed' || ps === 'done';
      if (filter === 'blocked') return ps === 'failed' || ps === 'blocked';
    }
    return true;
  };

  const filteredPrimary = primaryProjects.filter(filterProject);
  const filteredSecondary = secondaryProjects.filter(filterProject);
  const hasProjects = primaryProjects.length > 0 || secondaryProjects.length > 0;
  const hasResults = filteredPrimary.length > 0 || filteredSecondary.length > 0;

  const renderCard = (p: ProjectData, isSecondary = false) => {
    const workerStatus = p.workerDerivedStatus || p.worker?.status;
    const age = workerAgeById?.get(p.id ?? p.name)?.ageMs;

    return (
      <Link to={`/project/${p.name || p.id}`} key={p.id ?? p.name} className={cardLink}>
        <GlassPanel depth="shallow" padding="md" interactive>
          <div className={cardHeaderStyle}>
            <span className={cardTitle}>{p.name || p.id}</span>
            {workerStatus && <Badge variant={workerStatus === 'failed' ? 'error' : 'muted'}>{workerStatus}</Badge>}
            {p.pipelineState?.status && (
              <Badge variant={
                p.pipelineState.status === 'completed' ? 'success' :
                p.pipelineState.status === 'failed' ? 'error' :
                p.pipelineState.status === 'running' ? 'accent' : 'muted'
              }>
                {t(`status.${p.pipelineState.status}`, p.pipelineState.status)}
              </Badge>
            )}
            {age != null && <Badge variant="muted">{formatAge(age)}</Badge>}
            {isSecondary && <Badge variant="muted">{t('dashboard.secondary')}</Badge>}
            {diagnostics && p._pollution?.visibility === 'test' && <Badge variant="warning">test</Badge>}
          </div>
          <PipelineStatus state={p.pipelineState ?? null} />
          <div className={cardStats}>
            <span>{t('project.inbox')}: {p.inbox ?? 0}</span>
            <span>{t('project.outputs')}: {p.outputs ?? 0}</span>
          </div>
        </GlassPanel>
      </Link>
    );
  };

  return (
    <>
      {hasProjects && (
        <div className={filterBarStyle}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input
              placeholder={t('dashboard.projects') + '...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className={pillsStyle}>
            {filters.map((f) => (
              <button
                key={f.key}
                className={`${pillBase} ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
                type="button"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!hasProjects ? (
        <div className={emptyStyle}>
          <p>{t('dashboard.noProjectsDesc')}</p>
        </div>
      ) : !hasResults ? (
        <div className={emptyStyle}>
          <p>{t('dashboard.noProjects')}{' '}
            <button className={pillBase} onClick={() => { setSearch(''); setFilter('all'); }} type="button">
              {t('common.reset', 'Reset')}
            </button>
          </p>
        </div>
      ) : (
        <div className={gridStyle}>
          {filteredPrimary.map((p) => renderCard(p))}
          {filteredSecondary.map((p) => renderCard(p, true))}
        </div>
      )}
    </>
  );
}
