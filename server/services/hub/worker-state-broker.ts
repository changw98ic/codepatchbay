import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { AssignmentStore, type AttemptIdentity } from "../../../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../../../shared/orchestrator/worker-store.js";
import { isRecord, type LooseRecord } from "../../../core/contracts/types.js";
import { getProject } from "./hub-registry.js";
import {
  blockJob,
  completeJob,
  completePhase,
  createJob,
  failJob,
  startPhase,
} from "../job/job-store.js";
import { appendEvent } from "../event/event-store.js";
import { buildArtifactIndex } from "../job/job-projection.js";
import type { EventRecord } from "../event/event-types.js";

const MAX_BROKER_BODY_BYTES = 4 * 1024 * 1024;
const MUTATING_BROKER_OPERATIONS = new Set([
  "worker.register", "worker.update",
  "inbox.claim", "inbox.ack", "inbox.renew",
  "assignment.running", "assignment.heartbeat", "assignment.complete",
  "job.create", "job.startPhase", "job.completePhase", "job.complete", "job.fail", "job.block",
  "event.append", "artifact.index",
]);

function brokerError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest();
}

function bearerToken(headers: IncomingHttpHeaders) {
  const value = typeof headers.authorization === "string" ? headers.authorization : "";
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{43,256})$/);
  return match?.[1] || null;
}

function pick(source: LooseRecord, keys: string[]) {
  const result: LooseRecord = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  return result;
}

export async function readWorkerBrokerBody(request: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += value.length;
    if (size > MAX_BROKER_BODY_BYTES) throw brokerError("HUB_WORKER_BROKER_REQUEST_TOO_LARGE", "worker broker request is too large", 413);
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw brokerError("HUB_WORKER_BROKER_REQUEST_INVALID", "worker broker request is not valid JSON", 400);
  }
  if (!isRecord(parsed)) throw brokerError("HUB_WORKER_BROKER_REQUEST_INVALID", "worker broker request must be an object", 400);
  return parsed;
}

