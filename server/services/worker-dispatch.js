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

export async function guardSourcePath(hubRoot, projectId, sourcePath) {
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

export async function recordDispatch(hubRoot, { projectId, sourcePath, sessionId, workerId, queueEntryId } = {}) {
  if (!dispatchEnabled()) return null;
  return createDispatch(hubRoot, { projectId, sourcePath, sessionId, workerId, queueEntryId });
}

export async function lookupDispatch(hubRoot, dispatchId) {
  return getDispatch(hubRoot, dispatchId);
}

export async function markDispatchAssigned(hubRoot, dispatchId, { workerId } = {}) {
  if (!dispatchEnabled()) return null;
  return assignWorker(hubRoot, dispatchId, { workerId });
}

export async function markDispatchStarted(hubRoot, dispatchId) {
  if (!dispatchEnabled()) return null;
  return startDispatch(hubRoot, dispatchId);
}

export async function markDispatchCompleted(hubRoot, dispatchId) {
  if (!dispatchEnabled()) return null;
  return completeDispatch(hubRoot, dispatchId);
}

export async function markDispatchFailed(hubRoot, dispatchId) {
  if (!dispatchEnabled()) return null;
  return failDispatch(hubRoot, dispatchId);
}
