const REVIEW_STATUS_MAP = {
  user_review: 'running',
  dispatched: 'completed',
  expired: 'failed',
};

export function reviewBadgeClass(status) {
  return REVIEW_STATUS_MAP[status] || 'idle';
}

const PIPELINE_STATUS_MAP = {
  running: 'running',
  executing: 'running',
  verifying: 'running',
  completed: 'completed',
  done: 'completed',
  success: 'completed',
  failed: 'failed',
  blocked: 'failed',
};

export function pipelineBadgeClass(status) {
  return PIPELINE_STATUS_MAP[status] || 'idle';
}
