import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GlassPanel } from '@/components/glass/GlassPanel';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Tabs } from '@/components/shared/Tabs';
import { Toggle } from '@/components/shared/Toggle';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { useProjectsStore, useWebSocketStore } from '@/app/store';
import { getStatusInfo } from '@/utils/format';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const headerStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  marginBottom: space[2],
  flexWrap: 'wrap',
});

const titleStyle = style({
  fontSize: fontSize['2xl'],
  fontWeight: fontWeight.bold,
  color: theme.text,
  flex: 1,
});

const overviewGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: space[4],
  marginBottom: space[6],
});

const indexInfoGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: space[3],
});

const indexInfoItem = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const indexLabel = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
});

const workflowBoard = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: space[4],
  marginBottom: space[6],
});

const laneStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[2],
});

const laneHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: theme.textDim,
  padding: `${space[2]} 0`,
  borderBottom: `1px solid ${theme.border}`,
});

const taskCard = style({
  padding: space[3],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  cursor: 'pointer',
  transition: 'border-color 0.15s',
  selectors: {
    '&:hover': { borderColor: theme.textMuted },
  },
});

const taskCardActive = style({
  borderColor: theme.accent,
});

const taskTitle = style({
  fontSize: fontSize.sm,
  color: theme.text,
  marginBottom: space[1],
});

const taskMeta = style({
  display: 'flex',
  gap: space[3],
  fontSize: fontSize.xs,
  color: theme.textMuted,
});

const fileBrowser = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[3],
});

const fileBrowserTabs = style({
  display: 'flex',
  gap: space[2],
  marginBottom: space[2],
});

const fileList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
  maxHeight: 240,
  overflowY: 'auto' as const,
});

const fileItem = style({
  padding: `${space[1]} ${space[3]}`,
  fontSize: fontSize.xs,
  borderRadius: '6px',
  border: 'none',
  background: 'transparent',
  color: theme.textDim,
  cursor: 'pointer',
  textAlign: 'left' as const,
  width: '100%',
  transition: 'background 0.15s',
  selectors: {
    '&:hover': { background: theme.surfaceAlt },
  },
});

const fileItemActive = style({
  background: theme.accentTint,
  color: theme.accentLight,
});

const filePreview = style({
  marginTop: space[3],
  padding: space[4],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  fontSize: fontSize.xs,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap' as const,
  maxHeight: 320,
  overflowY: 'auto' as const,
  color: theme.textDim,
});

const knowledgeGrid = style({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: space[4],
});

const settingsRow = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: `${space[4]} 0`,
  borderBottom: `1px solid ${theme.border}`,
  gap: space[4],
});

const settingsInfo = style({
  flex: 1,
});

const settingsTitle = style({
  fontSize: fontSize.sm,
  fontWeight: fontWeight.semibold,
  color: theme.text,
  marginBottom: space[1],
});

const settingsDesc = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  lineHeight: 1.5,
});

const drilldownPane = style({
  marginTop: space[4],
  padding: space[4],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
});

const drilldownHeader = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: space[3],
});

const mutedStyle = style({
  fontSize: fontSize.sm,
  color: theme.textMuted,
  lineHeight: 1.6,
});

const emptyStyle = style({
  textAlign: 'center' as const,
  padding: space[6],
  color: theme.textMuted,
  fontSize: fontSize.sm,
});

const showMoreBtn = style({
  fontSize: fontSize.xs,
  color: theme.accent,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: `${space[2]} 0`,
});

const actionBarStyle = style({
  display: 'flex',
  gap: space[3],
  marginBottom: space[4],
  flexWrap: 'wrap',
});

const statusLine = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  fontSize: fontSize.sm,
  color: theme.textDim,
  marginBottom: space[4],
});

