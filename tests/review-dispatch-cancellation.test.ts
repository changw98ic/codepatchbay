import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  analyzeSession,
  cancelReviewDispatch,
  runReview,
} from "../server/services/review/review-dispatch.js";
import {
  createSession,
  getSession,
  updateSession,
  updateSessionIfNotCancelled,
} from "../server/services/review/review-session.js";
import { tempRoot } from "./helpers.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../core/runtime/process-tree.js";

const test = (name: string, fn: (t: any) => void | Promise<void>) => {
  void nodeTest(name, { concurrency: false }, fn);
};

function fakeIdentity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function nestedErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    codes.push(error.code);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) codes.push(...nestedErrorCodes(nested));
  }
  return codes;
}

async function writeFakeAcp(root: string) {
  const scriptPath = path.join(root, "fake-acp.mjs");
  await writeFile(scriptPath, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const agent = process.argv[2];
const pidDir = process.argv[3];
const mode = process.argv[4] || "";
const badProtocol = mode === "bad";
const failTeardown = mode === "fail-teardown";
mkdirSync(pidDir, { recursive: true });
writeFileSync(path.join(pidDir, \`\${agent}.pid\`), String(process.pid));
const { spawn } = await import("node:child_process");
const grandchild = spawn(process.execPath, ["-e", failTeardown
  ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"
  : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});
writeFileSync(path.join(pidDir, \`\${agent}-grandchild.pid\`), String(grandchild.pid));

let terminating = false;
process.on("SIGTERM", () => {
  if (terminating) return;
  terminating = true;
  if (failTeardown) return;
  setTimeout(() => process.exit(0), 80);
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      const protocolVersion = badProtocol ? 2 : 1;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion } }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: \`\${agent}-session\` } }) + "\\n");
    } else if (msg.method !== "session/prompt" && Object.hasOwn(msg, "id")) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }) + "\\n");
    }
  }
});

setInterval(() => {}, 1000);
`, "utf8");
  return scriptPath;
}

async function readPid(pidDir: string, agent: string) {
  return Number((await readFile(path.join(pidDir, `${agent}.pid`), "utf8")).trim());
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFakeChildren(pidDir: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const pids = await readFakePids(pidDir);
      if (pids.every((pid) => Number.isInteger(pid) && pidAlive(pid))) return pids;
    } catch {}
    await delay(20);
  }
  throw new Error("fake ACP children did not start");
}

async function readFakePids(pidDir: string) {
  return [
    await readPid(pidDir, "codex"),
    await readPid(pidDir, "codex-grandchild"),
    await readPid(pidDir, "claude"),
    await readPid(pidDir, "claude-grandchild"),
  ];
}

async function waitForFakePidRecords(pidDir: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const pids = await readFakePids(pidDir);
      if (pids.every((pid) => Number.isInteger(pid) && pid > 0)) return pids;
    } catch {}
    await delay(20);
  }
  throw new Error("fake ACP children did not record their pids");
}

