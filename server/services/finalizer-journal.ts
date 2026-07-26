import { createHash } from "node:crypto";

import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
import {
  appendEventIfCursor,
  eventStreamCursorForRecords,
  readEvents,
} from "./event/event-store.js";
import type { EventStoreOptions, EventStreamCursor } from "./event/event-types.js";
import { FINALIZER_MUTATION_RECEIPT_SCHEMA } from "./finalizer-contract.js";

export const FINALIZER_JOURNAL_EVENT = "finalizer_journal_updated";

export type FinalizerJournalMode = "remote" | "pr";
export type FinalizerJournalStage =
  | "claimed"
  | "repository.push.intent"
  | "repository.push.receipt"
  | "issue.close.intent"
  | "issue.close.receipt"
  | "remote.complete"
  | "local.complete"
  | "pull_request.push.intent"
  | "pull_request.push.receipt"
  | "pull_request.create.intent"
  | "pull_request.create.receipt"
  | "pr_opened.publish.intent"
  | "pr_opened.publish.receipt"
  | "event.complete";

export type FinalizerJournalRecord = LooseRecord & {
  schema: typeof FINALIZER_MUTATION_RECEIPT_SCHEMA;
  finalizationId: string;
  generation: number;
  project: string;
  entryId: string;
  originJobId: string;
  mode: FinalizerJournalMode;
  stage: FinalizerJournalStage;
  repository: string;
  issueNumber: number;
  capabilityDigest: string;
  principal: LooseRecord;
  claim: LooseRecord;
  source: LooseRecord;
  capsule: LooseRecord;
  commit: string;
  tree: string;
  preRemoteHead: string | null;
  targetBranch: string;
  receipts: LooseRecord;
};

export type FinalizerJournalSnapshot = {
  journalJobId: string;
  cursor: EventStreamCursor;
  record: FinalizerJournalRecord | null;
  invalidReason: string | null;
};

type AssertJournalMutationLease = (context: LooseRecord) => Promise<void | boolean> | void | boolean;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function finalizerJournalDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function finalizerJournalClaimId(value: {
  finalizationId: string;
  ownerDigest: string;
  claimGeneration: number;
}) {
  return finalizerJournalDigest({
    finalizationId: value.finalizationId,
    ownerDigest: value.ownerDigest,
    claimGeneration: value.claimGeneration,
  });
}

