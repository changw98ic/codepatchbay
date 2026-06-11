// @ts-nocheck
export const WorkerState = Object.freeze({
  STARTING: "starting",
  READY: "ready",
  ASSIGNED: "assigned",
  RUNNING: "running",
  DRAINING: "draining",
  EXITED: "exited",
  UNHEALTHY: "unhealthy",
  QUARANTINED: "quarantined",
});

export const AssignmentState = Object.freeze({
  SCHEDULED: "scheduled",
  ASSIGNED: "assigned",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  ORPHANED: "orphaned",
  RETRYING: "retrying",
  BLOCKED: "blocked",
});