async function withFakeReviewEnv<T>(
  hubRoot: string,
  scriptPath: string,
  pidDir: string,
  fn: () => Promise<T>,
  badProtocolAgent?: string,
  modeByAgent: Record<string, string> = {},
) {
  const previous = {
    CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
    CPB_ACP_CODEX_COMMAND: process.env.CPB_ACP_CODEX_COMMAND,
    CPB_ACP_CODEX_ARGS: process.env.CPB_ACP_CODEX_ARGS,
    CPB_ACP_CLAUDE_COMMAND: process.env.CPB_ACP_CLAUDE_COMMAND,
    CPB_ACP_CLAUDE_ARGS: process.env.CPB_ACP_CLAUDE_ARGS,
    CPB_REVIEW_ACP_TERM_GRACE_MS: process.env.CPB_REVIEW_ACP_TERM_GRACE_MS,
    CPB_REVIEW_ACP_KILL_GRACE_MS: process.env.CPB_REVIEW_ACP_KILL_GRACE_MS,
  };

  process.env.CPB_HUB_ROOT = hubRoot;
  process.env.CPB_ACP_CODEX_COMMAND = process.execPath;
  process.env.CPB_ACP_CODEX_ARGS = JSON.stringify([scriptPath, "codex", pidDir, modeByAgent.codex || (badProtocolAgent === "codex" ? "bad" : "")].filter(Boolean));
  process.env.CPB_ACP_CLAUDE_COMMAND = process.execPath;
  process.env.CPB_ACP_CLAUDE_ARGS = JSON.stringify([scriptPath, "claude", pidDir, modeByAgent.claude || (badProtocolAgent === "claude" ? "bad" : "")].filter(Boolean));
  process.env.CPB_REVIEW_ACP_TERM_GRACE_MS = modeByAgent.codex === "fail-teardown" || modeByAgent.claude === "fail-teardown" ? "25" : "500";
  process.env.CPB_REVIEW_ACP_KILL_GRACE_MS = modeByAgent.codex === "fail-teardown" || modeByAgent.claude === "fail-teardown" ? "25" : "500";

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeReviewSession(cpbRoot: string) {
  return createSession(cpbRoot, {
    project: "flow",
    intent: "test cancellation of raw review dispatch",
  });
}

test("analyzeSession timeout waits for the exact ACP process tree and close", async (t) => {
  const root = await tempRoot("cpb-review-analysis-timeout");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const scriptPath = path.join(cpbRoot, "server", "services", "acp", "acp-client.js");
  const rootPidFile = path.join(root, "analysis.pid");
  const childPidFile = path.join(root, "analysis-child.pid");
  const previous = {
    CPB_KILL_GRACE_MS: process.env.CPB_KILL_GRACE_MS,
    CPB_REVIEW_ANALYSIS_TIMEOUT_MS: process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS,
    CPB_REVIEW_ANALYSIS_TERM_GRACE_MS: process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS,
    CPB_REVIEW_ANALYSIS_KILL_GRACE_MS: process.env.CPB_REVIEW_ANALYSIS_KILL_GRACE_MS,
    CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS: process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS,
  };
  const identities: ProcessIdentity[] = [];
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const identity of identities) {
      if (isProcessIdentityAlive(identity)) {
        await killTree(identity.pid, 0, { expectedRootIdentity: identity, forceVerifyMs: 500 });
      }
    }
  });

  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid));`,
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  process.env.CPB_KILL_GRACE_MS = "25";
  process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS = "250";
  process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS = "25";
  process.env.CPB_REVIEW_ANALYSIS_KILL_GRACE_MS = "1000";
  process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS = "1000";

  const session = await createSession(cpbRoot, {
    project: "flow",
    intent: "analyze a timeout cleanup case",
    hubRoot,
  });
  const analysis = analyzeSession(cpbRoot, session.sessionId, { hubRoot });
  const pids: number[] = [];
  const pidDeadline = Date.now() + 2_000;
  while (Date.now() < pidDeadline && pids.length === 0) {
    try {
      pids.push(
        Number((await readFile(rootPidFile, "utf8")).trim()),
        Number((await readFile(childPidFile, "utf8")).trim()),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  assert.equal(pids.length, 2, "analysis fixture should publish its process tree");
  for (const pid of pids) {
    const identity = captureProcessIdentity(pid, { strict: true });
    assert.ok(identity, `process identity should be capturable for ${pid}`);
    identities.push(identity);
  }

  const result = await analysis;
  assert.equal(result.ok, false);
  assert.match(result.summary || "", /Analysis failed: Analysis timed out/);
  for (const pid of pids) assert.equal(isProcessIdentityAlive(identities.find((entry) => entry.pid === pid)!), false);
});

test("analyzeSession never signals an identity-unavailable child handle", async (t) => {
  const root = await tempRoot("cpb-review-analysis-no-identity");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const scriptPath = path.join(cpbRoot, "server", "services", "acp", "acp-client.js");
  const previousCloseGrace = process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS;
  t.after(() => {
    if (previousCloseGrace === undefined) delete process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS;
    else process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS = previousCloseGrace;
  });
  process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS = "500";
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "setTimeout(() => process.exit(0), 80);\n", "utf8");

  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => ({ stdout: "", status: 0 }) as ReturnType<ProcessTreeSystem["spawnSync"]>) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => null,
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const session = await createSession(cpbRoot, {
    project: "flow",
    intent: "analyze without a verified child identity",
    hubRoot,
  });
  const startedAt = Date.now();

  await assert.rejects(
    analyzeSession(cpbRoot, session.sessionId, { hubRoot, processTreeSystem: system }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(nestedErrorCodes(error).includes("CHILD_PROCESS_IDENTITY_UNAVAILABLE"));
      return true;
    },
  );

  assert.ok(Date.now() - startedAt >= 40, "identity failure must wait for the analysis child close boundary");
  assert.equal(directKill.mock.callCount(), 0, "identity failure must not invoke ChildProcess.kill");
  assert.deepEqual(signals, [], "identity failure must not invoke process-tree signaling");
});

test("analyzeSession never signals after root PID reuse", async (t) => {
  const root = await tempRoot("cpb-review-analysis-pid-reuse");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const scriptPath = path.join(cpbRoot, "server", "services", "acp", "acp-client.js");
  const previous = {
    timeout: process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS,
    termGrace: process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS,
    closeGrace: process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS,
  };
  t.after(() => {
    if (previous.timeout === undefined) delete process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS;
    else process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS = previous.timeout;
    if (previous.termGrace === undefined) delete process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS;
    else process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS = previous.termGrace;
    if (previous.closeGrace === undefined) delete process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS;
    else process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS = previous.closeGrace;
  });
  process.env.CPB_REVIEW_ANALYSIS_TIMEOUT_MS = "5";
  process.env.CPB_REVIEW_ANALYSIS_TERM_GRACE_MS = "0";
  process.env.CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS = "500";
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, "process.stdin.resume(); setTimeout(() => process.exit(0), 80);\n", "utf8");

  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  let captureCount = 0;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => ({ stdout: "", status: 0 }) as ReturnType<ProcessTreeSystem["spawnSync"]>) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, captureCount++ === 0 ? "original" : "successor"),
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const session = await createSession(cpbRoot, {
    project: "flow",
    intent: "analyze after a root PID is reused",
    hubRoot,
  });

  await assert.rejects(
    analyzeSession(cpbRoot, session.sessionId, { hubRoot, processTreeSystem: system }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(nestedErrorCodes(error).includes("PROCESS_IDENTITY_MISMATCH"));
      return true;
    },
  );

  assert.equal(directKill.mock.callCount(), 0, "PID reuse must not invoke ChildProcess.kill");
  assert.equal(
    signals.some((signal) => signal !== 0),
    false,
    "PID reuse must not send a terminating signal to the successor through killTree",
  );
});

test("raw review ACP startup never signals identity-unavailable child handles", async (t) => {
  const root = await tempRoot("cpb-review-acp-no-identity");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  const scriptPath = path.join(root, "natural-exit-acp.mjs");
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(scriptPath, "setTimeout(() => process.exit(0), 80);\n", "utf8");

  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => ({ stdout: "", status: 0 }) as ReturnType<ProcessTreeSystem["spawnSync"]>) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => null,
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    await assert.rejects(
      runReview(cpbRoot, session.sessionId, { processTreeSystem: system }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(nestedErrorCodes(error).includes("CHILD_PROCESS_IDENTITY_UNAVAILABLE"));
        return true;
      },
    );
  });

  assert.equal(directKill.mock.callCount(), 0, "identity failure must not invoke ChildProcess.kill");
  assert.deepEqual(signals, [], "identity failure must not invoke process-tree signaling");
});

test("runReview does not spawn ACP after cancellation is already durable", async () => {
  const root = await tempRoot("cpb-review-dispatch-pre-cancel");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const cancelled = await cancelReviewDispatch(cpbRoot, session.sessionId, "cancelled before launch");
    assert.equal(cancelled.ok, true);

    await runReview(cpbRoot, session.sessionId);

    await assert.rejects(() => readFile(path.join(pidDir, "codex.pid"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(path.join(pidDir, "claude.pid"), "utf8"), /ENOENT/);
    const updated = await getSession(cpbRoot, session.sessionId);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.detail, "cancelled before launch");
  });
});

test("cancelReviewDispatch preserves an already-completed session", async () => {
  const root = await tempRoot("cpb-review-dispatch-terminal-cancel");
  const cpbRoot = path.join(root, "cpb");
  await mkdir(cpbRoot, { recursive: true });

  const session = await makeReviewSession(cpbRoot);
  await updateSession(cpbRoot, session.sessionId, {
    status: "completed",
    detail: "decision committed",
  }, { skipTransitionCheck: true });

  const result = await cancelReviewDispatch(cpbRoot, session.sessionId, "late cancellation");
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_state");
  assert.equal("status" in result ? result.status : null, "completed");

  const persisted = await getSession(cpbRoot, session.sessionId);
  assert.equal(persisted?.status, "completed");
  assert.equal(persisted?.detail, "decision committed");
});

test("cancelReviewDispatch waits for both active raw ACP process trees to exit", async () => {
  const root = await tempRoot("cpb-review-dispatch-cancel");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const review = runReview(cpbRoot, session.sessionId);
    const pids = await waitForFakeChildren(pidDir);

    const result = await cancelReviewDispatch(cpbRoot, session.sessionId, "operator cancelled");
    assert.equal(result.ok, true);
    assert.deepEqual(pids.map(pidAlive), [false, false, false, false], "cancel should return after both ACP process trees are dead");

    await review;
    const updated = await getSession(cpbRoot, session.sessionId);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.detail, "operator cancelled");
  });
});

test("runReview rejects a concurrent duplicate for the same session", async () => {
  const root = await tempRoot("cpb-review-dispatch-duplicate");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const first = runReview(cpbRoot, session.sessionId);
    await waitForFakeChildren(pidDir);

    await assert.rejects(
      () => runReview(cpbRoot, session.sessionId),
      /review already running/,
    );
    await cancelReviewDispatch(cpbRoot, session.sessionId, "duplicate test cleanup");
    await first;
  });
});

test("external runReview abort waits for both raw ACP process trees to exit", async () => {
  const root = await tempRoot("cpb-review-dispatch-external-abort");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const controller = new AbortController();
    const review = runReview(cpbRoot, session.sessionId, { signal: controller.signal });
    const pids = await waitForFakeChildren(pidDir);

    controller.abort("external abort");
    await review;

    assert.deepEqual(pids.map(pidAlive), [false, false, false, false], "external abort should settle after both ACP process trees are dead");
    const updated = await getSession(cpbRoot, session.sessionId);
    assert.equal(updated?.status, "cancelled");
    assert.equal(updated?.detail, "external abort");
  });
});

test("partial ACP startup failure still tears down both retained process trees", async () => {
  const root = await tempRoot("cpb-review-dispatch-startup-failure");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const review = runReview(cpbRoot, session.sessionId);
    const pids = await waitForFakePidRecords(pidDir);
    await review;
    assert.deepEqual(pids.map(pidAlive), [false, false, false, false]);

    const updated = await getSession(cpbRoot, session.sessionId);
    assert.equal(updated?.status, "expired");
  }, "claude");
});

test("updateSessionIfNotCancelled keeps cancellation authoritative inside the session lock", async () => {
  const root = await tempRoot("cpb-review-dispatch-atomic-cancel");
  const cpbRoot = path.join(root, "cpb");
  await mkdir(cpbRoot, { recursive: true });

  const session = await makeReviewSession(cpbRoot);
  await updateSession(cpbRoot, session.sessionId, {
    status: "cancelled",
    detail: "cancel won",
  }, { skipTransitionCheck: true });

  const updated = await updateSessionIfNotCancelled(cpbRoot, session.sessionId, {
    status: "expired",
    detail: "late terminal overwrite",
  }, { skipTransitionCheck: true });

  assert.equal(updated.status, "cancelled");
  assert.equal(updated.detail, "cancel won");
  const persisted = await getSession(cpbRoot, session.sessionId);
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.detail, "cancel won");
});

test("terminal persistence failure rejects after verified ACP teardown", async () => {
  const root = await tempRoot("cpb-review-dispatch-persist-failure");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);

  await withFakeReviewEnv(hubRoot, scriptPath, pidDir, async () => {
    const session = await makeReviewSession(cpbRoot);
    const controller = new AbortController();
    const review = runReview(cpbRoot, session.sessionId, { signal: controller.signal });
    const pids = await waitForFakeChildren(pidDir);
    const sessionPath = path.join(hubRoot, "reviews", `${session.sessionId}.json`);
    await rm(sessionPath, { force: true });

    controller.abort("external abort with missing session file");

    await assert.rejects(
      review,
      /review session not found/,
    );
    assert.deepEqual(pids.map(pidAlive), [false, false, false, false], "runReview should reject only after both ACP process trees are dead");
  });
});

test("runReview preserves both ACP teardown failures", async () => {
  const root = await tempRoot("cpb-review-dispatch-double-teardown-failure");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const pidDir = path.join(root, "pids");
  await mkdir(cpbRoot, { recursive: true });
  const scriptPath = await writeFakeAcp(root);
  let pids: number[] = [];
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = path.join(root, "missing-bin");
    await withFakeReviewEnv(
      hubRoot,
      scriptPath,
      pidDir,
      async () => {
        const session = await makeReviewSession(cpbRoot);
        const controller = new AbortController();
        const review = runReview(cpbRoot, session.sessionId, { signal: controller.signal });
        pids = await waitForFakeChildren(pidDir);

        controller.abort("double teardown failure");

        await assert.rejects(
          review,
          (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            assert.match(error.message, /2 cleanup\/persistence errors/);
            assert.ok(error.errors.every((entry) => (
              nestedErrorCodes(entry).includes("PROCESS_ENUMERATION_UNAVAILABLE")
            )), "both ACP teardown failures must preserve their process-enumeration cause");
            return true;
          },
        );
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});