// Pipeline node graph styles
const pipelineGraph = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[3]} 0`,
  flexWrap: 'wrap',
});

const pipelineNode = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  border: `1px solid ${theme.border}`,
  background: theme.surfaceAlt,
  fontSize: fontSize.xs,
  fontWeight: fontWeight.medium,
  transition: 'all 0.2s',
});

const nodeCompleted = style({
  borderColor: theme.success,
  background: theme.successDim,
  color: theme.success,
});

const nodeRunning = style({
  borderColor: theme.accent,
  background: theme.accentTint,
  color: theme.accentLight,
});

const nodeFailed = style({
  borderColor: theme.error,
  background: theme.errorDim,
  color: theme.error,
});

const nodePending = style({
  color: theme.textMuted,
});

const nodeIcon = style({
  width: 16,
  height: 16,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
});

const connector = style({
  width: 24,
  height: 2,
  background: theme.border,
  flexShrink: 0,
  position: 'relative',
});

const connectorDone = style({
  background: theme.success,
});

interface ParsedTask {
  id: string;
  title: string;
  state: 'open' | 'in_progress' | 'done';
  stateLabel: string;
  sourceLine: number;
  description: string;
}

function parseTasksFromMarkdown(markdown: string | null | undefined): ParsedTask[] {
  if (!markdown) return [];
  return markdown.split('\n').reduce<ParsedTask[]>((list, line, index) => {
    const match = line.match(/^\s*-\s*\[([ x/])\]\s*(.*)$/i);
    if (match) {
      const checked = match[1].toLowerCase();
      const state = checked === 'x' ? 'done' : checked === '/' ? 'in_progress' : 'open';
      list.push({
        id: `task-${index}`,
        title: match[2].trim(),
        state,
        stateLabel: state === 'done' ? 'Done' : state === 'in_progress' ? 'In Progress' : 'Open',
        sourceLine: index + 1,
        description: 'Parsed from project task markdown.',
      });
    }
    return list;
  }, []);
}

function useCappedList<T>(items: T[], cap: number, deps: unknown[]) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, deps);
  const displayed = showAll ? items : items.slice(0, cap);
  return { displayed, showAll, toggle: () => setShowAll((v) => !v), hasMore: items.length > cap };
}

const KNOWN_PHASES = ['plan', 'execute', 'verify'];
const PHASE_ICONS: Record<string, string> = { plan: '📋', execute: '⚡', verify: '✅' };

function PipelineGraph({ state }: { state: {
  status?: string;
  phase?: string;
  phases?: string[];
  nodes?: Array<{ id: string; phase?: string; status?: string }>;
  retryCount?: number;
} | null | undefined }) {
  if (!state) return null;

  if (state.nodes && state.nodes.length > 0) {
    return (
      <div className={pipelineGraph}>
        {state.nodes.map((node, i) => {
          const status = node.status ?? 'pending';
          const nodeClass = status === 'completed' || status === 'success' ? nodeCompleted
            : status === 'running' || status === 'executing' ? nodeRunning
            : status === 'failed' || status === 'error' ? nodeFailed
            : nodePending;
          return (
            <span key={node.id} style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
              {i > 0 && <span className={`${connector} ${(state.nodes?.[i - 1]?.status === 'completed' || state.nodes?.[i - 1]?.status === 'success') ? connectorDone : ''}`} />}
              <span className={`${pipelineNode} ${nodeClass}`}>
                <span className={nodeIcon}>{PHASE_ICONS[node.phase ?? ''] ?? '○'}</span>
                {(node.phase ?? node.id).charAt(0).toUpperCase() + (node.phase ?? node.id).slice(1)}
              </span>
            </span>
          );
        })}
      </div>
    );
  }

  const phases = state.phases?.length ? state.phases : KNOWN_PHASES;
  const currentIdx = phases.indexOf(state.phase ?? '');

  return (
    <div className={pipelineGraph}>
      {phases.map((phase, i) => {
        let nodeClass = nodePending;
        if (currentIdx >= 0) {
          if (i < currentIdx) nodeClass = nodeCompleted;
          else if (i === currentIdx) {
            nodeClass = state.status === 'failed' ? nodeFailed
              : state.status === 'running' ? nodeRunning
              : nodeRunning;
          }
        }
        const connectorClass = i > 0 && (currentIdx >= 0 && i <= currentIdx) ? connectorDone : '';
        return (
          <span key={phase} style={{ display: 'flex', alignItems: 'center', gap: space[2] }}>
            {i > 0 && <span className={`${connector} ${connectorClass}`} />}
            <span className={`${pipelineNode} ${nodeClass}`}>
              <span className={nodeIcon}>{PHASE_ICONS[phase] ?? '○'}</span>
              {phase.charAt(0).toUpperCase() + phase.slice(1)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export default function Project() {
  const { t } = useTranslation();
  const { name } = useParams<{ name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'overview';
  const selectedFilePath = searchParams.get('file') || null;

  const [fileType, setFileType] = useState<'inbox' | 'outputs'>('inbox');
  const [selectedTask, setSelectedTask] = useState<ParsedTask | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);

  const [autoSync, setAutoSync] = useState(() => {
    try { return localStorage.getItem('cpb-settings-autoSync') !== 'false'; } catch { return true; }
  });
  const [writeback, setWriteback] = useState(() => {
    try { return localStorage.getItem('cpb-settings-writeback') === 'true'; } catch { return false; }
  });
  const [diagnostics, setDiagnostics] = useState(() => {
    try { return localStorage.getItem('cpb-settings-diagnostics') === 'true'; } catch { return false; }
  });

  const { getProject, loading } = useProjectsStore();
  const { subscribe } = useWebSocketStore();
  const project = getProject(name ?? '');

  const toggleSetting = useCallback((key: string, current: boolean, setter: (v: boolean) => void) => {
    const next = !current;
    setter(next);
    try { localStorage.setItem(`cpb-settings-${key}`, String(next)); } catch {}
  }, []);

  const setTab = useCallback((newTab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      next.delete('file');
      return next;
    }, { replace: true });
    setSelectedTask(null);
  }, [setSearchParams]);

  const setSelectedFile = useCallback((f: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (f) next.set('file', f); else next.delete('file');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Fetch file list
  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    fetch(`/api/projects/${name}/${fileType}`, { signal: controller.signal })
      .then((r) => r.json())
      .then(setFiles)
      .catch(() => setFiles([]));
    return () => controller.abort();
  }, [fileType, name]);

  // Fetch file content
  useEffect(() => {
    if (!name || !selectedFilePath) { setFileContent(null); return; }
    const controller = new AbortController();
    fetch(`/api/projects/${name}/files/${selectedFilePath}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => setFileContent(data.content))
      .catch(() => setFileContent(null));
    return () => controller.abort();
  }, [selectedFilePath, name]);

  // WS subscriptions
  useEffect(() => {
    if (!name) return;
    const unsub1 = subscribe('pipeline:update', (msg: Record<string, unknown>) => {
      if (msg.project === name) {
        // Project state will be updated via store refetch
      }
    });
    const unsub2 = subscribe('file:created', () => {
      fetch(`/api/projects/${name}/${fileType}`)
        .then((r) => r.json())
        .then(setFiles)
        .catch(() => {});
    });
    return () => { unsub1(); unsub2(); };
  }, [subscribe, name, fileType]);

  const { displayed: displayFiles, showAll: showAllFiles, toggle: toggleFiles, hasMore: hasMoreFiles } =
    useCappedList(files, 5, [fileType]);

  const parsedTasks = useMemo(() => parseTasksFromMarkdown((project as unknown as Record<string, unknown>)?.tasks as string | undefined), [project]);
  const lanes = useMemo(() => [
    { id: 'open' as const, title: t('project.open') },
    { id: 'in_progress' as const, title: t('project.inProgress') },
    { id: 'done' as const, title: t('project.done') },
  ], [t]);

  const tabItems = useMemo(() => [
    { key: 'overview', label: t('project.overview') },
    { key: 'tasks', label: t('project.tasks') },
    { key: 'knowledge', label: t('project.knowledge') },
    { key: 'settings', label: t('project.settings') },
  ], [t]);

  if (loading) return <div className={mutedStyle}>{t('app.loading')}</div>;
  if (!project) return <div className={emptyStyle}>{t('project.notFound')}</div>;

  const idxState = project.projectIndex?.state;
  const idxBranch = project.projectIndex?.branch;

  return (
    <div>
      <Breadcrumb items={[
        { label: t('nav.dashboard'), to: '/' },
        { label: name ?? '' },
      ]} />
      <div className={headerStyle}>
        <h2 className={titleStyle}>{name}</h2>
        {project.projectIndex && (
          <Badge variant={idxState === 'indexed' ? 'success' : idxState === 'error' ? 'error' : 'muted'}>
            idx:{idxState}{idxBranch ? ` (${idxBranch})` : ''}
          </Badge>
        )}
      </div>

      {project.pipelineState && (
        <div className={statusLine}>
          <PipelineGraph state={project.pipelineState} />
          <span style={{ color: theme.textMuted }}>
            {getStatusInfo(project.pipelineState.status ?? '').icon}{' '}
            {getStatusInfo(project.pipelineState.status ?? '').label}
            {project.pipelineState.phase && ` — ${project.pipelineState.phase}`}
          </span>
        </div>
      )}

      <div className={actionBarStyle}>
        <Button variant="primary" size="sm" onClick={() => {
          fetch(`/api/tasks/${name}/pipeline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction: `Full pipeline run for ${name}` }),
          }).then(() => useProjectsStore.getState().fetchProjects());
        }}>
          ▶ {t('project.runPipeline')}
        </Button>
        <Button variant="default" size="sm" onClick={() => {
          fetch(`/api/tasks/${name}/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction: `Plan for ${name}` }),
          }).then(() => useProjectsStore.getState().fetchProjects());
        }}>
          📋 {t('project.planOnly')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => {
          fetch(`/api/projects/${name}/index`, { method: 'POST' })
            .then(() => useProjectsStore.getState().fetchProjects());
        }}>
          🔄 {t('project.refreshIndex')}
        </Button>
      </div>

      <Tabs items={tabItems} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div>
          <div className={overviewGrid}>
            <GlassPanel depth="shallow" padding="md">
              <h4 style={{ marginBottom: 8, fontWeight: 600 }}>{t('project.narrative')}</h4>
              <p className={mutedStyle}>
                <strong>{name}</strong>
                {project.projectIndex ? (
                  <> {t('project.indexInfo', { branch: idxBranch || 'unknown', state: idxState || 'unknown' })}</>
                ) : (
                  <> {t('project.noIndex')}</>
                )}
              </p>
              <p className={mutedStyle}>
                {t('project.fileCountInfo', { count: files.length })}
              </p>
            </GlassPanel>

            <GlassPanel depth="shallow" padding="md">
              <h4 style={{ marginBottom: 12, fontWeight: 600 }}>{t('project.codebaseIndex')}</h4>
              {project.projectIndex ? (
                <div className={indexInfoGrid}>
                  <div className={indexInfoItem}>
                    <span className={indexLabel}>{t('project.state')}</span>
                    <Badge variant={idxState === 'indexed' ? 'success' : 'muted'}>
                      {idxState || 'unknown'}
                    </Badge>
                  </div>
                  <div className={indexInfoItem}>
                    <span className={indexLabel}>{t('project.branch')}</span>
                    <code style={{ fontSize: fontSize.xs }}>{idxBranch || 'unknown'}</code>
                  </div>
                  {project.projectIndex.fileCount != null && (
                    <div className={indexInfoItem}>
                      <span className={indexLabel}>{t('project.filesIndexed')}</span>
                      <span style={{ fontSize: fontSize.sm }}>{project.projectIndex.fileCount}</span>
                    </div>
                  )}
                </div>
              ) : (
                <p className={mutedStyle}>{t('project.noIndexAvailable')}</p>
              )}
            </GlassPanel>
          </div>

          <GlassPanel depth="shallow" padding="md">
            <h4 style={{ marginBottom: 8, fontWeight: 600 }}>{t('project.liveActivity')}</h4>
            <pre className={filePreview} style={{ maxHeight: 200 }}>
              {project.recentLog?.join('\n') || t('project.noLogs')}
            </pre>
          </GlassPanel>
        </div>
      )}

      {tab === 'tasks' && (
        <div>
          <div className={workflowBoard}>
            {lanes.map((lane) => {
              const laneTasks = parsedTasks.filter((t) => t.state === lane.id);
              return (
                <div key={lane.id} className={laneStyle}>
                  <div className={laneHeader}>
                    <span>{lane.title}</span>
                    <Badge variant="muted">{laneTasks.length}</Badge>
                  </div>
                  {laneTasks.map((task) => (
                    <div
                      key={task.id}
                      className={`${taskCard} ${selectedTask?.id === task.id ? taskCardActive : ''}`}
                      onClick={() => setSelectedTask(task)}
                    >
                      <div className={taskTitle}>{task.title}</div>
                      <div className={taskMeta}>
                        <span>{task.stateLabel}</span>
                        <span>{t('project.line')} {task.sourceLine}</span>
                      </div>
                    </div>
                  ))}
                  {laneTasks.length === 0 && (
                    <p style={{ fontSize: fontSize.xs, color: theme.textMuted, padding: space[2] }}>—</p>
                  )}
                </div>
              );
            })}
          </div>

          {selectedTask && (
            <div className={drilldownPane}>
              <div className={drilldownHeader}>
                <h4 style={{ fontWeight: 600 }}>{selectedTask.title}</h4>
                <Button variant="ghost" onClick={() => setSelectedTask(null)}>{t('common.close')}</Button>
              </div>
              <p className={mutedStyle}>{selectedTask.description}</p>
              <div style={{ display: 'flex', gap: space[4], marginTop: space[2], fontSize: fontSize.xs, color: theme.textMuted }}>
                <span>{t('project.state')}: {selectedTask.stateLabel}</span>
                <span>{t('project.line')}: {selectedTask.sourceLine}</span>
              </div>
            </div>
          )}

          <GlassPanel depth="shallow" padding="md" style={{ marginTop: space[6] }}>
            <h4 style={{ marginBottom: 12, fontWeight: 600 }}>{t('project.deliverables')}</h4>
            <div className={fileBrowserTabs}>
              <Button variant={fileType === 'inbox' ? 'primary' : 'ghost'} onClick={() => setFileType('inbox')}>
                {t('project.inbox')}
              </Button>
              <Button variant={fileType === 'outputs' ? 'primary' : 'ghost'} onClick={() => setFileType('outputs')}>
                {t('project.outputs')}
              </Button>
            </div>
            <div className={fileBrowser}>
              <div className={fileList}>
                {files.length === 0 ? (
                  <p className={emptyStyle}>{t('project.noFiles', { type: fileType })}</p>
                ) : (
                  displayFiles.map((f) => (
                    <button
                      key={f}
                      className={`${fileItem} ${selectedFilePath === `${fileType}/${f}` ? fileItemActive : ''}`}
                      onClick={() => setSelectedFile(`${fileType}/${f}`)}
                      type="button"
                    >
                      {f}
                    </button>
                  ))
                )}
              </div>
              {hasMoreFiles && (
                <button className={showMoreBtn} onClick={toggleFiles} type="button">
                  {showAllFiles ? t('project.showLess') : t('project.showAll', { count: files.length })}
                </button>
              )}
              {selectedFilePath && (
                <div>
                  <h5 style={{ fontSize: fontSize.xs, color: theme.textMuted, margin: '8px 0' }}>{selectedFilePath}</h5>
                  <pre className={filePreview}>{fileContent ?? t('project.noContent')}</pre>
                </div>
              )}
            </div>
          </GlassPanel>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className={knowledgeGrid}>
          <GlassPanel depth="shallow" padding="md">
            <h4 style={{ marginBottom: 8, fontWeight: 600 }}>{t('project.context')}</h4>
            <pre className={filePreview}>{(project as unknown as Record<string, unknown>).context as string || t('project.noContent')}</pre>
          </GlassPanel>
          <GlassPanel depth="shallow" padding="md">
            <h4 style={{ marginBottom: 8, fontWeight: 600 }}>{t('project.decisions')}</h4>
            <pre className={filePreview}>{(project as unknown as Record<string, unknown>).decisions as string || t('project.noContent')}</pre>
          </GlassPanel>
        </div>
      )}

      {tab === 'settings' && (
        <GlassPanel depth="shallow" padding="md">
          <div className={settingsRow}>
            <div className={settingsInfo}>
              <div className={settingsTitle}>{t('project.autoSync')}</div>
              <div className={settingsDesc}>{t('project.autoSyncDesc')}</div>
            </div>
            <Toggle active={autoSync} onChange={() => toggleSetting('autoSync', autoSync, setAutoSync)} />
          </div>
          <div className={settingsRow}>
            <div className={settingsInfo}>
              <div className={settingsTitle}>{t('project.writeback')}</div>
              <div className={settingsDesc}>{t('project.writebackDesc')}</div>
            </div>
            <Toggle active={writeback} onChange={() => toggleSetting('writeback', writeback, setWriteback)} />
          </div>
          <div className={settingsRow}>
            <div className={settingsInfo}>
              <div className={settingsTitle}>{t('project.diagnostics')}</div>
              <div className={settingsDesc}>{t('project.diagnosticsDesc')}</div>
            </div>
            <Toggle active={diagnostics} onChange={() => toggleSetting('diagnostics', diagnostics, setDiagnostics)} />
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
