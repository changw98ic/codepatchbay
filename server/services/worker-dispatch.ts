import { realpath } from "node:fs/promises";
import path from "node:path";
import { getProject } from "./hub-registry.js";
import {
  assignWorker,
  completeDispatch,
  createDispatch,
  failDispatch,
  getDispatch,
  startDispatch,
} from "./dispatch-state.js";

function dispatchEnabled() {
  return process.env.CPB_WORKER_DISPATCH_ENABLED === "1";
}

export { dispatchEnabled };

export async function guardSourcePath(hubRoot: string, projectId: string, sourcePath?: string) {
  if (!dispatchEnabled()) return;
  if (!sourcePath) throw new Error("sourcePath is required for Hub-dispatched mutations");

  const project = await getProject(hubRoot, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (!project.sourcePath) return;

  const registeredCanonical = await realpath(path.resolve(project.sourcePath));
  const providedCanonical = await realpath(path.resolve(sourcePath));

  if (registeredCanonical !== providedCanonical) {
    throw new Error(
      `sourcePath mismatch: project '${projectId}' registered at ${registeredCanonical}, got ${providedCanonical}`
    );
  }
}

export async function recordDispatch(hubRoot: string, { projectId, sourcePath, sessionId, workerId, queueEntryId }: Record<string, any> = {}) {
  if (!dispatchEnabled()) return null;
  return (createDispatch as any)(hubRoot, { projectId, sourcePath, sessionId, workerId, queueEntryId });
}

export async function lookupDispatch(hubRoot: string, dispatchId: string) {
  return getDispatch(hubRoot, dispatchId);
}

export async function markDispatchAssigned(hubRoot: string, dispatchId: string, { workerId }: { workerId?: string } = {}) {
  if (!dispatchEnabled()) return null;
  return (assignWorker as any)(hubRoot, dispatchId, { workerId });
}

export async function markDispatchStarted(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return startDispatch(hubRoot, dispatchId);
}

export async function markDispatchCompleted(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return completeDispatch(hubRoot, dispatchId);
}

export async function markDispatchFailed(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return failDispatch(hubRoot, dispatchId);
}
