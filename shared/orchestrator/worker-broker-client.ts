import { isLoopbackHost } from "../network.js";
import type { LooseRecord } from "../types.js";
import type { AttemptIdentity } from "./assignment-store.js";
import type { WorkerUpdateExpectation } from "./worker-store.js";

type InboxClaim = { assignmentId: string; assignment: LooseRecord; claimToken: string };

type BrokerCredentials = {
  url: string;
  token: string;
  workerId: string;
  incarnationToken: string;
};

export class WorkerBrokerClient {
  #url: string;
  #token: string;
  #workerId: string;
  #incarnationToken: string;

  constructor(credentials: BrokerCredentials) {
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
  }

  async call<T = unknown>(op: string, args: LooseRecord = {}): Promise<T> {
    const response = await fetch(this.#url, {
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
    const payload = await response.json().catch(() => ({})) as LooseRecord;
    if (!response.ok) {
      throw Object.assign(new Error(String(payload.message || "worker broker request failed")), {
        code: typeof payload.code === "string" ? payload.code : "HUB_WORKER_BROKER_UNAVAILABLE",
        statusCode: response.status,
      });
    }
    return payload.result as T;
  }

  registerWorker(_workerId: string, meta: LooseRecord) { return this.call<LooseRecord>("worker.register", { meta }); }
  updateWorkerIf(_workerId: string, updates: LooseRecord, expected: WorkerUpdateExpectation) { return this.call<LooseRecord | null>("worker.update", { updates, expected }); }
  hasInboxWork(_workerId: string) { return this.call<boolean>("worker.hasInbox"); }
  claimInboxEntries(_workerId: string, _incarnationToken?: string) { return this.call<InboxClaim[]>("inbox.claim"); }
  completeInboxClaim(_workerId: string, assignmentId: string, claimToken: string) { return this.call<boolean>("inbox.ack", { assignmentId, claimToken }); }
  renewInboxClaim(_workerId: string, assignmentId: string, claimToken: string, _incarnationToken?: string) { return this.call<boolean>("inbox.renew", { assignmentId, claimToken }); }
  assertActiveAttemptIdentity(assignmentId: string, attempt: number, identity: AttemptIdentity) { return this.call<LooseRecord>("assignment.assert", { assignmentId, attempt, identity }); }
  markRunning(assignmentId: string, attempt: number, identity?: AttemptIdentity) { return this.call<void>("assignment.running", { assignmentId, attempt, identity }); }
  recordHeartbeat(assignmentId: string, attempt: number, heartbeat: LooseRecord) { return this.call<void>("assignment.heartbeat", { assignmentId, attempt, heartbeat }); }
  readCancel(assignmentId: string, attempt: number) { return this.call<LooseRecord | null>("assignment.cancel", { assignmentId, attempt }); }
  completeAttemptAndAckInbox(assignmentId: string, attempt: number, result: LooseRecord, options: LooseRecord) {
    return this.call<{ accepted: boolean; inboxAcked: boolean }>("assignment.complete", { assignmentId, attempt, result, claimToken: options.claimToken });
  }

  getProject(projectId: string) {
    return this.call<LooseRecord>("project.get", { projectId });
  }

  createJob(_cpbRoot: string, input: LooseRecord) {
    return this.call<LooseRecord>("job.create", { project: input.project, jobId: input.jobId, input });
  }

  startPhase(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.call<LooseRecord>("job.startPhase", { project, jobId, options });
  }

  completePhase(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.call<LooseRecord>("job.completePhase", { project, jobId, options });
  }

  completeJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.call<LooseRecord>("job.complete", { project, jobId, options });
  }

  failJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.call<LooseRecord>("job.fail", { project, jobId, options });
  }

  blockJob(_cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
    return this.call<LooseRecord>("job.block", { project, jobId, options });
  }

  appendEvent(_cpbRoot: string, project: string, jobId: string, event: LooseRecord) {
    return this.call<unknown>("event.append", { project, jobId, event });
  }

  getArtifactIndex(_cpbRoot: string, project: string, jobId: string) {
    return this.call<LooseRecord>("artifact.index", { project, jobId });
  }
}
