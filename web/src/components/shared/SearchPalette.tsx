import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { style } from '@vanilla-extract/css';
import { theme } from '@/styles/theme.css';
import { space, fontSize, zIndex } from '@/design-system/tokens';
import { useProjectsStore } from '@/app/store';

const overlayStyle = style({
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  display: 'flex',
  justifyContent: 'center',
  paddingTop: '15vh',
  zIndex: zIndex.modal,
});

const paletteStyle = style({
  width: '100%',
  maxWidth: 560,
  maxHeight: '60vh',
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: '12px',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
});

const inputStyle = style({
  width: '100%',
  padding: `${space[4]} ${space[5]}`,
  fontSize: fontSize.base,
  color: theme.text,
  background: 'transparent',
  border: 'none',
  borderBottom: `1px solid ${theme.border}`,
  outline: 'none',
  selectors: {
    '&::placeholder': { color: theme.textMuted },
  },
});

const listStyle = style({
  overflowY: 'auto',
  padding: `${space[2]} 0`,
});

const itemStyle = style({
  display: 'flex',
  alignItems: 'center',
  gap: space[3],
  padding: `${space[3]} ${space[5]}`,
  cursor: 'pointer',
  transition: 'background 0.1s',
  selectors: {
    '&:hover': { background: theme.surfaceHover },
  },
});

const itemActive = style({
  background: theme.accentTint,
});

const itemLabel = style({
  fontSize: fontSize.sm,
  color: theme.text,
  flex: 1,
});

const itemType = style({
  fontSize: fontSize.xs,
  color: theme.textMuted,
  padding: `${space[1]} ${space[2]}`,
  borderRadius: '4px',
  background: theme.surfaceAlt,
});

const shortcutStyle = style({
  display: 'flex',
  gap: space[1],
  fontSize: fontSize.xs,
  color: theme.textMuted,
  padding: `${space[2]} ${space[5]}`,
  borderTop: `1px solid ${theme.border}`,
});

const kbdStyle = style({
  padding: '1px 6px',
  borderRadius: '4px',
  background: theme.surfaceAlt,
  border: `1px solid ${theme.border}`,
  fontSize: fontSize.xs,
  fontFamily: 'inherit',
});

interface SearchItem {
  id: string;
  label: string;
  type: string;
  to: string;
}

const NAV_ITEMS: SearchItem[] = [
  { id: 'nav-dashboard', label: 'Dashboard', type: 'page', to: '/' },
  { id: 'nav-newtask', label: 'New Task', type: 'page', to: '/new-task' },
  { id: 'nav-review', label: 'Review', type: 'page', to: '/review' },
  { id: 'nav-agents', label: 'Agents', type: 'page', to: '/agents' },
  { id: 'nav-logs', label: 'Logs', type: 'page', to: '/logs' },
];

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { projects } = useProjectsStore();

  const projectItems: SearchItem[] = useMemo(
    () => projects.map((p) => ({
      id: `proj-${p.name}`,
      label: p.name,
      type: 'project',
      to: `/project/${p.name}`,
    })),
    [projects],
  );

  const allItems = useMemo(() => [...NAV_ITEMS, ...projectItems], [projectItems]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase();
    return allItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.type.toLowerCase().includes(q),
    );
  }, [query, allItems]);

  useEffect(() => {
    setActiveIdx(0);
  }, [filtered]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    },
    [open],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const select = useCallback(
    (item: SearchItem) => {
      navigate(item.to);
      setOpen(false);
      setQuery('');
    },
    [navigate],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[activeIdx]) {
        select(filtered[activeIdx]);
      }
    },
    [filtered, activeIdx, select],
  );

  if (!open) return null;

  return (
    <div className={overlayStyle} onClick={() => setOpen(false)}>
      <div className={paletteStyle} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={inputStyle}
          placeholder="Search pages, projects..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <div className={listStyle}>
          {filtered.map((item, i) => (
            <div
              key={item.id}
              className={`${itemStyle} ${i === activeIdx ? itemActive : ''}`}
              onClick={() => select(item)}
              onMouseEnter={() => setActiveIdx(i)}
            >
              <span className={itemLabel}>{item.label}</span>
              <span className={itemType}>{item.type}</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: space[6], textAlign: 'center', color: theme.textMuted, fontSize: fontSize.sm }}>
              No results found
            </div>
          )}
        </div>
        <div className={shortcutStyle}>
          <kbd className={kbdStyle}>↑↓</kbd> navigate
          <kbd className={kbdStyle}>↵</kbd> select
          <kbd className={kbdStyle}>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
