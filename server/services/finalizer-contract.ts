import { createHash } from "node:crypto";

import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
import { normalizeGithubRemoteCapability } from "./github/github-remote-capability.js";

export const FINALIZER_MUTATION_RECEIPT_SCHEMA = "cpb.finalizer-mutation-receipt.v1";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function objectId(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^[0-9a-f]{40,64}$/.test(normalized) ? normalized : null;
}

function sha256Text(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function sha256Identity(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^sha256:[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function isoTimestamp(value: unknown) {
  const normalized = text(value);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === normalized
    ? normalized
    : null;
}

function canonicalPrincipal(value: unknown) {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const stableId = text(value.stableId);
  const login = text(value.login)?.toLowerCase() || null;
  if ((kind !== "github_app" && kind !== "gh_user") || !stableId || !login) return null;
  const authorId = typeof value.authorId === "number" && Number.isSafeInteger(value.authorId) && value.authorId > 0
    ? String(value.authorId)
    : typeof value.authorId === "string" && /^[1-9][0-9]*$/.test(value.authorId)
      ? value.authorId
      : null;
  return { kind, stableId, login, ...(authorId ? { authorId } : {}) };
}

function canonicalFenceDigest(value: unknown) {
  if (!isRecord(value)) return null;
  const processIdentity = isRecord(value.processIdentity) ? value.processIdentity : {};
  const attemptToken = text(value.attemptToken);
  const normalized: LooseRecord = {
    assignmentId: text(value.assignmentId),
    entryId: text(value.entryId),
    attemptTokenHash: attemptToken ? digest(attemptToken) : null,
    orchestratorEpoch: integer(value.orchestratorEpoch),
    workerId: text(value.workerId),
    workerIncarnation: text(value.workerIncarnation),
    processIdentity: {
      pid: integer(processIdentity.pid),
      startTimeTicks: text(processIdentity.startTimeTicks),
      ...(text(processIdentity.bootId) ? { bootId: text(processIdentity.bootId) } : {}),
    },
  };
  if (
    !normalized.assignmentId
    || !normalized.entryId
    || !normalized.attemptTokenHash
    || !normalized.orchestratorEpoch
    || !normalized.workerId
    || !normalized.workerIncarnation
    || !(normalized.processIdentity as LooseRecord).pid
    || !(normalized.processIdentity as LooseRecord).startTimeTicks
  ) return null;
  return digest(normalized);
}

function operationReceipt(value: unknown, operation: string) {
  if (!isRecord(value)) return null;
  if (
    value.operation !== operation
    || value.committed !== true
    || value.attempted !== true
    || !isoTimestamp(value.observedAt)
    || !sha256Text(value.eventId)
  ) return null;
  return value;
}

function sourceReceiptMatches(result: LooseRecord, source: LooseRecord) {
  const receipt = isRecord(result.sourceSync) ? result.sourceSync : null;
  const commit = objectId(result.commit);
  return Boolean(
    receipt
    && receipt.committed === true
    && receipt.clean === true
    && text(receipt.expectedBranch) === text(source.branch)
    && text(receipt.previousHead)?.toLowerCase() === text(source.head)?.toLowerCase()
    && objectId(receipt.expectedHead) === commit
    && text(receipt.actualBranch) === text(source.branch)
    && objectId(receipt.actualHead) === commit
  );
}

function failure(reason: string) {
  return { ok: false as const, reason };
}

export function validateFinalizerMutationReceipt(
  result: unknown,
  expected: { mode: "remote" | "pr"; binding: LooseRecord },
): { ok: true; receipt: LooseRecord } | { ok: false; reason: string } {
  if (!isRecord(result) || !isRecord(expected) || !isRecord(expected.binding)) {
    return failure("finalizer mutation receipt input is not an object");
  }
  if (result.ok !== true || result.mode !== expected.mode || !text(result.jobId)) {
    return failure("finalizer mutation receipt has an invalid success identity");
  }
  const binding = expected.binding;
  if (text(result.jobId) !== text(binding.jobId)) {
    return failure("finalizer mutation receipt job identity does not match the expected assignment");
  }
  const source = isRecord(binding.source) ? binding.source : {};
  const worktree = isRecord(binding.worktree) ? binding.worktree : {};
  const candidate = isRecord(binding.candidate) ? binding.candidate : {};
  const principal = canonicalPrincipal(binding.principal);
  const receiptPrincipal = canonicalPrincipal(result.principal);
  if (!principal || !receiptPrincipal || digest(principal) !== digest(receiptPrincipal)) {
    return failure("finalizer mutation receipt principal does not match the resolved transport");
  }
  let capability;
  try {
    capability = normalizeGithubRemoteCapability(binding.capability);
  } catch {
    return failure("finalizer mutation receipt binding has no valid capability");
  }
  const expectedSourceBranch = text(source.branch);
  const expectedSourceHead = objectId(source.head);
  const candidateBase = objectId(candidate.baseSha);
  const candidateHead = objectId(candidate.headSha);
  const candidateTree = objectId(candidate.treeHash);
  const candidateIdentity = sha256Identity(candidate.identityHash);
  const candidateReplay = isRecord(candidate.cleanReplay) ? candidate.cleanReplay : {};
  const expectedTargetBranch = text(binding.targetBranch)
    || (expected.mode === "remote" ? expectedSourceBranch : text(worktree.branch));
  const expectedPreRemoteHead = Object.hasOwn(binding, "preRemoteHead")
    ? (binding.preRemoteHead === null ? null : objectId(binding.preRemoteHead))
    : expected.mode === "remote" ? expectedSourceHead : null;
  const commit = objectId(result.commit);
  const tree = objectId(result.tree);
  if (!text(binding.originJobId) || !expectedSourceBranch || !expectedSourceHead || !expectedTargetBranch
    || !candidateBase || !candidateHead || !candidateTree || !candidateIdentity
    || candidateBase !== expectedSourceHead
    || !commit || !tree || tree !== candidateTree
    || candidateReplay.cleanApply !== true
    || objectId(candidateReplay.baseSha) !== candidateBase
    || objectId(candidateReplay.expectedTreeHash) !== candidateTree
    || objectId(candidateReplay.actualTreeHash) !== candidateTree
    || (expected.mode === "remote" && !expectedPreRemoteHead)) {
    return failure("finalizer mutation receipt expected source/target/candidate binding is incomplete");
  }
  const intent = isRecord(result.remoteIntent) ? result.remoteIntent : null;
  if (!intent || intent.schema !== FINALIZER_MUTATION_RECEIPT_SCHEMA) {
    return failure("finalizer mutation receipt has no canonical journal receipt");
  }
  const claim = isRecord(intent.claim) ? intent.claim : {};
  const takeover = isRecord(claim.takeover) ? claim.takeover : null;
  const claimPolicy = binding.claimPolicy === "durable-observation"
    ? "durable-observation"
    : "current-fence";
  const acceptedOwnerDigest = text(binding.acceptedOwnerDigest)?.toLowerCase() || null;
  const fenceDigest = claimPolicy === "durable-observation"
    ? (/^[0-9a-f]{64}$/.test(acceptedOwnerDigest || "") ? acceptedOwnerDigest : null)
    : canonicalFenceDigest(binding.mutationFence);
  const expectedFinalizationId = digest({
    schema: FINALIZER_MUTATION_RECEIPT_SCHEMA,
    project: text(binding.project),
    entryId: text(binding.entryId),
    originJobId: text(binding.originJobId),
    mode: expected.mode,
    repository: capability.repository,
    issueNumber: capability.issueNumber,
    capabilityDigest: digest(capability),
    principal,
    source: { branch: expectedSourceBranch, head: expectedSourceHead },
    commit,
    tree,
    preRemoteHead: expectedPreRemoteHead,
    targetBranch: expectedTargetBranch,
  });
  if (
    text(intent.finalizationId)?.toLowerCase() !== expectedFinalizationId
    || !integer(intent.generation)
    || text(intent.project) !== text(binding.project)
    || text(intent.entryId) !== text(binding.entryId)
    || text(intent.originJobId) !== text(binding.originJobId)
    || intent.mode !== expected.mode
    || intent.repository !== capability.repository
    || intent.issueNumber !== capability.issueNumber
    || intent.capabilityDigest !== digest(capability)
    || digest(canonicalPrincipal(intent.principal)) !== digest(principal)
    || !sha256Text(claim.claimId)
    || !integer(claim.claimGeneration)
    || !fenceDigest
    || claim.ownerDigest !== fenceDigest
    || !isRecord(intent.source)
    || text(intent.source.branch) !== expectedSourceBranch
    || objectId(intent.source.head) !== expectedSourceHead
    || intent.targetBranch !== expectedTargetBranch
    || (intent.preRemoteHead === null ? null : objectId(intent.preRemoteHead)) !== expectedPreRemoteHead
    || (takeover !== null && (
      !["owner-dead", "explicit-handoff"].includes(String(takeover.kind || ""))
      || !sha256Text(takeover.previousClaimId)
      || !sha256Text(takeover.evidenceId)
      || !isoTimestamp(takeover.observedAt)
    ))
  ) {
    return failure("finalizer mutation receipt journal binding or claim is invalid");
  }
  if (objectId(intent.commit) !== commit || objectId(intent.tree) !== tree) {
    return failure("finalizer mutation receipt commit/tree binding is invalid");
  }
  const receipts = isRecord(intent.receipts) ? intent.receipts : {};
  const remoteWrites = isRecord(result.remoteWrites) ? result.remoteWrites : {};
  if (expected.mode === "remote") {
    if (
      result.status !== "finalized"
      || result.committed !== true
      || result.pushed !== true
      || result.closed !== true
      || result.localSynced !== true
      || intent.stage !== "local.complete"
      || !operationReceipt(receipts.push, "repository.push")
      || !operationReceipt(receipts.issueClose, "issue.close")
      || !isRecord(remoteWrites.push)
      || remoteWrites.push.committed !== true
      || !isRecord(remoteWrites.issueClose)
      || remoteWrites.issueClose.committed !== true
      || !sourceReceiptMatches(result, source)
    ) return failure("remote finalizer receipt is missing exact push, close, or source-sync truth");
  } else {
    const number = integer(result.prNumber);
    const url = text(result.prUrl);
    if (
      result.status !== "pr.opened"
      || result.committed !== true
      || result.pushed !== true
      || result.closed !== false
      || result.eventRecorded !== true
      || intent.stage !== "event.complete"
      || !operationReceipt(receipts.branchPush, "pull_request.push")
      || !operationReceipt(receipts.pullRequestCreate, "pull_request.create")
      || !operationReceipt(receipts.prEvent, "pr_opened.publish")
      || !isRecord(remoteWrites.branchPush)
      || remoteWrites.branchPush.committed !== true
      || !isRecord(remoteWrites.pullRequestCreate)
      || remoteWrites.pullRequestCreate.committed !== true
      || !number
      || url !== `https://github.com/${capability.repository}/pull/${number}`
    ) return failure("PR finalizer receipt is missing exact push, create, event, or URL truth");
  }
  return { ok: true, receipt: result };
}

export function finalizerCapabilityDigest(value: unknown) {
  return digest(normalizeGithubRemoteCapability(value));
}

export function finalizerMutationFenceDigest(value: unknown) {
  return canonicalFenceDigest(value);
}
