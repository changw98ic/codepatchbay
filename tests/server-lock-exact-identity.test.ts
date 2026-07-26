import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import type { ProcessIdentity } from "../core/runtime/process-tree.js";
import {
  assignWorker,
  completeDispatch,
  createDispatch,
  startDispatch,
  withDispatchLockTestHooksForTests,
  type DispatchLockTestHooks,
} from "../server/services/dispatch/dispatch.js";
import {
  ingestEvent,
  withCandidateLockTestHooksForTests,
  type CandidateLockTestHooks,
} from "../server/services/event-source.js";
import {
  appendEvent,
  eventFileFor,
  withEventLockTestHooksForTests,
  type EventLockTestHooks,
} from "../server/services/event/event-store.js";
import {
  rebuildJobsIndex,
  withJobsIndexLockTestHooksForTests,
  type JobsIndexLockTestHooks,
} from "../server/services/job/job-store.js";
import {
  createSession,
  updateSession,
  withReviewSessionLockTestHooksForTests,
  type ReviewSessionLockTestHooks,
} from "../server/services/review/review-session.js";
import { tempRoot } from "./helpers.js";

function scopedHookProxy<T extends object>(storage: AsyncLocalStorage<T>, label: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return Reflect.get(storage.getStore() || {}, property);
    },
    set(_target, property, value) {
      const hooks = storage.getStore();
      if (!hooks) throw new Error(`${label} test hook mutation requires a scoped test`);
      return Reflect.set(hooks, property, value);
    },
    deleteProperty(_target, property) {
      const hooks = storage.getStore();
      if (!hooks) return true;
      return Reflect.deleteProperty(hooks, property);
    },
  });
}

const dispatchLockTestHookScope = new AsyncLocalStorage<DispatchLockTestHooks>();
const candidateLockTestHookScope = new AsyncLocalStorage<CandidateLockTestHooks>();
const eventLockTestHookScope = new AsyncLocalStorage<EventLockTestHooks>();
const jobsIndexLockTestHookScope = new AsyncLocalStorage<JobsIndexLockTestHooks>();
const reviewSessionLockTestHookScope = new AsyncLocalStorage<ReviewSessionLockTestHooks>();

const __dispatchLockTestHooks = scopedHookProxy(dispatchLockTestHookScope, "dispatch-lock");
const __candidateLockTestHooks = scopedHookProxy(candidateLockTestHookScope, "candidate-lock");
const __eventLockTestHooks = scopedHookProxy(eventLockTestHookScope, "event-lock");
const __jobsIndexLockTestHooks = scopedHookProxy(jobsIndexLockTestHookScope, "jobs-index");
const __reviewSessionLockTestHooks = scopedHookProxy(reviewSessionLockTestHookScope, "review-session-lock");

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const dispatchHooks: DispatchLockTestHooks = {};
    const candidateHooks: CandidateLockTestHooks = {};
    const eventHooks: EventLockTestHooks = {};
    const jobsHooks: JobsIndexLockTestHooks = {};
    const reviewHooks: ReviewSessionLockTestHooks = {};
    return dispatchLockTestHookScope.run(dispatchHooks, () => (
      candidateLockTestHookScope.run(candidateHooks, () => (
        eventLockTestHookScope.run(eventHooks, () => (
          jobsIndexLockTestHookScope.run(jobsHooks, () => (
            reviewSessionLockTestHookScope.run(reviewHooks, () => (
              withDispatchLockTestHooksForTests(dispatchHooks, () => (
                withCandidateLockTestHooksForTests(candidateHooks, () => (
                  withEventLockTestHooksForTests(eventHooks, () => (
                    withJobsIndexLockTestHooksForTests(jobsHooks, () => (
                      withReviewSessionLockTestHooksForTests(reviewHooks, () => fn(context))
                    ))
                  ))
                ))
              ))
            ))
          ))
        ))
      ))
    ));
  });
}

