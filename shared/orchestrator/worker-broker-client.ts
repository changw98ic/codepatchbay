import { isLoopbackHost } from "../network.js";
import { isRecord, type LooseRecord } from "../types.js";
import type { AttemptIdentity } from "./assignment-store.js";
import { assertBrokerArtifactIndex, type BrokerArtifactIndex } from "./artifact-index.js";
import type { WorkerUpdateExpectation } from "./worker-store.js";

type InboxClaim = { assignmentId: string; assignment: LooseRecord; claimToken: string };

type BrokerCredentials = {
  url: string;
  token: string;
  workerId: string;
  incarnationToken: string;
};

type WorkerBrokerClientOptions = {
  fetch?: typeof globalThis.fetch;
};

function contractError(message: string) {
  return Object.assign(new Error(message), { code: "WORKER_BROKER_CONTRACT_INVALID" });
}

function brokerResult<T>(payload: LooseRecord, op: string): T {
  if (payload.ok !== true) {
    throw contractError(`worker broker ${op} success response must declare ok=true`);
  }
  if (!Object.hasOwn(payload, "result")) {
    throw contractError(`worker broker ${op} success envelope missing result`);
  }
  return payload.result as T;
}

function recordResult(value: unknown, op: string): LooseRecord {
  if (!isRecord(value)) throw contractError(`worker broker ${op} result must be an object`);
  return value;
}

function nullableRecordResult(value: unknown, op: string): LooseRecord | null {
  return value === null ? null : recordResult(value, op);
}

function booleanResult(value: unknown, op: string): boolean {
  if (typeof value !== "boolean") throw contractError(`worker broker ${op} result must be a boolean`);
  return value;
}

function voidResult(value: unknown, op: string): void {
  if (value !== null) throw contractError(`worker broker ${op} result must be null`);
}

function jobResult(value: unknown, op: string, expectedJobId?: string): LooseRecord & { jobId: string } {
  const job = recordResult(value, op);
  if (typeof job.jobId !== "string" || !job.jobId) {
    throw contractError(`worker broker ${op} result requires a non-empty jobId`);
  }
  if (expectedJobId && job.jobId !== expectedJobId) {
    throw contractError(`worker broker ${op} result jobId does not match ${expectedJobId}`);
  }
  return job as LooseRecord & { jobId: string };
}

function projectResult(value: unknown, op: string, expectedProjectId: string): LooseRecord & {
  projectId: string;
  sourcePath: string | null;
  projectRuntimeRoot: string;
} {
  const project = recordResult(value, op);
  if (project.projectId !== expectedProjectId) {
    throw contractError(`worker broker ${op} result projectId does not match ${expectedProjectId}`);
  }
  if (project.sourcePath !== null && typeof project.sourcePath !== "string") {
    throw contractError(`worker broker ${op} result sourcePath must be a string or null`);
  }
  if (typeof project.projectRuntimeRoot !== "string" || !project.projectRuntimeRoot) {
    throw contractError(`worker broker ${op} result requires a non-empty projectRuntimeRoot`);
  }
  return project as LooseRecord & { projectId: string; sourcePath: string | null; projectRuntimeRoot: string };
}

function inboxClaimsResult(value: unknown, op: string): InboxClaim[] {
  if (!Array.isArray(value)) throw contractError(`worker broker ${op} result must be an array`);
  return value.map((candidate, index) => {
    const claim = recordResult(candidate, `${op}[${index}]`);
    if (typeof claim.assignmentId !== "string" || !claim.assignmentId
      || typeof claim.claimToken !== "string" || !claim.claimToken
      || !isRecord(claim.assignment)) {
      throw contractError(`worker broker ${op}[${index}] requires assignmentId, claimToken, and assignment`);
    }
    return claim as InboxClaim;
  });
}

function completionResult(value: unknown, op: string): { accepted: boolean; inboxAcked: boolean } {
  const result = recordResult(value, op);
  if (typeof result.accepted !== "boolean" || typeof result.inboxAcked !== "boolean") {
    throw contractError(`worker broker ${op} result requires boolean accepted and inboxAcked`);
  }
  return { accepted: result.accepted, inboxAcked: result.inboxAcked };
}

export class WorkerBrokerClient {
  #url: string;
  #token: string;
  #workerId: string;
  #incarnationToken: string;
  #fetch: typeof globalThis.fetch;