export function finalizerJournalPrEventId(finalizationId: string) {
  return finalizerJournalDigest({ finalizationId, operation: "pr_opened.publish" });
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function eventStreamIdentity(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value) ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function objectId(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^[0-9a-f]{40,64}$/.test(normalized) ? normalized : null;
}

function sha256(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function isoTimestamp(value: unknown) {
  const normalized = text(value);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === normalized
    ? normalized
    : null;
}

function repository(value: unknown) {
  const normalized = text(value)?.toLowerCase() || "";
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function principal(value: unknown) {
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

function claim(value: unknown) {
  if (!isRecord(value)) return null;
  const claimId = sha256(value.claimId);
  const claimGeneration = positiveInteger(value.claimGeneration);
  const ownerDigest = sha256(value.ownerDigest);
  if (!claimId || !claimGeneration || !ownerDigest) return null;
  const takeover = isRecord(value.takeover) ? value.takeover : null;
  if (takeover && (
    !["owner-dead", "explicit-handoff"].includes(String(takeover.kind || ""))
    || !sha256(takeover.previousClaimId)
    || !sha256(takeover.evidenceId)
    || !isoTimestamp(takeover.observedAt)
  )) return null;
  return {
    claimId,
    claimGeneration,
    ownerDigest,
    ...(takeover ? { takeover: {
      kind: takeover.kind,
      previousClaimId: sha256(takeover.previousClaimId),
      evidenceId: sha256(takeover.evidenceId),
      observedAt: isoTimestamp(takeover.observedAt),
    } } : {}),
  };
}

const STAGES = new Set<FinalizerJournalStage>([
  "claimed",
  "repository.push.intent",
  "repository.push.receipt",
  "issue.close.intent",
  "issue.close.receipt",
  "remote.complete",
  "local.complete",
  "pull_request.push.intent",
  "pull_request.push.receipt",
  "pull_request.create.intent",
  "pull_request.create.receipt",
  "pr_opened.publish.intent",
  "pr_opened.publish.receipt",
  "event.complete",
]);

const NEXT_STAGE: Record<FinalizerJournalStage, FinalizerJournalStage[]> = {
  claimed: ["repository.push.intent", "pull_request.push.intent"],
  "repository.push.intent": ["repository.push.receipt"],
  "repository.push.receipt": ["issue.close.intent"],
  "issue.close.intent": ["issue.close.receipt"],
  "issue.close.receipt": ["remote.complete"],
  "remote.complete": ["local.complete"],
  "local.complete": [],
  "pull_request.push.intent": ["pull_request.push.receipt"],
  "pull_request.push.receipt": ["pull_request.create.intent"],
  "pull_request.create.intent": ["pull_request.create.receipt"],
  "pull_request.create.receipt": ["pr_opened.publish.intent"],
  "pr_opened.publish.intent": ["pr_opened.publish.receipt"],
  "pr_opened.publish.receipt": ["event.complete"],
  "event.complete": [],
};

const STAGE_RECEIPT_KEY: Partial<Record<FinalizerJournalStage, string>> = {
  "repository.push.receipt": "push",
  "issue.close.receipt": "issueClose",
  "local.complete": "sourceSync",
  "pull_request.push.intent": "branchPushIntent",
  "pull_request.push.receipt": "branchPush",
  "pull_request.create.intent": "pullRequestCreateIntent",
  "pull_request.create.receipt": "pullRequestCreate",
  "pr_opened.publish.intent": "prEventIntent",
  "pr_opened.publish.receipt": "prEvent",
};

const RECEIPT_OPERATION: Record<string, string> = {
  push: "repository.push",
  issueClose: "issue.close",
  sourceSync: "source.sync",
  branchPush: "pull_request.push",
  pullRequestCreate: "pull_request.create",
  prEvent: "pr_opened.publish",
};

function prPlanRequestIdentity(value: LooseRecord) {
  return {
    repo: value.repo,
    head: value.head,
    base: value.base,
    title: value.title,
    body: value.body,
    draft: value.draft,
  };
}

function nullableObjectId(value: unknown) {
  return value === null ? null : objectId(value);
}

function validCommittedVerification(
  value: unknown,
  record: FinalizerJournalRecord,
  operation: string,
  receipt: LooseRecord,
) {
  if (!isRecord(value) || value.operation !== operation || value.committed !== true) return false;
  const observedPrincipal = principal(value.principal);
  if (!observedPrincipal
    || finalizerJournalDigest(observedPrincipal) !== finalizerJournalDigest(record.principal)) return false;
  const evidence = isRecord(value.evidence) ? value.evidence : null;
  if (!evidence) return false;
  if (
    evidence.repository !== record.repository
    || !text(evidence.repositoryId)
    || Number(evidence.issueNumber) !== record.issueNumber
    || evidence.capabilityDigest !== record.capabilityDigest
  ) return false;
  if (operation === "repository.push") {
    return evidence.targetBranch === record.targetBranch
      && evidence.expectedRef === `refs/heads/${record.targetBranch}`
      && evidence.actualRef === `refs/heads/${record.targetBranch}`
      && objectId(evidence.expectedCommit) === record.commit
      && objectId(evidence.actualCommit) === record.commit;
  }
  if (operation === "issue.close") {
    return Number(evidence.number) === record.issueNumber
      && evidence.state === "CLOSED"
      && evidence.url === `https://github.com/${record.repository}/issues/${record.issueNumber}`;
  }
  if (operation === "pull_request.create") {
    const pullRequest = isRecord(evidence.pullRequest) ? evidence.pullRequest : null;
    const number = positiveInteger(receipt.prNumber);
    return Boolean(pullRequest
      && number
      && Number(evidence.matchCount) === 1
      && Number(pullRequest.number) === number
      && pullRequest.state === "OPEN"
      && pullRequest.draft === true
      && pullRequest.title === receipt.title
      && pullRequest.bodyMatches === true
      && Number(pullRequest.bodyLength) === String(receipt.body || "").length
      && pullRequest.url === receipt.prUrl
      && text(pullRequest.authorLogin)?.toLowerCase() === record.principal.login
      && String(pullRequest.authorId || "") === String(record.principal.authorId || record.principal.stableId)
      && pullRequest.headBranch === record.targetBranch
      && objectId(pullRequest.headSha) === record.commit
      && pullRequest.headRepository === record.repository
      && pullRequest.baseBranch === record.source.branch
      && pullRequest.baseRepository === record.repository
      && pullRequest.exactGeneration === true);
  }
  return false;
}

function validReceiptIdentity(key: string, value: unknown, record: FinalizerJournalRecord) {
  if (!isRecord(value)) return false;
  const operation = RECEIPT_OPERATION[key];
  if (operation) {
    if (
      value.operation !== operation
      || value.attempted !== true
      || value.committed !== true
      || !isoTimestamp(value.observedAt)
      || !sha256(value.eventId)
    ) return false;
  }
  if (key === "push" || key === "branchPush") {
    return value.repository === record.repository
      && Number(value.issueNumber) === record.issueNumber
      && objectId(value.commit) === record.commit
      && objectId(value.tree) === record.tree
      && value.targetBranch === record.targetBranch
      && nullableObjectId(value.preRemoteHead) === record.preRemoteHead
      && validCommittedVerification(value.verification, record, "repository.push", value);
  }
  if (key === "issueClose") {
    return value.repository === record.repository
      && Number(value.issueNumber) === record.issueNumber
      && objectId(value.commit) === record.commit
      && validCommittedVerification(value.verification, record, "issue.close", value);
  }
  if (key === "branchPushIntent") {
    const frozenPlan = isRecord(record.receipts.prPlan) ? record.receipts.prPlan : null;
    const nestedPlan = isRecord(value.pullRequestPlan) ? value.pullRequestPlan : null;
    return value.operation === "repository.push"
      && value.repository === record.repository
      && Number(value.issueNumber) === record.issueNumber
      && String(value.commit || "").toLowerCase() === record.commit
      && value.targetBranch === record.targetBranch
      && (!frozenPlan || (nestedPlan
        && finalizerJournalDigest(nestedPlan) === finalizerJournalDigest(frozenPlan)));
  }
  if (key === "prPlan") {
    return value.repo === record.repository
      && value.head === record.targetBranch
      && value.base === record.source.branch
      && value.eventJobId === record.originJobId
      && Boolean(text(value.title))
      && String(value.title).length <= 256
      && typeof value.body === "string"
      && value.body.length <= 65_536
      && !value.body.includes("\u0000")
      && value.draft === true;
  }
  if (key === "pullRequestCreateIntent") {
    const frozenPlan = isRecord(record.receipts.prPlan) ? record.receipts.prPlan : null;
    const intentPlan = {
      repo: value.repository,
      head: value.headBranch,
      base: value.baseBranch,
      title: value.title,
      body: value.body,
      draft: value.draft,
    };
    return Boolean(frozenPlan)
      && finalizerJournalDigest(intentPlan) === finalizerJournalDigest(prPlanRequestIdentity(frozenPlan!))
      && value.operation === "pull_request.create"
      && value.repository === record.repository
      && Number(value.issueNumber) === record.issueNumber
      && String(value.commit || "").toLowerCase() === record.commit
      && value.headBranch === record.targetBranch
      && value.baseBranch === record.source.branch
      && Boolean(text(value.title))
      && String(value.title).length <= 256
      && typeof value.body === "string"
      && value.body.length <= 65_536
      && !value.body.includes("\u0000")
      && value.draft === true
      && text(value.authorLogin)?.toLowerCase() === record.principal.login
      && String(value.authorId || "") === String(record.principal.authorId || record.principal.stableId);
  }
  if (key === "prEventIntent") {
    const number = positiveInteger(value.prNumber);
    const frozenPlan = isRecord(record.receipts.prPlan) ? record.receipts.prPlan : null;
    const expectedEventId = finalizerJournalPrEventId(record.finalizationId);
    return Boolean(
      frozenPlan
      && value.jobId === record.originJobId
      && value.jobId === frozenPlan.eventJobId
      && value.eventId === expectedEventId
      && number
      && value.prUrl === `https://github.com/${record.repository}/pull/${number}`
    );
  }
  if (key === "pullRequestCreate") {
    const number = positiveInteger(value.prNumber);
    const createIntent = isRecord(record.receipts.pullRequestCreateIntent)
      ? record.receipts.pullRequestCreateIntent
      : null;
    return Boolean(createIntent
      && number
      && value.prUrl === `https://github.com/${record.repository}/pull/${number}`
      && value.repository === record.repository
      && Number(value.issueNumber) === record.issueNumber
      && objectId(value.commit) === record.commit
      && value.headBranch === createIntent!.headBranch
      && value.baseBranch === createIntent!.baseBranch
      && value.title === createIntent!.title
      && value.body === createIntent!.body
      && value.draft === true
      && text(value.authorLogin)?.toLowerCase() === record.principal.login
      && String(value.authorId || "") === String(record.principal.authorId || record.principal.stableId)
      && validCommittedVerification(value.verification, record, "pull_request.create", value));
  }
  if (key === "prEvent") {
    const number = positiveInteger(value.prNumber);
    const eventIntent = isRecord(record.receipts.prEventIntent) ? record.receipts.prEventIntent : null;
    const cursor = isRecord(value.eventStreamCursor) ? value.eventStreamCursor : null;
    const expectedRecordDigest = finalizerJournalDigest({
      type: "pr_opened",
      project: record.project,
      jobId: record.originJobId,
      finalizationId: record.finalizationId,
      eventId: eventIntent?.eventId,
      prUrl: eventIntent?.prUrl,
      prNumber: eventIntent?.prNumber,
    });
    return Boolean(eventIntent
      && number
      && value.prUrl === eventIntent.prUrl
      && number === Number(eventIntent.prNumber)
      && value.eventId === eventIntent.eventId
      && value.jobId === eventIntent.jobId
      && value.finalizationId === record.finalizationId
      && value.eventRecordDigest === expectedRecordDigest
      && cursor
      && positiveInteger(cursor.eventCount)
      && sha256(cursor.eventDigest));
  }
  if (key === "sourceSync") {
    return value.clean === true
      && value.expectedBranch === record.source.branch
      && String(value.previousHead || "").toLowerCase() === record.source.head
      && String(value.expectedHead || "").toLowerCase() === record.commit
      && value.actualBranch === record.source.branch
      && String(value.actualHead || "").toLowerCase() === record.commit;
  }
  return true;
}

function validInitialRecord(candidate: FinalizerJournalRecord) {
  const initialReceiptKeys = Object.keys(candidate.receipts);
  const validInitialReceipts = initialReceiptKeys.length === 0 || (
    candidate.mode === "pr"
    && initialReceiptKeys.length === 1
    && initialReceiptKeys[0] === "prPlan"
    && validReceiptIdentity("prPlan", candidate.receipts.prPlan, candidate)
  );
  return candidate.generation === 1
    && candidate.stage === "claimed"
    && candidate.claim.claimGeneration === 1
    && !Object.hasOwn(candidate.claim, "takeover")
    && validInitialReceipts;
}

export function finalizerJournalJobId(project: string, entryId: string) {
  const digest = createHash("sha256").update(project).update("\0").update(entryId).digest("hex").slice(0, 32);
  return `finalizer-journal-${digest}`;
}

export function finalizerJournalFinalizationId(value: {
  project: string;
  entryId: string;
  originJobId: string;
  mode: FinalizerJournalMode;
  repository: string;
  issueNumber: number;
  capabilityDigest: string;
  principal: LooseRecord;
  source: LooseRecord;
  commit: string;
  tree: string;
  preRemoteHead: string | null;
  targetBranch: string;
}) {
  return finalizerJournalDigest({
    schema: FINALIZER_MUTATION_RECEIPT_SCHEMA,
    project: value.project,
    entryId: value.entryId,
    originJobId: value.originJobId,
    mode: value.mode,
    repository: value.repository,
    issueNumber: value.issueNumber,
    capabilityDigest: value.capabilityDigest,
    principal: value.principal,
    source: value.source,
    commit: value.commit,
    tree: value.tree,
    preRemoteHead: value.preRemoteHead,
    targetBranch: value.targetBranch,
  });
}

export function normalizeFinalizerJournalRecord(value: unknown): FinalizerJournalRecord | null {
  if (!isRecord(value) || value.schema !== FINALIZER_MUTATION_RECEIPT_SCHEMA) return null;
  const mode = value.mode;
  const stage = value.stage;
  const normalizedPrincipal = principal(value.principal);
  const normalizedClaim = claim(value.claim);
  const source = isRecord(value.source) ? value.source : null;
  const capsule = isRecord(value.capsule) ? value.capsule : null;
  const normalizedRepository = repository(value.repository);
  const issueNumber = positiveInteger(value.issueNumber);
  const commit = objectId(value.commit);
  const tree = objectId(value.tree);
  const preRemoteHead = value.preRemoteHead === null ? null : objectId(value.preRemoteHead);
  if (
    (mode !== "remote" && mode !== "pr")
    || typeof stage !== "string"
    || !STAGES.has(stage as FinalizerJournalStage)
    || !sha256(value.finalizationId)
    || !positiveInteger(value.generation)
    || !text(value.project)
    || !text(value.entryId)
    || !eventStreamIdentity(value.originJobId)
    || !normalizedRepository
    || !issueNumber
    || !sha256(value.capabilityDigest)
    || !normalizedPrincipal
    || !normalizedClaim
    || !source
    || !text(source.branch)
    || !objectId(source.head)
    || !capsule
    || !text(capsule.path)
    || !sha256(capsule.sha256)
    || !positiveInteger(capsule.bytes)
    || !commit
    || !tree
    || (value.preRemoteHead !== null && !preRemoteHead)
    || !text(value.targetBranch)
    || !isRecord(value.receipts)
  ) return null;
  if (mode === "remote" && !String(stage).startsWith("repository.")
    && !String(stage).startsWith("issue.")
    && stage !== "claimed" && stage !== "remote.complete" && stage !== "local.complete") return null;
  if (mode === "pr" && !String(stage).startsWith("pull_request.")
    && !String(stage).startsWith("pr_opened.")
    && stage !== "claimed" && stage !== "event.complete") return null;
  const normalized: FinalizerJournalRecord = {
    ...value,
    schema: FINALIZER_MUTATION_RECEIPT_SCHEMA,
    finalizationId: String(value.finalizationId).toLowerCase(),
    generation: Number(value.generation),
    project: String(value.project),
    entryId: String(value.entryId),
    originJobId: String(value.originJobId),
    mode,
    stage: stage as FinalizerJournalStage,
    repository: normalizedRepository,
    issueNumber,
    capabilityDigest: String(value.capabilityDigest).toLowerCase(),
    principal: normalizedPrincipal,
    claim: normalizedClaim,
    source: {
      ...source,
      branch: String(source.branch),
      head: String(source.head).toLowerCase(),
    },
    capsule: {
      path: String(capsule.path),
      sha256: String(capsule.sha256).toLowerCase(),
      bytes: Number(capsule.bytes),
    },
    commit,
    tree,
    preRemoteHead,
    targetBranch: String(value.targetBranch),
    receipts: { ...value.receipts },
  };
  if (normalized.finalizationId !== finalizerJournalFinalizationId(normalized)) return null;
  if (normalized.claim.claimId !== finalizerJournalClaimId({
    finalizationId: normalized.finalizationId,
    ownerDigest: String(normalized.claim.ownerDigest),
    claimGeneration: Number(normalized.claim.claimGeneration),
  })) return null;
  return normalized;
}

function immutableBinding(record: FinalizerJournalRecord) {
  const { generation: _generation, stage: _stage, claim: _claim, receipts: _receipts, ...binding } = record;
  return binding;
}

function validTransition(previous: FinalizerJournalRecord, next: FinalizerJournalRecord) {
  if (next.generation !== previous.generation + 1) return false;
  if (finalizerJournalDigest(immutableBinding(next)) !== finalizerJournalDigest(immutableBinding(previous))) return false;
  const previousClaim = previous.claim as LooseRecord;
  const nextClaim = next.claim as LooseRecord;
  const sameClaim = finalizerJournalDigest(previousClaim) === finalizerJournalDigest(nextClaim);
  if (!sameClaim) {
    const takeover = isRecord(nextClaim.takeover) ? nextClaim.takeover : null;
    if (
      Number(nextClaim.claimGeneration) !== Number(previousClaim.claimGeneration) + 1
      || nextClaim.claimId === previousClaim.claimId
      || nextClaim.ownerDigest === previousClaim.ownerDigest
      || !takeover
      || takeover.previousClaimId !== previousClaim.claimId
    ) return false;
    if (next.stage !== previous.stage) return false;
  }
  if (next.stage !== previous.stage && !NEXT_STAGE[previous.stage].includes(next.stage)) return false;
  for (const [key, receipt] of Object.entries(previous.receipts)) {
    if (!Object.hasOwn(next.receipts, key)
      || finalizerJournalDigest(next.receipts[key]) !== finalizerJournalDigest(receipt)) return false;
  }
  const additions = Object.keys(next.receipts).filter((key) => !Object.hasOwn(previous.receipts, key));
  // A same-stage generation exists only to transfer the fenced claim.  A
  // same-owner/no-op append would create an unbounded sequence of records that
  // carries no new durable fact and could be mistaken for lease renewal.
  if (next.stage === previous.stage) return !sameClaim && additions.length === 0;
  const expectedKey = STAGE_RECEIPT_KEY[next.stage];
  if (expectedKey) {
    if (additions.length !== 1 || additions[0] !== expectedKey) return false;
    if (!validReceiptIdentity(expectedKey, next.receipts[expectedKey], next)) return false;
  } else if (additions.length !== 0) return false;
  return true;
}

async function invalidPrEventReadbackReason(
  cpbRoot: string,
  record: FinalizerJournalRecord,
  opts: EventStoreOptions,
) {
  const receipt = isRecord(record.receipts.prEvent) ? record.receipts.prEvent : null;
  if (!receipt) return null;
  const intent = isRecord(record.receipts.prEventIntent) ? record.receipts.prEventIntent : null;
  const receiptCursor = isRecord(receipt.eventStreamCursor) ? receipt.eventStreamCursor : null;
  if (!intent || !receiptCursor) return "finalizer PR event receipt has no bound intent or cursor";
  let originEvents: LooseRecord[];
  try {
    originEvents = await readEvents(cpbRoot, record.project, record.originJobId, opts);
  } catch {
    return "finalizer PR event origin stream could not be read";
  }
  const sameEventId = originEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.eventId === intent.eventId);
  const exact = sameEventId.filter(({ event }) => (
    event.type === "pr_opened"
    && event.project === record.project
    && event.jobId === record.originJobId
    && event.finalizationId === record.finalizationId
    && event.eventId === intent.eventId
    && event.prUrl === intent.prUrl
    && typeof event.prNumber === "number"
    && event.prNumber === intent.prNumber
  ));
  if (sameEventId.length !== 1 || exact.length !== 1) {
    return "finalizer PR event origin stream does not contain one exact bound event";
  }
  const observedRecordDigest = finalizerJournalDigest({
    type: exact[0].event.type,
    project: exact[0].event.project,
    jobId: exact[0].event.jobId,
    finalizationId: exact[0].event.finalizationId,
    eventId: exact[0].event.eventId,
    prUrl: exact[0].event.prUrl,
    prNumber: exact[0].event.prNumber,
  });
  if (receipt.eventRecordDigest !== observedRecordDigest) {
    return "finalizer PR event receipt digest does not match the persisted origin event";
  }
  const observedCursor = eventStreamCursorForRecords(originEvents.slice(0, exact[0].index + 1));
  if (
    Number(receiptCursor.eventCount) !== observedCursor.eventCount
    || receiptCursor.eventDigest !== observedCursor.eventDigest
  ) {
    return "finalizer PR event cursor does not match its exact origin-stream prefix";
  }
  return null;
}

export async function readFinalizerJournal(
  cpbRoot: string,
  project: string,
  entryId: string,
  opts: EventStoreOptions = {},
): Promise<FinalizerJournalSnapshot> {
  const journalJobId = finalizerJournalJobId(project, entryId);
  const events = await readEvents(cpbRoot, project, journalJobId, opts);
  const cursor = eventStreamCursorForRecords(events);
  let record: FinalizerJournalRecord | null = null;
  for (const event of events) {
    if (event.type !== FINALIZER_JOURNAL_EVENT) {
      return { journalJobId, cursor, record: null, invalidReason: "finalizer journal stream contains a foreign event" };
    }
    const candidate = normalizeFinalizerJournalRecord(event.intent);
    if (!candidate) return { journalJobId, cursor, record: null, invalidReason: "finalizer journal contains an invalid record" };
    if (
      event.project !== project
      || event.jobId !== journalJobId
      || event.entryId !== entryId
      || event.finalizationId !== candidate.finalizationId
      || event.generation !== candidate.generation
      || candidate.project !== project
      || candidate.entryId !== entryId
    ) {
      return { journalJobId, cursor, record: null, invalidReason: "finalizer journal event identity is inconsistent" };
    }
    if (!record) {
      if (!validInitialRecord(candidate)) {
        return { journalJobId, cursor, record: null, invalidReason: "finalizer journal does not start with a generation-one claim" };
      }
    } else if (!validTransition(record, candidate)) {
      return { journalJobId, cursor, record: null, invalidReason: "finalizer journal transition is invalid" };
    }
    record = candidate;
  }
  if (record) {
    const prEventReadbackFailure = await invalidPrEventReadbackReason(cpbRoot, record, opts);
    if (prEventReadbackFailure) {
      return { journalJobId, cursor, record: null, invalidReason: prEventReadbackFailure };
    }
  }
  return { journalJobId, cursor, record, invalidReason: null };
}

export async function appendFinalizerJournal(
  cpbRoot: string,
  project: string,
  entryId: string,
  nextValue: FinalizerJournalRecord,
  {
    dataRoot,
    expected,
    assertMutationLease,
    leaseContext = {},
  }: {
    dataRoot?: string;
    expected: FinalizerJournalSnapshot;
    assertMutationLease: AssertJournalMutationLease;
    leaseContext?: LooseRecord;
  },
): Promise<FinalizerJournalSnapshot> {
  const next = normalizeFinalizerJournalRecord(nextValue);
  if (!next) throw Object.assign(new Error("invalid finalizer journal candidate"), { code: "FINALIZER_JOURNAL_INVALID", committed: false });
  if (next.project !== project || next.entryId !== entryId) {
    throw Object.assign(new Error("finalizer journal candidate identity does not match its stream"), {
      code: "FINALIZER_JOURNAL_IDENTITY_MISMATCH",
      committed: false,
    });
  }
  if (expected.invalidReason || expected.journalJobId !== finalizerJournalJobId(project, entryId)) {
    throw Object.assign(new Error(expected.invalidReason || "finalizer journal identity changed"), { code: "FINALIZER_JOURNAL_INVALID", committed: false });
  }
  if (expected.record && (expected.record.project !== project || expected.record.entryId !== entryId)) {
    throw Object.assign(new Error("finalizer journal expected snapshot identity is inconsistent"), {
      code: "FINALIZER_JOURNAL_IDENTITY_MISMATCH",
      committed: false,
    });
  }
  if (expected.record ? !validTransition(expected.record, next) : !validInitialRecord(next)) {
    throw Object.assign(new Error("finalizer journal candidate is not the next generation"), { code: "FINALIZER_JOURNAL_TRANSITION_INVALID", committed: false });
  }
  const allowed = await assertMutationLease({
    ...leaseContext,
    operation: expected.record ? (next.stage === expected.record.stage ? "journal.claim" : next.stage.endsWith(".intent") ? "journal.intent" : next.stage.endsWith(".receipt") ? "journal.receipt" : "journal.complete") : "journal.claim",
    phase: "before-write",
    project,
    entryId,
    originJobId: next.originJobId,
    finalizationId: next.finalizationId,
    generation: next.generation,
    claimId: next.claim.claimId,
    claimGeneration: next.claim.claimGeneration,
    ownerDigest: next.claim.ownerDigest,
    takeoverKind: isRecord(next.claim.takeover) ? next.claim.takeover.kind : null,
    previousClaimId: isRecord(next.claim.takeover) ? next.claim.takeover.previousClaimId : null,
    takeoverEvidenceId: isRecord(next.claim.takeover) ? next.claim.takeover.evidenceId : null,
    repository: next.repository,
    issueNumber: next.issueNumber,
    commit: next.commit,
    tree: next.tree,
  });
  if (allowed === false) {
    throw Object.assign(new Error("finalizer mutation lease rejected journal write"), {
      code: "MUTATION_LEASE_LOST",
      committed: false,
    });
  }
  const event = {
    type: FINALIZER_JOURNAL_EVENT,
    project,
    jobId: expected.journalJobId,
    entryId,
    finalizationId: next.finalizationId,
    generation: next.generation,
    intent: next,
    ts: new Date().toISOString(),
  };
  try {
    const result = await appendEventIfCursor(
      cpbRoot,
      project,
      expected.journalJobId,
      event,
      expected.cursor,
      { dataRoot, externalJournal: true },
    );
    if (!result.committed) {
      return await readFinalizerJournal(cpbRoot, project, entryId, { dataRoot });
    }
  } catch (error) {
    if (!isRecord(error) || error.committed !== true) throw error;
    const observed = await readFinalizerJournal(cpbRoot, project, entryId, { dataRoot }).catch(() => null);
    if (observed?.record && finalizerJournalDigest(observed.record) === finalizerJournalDigest(next)) return observed;
    throw error;
  }
  return await readFinalizerJournal(cpbRoot, project, entryId, { dataRoot });
}