type IdentityCaptureHooks = {
  captureProcessIdentity?: () => ProcessIdentity | null;
};

type RecoveryValidationHooks = IdentityCaptureHooks & {
  afterRecoveryObserved?: (context: { lockDir: string; owner: Record<string, unknown> | null }) => void | Promise<void>;
  afterQuarantineRename?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null }) => void | Promise<void>;
  beforeRelease?: (context: { lockDir: string; ownerToken: string }) => void | Promise<void>;
};

type MalformedOwnerVariant =
  | "missing-precision"
  | "invalid-precision"
  | "mismatched-incarnation"
  | "noncanonical-captured-at"
  | "noncanonical-acquired-at"
  | "invalid-process-group";

function nestedErrorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const codes = "code" in error && typeof error.code === "string" ? [error.code] : [];
  if (error instanceof AggregateError) {
    for (const entry of error.errors) codes.push(...nestedErrorCodes(entry, seen));
  }
  if ("cause" in error) codes.push(...nestedErrorCodes(error.cause, seen));
  return codes;
}

function coarseCurrentIdentity(): ProcessIdentity {
  const birthId = "test-coarse-process-start";
  return {
    pid: process.pid,
    birthId,
    incarnation: `${process.pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision: "coarse",
  };
}

async function assertUnavailableIdentityCleanup(
  hooks: IdentityCaptureHooks,
  run: () => Promise<unknown>,
  assertClean: () => void | Promise<void>,
) {
  const exactIdentity = { ...coarseCurrentIdentity(), birthIdPrecision: "exact" as const };
  const missingPrecisionIdentity = { ...exactIdentity };
  delete missingPrecisionIdentity.birthIdPrecision;
  const captures: Array<() => ProcessIdentity | null> = [
    () => null,
    () => coarseCurrentIdentity(),
    () => missingPrecisionIdentity,
    () => ({ ...exactIdentity, capturedAt: "2026-01-01T00:00:00Z" }),
    () => ({ ...exactIdentity, processGroupId: 0 }),
  ];
  for (const capture of captures) {
    hooks.captureProcessIdentity = capture;
    try {
      await assert.rejects(
        run,
        (error: unknown) => {
          assert.match(String((error as NodeJS.ErrnoException).code), /^(PROCESS_IDENTITY_UNAVAILABLE|DIRECTORY_LOCK_IDENTITY_UNAVAILABLE|DIRECTORY_LOCK_PATH_INVALID)$/);
          return true;
        },
      );
    } finally {
      hooks.captureProcessIdentity = undefined;
    }
    await assertClean();
  }
}

async function malformedOwner(
  lockDir: string,
  format: string,
  ownerToken: string,
  variant: MalformedOwnerVariant,
) {
  const birthId = `test-malformed-${variant}`;
  const processIdentity: Record<string, unknown> = {
    pid: process.pid,
    birthId,
    incarnation: `${process.pid}:${birthId}`,
    capturedAt: new Date(0).toISOString(),
    birthIdPrecision: "exact",
  };
  if (variant === "missing-precision") delete processIdentity.birthIdPrecision;
  if (variant === "invalid-precision") processIdentity.birthIdPrecision = "coarse";
  if (variant === "mismatched-incarnation") processIdentity.incarnation = `${process.pid}:different-birth`;
  if (variant === "noncanonical-captured-at") processIdentity.capturedAt = "2026-01-01T00:00:00Z";
  if (variant === "invalid-process-group") processIdentity.processGroupId = 0;
  const owner: Record<string, unknown> = {
    format,
    ownerToken,
    pid: process.pid,
    acquiredAt: variant === "noncanonical-acquired-at" ? "2026-01-01T00:00:00Z" : new Date(0).toISOString(),
    processIdentity,
  };
  if (format === "cpb-directory-lock/v1") {
    owner.lockPath = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
    owner.host = os.hostname();
  }
  return owner;
}

async function assertMalformedOwnersFailClosed(
  hooks: RecoveryValidationHooks,
  lockDir: string,
  format: string,
  run: (variant: MalformedOwnerVariant) => Promise<unknown>,
) {
  const variants: MalformedOwnerVariant[] = [
    "missing-precision",
    "invalid-precision",
    "mismatched-incarnation",
    "noncanonical-captured-at",
    "noncanonical-acquired-at",
    "invalid-process-group",
  ];
  for (const variant of variants) {
    const ownerToken = `malformed-${variant}`;
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify(await malformedOwner(lockDir, format, ownerToken, variant), null, 2)}\n`,
      "utf8",
    );
    const old = new Date(0);
    await utimes(lockDir, old, old);

    let observed = false;
    let malformedOwnerQuarantined = false;
    hooks.afterRecoveryObserved = async ({ owner }) => {
      observed = true;
      assert.equal(owner, null, `${variant} owner must be rejected by the v2 parser`);
      await rm(lockDir, { recursive: true });
    };
    hooks.afterQuarantineRename = ({ ownerToken: quarantinedToken }) => {
      if (quarantinedToken === ownerToken || quarantinedToken === null) malformedOwnerQuarantined = true;
    };
    try {
      if (format === "cpb-directory-lock/v1") {
        await assert.rejects(
          run(variant),
          (error: NodeJS.ErrnoException) => {
            assert.match(String(error.code || error.message), /DIRECTORY_LOCK_UNSAFE|directory lock|invalid|malformed/i);
            return true;
          },
        );
      } else {
        await run(variant);
      }
    } finally {
      hooks.afterRecoveryObserved = undefined;
      hooks.afterQuarantineRename = undefined;
    }

    assert.equal(observed, format !== "cpb-directory-lock/v1", `${variant} owner observation mismatch`);
    assert.equal(malformedOwnerQuarantined, false, `${variant} owner must not authorize quarantine`);
  }
}