export async function handleWorkerStateBroker({
  cpbRoot,
  hubRoot,
  headers,
  body,
  beforeMutation,
}: {
  cpbRoot: string;
  hubRoot: string;
  headers: IncomingHttpHeaders;
  body: LooseRecord;
  beforeMutation?: (context: { workerId: string; op: string }) => Promise<void>;
}) {
  const token = bearerToken(headers);
  const workerId = typeof body.workerId === "string" ? body.workerId : "";
  const incarnationToken = typeof body.incarnationToken === "string" ? body.incarnationToken : "";
  const op = typeof body.op === "string" ? body.op : "";
  if (!token || !workerId || !incarnationToken || !op) {
    throw brokerError("HUB_WORKER_BROKER_AUTHENTICATION_REQUIRED", "valid worker broker credentials are required", 401);
  }
  const workers = new WorkerStore(hubRoot);
  const assignments = new AssignmentStore(hubRoot);
  const worker = await workers.getWorker(workerId);
  const expectedHash = typeof worker?.brokerTokenHash === "string" ? Buffer.from(worker.brokerTokenHash, "hex") : Buffer.alloc(0);
  const actualHash = tokenHash(token);
  if (worker?.incarnationToken !== incarnationToken || expectedHash.length !== actualHash.length
    || !timingSafeEqual(expectedHash, actualHash)) {
    throw brokerError("HUB_WORKER_BROKER_AUTHENTICATION_REQUIRED", "valid worker broker credentials are required", 401);
  }
  if (["exited", "exhausted", "restarting"].includes(String(worker.status || ""))) {
    throw brokerError("HUB_WORKER_BROKER_AUTHENTICATION_REQUIRED", "worker broker credential is no longer active", 401);
  }
  const args: LooseRecord = isRecord(body.args) ? body.args as LooseRecord : {};
  const assignmentId = String(args.assignmentId || "");
  if (op.startsWith("assignment.")) {
    const active = assignmentId ? await assignments.getActiveAttempt(assignmentId) : null;
    if (!active || active.workerId !== workerId) {
      throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "assignment is not owned by this worker incarnation", 403);
    }
  }

  let jobScope: {
    assignment: LooseRecord;
    active: LooseRecord;
    project: LooseRecord;
    projectId: string;
    dataRoot: string;
    jobId: string;
  } | null = null;
  if (/^(?:project|job|event|artifact)\./.test(op)) {
    const activeAssignmentId = typeof worker.currentAssignmentId === "string" ? worker.currentAssignmentId : "";
    const assignment = activeAssignmentId ? await assignments.getAssignment(activeAssignmentId) : null;
    const active = activeAssignmentId ? await assignments.getActiveAttempt(activeAssignmentId) : null;
    if (!assignment || !active || active.workerId !== workerId
      || active.attemptToken !== worker.currentAttemptToken) {
      throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "worker has no active assignment scope", 403);
    }
    const projectId = String(assignment.projectId || "");
    if (!projectId || projectId !== String(worker.projectId || "")) {
      throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "assignment project does not match worker scope", 403);
    }
    const project = await getProject(hubRoot, projectId);
    const dataRoot = typeof project?.projectRuntimeRoot === "string" ? project.projectRuntimeRoot : "";
    if (!project || !dataRoot) {
      throw brokerError("HUB_WORKER_BROKER_PROJECT_UNAVAILABLE", "worker project runtime root is unavailable", 409);
    }
    const attempt = Number(active.attempt);
    const expectedJobId = `job-${String(assignment.entryId || "")}${attempt > 1 ? `-a${attempt}` : ""}`;
    const requestedProject = String(args.projectId || args.project || "");
    const input = isRecord(args.input) ? args.input as LooseRecord : {};
    const requestedJobId = String(args.jobId || input.jobId || expectedJobId);
    if ((requestedProject && requestedProject !== projectId) || requestedJobId !== expectedJobId) {
      throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "job operation is outside the active assignment scope", 403);
    }
    jobScope = { assignment, active, project, projectId, dataRoot, jobId: expectedJobId };
  }

  const scopedJob = () => {
    if (!jobScope) throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "job scope is required", 403);
    return jobScope;
  };
  if (MUTATING_BROKER_OPERATIONS.has(op)) await beforeMutation?.({ workerId, op });
  switch (op) {
    case "worker.register":
      return await workers.registerWorker(workerId, {
        ...pick(isRecord(args.meta) ? args.meta as LooseRecord : {}, ["pid", "host", "status", "startedAt", "lastHeartbeatAt"]),
        projectId: worker.projectId ?? null,
        brokerTokenHash: worker.brokerTokenHash,
        incarnationToken,
      });
    case "worker.update": {
      const updates = pick(isRecord(args.updates) ? args.updates as LooseRecord : {}, [
        "status", "currentAssignmentId", "currentAttemptToken", "lastHeartbeatAt", "exitSignal", "exitCode",
      ]);
      const expected = pick(isRecord(args.expected) ? args.expected as LooseRecord : {}, [
        "status", "currentAssignmentId", "currentAttemptToken",
      ]);
      return await workers.updateWorkerIf(workerId, updates, { ...expected, incarnationToken });
    }
    case "worker.hasInbox": return await workers.hasInboxWork(workerId);
    case "inbox.claim": return await workers.claimInboxEntries(workerId, incarnationToken);
    case "inbox.ack": return await workers.completeInboxClaim(workerId, String(args.assignmentId || ""), String(args.claimToken || ""));
    case "inbox.renew": return await workers.renewInboxClaim(workerId, String(args.assignmentId || ""), String(args.claimToken || ""), incarnationToken);
    case "assignment.assert":
      return await assignments.assertActiveAttemptIdentity(assignmentId, Number(args.attempt), isRecord(args.identity) ? args.identity as AttemptIdentity : {} as AttemptIdentity);
    case "assignment.running":
      return await assignments.markRunning(assignmentId, Number(args.attempt), isRecord(args.identity) ? args.identity as AttemptIdentity : undefined);
    case "assignment.heartbeat":
      return await assignments.recordHeartbeat(assignmentId, Number(args.attempt), isRecord(args.heartbeat) ? args.heartbeat : {});
    case "assignment.cancel": return await assignments.readCancel(assignmentId, Number(args.attempt));
    case "assignment.complete":
      return await assignments.completeAttemptAndAckInbox(
        assignmentId, Number(args.attempt), isRecord(args.result) ? args.result : {},
        { workerId, claimToken: String(args.claimToken || "") },
      );
    case "project.get": {
      const scope = scopedJob();
      return pick(scope.project, ["projectId", "sourcePath", "projectRuntimeRoot"]);
    }
    case "job.create": {
      const scope = scopedJob();
      const input = isRecord(args.input) ? args.input as LooseRecord : {};
      return await createJob(cpbRoot, {
        ...pick(input, [
          "ts", "executor", "indexSnapshot", "indexFreshness", "planCache",
          "routingCategory", "routing", "agentAvailability", "teamPolicy",
        ]),
        project: scope.projectId,
        jobId: scope.jobId,
        task: typeof scope.assignment.task === "string" ? scope.assignment.task : "",
        workflow: typeof scope.assignment.workflow === "string" ? scope.assignment.workflow : "standard",
        planMode: typeof scope.assignment.planMode === "string" ? scope.assignment.planMode : null,
        sourceContext: isRecord(scope.assignment.sourceContext) || typeof scope.assignment.sourceContext === "string"
          ? scope.assignment.sourceContext
          : null,
        queueEntryId: String(scope.assignment.entryId || ""),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof createJob>[1]);
    }
    case "job.startPhase": {
      const scope = scopedJob();
      return await startPhase(cpbRoot, scope.projectId, scope.jobId, {
        ...pick(isRecord(args.options) ? args.options : {}, ["phase", "attempt", "leaseId", "ts", "acpProfile", "uiLane", "uiLaneReason"]),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof startPhase>[3]);
    }
    case "job.completePhase": {
      const scope = scopedJob();
      return await completePhase(cpbRoot, scope.projectId, scope.jobId, {
        ...pick(isRecord(args.options) ? args.options : {}, ["phase", "artifact", "ts"]),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof completePhase>[3]);
    }
    case "job.complete": {
      const scope = scopedJob();
      return await completeJob(cpbRoot, scope.projectId, scope.jobId, {
        ...pick(isRecord(args.options) ? args.options : {}, ["ts"]),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof completeJob>[3]);
    }
    case "job.fail": {
      const scope = scopedJob();
      return await failJob(cpbRoot, scope.projectId, scope.jobId, {
        ...pick(isRecord(args.options) ? args.options : {}, ["reason", "code", "phase", "retryable", "retryCount", "cause", "ts"]),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof failJob>[3]);
    }
    case "job.block": {
      const scope = scopedJob();
      return await blockJob(cpbRoot, scope.projectId, scope.jobId, {
        ...pick(isRecord(args.options) ? args.options : {}, ["reason", "code", "kind", "cause", "ts"]),
        dataRoot: scope.dataRoot,
      } as Parameters<typeof blockJob>[3]);
    }
    case "event.append": {
      const scope = scopedJob();
      const event = isRecord(args.event) ? args.event as EventRecord : {} as EventRecord;
      return await appendEvent(cpbRoot, scope.projectId, scope.jobId, {
        ...event,
        jobId: scope.jobId,
        project: scope.projectId,
      }, { dataRoot: scope.dataRoot });
    }
    case "artifact.index": {
      const scope = scopedJob();
      return await buildArtifactIndex(cpbRoot, scope.projectId, scope.jobId, { dataRoot: scope.dataRoot });
    }
    default: throw brokerError("HUB_WORKER_BROKER_OPERATION_DENIED", "worker broker operation is not allowed", 403);
  }
}
