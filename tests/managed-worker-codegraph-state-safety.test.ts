import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readFile, readlink, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import {
  _removeStaleCodeGraphStateForTests,
  withCodeGraphStateTestHooksForTests,
  type CodeGraphStateTestHooks,
} from "../runtime/worker/managed-worker.js";
import { tempRoot } from "./helpers.js";

const codeGraphStateTestHookScope = new AsyncLocalStorage<CodeGraphStateTestHooks>();
const __codeGraphStateTestHooks = new Proxy({} as CodeGraphStateTestHooks, {
  get(_target, property) {
    return Reflect.get(codeGraphStateTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = codeGraphStateTestHookScope.getStore();
    if (!hooks) throw new Error("CodeGraph state hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = codeGraphStateTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: CodeGraphStateTestHooks = {};
    return codeGraphStateTestHookScope.run(
      hooks,
      () => withCodeGraphStateTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

const CODEGRAPH_STATE_MAX_BYTES = 64 * 1024;

async function stateFixture(prefix: string, source = "stale-codegraph") {
  const root = await tempRoot(prefix);
  const worktreePath = path.join(root, "worktree");
  const statePath = path.join(worktreePath, ".codegraph", "daemon.pid");
  await mkdir(path.dirname(statePath), { recursive: true });
  const canonicalWorktreePath = await realpath(worktreePath);
  const pid = 999_999;
  const birthId = `${source}-birth`;
  const state = {
    pid,
    codebaseRoot: canonicalWorktreePath,
    socketPath: null,
    source,
    processIdentity: {
      pid,
      birthId,
      incarnation: `${pid}:${birthId}`,
      capturedAt: "2026-07-21T00:00:00.000Z",
      birthIdPrecision: "exact",
    },
  };
  return { root, worktreePath, canonicalWorktreePath, statePath, state };
}

function serialized(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("managed worker rejects a symbolic-link CodeGraph state without mutating its target", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-symlink");
  const outside = path.join(fixture.root, "outside-daemon.json");
  const outsideContent = serialized(fixture.state);
  await writeFile(outside, outsideContent, "utf8");
  await symlink(outside, fixture.statePath);

  await assert.rejects(
    _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
    (error: NodeJS.ErrnoException) => error.code === "codegraph_runtime_failed",
  );

  assert.equal(await readFile(outside, "utf8"), outsideContent);
  assert.equal(await readlink(fixture.statePath), outside);
});

test("managed worker rejects oversized CodeGraph state without deleting it", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-oversized");
  const oversized = "x".repeat(CODEGRAPH_STATE_MAX_BYTES + 1);
  await writeFile(fixture.statePath, oversized, "utf8");

  await assert.rejects(
    _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
    (error: NodeJS.ErrnoException) => error.code === "codegraph_runtime_failed",
  );
  assert.equal((await lstat(fixture.statePath)).size, oversized.length);
});

test("managed worker preserves a canonical CodeGraph successor before quarantine", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-pre-quarantine");
  const successor = { ...fixture.state, source: "codegraph-successor" };
  const successorContent = serialized(successor);
  await writeFile(fixture.statePath, serialized(fixture.state), "utf8");

  __codeGraphStateTestHooks.afterStaleStateObserved = async ({ statePath }) => {
    const replacement = `${statePath}.replacement`;
    await writeFile(replacement, successorContent, "utf8");
    await rename(replacement, statePath);
  };
  try {
    await assert.rejects(
      _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
      (error: NodeJS.ErrnoException & {
        committed?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: { canonical?: string };
      }) => error.code === "codegraph_runtime_failed"
        && error.committed === false
        && error.successorPreserved === true
        && error.recoveryPaths?.canonical === fixture.statePath,
    );
  } finally {
    __codeGraphStateTestHooks.afterStaleStateObserved = undefined;
  }
  assert.equal(await readFile(fixture.statePath, "utf8"), successorContent);
});

test("managed worker preserves a CodeGraph successor and quarantine after rename", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-post-quarantine");
  const originalContent = serialized(fixture.state);
  const successor = { ...fixture.state, source: "codegraph-post-rename-successor" };
  const successorContent = serialized(successor);
  await writeFile(fixture.statePath, originalContent, "utf8");
  let quarantinePath = "";

  __codeGraphStateTestHooks.afterStateQuarantineRename = async (context) => {
    quarantinePath = context.quarantinePath;
    await writeFile(context.statePath, successorContent, "utf8");
  };
  try {
    await assert.rejects(
      _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
      (error: NodeJS.ErrnoException & {
        committed?: boolean;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: { canonical?: string; quarantine?: string };
      }) => error.code === "codegraph_runtime_failed"
        && error.committed === true
        && error.quarantinePreserved === true
        && error.successorPreserved === true
        && error.recoveryPaths?.canonical === fixture.statePath
        && error.recoveryPaths.quarantine === quarantinePath,
    );
  } finally {
    __codeGraphStateTestHooks.afterStateQuarantineRename = undefined;
  }
  assert.equal(await readFile(fixture.statePath, "utf8"), successorContent);
  assert.equal(await readFile(quarantinePath, "utf8"), originalContent);
});

test("managed worker preserves a same-owner CodeGraph quarantine generation ABA", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-quarantine-aba");
  const originalContent = serialized(fixture.state);
  await writeFile(fixture.statePath, originalContent, "utf8");
  let quarantinePath = "";

  __codeGraphStateTestHooks.afterStateQuarantineRename = async (context) => {
    quarantinePath = context.quarantinePath;
    await writeFile(quarantinePath, originalContent, "utf8");
  };
  try {
    await assert.rejects(
      _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
      (error: NodeJS.ErrnoException & {
        committed?: boolean;
        quarantinePreserved?: boolean;
        recoveryPaths?: { quarantine?: string };
      }) => error.code === "codegraph_runtime_failed"
        && error.committed === true
        && error.quarantinePreserved === true
        && error.recoveryPaths?.quarantine === quarantinePath,
    );
  } finally {
    __codeGraphStateTestHooks.afterStateQuarantineRename = undefined;
  }
  assert.equal(await readFile(quarantinePath, "utf8"), originalContent);
});

test("managed worker retains a verified stale CodeGraph quarantine as recovery evidence", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-quarantine-evidence");
  const originalContent = serialized(fixture.state);
  await writeFile(fixture.statePath, originalContent, "utf8");

  await _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath);

  await assert.rejects(lstat(fixture.statePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const quarantineNames = (await readdir(path.dirname(fixture.statePath)))
    .filter((name) => name.startsWith(`${path.basename(fixture.statePath)}.stale-`));
  assert.equal(quarantineNames.length, 1);
  assert.equal(
    await readFile(path.join(path.dirname(fixture.statePath), quarantineNames[0]), "utf8"),
    originalContent,
  );
});

test("managed worker fails closed when CodeGraph quarantine directory fsync is unsupported", async () => {
  const fixture = await stateFixture("cpb-codegraph-state-rename-fsync");
  await writeFile(fixture.statePath, serialized(fixture.state), "utf8");
  let quarantinePath = "";

  __codeGraphStateTestHooks.syncDirectory = ({ phase }) => {
    if (phase === "quarantine-rename") {
      throw Object.assign(new Error("directory fsync unsupported"), { code: "ENOTSUP" });
    }
  };
  try {
    await assert.rejects(
      _removeStaleCodeGraphStateForTests(fixture.statePath, fixture.canonicalWorktreePath),
      (error: NodeJS.ErrnoException & {
        committed?: boolean;
        removalCommitted?: boolean;
        quarantinePreserved?: boolean;
        recoveryPaths?: { canonical?: string; quarantine?: string };
      }) => {
        quarantinePath = error.recoveryPaths?.quarantine || "";
        return error.code === "codegraph_runtime_failed"
          && error.committed === true
          && error.removalCommitted === false
          && error.quarantinePreserved === true
          && error.recoveryPaths?.canonical === fixture.statePath
          && quarantinePath.length > 0;
      },
    );
  } finally {
    __codeGraphStateTestHooks.syncDirectory = undefined;
  }
  await assert.rejects(lstat(fixture.statePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal((await lstat(quarantinePath)).isFile(), true);
});

test("managed worker CodeGraph state hooks stay isolated across overlapping cleanup scopes", async () => {
  const first = await stateFixture("cpb-codegraph-state-hook-scope-first", "first-owner");
  const second = await stateFixture("cpb-codegraph-state-hook-scope-second", "second-owner");
  await writeFile(first.statePath, serialized(first.state), "utf8");
  await writeFile(second.statePath, serialized(second.state), "utf8");

  let firstEntered!: () => void;
  const firstObserved = new Promise<void>((resolve) => { firstEntered = resolve; });
  let resumeFirst!: () => void;
  const firstResume = new Promise<void>((resolve) => { resumeFirst = resolve; });
  const observations: string[] = [];

  const firstCleanup = withCodeGraphStateTestHooksForTests({
    afterStaleStateObserved: async () => {
      observations.push("first-before");
      firstEntered();
      await firstResume;
    },
    afterStateQuarantineRename: () => { observations.push("first-after"); },
  }, () => _removeStaleCodeGraphStateForTests(first.statePath, first.canonicalWorktreePath));

  await firstObserved;
  await withCodeGraphStateTestHooksForTests({
    afterStateQuarantineRename: () => { observations.push("second"); },
  }, () => _removeStaleCodeGraphStateForTests(second.statePath, second.canonicalWorktreePath));
  resumeFirst();
  await firstCleanup;

  assert.deepEqual(observations, ["first-before", "second", "first-after"]);
});