  constructor(credentials: BrokerCredentials, options: WorkerBrokerClientOptions = {}) {
    const endpoint = new URL(credentials.url);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname))) {
      throw new Error("worker broker URL must use HTTPS or loopback HTTP");
    }
    endpoint.pathname = "/internal/worker-state";
    endpoint.search = "";
    endpoint.hash = "";
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(credentials.token)) throw new Error("worker broker token is invalid");
    this.#url = endpoint.toString();
    this.#token = credentials.token;
    this.#workerId = credentials.workerId;
    this.#incarnationToken = credentials.incarnationToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #call(op: string, args: LooseRecord = {}): Promise<unknown> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workerId: this.#workerId,
        incarnationToken: this.#incarnationToken,
        op,
        args,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payloadValue: unknown = await response.json().catch(() => ({}));
    const payload = isRecord(payloadValue) ? payloadValue : {};
    if (!response.ok) {
      throw Object.assign(new Error(String(payload.message || "worker broker request failed")), {
        code: typeof payload.code === "string" ? payload.code : "HUB_WORKER_BROKER_UNAVAILABLE",
        statusCode: response.status,
      });
    }
    return brokerResult<unknown>(payload, op);
  }

  registerWorker(_workerId: string, meta: LooseRecord) { return this.#call("worker.register", { meta }).then((value) => recordResult(value, "worker.register")); }
  updateWorkerIf(_workerId: string, updates: LooseRecord, expected: WorkerUpdateExpectation) { return this.#call("worker.update", { updates, expected }).then((value) => nullableRecordResult(value, "worker.update")); }
  hasInboxWork(_workerId: string) { return this.#call("worker.hasInbox").then((value) => booleanResult(value, "worker.hasInbox")); }
  claimInboxEntries(_workerId: string, _incarnationToken?: string) { return this.#call("inbox.claim").then((value) => inboxClaimsResult(value, "inbox.claim")); }
  completeInboxClaim(_workerId: string, assignmentId: string, claimToken: string) { return this.#call("inbox.ack", { assignmentId, claimToken }).then((value) => booleanResult(value, "inbox.ack")); }
  renewInboxClaim(_workerId: string, assignmentId: string, claimToken: string, _incarnationToken?: string) { return this.#call("inbox.renew", { assignmentId, claimToken }).then((value) => booleanResult(value, "inbox.renew")); }
  getAttempt(assignmentId: string, attempt: number) {
    return this.#call("assignment.attempt", { assignmentId, attempt })
      .then((value) => nullableRecordResult(value, "assignment.attempt"));
  }
  assertActiveAttemptIdentity(assignmentId: string, attempt: number, identity: AttemptIdentity) { return this.#call("assignment.assert", { assignmentId, attempt, identity }).then((value) => recordResult(value, "assignment.assert")); }
  markRunning(assignmentId: string, attempt: number, identity?: AttemptIdentity) { return this.#call("assignment.running", { assignmentId, attempt, identity }).then((value) => voidResult(value, "assignment.running")); }
  recordHeartbeat(assignmentId: string, attempt: number, heartbeat: LooseRecord) { return this.#call("assignment.heartbeat", { assignmentId, attempt, heartbeat }).then((value) => {
    if (value !== null && value !== false) throw contractError("worker broker assignment.heartbeat result must be null or false");
  }); }
  readCancel(assignmentId: string, attempt: number) { return this.#call("assignment.cancel", { assignmentId, attempt }).then((value) => nullableRecordResult(value, "assignment.cancel")); }
  completeAttemptAndAckInbox(assignmentId: string, attempt: number, result: LooseRecord, options: LooseRecord) {
    return this.#call("assignment.complete", { assignmentId, attempt, result, claimToken: options.claimToken })
      .then((value) => completionResult(value, "assignment.complete"));
  }

  getProject(projectId: string) {
    return this.#call("project.get", { projectId }).then((value) => projectResult(value, "project.get", projectId));
  }

  createJob(_cpbRoot: string, input: LooseRecord) {
    return this.#call("job.create", { project: input.project, jobId: input.jobId, input })
      .then((value) => jobResult(value, "job.create", typeof input.jobId === "string" ? input.jobId : undefined));
  }

  startPhase(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.#call("job.startPhase", { project, jobId, options })
      .then((value) => jobResult(value, "job.startPhase", jobId));
  }

  completePhase(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.#call("job.completePhase", { project, jobId, options })
      .then((value) => jobResult(value, "job.completePhase", jobId));
  }

  completeJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.#call("job.complete", { project, jobId, options })
      .then((value) => jobResult(value, "job.complete", jobId));
  }

  failJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.#call("job.fail", { project, jobId, options })
      .then((value) => jobResult(value, "job.fail", jobId));
  }

  blockJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.#call("job.block", { project, jobId, options })
      .then((value) => jobResult(value, "job.block", jobId));
  }

  appendEvent(_cpbRoot: string, project: string, jobId: string, event: LooseRecord) {
    return this.#call("event.append", { project, jobId, event }).then((value) => {
      if (value !== null) recordResult(value, "event.append");
    });
  }

  getArtifactIndex(_cpbRoot: string, project: string, jobId: string) {
    return this.#call("artifact.index", { project, jobId })
      .then((result) => assertBrokerArtifactIndex(result, "worker broker artifact.index")) as Promise<BrokerArtifactIndex>;
  }
}
