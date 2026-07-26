import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import { captureCurrentProcessIdentity, captureProcessIdentity, type ProcessIdentity } from "../core/runtime/process-tree.js";
import {
  createSession,
  getSession,
  listSessions,
  noteReviewAcpCall,
  updateSession,
  withReviewSessionLockTestHooksForTests,
  type ReviewSessionLockTestHooks,
} from "../server/services/review/review-session.js";
import { tempRoot } from "./helpers.js";

const reviewSessionLockTestHookScope = new AsyncLocalStorage<ReviewSessionLockTestHooks>();
const __reviewSessionLockTestHooks = new Proxy({} as ReviewSessionLockTestHooks, {
  get(_target, property) {
    return Reflect.get(reviewSessionLockTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = reviewSessionLockTestHookScope.getStore();
    if (!hooks) throw new Error("review-session test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = reviewSessionLockTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: ReviewSessionLockTestHooks = {};
    return reviewSessionLockTestHookScope.run(
      hooks,
      () => withReviewSessionLockTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

function currentProcessIdentity() {
  const identity = captureProcessIdentity(process.pid, { strict: false });
  assert.ok(identity);
  return identity;
}

function exactCurrentProcessIdentityOrNull() {
  try {
    return captureCurrentProcessIdentity();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "PROCESS_IDENTITY_UNAVAILABLE") return null;
    throw error;
  }
}

async function reviewLockOwner(lockDir: string, ownerToken: string, identity = currentProcessIdentity()) {
  assert.ok(identity);
  return {
    format: "cpb-directory-lock/v1",
    ownerToken,
    lockPath: path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir)),
    pid: identity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      ...identity,
      birthIdPrecision: identity.birthIdPrecision === "coarse" ? "coarse" : "exact",
    },
  };
}

async function writeReviewLockOwner(lockDir: string, ownerToken: string, identity = currentProcessIdentity()) {
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(await reviewLockOwner(lockDir, ownerToken, identity), null, 2)}\n`, "utf8");
}

function predecessorIdentity(current: ProcessIdentity, suffix: string): ProcessIdentity {
  const birthId = `${current.birthId}:${suffix}`;
  return {
    ...current,
    birthId,
    incarnation: `${current.pid}:${birthId}`,
  };
}

async function withHubRoot<T>(hubRoot: string, fn: () => Promise<T>) {
  const previous = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previous;
  }
}

test("review session lock recovers a stale owner after PID reuse is disproven", async () => {
  const root = await tempRoot("cpb-review-session-lock-pid-reuse");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await withHubRoot(hubRoot, async () => {
    const session = await createSession(cpbRoot, { project: "flow", intent: "pid reuse" });
    const lockDir = path.join(hubRoot, "reviews", ".locks", "reviews.lock");
    const current = exactCurrentProcessIdentityOrNull();
    if (!current) return;
    await writeReviewLockOwner(lockDir, "predecessor-owner", predecessorIdentity(current, "predecessor"));
    const old = new Date(0);
    await utimes(lockDir, old, old);

    const updated = await updateSession(cpbRoot, session.sessionId, { status: "researching" });

    assert.equal(updated.status, "researching");
    assert.equal(existsSync(lockDir), false);
  });
});

test("review session stale recovery preserves an ABA successor owner", async () => {
  const root = await tempRoot("cpb-review-session-lock-aba");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await withHubRoot(hubRoot, async () => {
    const session = await createSession(cpbRoot, { project: "flow", intent: "aba" });
    const lockDir = path.join(hubRoot, "reviews", ".locks", "reviews.lock");
    const current = exactCurrentProcessIdentityOrNull();
    if (!current) return;
    await writeReviewLockOwner(lockDir, "predecessor-owner", predecessorIdentity(current, "aba-predecessor"));
    const old = new Date(0);
    await utimes(lockDir, old, old);

    let quarantineDir = "";
    __reviewSessionLockTestHooks.afterQuarantineRename = async ({ lockDir: originalLockDir, quarantineDir: quarantined }) => {
      quarantineDir = quarantined;
      await writeReviewLockOwner(originalLockDir, "successor-owner");
    };
    __reviewSessionLockTestHooks.waitMs = 100;
    try {
      await assert.rejects(
        updateSession(cpbRoot, session.sessionId, { status: "researching" }),
        (error: NodeJS.ErrnoException & { committed?: boolean; successorPreserved?: boolean; quarantinePreserved?: boolean }) => {
          assert.equal(error.code, "DIRECTORY_LOCK_SUCCESSOR_PRESERVED");
          assert.equal(error.committed, true);
          assert.equal(error.successorPreserved, true);
          assert.equal(error.quarantinePreserved, true);
          return true;
        },
      );
    } finally {
      __reviewSessionLockTestHooks.afterQuarantineRename = undefined;
      __reviewSessionLockTestHooks.waitMs = undefined;
    }

    const successor = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(successor.ownerToken, "successor-owner");
    assert.ok(quarantineDir);
    const predecessor = JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8"));
    assert.equal(predecessor.ownerToken, "predecessor-owner");
  });
});

test("review session lock fails closed on a symlinked lock path", async () => {
  const root = await tempRoot("cpb-review-session-lock-symlink");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const external = await tempRoot("cpb-review-session-lock-target");
  await withHubRoot(hubRoot, async () => {
    const session = await createSession(cpbRoot, { project: "flow", intent: "symlink" });
    const lockDir = path.join(hubRoot, "reviews", ".locks", "reviews.lock");
    await symlink(external, lockDir);

    await assert.rejects(
      updateSession(cpbRoot, session.sessionId, { status: "researching" }),
      /unsafe directory lock path|unsafe directory lock target/,
    );
  });
});

test("review session test hooks are isolated across overlapping async scopes", async () => {
  const root = await tempRoot("cpb-review-session-hook-isolation");
  const cpbRoot = path.join(root, "cpb");
  const firstHub = path.join(root, "hub-first");
  const secondHub = path.join(root, "hub-second");
  const first = await createSession(cpbRoot, { project: "flow", intent: "first", hubRoot: firstHub });
  const second = await createSession(cpbRoot, { project: "flow", intent: "second", hubRoot: secondHub });

  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const firstSeen: string[] = [];
  const secondSeen: string[] = [];

  const firstUpdate = withReviewSessionLockTestHooksForTests({
    beforeSessionPublish: async ({ filePath }) => {
      firstSeen.push(filePath);
      entered();
      await blocked;
    },
  }, () => updateSession(cpbRoot, first.sessionId, { status: "researching" }, { hubRoot: firstHub }));
  await firstEntered;
  const secondUpdate = withReviewSessionLockTestHooksForTests({
    beforeSessionPublish: ({ filePath }) => { secondSeen.push(filePath); },
  }, () => updateSession(cpbRoot, second.sessionId, { status: "researching" }, { hubRoot: secondHub }));

  const secondResult = await secondUpdate;
  assert.equal(secondResult.status, "researching");
  unblock();
  const firstResult = await firstUpdate;
  assert.equal(firstResult.status, "researching");
  assert.deepEqual(firstSeen, [path.join(firstHub, "reviews", `${first.sessionId}.json`)]);
  assert.deepEqual(secondSeen, [path.join(secondHub, "reviews", `${second.sessionId}.json`)]);
});

test("review session create is no-clobber when an id collides", async () => {
  const root = await tempRoot("cpb-review-session-create-collision");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sessionId = "rev-fixed-collision";
  const first = await withReviewSessionLockTestHooksForTests(
    { makeSessionId: () => sessionId },
    () => createSession(cpbRoot, { project: "flow", intent: "original", hubRoot }),
  );
  assert.equal(first.sessionId, sessionId);

  await assert.rejects(
    withReviewSessionLockTestHooksForTests(
      { makeSessionId: () => sessionId },
      () => createSession(cpbRoot, { project: "flow", intent: "replacement", hubRoot }),
    ),
    (error: NodeJS.ErrnoException & { committed?: boolean; successorPreserved?: boolean }) => {
      assert.equal(error.code, "REVIEW_SESSION_ID_COLLISION");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );
  assert.equal((await getSession(cpbRoot, sessionId, { hubRoot }))?.intent, "original");
});

test("review session create preserves a publication successor with truthful evidence", async () => {
  const root = await tempRoot("cpb-review-session-create-successor");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sessionId = "rev-create-successor";
  let recoveryPaths: string[] = [];

  await assert.rejects(
    withReviewSessionLockTestHooksForTests({
      makeSessionId: () => sessionId,
      beforeCreateDirectorySync: async ({ filePath }) => {
        const successor = JSON.parse(await readFile(filePath, "utf8"));
        successor.intent = "successor";
        successor.updatedAt = new Date().toISOString();
        await writeFile(filePath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
      },
    }, () => createSession(cpbRoot, { project: "flow", intent: "predecessor", hubRoot })),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      committedPath?: string | null;
      successorPreserved?: boolean;
      recoveryPaths?: string[];
    }) => {
      assert.equal(error.code, "REVIEW_SESSION_COMMITTED_PUBLICATION_RACE");
      assert.equal(error.committed, true);
      assert.equal(error.committedPath, null);
      assert.equal(error.successorPreserved, true);
      recoveryPaths = error.recoveryPaths || [];
      assert.ok(recoveryPaths.length > 0);
      return true;
    },
  );

  for (const recoveryPath of recoveryPaths) assert.equal(existsSync(recoveryPath), true);
  assert.equal((await getSession(cpbRoot, sessionId, { hubRoot }))?.intent, "successor");
});

test("review session reads reject symlinks, hardlinks, oversized files, and corrupt schema", async () => {
  const root = await tempRoot("cpb-review-session-read-safety");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");

  const symlinked = await createSession(cpbRoot, { project: "flow", intent: "symlink", hubRoot });
  const symlinkPath = path.join(hubRoot, "reviews", `${symlinked.sessionId}.json`);
  const external = path.join(root, "external.json");
  await writeFile(external, JSON.stringify(symlinked), "utf8");
  await rm(symlinkPath);
  await symlink(external, symlinkPath);
  await assert.rejects(getSession(cpbRoot, symlinked.sessionId, { hubRoot }), /unsafe review session|bounded read/i);

  const hardlinked = await createSession(cpbRoot, { project: "flow", intent: "hardlink", hubRoot });
  const hardlinkPath = path.join(hubRoot, "reviews", `${hardlinked.sessionId}.json`);
  await link(hardlinkPath, path.join(root, "hardlink-alias.json"));
  await assert.rejects(
    getSession(cpbRoot, hardlinked.sessionId, { hubRoot }),
    (error: NodeJS.ErrnoException) => error.code === "REVIEW_SESSION_FILE_UNSAFE",
  );

  const oversized = await createSession(cpbRoot, { project: "flow", intent: "oversized", hubRoot });
  await writeFile(path.join(hubRoot, "reviews", `${oversized.sessionId}.json`), Buffer.alloc(17 * 1024 * 1024, 0x20));
  await assert.rejects(
    getSession(cpbRoot, oversized.sessionId, { hubRoot }),
    (error: NodeJS.ErrnoException) => error.code === "REVIEW_SESSION_FILE_TOO_LARGE",
  );

  const corrupt = await createSession(cpbRoot, { project: "flow", intent: "corrupt", hubRoot });
  await writeFile(
    path.join(hubRoot, "reviews", `${corrupt.sessionId}.json`),
    `${JSON.stringify({ sessionId: corrupt.sessionId, status: "idle" })}\n`,
    "utf8",
  );
  await assert.rejects(
    getSession(cpbRoot, corrupt.sessionId, { hubRoot }),
    (error: NodeJS.ErrnoException) => error.code === "REVIEW_SESSION_SCHEMA_INVALID",
  );
});

test("review session listing reports corrupt entries instead of dropping them", async () => {
  const root = await tempRoot("cpb-review-session-list-corrupt");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await createSession(cpbRoot, { project: "flow", intent: "valid", hubRoot });
  await writeFile(path.join(hubRoot, "reviews", "rev-corrupt.json"), "{not-json\n", "utf8");

  await assert.rejects(
    listSessions(cpbRoot, { hubRoot }),
    (error: NodeJS.ErrnoException) => error.code === "REVIEW_SESSION_JSON_INVALID",
  );
});

test("review session update preserves an ABA successor and failed temp evidence", async () => {
  const root = await tempRoot("cpb-review-session-update-aba");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const session = await createSession(cpbRoot, { project: "flow", intent: "predecessor", hubRoot });
  const filePath = path.join(hubRoot, "reviews", `${session.sessionId}.json`);
  const successor = { ...session, intent: "successor", updatedAt: new Date().toISOString() };

  let recoveryPaths: string[] = [];
  await assert.rejects(
    withReviewSessionLockTestHooksForTests({
      beforeSessionPublish: async () => {
        await writeFile(filePath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
      },
    }, () => updateSession(cpbRoot, session.sessionId, { status: "researching" }, { hubRoot })),
    (error: NodeJS.ErrnoException & { committed?: boolean; successorPreserved?: boolean; recoveryPaths?: unknown }) => {
      assert.equal(error.code, "REVIEW_SESSION_GENERATION_CONFLICT");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      recoveryPaths = Array.isArray(error.recoveryPaths) ? error.recoveryPaths : [];
      assert.ok(recoveryPaths.length > 0);
      return true;
    },
  );

  for (const recoveryPath of recoveryPaths) assert.equal(existsSync(recoveryPath), true);
  assert.equal((await getSession(cpbRoot, session.sessionId, { hubRoot }))?.intent, "successor");
  const recoveryEntries = await readdir(path.join(hubRoot, "reviews"));
  assert.ok(recoveryEntries.some((name) => name.includes(".failed-")));
});

test("review session update reports committed publication races without deleting the successor", async () => {
  const root = await tempRoot("cpb-review-session-update-committed-race");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const session = await createSession(cpbRoot, { project: "flow", intent: "predecessor", hubRoot });
  const filePath = path.join(hubRoot, "reviews", `${session.sessionId}.json`);
  let recoveryPaths: string[] = [];

  await assert.rejects(
    withReviewSessionLockTestHooksForTests({
      afterSessionPublish: async () => {
        const successor = JSON.parse(await readFile(filePath, "utf8"));
        successor.intent = "successor-after-publication";
        successor.updatedAt = new Date().toISOString();
        await writeFile(filePath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
      },
    }, () => updateSession(cpbRoot, session.sessionId, { status: "researching" }, { hubRoot })),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      committedPath?: string | null;
      successorPreserved?: boolean;
      recoveryPaths?: string[];
    }) => {
      assert.equal(error.code, "DURABLE_JSON_COMMITTED_PUBLICATION_RACE");
      assert.equal(error.committed, true);
      assert.equal(error.committedPath, filePath);
      assert.equal(error.successorPreserved, true);
      recoveryPaths = error.recoveryPaths || [];
      assert.ok(recoveryPaths.length > 0);
      return true;
    },
  );

  for (const recoveryPath of recoveryPaths) assert.equal(existsSync(recoveryPath), true);
  assert.equal(
    (await getSession(cpbRoot, session.sessionId, { hubRoot }))?.intent,
    "successor-after-publication",
  );
});

test("review session read fails closed when its parent directory is replaced", async () => {
  const root = await tempRoot("cpb-review-session-parent-replacement");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const session = await createSession(cpbRoot, { project: "flow", intent: "predecessor", hubRoot });
  const reviewsDirectory = path.join(hubRoot, "reviews");
  const predecessorDirectory = path.join(hubRoot, "reviews-predecessor");
  const successor = { ...session, intent: "successor", updatedAt: new Date().toISOString() };
  let replaced = false;

  await assert.rejects(
    withReviewSessionLockTestHooksForTests({
      readFile: {
        beforePathGenerationCheck: async () => {
          if (replaced) return;
          replaced = true;
          await rename(reviewsDirectory, predecessorDirectory);
          await mkdir(reviewsDirectory);
          await writeFile(
            path.join(reviewsDirectory, `${session.sessionId}.json`),
            `${JSON.stringify(successor, null, 2)}\n`,
            "utf8",
          );
        },
      },
    }, () => getSession(cpbRoot, session.sessionId, { hubRoot })),
    (error: NodeJS.ErrnoException & { successorPreserved?: boolean }) => {
      assert.equal(error.code, "REVIEW_SESSION_DIRECTORY_UNSAFE");
      assert.equal(error.successorPreserved, true);
      return true;
    },
  );

  assert.equal(JSON.parse(await readFile(
    path.join(reviewsDirectory, `${session.sessionId}.json`),
    "utf8",
  )).intent, "successor");
  assert.equal(JSON.parse(await readFile(
    path.join(predecessorDirectory, `${session.sessionId}.json`),
    "utf8",
  )).intent, "predecessor");
});

test("review session read-modify-write operations share one fence", async () => {
  const root = await tempRoot("cpb-review-session-shared-fence");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const session = await createSession(cpbRoot, { project: "flow", intent: "budget", hubRoot });

  await Promise.all([
    noteReviewAcpCall(cpbRoot, session.sessionId, { agent: "codex", promptBytes: 11 }, { hubRoot }),
    noteReviewAcpCall(cpbRoot, session.sessionId, { agent: "claude", promptBytes: 13 }, { hubRoot }),
  ]);

  const loaded = await getSession(cpbRoot, session.sessionId, { hubRoot });
  assert.equal(loaded?.budget.usedAcpCalls, 2);
  assert.equal(loaded?.budget.usedPromptBytes, 24);
});

test("review session lock identity capture does not depend on PATH ps lookup", async () => {
  const root = await tempRoot("cpb-review-session-lock-path");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const previousPath = process.env.PATH;
  await withHubRoot(hubRoot, async () => {
    const session = await createSession(cpbRoot, { project: "flow", intent: "path" });
    process.env.PATH = path.join(root, "missing-bin");
    try {
      await updateSession(cpbRoot, session.sessionId, { status: "researching" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const loaded = await getSession(cpbRoot, session.sessionId);
    assert.equal(loaded?.status, "researching");
  });
});
