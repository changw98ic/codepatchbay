import path from "node:path";

export const SDD_TRACE_SCHEMA_VERSION = 1;

export function sddDir(cpbRoot, project) {
  return path.join(path.resolve(cpbRoot), "wiki", "projects", project, "sdd");
}

export function sddTracePath(cpbRoot, project) {
  return path.join(sddDir(cpbRoot, project), "trace.json");
}

export function defaultSddTrace(project, { status = "initialized", ts = new Date().toISOString() } = {}) {
  return {
    schemaVersion: SDD_TRACE_SCHEMA_VERSION,
    traceId: `sdd-${project}`,
    project,
    workflow: "sdd-standard",
    planMode: "parent",
    status,
    artifacts: {
      spec: "spec.md",
      design: "design.md",
      tasks: "tasks.md",
    },
    createdAt: ts,
    updatedAt: ts,
  };
}

export function sddQueueMetadata(trace) {
  return {
    workflow: trace.workflow || "sdd-standard",
    planMode: trace.planMode || "parent",
    sddTrace: {
      schemaVersion: trace.schemaVersion || SDD_TRACE_SCHEMA_VERSION,
      traceId: trace.traceId,
      project: trace.project,
      status: trace.status,
      artifacts: trace.artifacts || {},
    },
  };
}