test("event lock rejects null and coarse owner identities without leaving a lock", async () => {
  const root = await tempRoot("cpb-event-lock-exact-identity");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const project = "flow";
  const jobId = "job-20260721-000001-exact";
  const lockDir = `${eventFileFor(cpbRoot, project, jobId, { dataRoot })}.lock`;
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  delete process.env.CPB_HUB_ROOT;
  try {
    await assertUnavailableIdentityCleanup(
      __eventLockTestHooks,
      () => appendEvent(cpbRoot, project, jobId, {
        type: "job_created",
        jobId,
        project,
        task: "exact event lock identity",
        workflow: "standard",
        ts: "2026-07-21T00:00:01.000Z",
      }, { dataRoot }),
      () => assert.equal(existsSync(lockDir), false),
    );
  } finally {
    __eventLockTestHooks.captureProcessIdentity = undefined;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("jobs-index lock rejects null and coarse owner identities without leaving a lock", async () => {
  const root = await tempRoot("cpb-jobs-index-lock-exact-identity");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");

  await assertUnavailableIdentityCleanup(
    __jobsIndexLockTestHooks,
    () => rebuildJobsIndex(cpbRoot, { dataRoot }),
    () => assert.equal(existsSync(lockDir), false),
  );
});

test("jobs-index identity failure cleanup preserves a replacement lock directory", async () => {
  const root = await tempRoot("cpb-jobs-index-lock-identity-aba");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");

  __jobsIndexLockTestHooks.captureProcessIdentity = () => {
    return null;
  };
  try {
    await assert.rejects(
      rebuildJobsIndex(cpbRoot, { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE",
    );
  } finally {
    __jobsIndexLockTestHooks.captureProcessIdentity = undefined;
  }

  assert.equal(existsSync(lockDir), false);
});

test("jobs-index stale recovery never treats a coarse identity as stale proof", async () => {
  const root = await tempRoot("cpb-jobs-index-lock-coarse-recovery");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");
  await mkdir(path.dirname(lockDir), { recursive: true });
  const coarseOwner = {
    format: "cpb-directory-lock/v1",
    ownerToken: "coarse-owner",
    lockPath: path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir)),
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: coarseCurrentIdentity(),
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(coarseOwner, null, 2)}\n`, "utf8");
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let coarseOwnerQuarantined = false;
  __jobsIndexLockTestHooks.afterRecoveryObserved = async () => {
    await rm(lockDir, { recursive: true });
  };
  __jobsIndexLockTestHooks.afterQuarantineRename = ({ ownerToken }) => {
    if (ownerToken === coarseOwner.ownerToken) coarseOwnerQuarantined = true;
  };
  try {
    await assert.rejects(
      rebuildJobsIndex(cpbRoot, { dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "DIRECTORY_LOCK_UNSAFE",
    );
  } finally {
    __jobsIndexLockTestHooks.afterRecoveryObserved = undefined;
    __jobsIndexLockTestHooks.afterQuarantineRename = undefined;
  }

  assert.equal(coarseOwnerQuarantined, false);
  assert.equal(existsSync(lockDir), true);
});

test("review session lock rejects null and coarse owner identities without leaving a lock", async () => {
  const root = await tempRoot("cpb-review-lock-exact-identity");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    const session = await createSession(cpbRoot, { project: "flow", intent: "exact lock identity" });
    const lockDir = path.join(hubRoot, "reviews", ".locks", "reviews.lock");
    await assertUnavailableIdentityCleanup(
      __reviewSessionLockTestHooks,
      () => updateSession(cpbRoot, session.sessionId, { status: "researching" }),
      () => assert.equal(existsSync(lockDir), false),
    );
  } finally {
    __reviewSessionLockTestHooks.captureProcessIdentity = undefined;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("candidate lock rejects null and coarse owner identities without leaving a lock", async () => {
  const root = await tempRoot("cpb-candidate-lock-exact-identity");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const lockDir = path.join(hubRoot, "event-sources", "candidates.json.lock");

  await assertUnavailableIdentityCleanup(
    __candidateLockTestHooks,
    () => ingestEvent(cpbRoot, {
      source: "github",
      externalId: "delivery-exact-identity",
      projectId: "flow",
    }, { hubRoot }),
    () => assert.equal(existsSync(lockDir), false),
  );
});

test("candidate lock preserves an empty successor created during quarantine", async () => {
  const root = await tempRoot("cpb-candidate-lock-empty-successor");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const lockDir = path.join(hubRoot, "event-sources", "candidates.json.lock");
  await mkdir(path.dirname(lockDir), { recursive: true });
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify({
    format: "cpb-directory-lock/v1",
    ownerToken: "dead-candidate-owner",
    lockPath: path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir)),
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-candidate-birth",
      incarnation: "999999:dead-candidate-birth",
      capturedAt: new Date(0).toISOString(),
      birthIdPrecision: "exact",
    },
  }, null, 2)}\n`, "utf8");
  const old = new Date(0);
  await utimes(lockDir, old, old);

  __candidateLockTestHooks.afterQuarantineRename = async ({ lockDir: originalLockDir }) => {
    await mkdir(originalLockDir);
  };
  try {
    await assert.rejects(
      ingestEvent(cpbRoot, {
        source: "github",
        externalId: "delivery-empty-successor",
        projectId: "flow",
      }, { hubRoot }),
      { code: "DIRECTORY_LOCK_SUCCESSOR_PRESERVED" },
    );
  } finally {
    __candidateLockTestHooks.afterQuarantineRename = undefined;
  }

  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.some((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`)), true);
});

test("candidate mutation fails when exact lock ownership is lost before release", async () => {
  const root = await tempRoot("cpb-candidate-lock-release-loss");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const lockDir = path.join(hubRoot, "event-sources", "candidates.json.lock");
  let replacementOwner: Record<string, unknown> | null = null;

  __candidateLockTestHooks.beforeRelease = async ({ lockDir: ownedLockDir }) => {
    const ownerFile = path.join(ownedLockDir, "owner.json");
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    replacementOwner = { ...owner, ownerToken: "candidate-successor-owner" };
    await writeFile(ownerFile, `${JSON.stringify(replacementOwner, null, 2)}\n`, "utf8");
  };
  try {
    await assert.rejects(
      ingestEvent(cpbRoot, {
        source: "github",
        externalId: "delivery-release-loss",
        projectId: "flow",
      }, { hubRoot }),
      (error: unknown) => nestedErrorCodes(error).includes("DIRECTORY_LOCK_RELEASE_FAILED")
        && nestedErrorCodes(error).includes("DIRECTORY_LOCK_LOST"),
    );
  } finally {
    __candidateLockTestHooks.beforeRelease = undefined;
  }

  assert.deepEqual(
    JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")),
    replacementOwner,
  );
});

test("dispatch lock rejects null and coarse owner identities without publishing an owner", async () => {
  const root = await tempRoot("cpb-dispatch-lock-exact-identity");
  const hubRoot = path.join(root, "hub");
  const dispatchDir = path.join(hubRoot, "dispatches");

  await assertUnavailableIdentityCleanup(
    __dispatchLockTestHooks,
    () => createDispatch(hubRoot, { projectId: "flow", sourcePath: root }),
    async () => {
      const entries = await readdir(dispatchDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.deepEqual(entries, []);
    },
  );
});

test("event lock treats malformed v2 identities as unknown and never quarantines them", async () => {
  const root = await tempRoot("cpb-event-lock-malformed-owner");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const project = "flow";
  const jobId = "job-20260721-000002-malformed";
  const lockDir = `${eventFileFor(cpbRoot, project, jobId, { dataRoot })}.lock`;
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  delete process.env.CPB_HUB_ROOT;
  try {
    await assertMalformedOwnersFailClosed(
      __eventLockTestHooks,
      lockDir,
      "cpb-directory-lock/v1",
      () => appendEvent(cpbRoot, project, jobId, {
        type: "job_created",
        jobId,
        project,
        task: "malformed event lock owner",
        workflow: "standard",
        ts: "2026-07-21T00:00:02.000Z",
      }, { dataRoot }),
    );
  } finally {
    __eventLockTestHooks.afterRecoveryObserved = undefined;
    __eventLockTestHooks.afterQuarantineRename = undefined;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("jobs-index lock treats malformed v2 identities as unknown and never quarantines them", async () => {
  const root = await tempRoot("cpb-jobs-index-lock-malformed-owner");
  const cpbRoot = path.join(root, "cpb");
  const dataRoot = path.join(root, "runtime");
  const lockDir = path.join(dataRoot, "jobs-index.json.lock");

  await assertMalformedOwnersFailClosed(
    __jobsIndexLockTestHooks,
    lockDir,
    "cpb-directory-lock/v1",
    () => rebuildJobsIndex(cpbRoot, { dataRoot }),
  );
});

test("review lock treats malformed v2 identities as unknown and never quarantines them", async () => {
  const root = await tempRoot("cpb-review-lock-malformed-owner");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const session = await createSession(cpbRoot, {
    project: "flow",
    intent: "malformed review lock owner",
    controlRoot: hubRoot,
  });
  const lockDir = path.join(hubRoot, "reviews", ".locks", "reviews.lock");

  await assertMalformedOwnersFailClosed(
    __reviewSessionLockTestHooks,
    lockDir,
    "cpb-directory-lock/v1",
    () => updateSession(
      cpbRoot,
      session.sessionId,
      { status: "researching" },
      { controlRoot: hubRoot, skipTransitionCheck: true },
    ),
  );
});

test("candidate lock treats malformed v2 identities as unknown and never quarantines them", async () => {
  const root = await tempRoot("cpb-candidate-lock-malformed-owner");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const lockDir = path.join(hubRoot, "event-sources", "candidates.json.lock");

  await assertMalformedOwnersFailClosed(
    __candidateLockTestHooks,
    lockDir,
    "cpb-directory-lock/v1",
    () => ingestEvent(cpbRoot, {
      source: "github",
      externalId: "delivery-malformed-owner",
      projectId: "flow",
    }, { hubRoot }),
  );
});

test("dispatch lock treats malformed v2 identities as unknown and never quarantines them", async () => {
  const root = await tempRoot("cpb-dispatch-lock-malformed-owner");
  const hubRoot = path.join(root, "hub");
  const dispatch = await createDispatch(hubRoot, {
    projectId: "flow",
    sourcePath: root,
    ts: "2026-07-21T00:00:03.000Z",
  });
  assert.ok(dispatch?.dispatchId);
  const dispatchId = String(dispatch.dispatchId);
  const lockDir = path.join(hubRoot, "dispatches", `${dispatchId}.jsonl.lock`);

  await assertMalformedOwnersFailClosed(
    __dispatchLockTestHooks,
    lockDir,
    "cpb-directory-lock/v1",
    (variant) => {
      if (variant === "missing-precision") {
        return assignWorker(hubRoot, dispatchId, { workerId: "worker-malformed" });
      }
      if (variant === "invalid-precision") return startDispatch(hubRoot, dispatchId);
      return completeDispatch(hubRoot, dispatchId);
    },
  );
});

test("event, candidate, and dispatch hook scopes isolate concurrent operations", async () => {
  const root = await tempRoot("cpb-server-lock-hook-isolation");
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  delete process.env.CPB_HUB_ROOT;
  try {
    const eventFailureRoot = path.join(root, "event-failure");
    const eventSuccessRoot = path.join(root, "event-success");
    await Promise.all([
      withEventLockTestHooksForTests({ captureProcessIdentity: () => null }, () => assert.rejects(
        appendEvent(root, "flow", "job-event-failure", {
          type: "job_created",
          jobId: "job-event-failure",
          project: "flow",
          task: "isolated failure",
          workflow: "standard",
          ts: "2026-07-21T00:10:00.000Z",
        }, { dataRoot: eventFailureRoot }),
        { code: "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE" },
      )),
      withEventLockTestHooksForTests({}, () => appendEvent(root, "flow", "job-event-success", {
        type: "job_created",
        jobId: "job-event-success",
        project: "flow",
        task: "isolated success",
        workflow: "standard",
        ts: "2026-07-21T00:10:01.000Z",
      }, { dataRoot: eventSuccessRoot })),
    ]);

    await Promise.all([
      withCandidateLockTestHooksForTests({ captureProcessIdentity: () => null }, () => assert.rejects(
        ingestEvent(root, {
          source: "github",
          externalId: "candidate-hook-failure",
          projectId: "flow",
        }, { hubRoot: path.join(root, "candidate-failure") }),
        { code: "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE" },
      )),
      withCandidateLockTestHooksForTests({}, () => ingestEvent(root, {
        source: "github",
        externalId: "candidate-hook-success",
        projectId: "flow",
      }, { hubRoot: path.join(root, "candidate-success") })),
    ]);

    await Promise.all([
      withDispatchLockTestHooksForTests({ captureProcessIdentity: () => null }, () => assert.rejects(
        createDispatch(path.join(root, "dispatch-failure"), {
          projectId: "flow",
          sourcePath: root,
          ts: "2026-07-21T00:10:02.000Z",
        }),
        { code: "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE" },
      )),
      withDispatchLockTestHooksForTests({}, () => createDispatch(path.join(root, "dispatch-success"), {
        projectId: "flow",
        sourcePath: root,
        ts: "2026-07-21T00:10:03.000Z",
      })),
    ]);
  } finally {
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});
