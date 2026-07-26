import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { checkCodeGraphReady } from "../server/services/infra.js";
import { withCodeGraphReadinessTestHooksForTests } from "../server/services/readiness-checks.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import type { BoundedRegularFileReadHooks } from "../core/runtime/durable-directory-lock.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

async function withPatchedProcessKill<T>(
  impl: (pid: number, signal?: NodeJS.Signals | number) => true,
  fn: () => Promise<T>,
) {
  const originalKill = process.kill;
  Object.defineProperty(process, "kill", {
    configurable: true,
    value: impl,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: originalKill,
    });
  }
}

function currentProcessIdentity(pid = process.pid) {
  const identity = captureProcessIdentity(pid, { strict: true });
  assert.ok(identity, `expected process identity for pid ${pid}`);
  return identity;
}

function daemonState(sourcePath: string, pid = process.pid, overrides: Record<string, unknown> = {}) {
  return {
    pid,
    processIdentity: currentProcessIdentity(pid),
    codebaseRoot: sourcePath,
    socketPath: path.join(sourcePath, ".codegraph", "daemon.sock"),
    source: "codegraph_daemon",
    ...overrides,
  };
}

async function withBoundedReadHooks<T>(hooks: BoundedRegularFileReadHooks, operation: () => Promise<T>) {
  return withCodeGraphReadinessTestHooksForTests({ boundedRead: hooks }, operation);
}

async function assertCodeGraphUnavailable(
  operation: () => Promise<unknown>,
  reason: string,
  errorCode?: string,
) {
  await assert.rejects(operation, (error) => {
    const typed = error as Error & {
      code?: string;
      details?: { reason?: string; errorCode?: string; error?: string; statePath?: string };
    };
    assert.equal(typed.code, "codegraph_unavailable");
    assert.equal(typed.details?.reason, reason);
    if (errorCode) assert.equal(typed.details?.errorCode, errorCode);
    if (errorCode) assert.ok(typed.details?.error);
    return true;
  });
}

async function writeCodeGraphReadyFixture(prefix: string, pid = process.pid) {
  const cpbRoot = await tempRoot(`${prefix}-cpb`);
  const sourcePath = await tempRoot(`${prefix}-source`);
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));
  const daemonPath = path.join(await realpath(sourcePath), ".codegraph", "daemon.pid");
  const state = daemonState(sourcePath, pid);
  await writeFile(daemonPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { cpbRoot, sourcePath, pid, daemonPath, state };
}

function errno(code: string) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("CodeGraph index-only flag is allowed through child env policy", () => {
  const env = buildChildEnv({
    CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
    NOT_ALLOWED_FLAG: "1",
  }) as Record<string, unknown>;
  assert.equal(env.CPB_CODEGRAPH_INDEX_ONLY_OK, "1");
  assert.equal(env.NOT_ALLOWED_FLAG, undefined);
});

test("project runtime root is only passed to child env through explicit overrides", () => {
  const fromParent = buildChildEnv({
    CPB_PROJECT_RUNTIME_ROOT: "/tmp/poisoned-runtime-root",
  }) as Record<string, unknown>;
  assert.equal(fromParent.CPB_PROJECT_RUNTIME_ROOT, undefined);

  const explicit = buildChildEnv({}, {
    CPB_PROJECT_RUNTIME_ROOT: "/tmp/verified-runtime-root",
  }) as Record<string, unknown>;
  assert.equal(explicit.CPB_PROJECT_RUNTIME_ROOT, "/tmp/verified-runtime-root");
});

test("CodeGraph readiness can explicitly accept a static index without daemon state", async () => {
  const sourcePath = await tempRoot("cpb-codegraph-index-only");
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));

  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    const readiness = await checkCodeGraphReady({ sourcePath });
    assert.equal(readiness.available, true);
    assert.match(readiness.indexFile, /codegraph\.db$/);
    assert.equal(readiness.state.source, "index_only");
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
});

test("CodeGraph index-only mode rejects an invalid canonical daemon owner instead of treating it as absent", async () => {
  const cpbRoot = await tempRoot("cpb-codegraph-index-invalid-owner-cpb");
  const sourcePath = await tempRoot("cpb-codegraph-index-invalid-owner-source");
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));
  await writeFile(path.join(cgDir, "daemon.pid"), `${JSON.stringify({ pid: 0 }, null, 2)}\n`, "utf8");

  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    await assertCodeGraphUnavailable(
      () => checkCodeGraphReady({ cpbRoot, sourcePath }),
      "invalid_codegraph_state",
    );
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
});

test("CodeGraph readiness rejects a string pid instead of coercing it", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-string-owner-pid");
  await writeFile(daemonPath, `${JSON.stringify({ ...state, pid: String(process.pid) }, null, 2)}\n`, "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "invalid_codegraph_state",
  );
});

