import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/shared/Badge';
import { Button } from '@/components/shared/Button';
import { Toggle } from '@/components/shared/Toggle';
import { Breadcrumb } from '@/components/shared/Breadcrumb';
import { useLogsStore, useWebSocketStore } from '@/app/store';
import type { LogAppendMessage } from '@/types/websocket';
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

const controlsRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  marginBottom: space[4],
  flexWrap: 'wrap',
});

const filterGroup = style({
  display: 'flex',
  gap: space[2],
});

const filterBtn = style({
  padding: `${space[1]} ${space[3]}`,
  fontSize: fontSize.xs,
  borderRadius: '6px',
  border: `1px solid ${theme.border}`,
  background: 'transparent',
  color: theme.textMuted,
  cursor: 'pointer',
  transition: 'all 0.15s',
  selectors: {
    '&:hover': { borderColor: theme.textMuted, color: theme.text },
  },
});

const filterBtnActive = style({
  background: theme.accentTint,
  borderColor: theme.accent,
  color: theme.accentLight,
});

const connectionBadge = style({
  fontSize: fontSize.xs,
  display: 'flex',
  alignItems: 'center',
  gap: space[2],
});

const dotConnected = style({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: theme.success,
  display: 'inline-block',
});

const dotDisconnected = style({
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: theme.error,
  display: 'inline-block',
});

const searchInput = style({
  padding: `${space[2]} ${space[3]}`,
  fontSize: fontSize.xs,
  borderRadius: '6px',
  border: `1px solid ${theme.border}`,
  background: theme.surfaceAlt,
  color: theme.text,
  outline: 'none',
  width: 200,
  selectors: {
    '&::placeholder': { color: theme.textMuted },
    '&:focus': { borderColor: theme.accent },
  },
});

const logContainer = style({
  padding: space[4],
  borderRadius: '8px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  fontFamily: 'monospace',
  fontSize: fontSize.xs,
  lineHeight: 1.8,
  maxHeight: 'calc(100vh - 320px)',
  minHeight: 300,
  overflowY: 'auto',
  position: 'relative',
});

const logLine = style({
  display: 'flex',
  gap: space[3],
  padding: `${space[1]} ${space[2]}`,
  borderRadius: '4px',
  transition: 'background 0.1s',
  selectors: {
    '&:hover': { background: theme.surfaceHover },
  },
});

const logLineError = style({
  background: theme.errorDim,
});

const logTimestamp = style({
  color: theme.textMuted,
  flexShrink: 0,
  fontSize: 11,
});

const logSource = style({
  color: theme.textDim,
  flexShrink: 0,
  minWidth: 60,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const logMessage = style({
  color: theme.text,
  flex: 1,
  wordBreak: 'break-word',
});

const scrollToBottomBtn = style({
  position: 'absolute',
  bottom: space[4],
  right: space[4],
  padding: `${space[2]} ${space[3]}`,
  borderRadius: '6px',
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  color: theme.textDim,
  fontSize: fontSize.xs,
  cursor: 'pointer',
  transition: 'all 0.15s',
  selectors: {
    '&:hover': { borderColor: theme.accent, color: theme.accentLight },
  },
});

const emptyStyle = style({
  textAlign: 'center' as const,
  padding: space[8],
  color: theme.textMuted,
  fontSize: fontSize.sm,
});

function levelColor(level: string): string {
  if (level === 'error') return theme.error;
  if (level === 'warn') return '#f5a623';
  return theme.textDim;
}

export default function Logs() {
  const { t } = useTranslation();
  const { levelFilter, autoScroll, clear, setLevelFilter, setAutoScroll, filtered } = useLogsStore();
  const { subscribe, connected } = useWebSocketStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const unsub = subscribe('log:append', (msg) => {
      useLogsStore.getState().append(msg as LogAppendMessage);
    });
    return unsub;
  }, [subscribe]);

  const rawEntries = filtered();

  const displayEntries = useMemo(() => {
    if (!searchQuery.trim()) return rawEntries;
    const q = searchQuery.toLowerCase();
    return rawEntries.filter(
      (e) => e.message.toLowerCase().includes(q) || (e.source && e.source.toLowerCase().includes(q)),
    );
  }, [rawEntries, searchQuery]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayEntries.length, autoScroll]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 100);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  const filterLevels: Array<'all' | 'info' | 'warn' | 'error'> = ['all', 'info', 'warn', 'error'];

  const handleClear = useCallback(() => {
    clear();
  }, [clear]);

  return (
    <div>
      <Breadcrumb items={[{ label: t('nav.dashboard'), to: '/' }, { label: t('logs.title') }]} />
      <div className={headerStyle}>
        <div>
          <h2 className={titleStyle}>{t('logs.title')}</h2>
          <p style={{ fontSize: fontSize.xs, color: theme.textMuted, marginTop: space[1] }}>
            {t('logs.subtitle')}
          </p>
        </div>
        <div className={connectionBadge}>
          <span className={connected ? dotConnected : dotDisconnected} />
          <span style={{ color: theme.textMuted }}>
            {connected ? t('logs.connected') : t('logs.disconnected')}
          </span>
        </div>
      </div>

      <div className={controlsRow}>
        <div className={filterGroup}>
          {filterLevels.map((level) => (
            <button
              key={level}
              className={`${filterBtn} ${levelFilter === level ? filterBtnActive : ''}`}
              onClick={() => setLevelFilter(level)}
              type="button"
            >
              {t(`logs.${level}`)}
            </button>
          ))}
        </div>
        <input
          className={searchInput}
          placeholder={t('logs.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          type="text"
        />
        <Toggle label={t('logs.autoScroll')} active={autoScroll} onChange={setAutoScroll} />
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={handleClear}>{t('logs.clear')}</Button>
      </div>

      {displayEntries.length === 0 ? (
        <div className={emptyStyle}>{t('logs.noLogs')}</div>
      ) : (
        <div style={{ position: 'relative' }}>
          <div ref={containerRef} className={logContainer} onScroll={handleScroll}>
            {displayEntries.map((entry, i) => (
              <div key={i} className={`${logLine} ${entry.level === 'error' ? logLineError : ''}`}>
                <span className={logTimestamp}>
                  {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}
                </span>
                <Badge variant={entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warning' : 'muted'}>
                  {entry.level}
                </Badge>
                {entry.source && (
                  <span className={logSource} style={{ color: levelColor(entry.level) }}>
                    {entry.source}
                  </span>
                )}
                <span className={logMessage} style={{ color: entry.level === 'error' ? theme.error : theme.text }}>
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
          {showScrollBtn && !autoScroll && (
            <button className={scrollToBottomBtn} onClick={scrollToBottom} type="button">
              ↓ {t('logs.scrollToBottom')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
