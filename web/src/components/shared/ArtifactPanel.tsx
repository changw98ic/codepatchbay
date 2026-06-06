import { useCallback, useEffect, useState } from 'react';
import { style } from '@vanilla-extract/css';
import { Badge } from '@/components/shared/Badge';
import type { ArtifactIndexEntry, JobArtifactDetailResponse } from '@/types/api';
import { theme } from '@/styles/theme.css';
import { space, fontSize, fontWeight } from '@/design-system/tokens';

const panelStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[3],
});

const sectionLabel = style({
  fontSize: fontSize.xs,
  fontWeight: fontWeight.semibold,
  color: theme.textMuted,
  textTransform: 'uppercase',
  letterSpacing: 0,
  marginBottom: space[1],
});

const verdictRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '8px',
  border: `1px solid ${theme.border}`,
  background: theme.surfaceAlt,
});

const metaText = style({
  fontSize: fontSize.xs,
  color: theme.textDim,
  lineHeight: 1.5,
});

const artifactList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: space[1],
});

const artifactRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '6px',
  border: `1px solid ${theme.border}`,
  background: theme.surfaceAlt,
});

const artifactRowBroken = style({
  borderColor: theme.warning,
  background: theme.warningDim,
});

const artifactKind = style({
  fontSize: fontSize.xs,
  fontWeight: fontWeight.medium,
  color: theme.text,
  minWidth: 76,
  textTransform: 'capitalize',
});

const artifactPath = style({
  fontSize: fontSize.xs,
  color: theme.textDim,
  fontFamily: 'monospace',
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const warningBox = style({
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '6px',
  border: `1px solid ${theme.warning}`,
  background: theme.warningDim,
  fontSize: fontSize.xs,
  color: theme.warning,
});

const emptyStyle = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  padding: space[2],
});

function verdictVariant(status: string): 'success' | 'error' | 'warning' | 'muted' {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pass') return 'success';
  if (normalized === 'fail') return 'error';
  if (normalized === 'partial' || normalized === 'inconclusive' || normalized === 'infra_error') return 'warning';
  return 'muted';
}

function artifactName(entry: ArtifactIndexEntry): string {
  return String(entry.path || entry.id || entry.kind || 'artifact').split(/[\\/]/).pop() || 'artifact';
}

interface ArtifactPanelProps {
  project: string;
  jobId: string;
  apiBase?: string;
}

export function ArtifactPanel({ project, jobId, apiBase = '/api/tasks' }: ArtifactPanelProps) {
  const [data, setData] = useState<JobArtifactDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchArtifacts = useCallback(async () => {
    if (!project || !jobId) return;
    setLoading(true);
    setError(null);
    try {
      const url = `${apiBase}/${encodeURIComponent(project)}/jobs/${encodeURIComponent(jobId)}/artifacts`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load artifacts');
    } finally {
      setLoading(false);
    }
  }, [apiBase, jobId, project]);

  useEffect(() => {
    fetchArtifacts();
  }, [fetchArtifacts]);

  if (loading) return <div className={emptyStyle}>Loading artifacts...</div>;
  if (error) return <div className={warningBox}>{error}</div>;
  if (!data) return null;

  const entries = data.artifactIndex?.entries || [];
  const warnings = data.warnings || [];

  return (
    <div className={panelStyle}>
      <div>
        <div className={sectionLabel}>Verdict</div>
        {data.verdict ? (
          <>
            <div className={verdictRow}>
              <Badge variant={verdictVariant(data.verdict.status)}>{data.verdict.status}</Badge>
              {data.verdict.confidence != null && <span className={metaText}>confidence: {data.verdict.confidence}</span>}
              {data.verdict.blockingCount > 0 && <span className={metaText}>{data.verdict.blockingCount} blocking</span>}
            </div>
            {data.verdict.reason && <div className={metaText}>{data.verdict.reason}</div>}
          </>
        ) : (
          <div className={emptyStyle}>No verdict available</div>
        )}
      </div>

      {warnings.length > 0 && (
        <div>
          <div className={sectionLabel}>Warnings</div>
          <div className={artifactList}>
            {warnings.map((warning, index) => (
              <div key={warning.id || `${warning.kind}-${index}`} className={warningBox}>
                {warning.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className={sectionLabel}>Artifacts ({entries.length})</div>
        {entries.length === 0 ? (
          <div className={emptyStyle}>No artifacts found</div>
        ) : (
          <div className={artifactList}>
            {entries.map((entry) => (
              <div key={`${entry.kind}-${entry.phase || 'none'}-${entry.id}`} className={`${artifactRow} ${entry.broken ? artifactRowBroken : ''}`}>
                <span className={artifactKind}>{entry.kind}</span>
                <span className={artifactPath}>{artifactName(entry)}</span>
                {entry.phase && <Badge variant="muted">{entry.phase}</Badge>}
                <Badge variant={entry.broken ? 'warning' : 'success'}>{entry.broken ? 'broken' : 'ok'}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