test("CodeGraph index-only mode ignores mismatched CPB root daemon state", async () => {
  const cpbRoot = await tempRoot("cpb-codegraph-index-only-cpb");
  const hubRoot = await tempRoot("cpb-codegraph-index-only-hub");
  const sourcePath = await tempRoot("cpb-codegraph-index-only-source");
  await mkdir(hubRoot, { recursive: true });
  await writeFile(path.join(hubRoot, "codegraph-state.json"), `${JSON.stringify({
    pid: process.pid,
    codebaseRoot: cpbRoot,
  }, null, 2)}\n`);
  const cgDir = path.join(sourcePath, ".codegraph");
  await mkdir(cgDir, { recursive: true });
  await writeFile(path.join(cgDir, "codegraph.db"), Buffer.alloc(2048, 1));
  await writeFile(path.join(cgDir, "daemon.pid"), JSON.stringify({
    pid: process.pid,
    processIdentity: currentProcessIdentity(),
    version: "test",
    codebaseRoot: sourcePath,
    socketPath: path.join(cgDir, "daemon.sock"),
  }) + "\n", "utf8");

  const readiness = await checkCodeGraphReady({ cpbRoot, hubRoot, sourcePath });
  assert.equal(readiness.available, true);
});

test("CodeGraph readiness treats kill(0) EPERM as unverified", async () => {
  const { cpbRoot, sourcePath, pid } = await writeCodeGraphReadyFixture("cpb-codegraph-eperm-alive");

  await assert.rejects(
    () => withPatchedProcessKill((checkedPid, signal) => {
      assert.equal(checkedPid, pid);
      assert.equal(signal, 0);
      throw errno("EPERM");
    }, () => checkCodeGraphReady({ cpbRoot, sourcePath })),
    /CodeGraph process is not running/,
  );
});

test("CodeGraph readiness treats unknown kill(0) errors as unverified", async () => {
  const { cpbRoot, sourcePath, pid } = await writeCodeGraphReadyFixture("cpb-codegraph-eio-alive");

  await assert.rejects(
    () => withPatchedProcessKill((checkedPid, signal) => {
      assert.equal(checkedPid, pid);
      assert.equal(signal, 0);
      throw errno("EIO");
    }, () => checkCodeGraphReady({ cpbRoot, sourcePath })),
    /CodeGraph process is not running/,
  );
});

test("CodeGraph readiness treats kill(0) ESRCH as a dead daemon", async () => {
  const { cpbRoot, sourcePath, pid } = await writeCodeGraphReadyFixture("cpb-codegraph-esrch-dead");

  await assert.rejects(
    () => withPatchedProcessKill((checkedPid, signal) => {
      assert.equal(checkedPid, pid);
      assert.equal(signal, 0);
      throw errno("ESRCH");
    }, () => checkCodeGraphReady({ cpbRoot, sourcePath })),
    /CodeGraph process is not running/,
  );
});

test("CodeGraph readiness does not trust writable CPB state without the canonical daemon owner", async () => {
  const cpbRoot = await tempRoot("cpb-codegraph-unbound-state-cpb");
  const sourcePath = await tempRoot("cpb-codegraph-unbound-state-source");
  await mkdir(path.join(cpbRoot, "cpb-task"), { recursive: true });
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(2048, 1));
  await writeFile(
    path.join(cpbRoot, "cpb-task", "codegraph-state.json"),
    `${JSON.stringify(daemonState(sourcePath), null, 2)}\n`,
    "utf8",
  );

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unbound_codegraph_state",
  );
});

test("CodeGraph readiness rejects a symlinked daemon owner instead of following it", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-symlink-owner");
  const externalRoot = await tempRoot("cpb-codegraph-symlink-owner-external");
  const externalState = path.join(externalRoot, "daemon.pid");
  await writeFile(externalState, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rm(daemonPath);
  await symlink(externalState, daemonPath);

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "BOUNDED_FILE_UNSAFE",
  );
});

test("CodeGraph readiness rejects an oversized daemon owner with a bounded error", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-oversized-owner");
  await writeFile(
    daemonPath,
    `${JSON.stringify({ ...state, padding: "x".repeat(64 * 1024) }, null, 2)}\n`,
    "utf8",
  );

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "BOUNDED_FILE_TOO_LARGE",
  );
});

test("CodeGraph readiness rejects a non-regular daemon owner as unsafe, not missing", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-directory-owner");
  await rm(daemonPath);
  await mkdir(daemonPath);

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "BOUNDED_FILE_UNSAFE",
  );
});

test("CodeGraph readiness reports non-ENOENT owner read failures explicitly", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-owner-read-error");
  let injected = false;

  await withBoundedReadHooks({
    afterOpen: ({ filePath }) => {
      if (filePath !== daemonPath) return;
      injected = true;
      throw errno("EIO");
    },
  }, () => assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "EIO",
  ));
  assert.equal(injected, true);
});

test("CodeGraph readiness reports malformed owner JSON instead of treating it as missing", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-malformed-owner");
  await writeFile(daemonPath, "{not-json\n", "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "malformed_codegraph_state",
    "CODEGRAPH_STATE_MALFORMED",
  );
});

test("CodeGraph readiness rejects descriptor-generation ABA during owner read", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-descriptor-aba");
  let changed = false;

  await withBoundedReadHooks({
    afterChunk: async ({ filePath }) => {
      if (changed || filePath !== daemonPath) return;
      changed = true;
      await utimes(filePath, new Date(1_000), new Date(2_000));
    },
  }, () => assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "BOUNDED_FILE_CHANGED",
  ));
  assert.equal(changed, true);
});

