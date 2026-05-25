const STATUS_MAP: Record<string, { label: string; icon: string; color: 'success' | 'warning' | 'error' | 'accent' | 'muted' }> = {
  running: { label: 'Running', icon: '▶', color: 'accent' },
  executing: { label: 'Executing', icon: '▶', color: 'accent' },
  completed: { label: 'Completed', icon: '✓', color: 'success' },
  done: { label: 'Done', icon: '✓', color: 'success' },
  success: { label: 'Success', icon: '✓', color: 'success' },
  failed: { label: 'Failed', icon: '✕', color: 'error' },
  error: { label: 'Error', icon: '✕', color: 'error' },
  blocked: { label: 'Blocked', icon: '⏸', color: 'warning' },
  cancelled: { label: 'Cancelled', icon: '⊘', color: 'muted' },
  pending: { label: 'Pending', icon: '○', color: 'muted' },
  queued: { label: 'Queued', icon: '◷', color: 'muted' },
  idle: { label: 'Idle', icon: '–', color: 'muted' },
  available: { label: 'Available', icon: '●', color: 'success' },
  busy: { label: 'Busy', icon: '●', color: 'accent' },
  offline: { label: 'Offline', icon: '○', color: 'muted' },
  researching: { label: 'Researching', icon: '🔍', color: 'accent' },
  user_review: { label: 'Needs Review', icon: '⏳', color: 'warning' },
  approved: { label: 'Approved', icon: '✓', color: 'success' },
  rejected: { label: 'Rejected', icon: '✕', color: 'error' },
  indexed: { label: 'Indexed', icon: '✓', color: 'success' },
};

export function getStatusInfo(status: string) {
  return STATUS_MAP[status] ?? { label: status, icon: '○', color: 'muted' as const };
}

export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return '–';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) return 'just now';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

export function truncateId(id: string, len = 8): string {
  if (!id) return '–';
  return id.length > len ? `…${id.slice(-len)}` : id;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '–';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${(ms / 3600000).toFixed(1)}h`;
}