test("CodeGraph readiness rejects path-generation ABA after a pinned owner read", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-path-aba");
  const raw = await readFile(daemonPath);
  const retiredPath = `${daemonPath}.retired`;
  let swapped = false;

  await withBoundedReadHooks({
    beforePathGenerationCheck: async ({ filePath }) => {
      if (swapped || filePath !== daemonPath) return;
      swapped = true;
      await rename(daemonPath, retiredPath);
      await writeFile(daemonPath, raw);
    },
  }, () => assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "unsafe_codegraph_state",
    "BOUNDED_FILE_CHANGED",
  ));
  assert.equal(swapped, true);
  assert.deepEqual(await readFile(daemonPath), raw);
  assert.deepEqual(await readFile(retiredPath), raw);
});

test("CodeGraph readiness hooks stay isolated across overlapping async reads", async () => {
  const first = await writeCodeGraphReadyFixture("cpb-codegraph-hook-scope-first");
  const second = await writeCodeGraphReadyFixture("cpb-codegraph-hook-scope-second");
  let firstEntered!: () => void;
  const firstObserved = new Promise<void>((resolve) => { firstEntered = resolve; });
  let resumeFirst!: () => void;
  const firstResume = new Promise<void>((resolve) => { resumeFirst = resolve; });
  const observations: string[] = [];

  const firstRead = withBoundedReadHooks({
    afterOpen: async ({ filePath }) => {
      if (filePath !== first.daemonPath) return;
      observations.push("first-before");
      firstEntered();
      await firstResume;
      observations.push("first-after");
    },
  }, () => checkCodeGraphReady({ cpbRoot: first.cpbRoot, sourcePath: first.sourcePath }));

  await firstObserved;
  const secondResult = await withBoundedReadHooks({
    afterOpen: ({ filePath }) => {
      if (filePath === second.daemonPath) observations.push("second");
    },
  }, () => checkCodeGraphReady({ cpbRoot: second.cpbRoot, sourcePath: second.sourcePath }));
  resumeFirst();
  const firstResult = await firstRead;

  assert.equal(firstResult.available, true);
  assert.equal(secondResult.available, true);
  assert.deepEqual(observations, ["first-before", "second", "first-after"]);
});

test("CodeGraph readiness requires a persisted exact identity and never recaptures one from pid", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-no-owner-identity");
  await writeFile(daemonPath, `${JSON.stringify({
    pid: process.pid,
    codebaseRoot: sourcePath,
    socketPath: path.join(sourcePath, ".codegraph", "daemon.sock"),
  }, null, 2)}\n`, "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "missing_process_identity",
  );
});

test("CodeGraph readiness derives a missing root only from the pinned canonical daemon-owner path", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-missing-owner-root");
  const { codebaseRoot: _ignored, ...withoutRoot } = state;
  await writeFile(daemonPath, `${JSON.stringify(withoutRoot, null, 2)}\n`, "utf8");

  const readiness = await checkCodeGraphReady({ cpbRoot, sourcePath });

  assert.equal(readiness.available, true);
  assert.equal(readiness.state.codebaseRoot, await realpath(sourcePath));
  assert.equal((readiness.state as { statePath?: string }).statePath, daemonPath);
});

test("CodeGraph readiness rejects an explicit owner root bound to another source", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-wrong-owner-root");
  const otherSource = await tempRoot("cpb-codegraph-wrong-owner-root-other");
  await writeFile(daemonPath, `${JSON.stringify({ ...state, codebaseRoot: otherSource }, null, 2)}\n`, "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "codegraph_root_mismatch",
  );
});

test("CodeGraph readiness rejects an explicitly malformed owner root instead of treating it as missing", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-malformed-owner-root");
  await writeFile(daemonPath, `${JSON.stringify({ ...state, codebaseRoot: 42 }, null, 2)}\n`, "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "invalid_codegraph_state",
  );
});

test("CodeGraph readiness rejects an owner that declares a different state path", async () => {
  const { cpbRoot, sourcePath, daemonPath, state } = await writeCodeGraphReadyFixture("cpb-codegraph-owner-path-mismatch");
  await writeFile(daemonPath, `${JSON.stringify({
    ...state,
    statePath: path.join(sourcePath, ".codegraph", "other-daemon.pid"),
  }, null, 2)}\n`, "utf8");

  await assertCodeGraphUnavailable(
    () => checkCodeGraphReady({ cpbRoot, sourcePath }),
    "codegraph_state_path_mismatch",
  );
});

test("CodeGraph readiness returns the canonical owner path used for its proof", async () => {
  const { cpbRoot, sourcePath, daemonPath } = await writeCodeGraphReadyFixture("cpb-codegraph-owner-path-proof");

  const readiness = await checkCodeGraphReady({ cpbRoot, sourcePath });

  assert.equal(readiness.available, true);
  assert.equal((readiness.state as { statePath?: string }).statePath, daemonPath);
});
