/**
 * `cpb fix` command tests — Phase 1, WAVE 2.
 *
 * Pins the plan §阶段1 exit conditions and §5.1 contract cases for the thin
 * `fix` facade (`cli/commands/fix.ts`):
 *
 *   (a) readiness failure (missing project) -> needs_setup exit AND no queue
 *       entry written (the load-bearing "readiness failure must not enqueue"
 *       invariant);
 *   (a-unit) the invariant at the unit level: a stubbed failing readiness with
 *       a trap enqueue that throws if called;
 *   (b) a successful fix enqueues EXACTLY one entry, prints the taskId, exits
 *       `FixAccepted`, and the output carries no internal architecture terms;
 *   (c) `--idempotency-key` with an existing ACTIVE same-key entry reuses it
 *       (no new entry, same taskId);
 *   (d) `--idempotency-key` with only a TERMINAL same-key entry creates a NEW
 *       entry (and persists the hashed key on it);
 *   (e) `--follow` exits `FollowCompletedVerified` on a succeeded task and
 *       `FollowFailed` on a failed task (plus the remaining follow exit-code
 *       map is covered by the pure `exitCodeForFollowState` unit tests).
 *
 * The integration cases (a, b, c, d) drive the REAL services against temp hub
 * roots (the same pattern `tests/fix-readiness.test.ts` uses), so the
 * readiness gate, the durable queue and the idempotency contract are exercised
 * end-to-end. The `--follow` case (e) and the unit cases inject stubs so the
 * poll loop is deterministic (no real timers, no process-wide SIGINT handler).
 */

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import {
  autoDetectProject,
  buildFixEnqueueInput,
  exitCodeForFollowState,
  followTask,
  parseFixArgs,
  run,
  type FixDeps,
  type FixCtx,
  type FollowHooks,
} from "../cli/commands/fix.js";
import { loadQueue } from "../server/services/hub/hub-queue.js";
import {
  getHubRuntime,
  resetInstances,
} from "../server/services/hub/hub-registry.js";
import { hashTaskKey } from "../core/contracts/idempotency.js";
import { ExitCode } from "../core/contracts/exit-code.js";
import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  type TaskStateValue,
  type TaskView,
} from "../core/contracts/task-view.js";
import { tempRoot, writeJson } from "./helpers.js";

// ─── env management ─────────────────────────────────────────────────────────
//
// resolveHubRoot(cpbRoot) honors CPB_HUB_ROOT before falling back to ~/.cpb.
// The test runner clears CPB_* at init, so each test (re)sets CPB_HUB_ROOT to
// its temp hub root and the suite restores the original env afterwards.

const SAVED_HUB_ROOT = process.env.CPB_HUB_ROOT;

before(() => {
  resetInstances();
});

afterEach(() => {
  if (SAVED_HUB_ROOT === undefined) {
    delete process.env.CPB_HUB_ROOT;
  } else {
    process.env.CPB_HUB_ROOT = SAVED_HUB_ROOT;
  }
});

after(() => {
  if (SAVED_HUB_ROOT === undefined) {
    delete process.env.CPB_HUB_ROOT;
  } else {
    process.env.CPB_HUB_ROOT = SAVED_HUB_ROOT;
  }
});

// ─── fixtures ───────────────────────────────────────────────────────────────

interface Fixture {
  root: string;
  cpbRoot: string;
  hubRoot: string;
  runtimeRoot: string;
  sourcePath: string;
}

async function freshFixture(prefix: string): Promise<Fixture> {
  const root = await tempRoot(`cpb-fix-cmd-${prefix}`);
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const runtimeRoot = path.join(root, "runtime");
  const sourcePath = path.join(root, "src");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  process.env.CPB_HUB_ROOT = hubRoot;
  return { root, cpbRoot, hubRoot, runtimeRoot, sourcePath };
}

/**
 * Write projects.json directly with a normalized registry shape. Avoids the
 * CAS/lock machinery of registerProject so the fixture is fully deterministic.
 */
async function writeRegistry(
  hubRoot: string,
  projects: Record<string, Record<string, unknown>>,
): Promise<void> {
  const registry = {
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    projects,
    projectRevisions: Object.fromEntries(Object.keys(projects).map((id) => [id, 1])),
    mutationId: "fix-cmd-test",
  };
  await writeJson(path.join(hubRoot, "projects.json"), registry);
}

async function writeProjectAgents(
  cpbRoot: string,
  project: string,
  agents: unknown,
): Promise<void> {
  await writeJson(path.join(cpbRoot, "wiki", "projects", project, "project.json"), { agents });
}

/** Persist a LIVE hub state via the canonical writer so readHubLiveness passes. */
async function writeLiveHub(cpbRoot: string, hubRoot: string): Promise<void> {
  const runtime = getHubRuntime(cpbRoot, hubRoot);
  await runtime.persist();
}

/**
 * Write `hubRoot/queue/queue.json` directly. This is the durable shape loadQueue
 * reads; writing it directly lets the idempotency cases pre-seed active/terminal
 * same-key entries without invoking the real enqueue.
 */
async function seedQueue(hubRoot: string, entries: unknown[]): Promise<void> {
  await writeJson(path.join(hubRoot, "queue", "queue.json"), { version: 1, entries });
}

/** Minimal valid TaskView for the injected projectTaskView in --follow tests. */
function makeView(taskId: string, state: TaskStateValue): TaskView {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    taskId,
    state,
    summary: "",
    progress: { ratio: null, label: "" },
    checks: [],
    changedFiles: [],
    nextAction: { kind: null, message: "" },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

// ─── output capture ─────────────────────────────────────────────────────────

interface Captured {
  stdout: string[];
  stderr: string[];
  /** Concatenation of stdout + stderr lines, computed on each access. */
  readonly all: string[];
}

function captureOut(): { ctx: Pick<FixCtx, "out">; captured: Captured } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captured: Captured = {
    stdout,
    stderr,
    get all() {
      return [...stdout, ...stderr];
    },
  };
  return {
    ctx: {
      out: {
        log: (line: string) => stdout.push(line),
        err: (line: string) => stderr.push(line),
      },
    },
    captured,
  };
}

// Internal architecture terms that must NEVER appear in user-facing output
// outside of a literal `cpb ...` command reference (mirrors fix-readiness.test).
const INTERNAL_TERM_RE =
  /\b(hub|worker|acp|provider|lease|queue|orchestrator|finalizer|supervisor|assignment|attempt|pid|session|evidence|checkpoint|registry)\b/i;

/** Strip `cpb ...` / backtick command refs, then assert no internal term. */
function assertNoInternalTerms(lines: string[], label = "output"): void {
  for (const line of lines) {
    const prose = line.replace(/`[^`]*`/g, "");
    assert.doesNotMatch(
      prose,
      INTERNAL_TERM_RE,
      `${label} must not surface internal terms outside command refs: "${line}"`,
    );
  }
}

// Forbidden TaskView field names — must never appear in the public output.
const FORBIDDEN_NAMES = [
  "jobId",
  "attemptId",
  "provider",
  "agent",
  "lease",
  "leaseId",
  "session",
  "sessionId",
  "pid",
  "PID",
  "prompt",
  "env",
  "cwd",
];

function assertNoForbiddenNames(lines: string[]): void {
  for (const line of lines) {
    for (const name of FORBIDDEN_NAMES) {
      assert.doesNotMatch(
        line,
        new RegExp(`\\b${name}\\b`, "i"),
        `output must not reference forbidden field "${name}": "${line}"`,
      );
    }
  }
}

// ─── (a) readiness failure: missing project -> needs_setup + NO queue write ──

test("(a) missing project -> needs_setup exit, no queue entry written", async () => {
  const { cpbRoot, hubRoot } = await freshFixture("a-missing-project");
  // No projects.json -> getProject returns null -> readiness fails needs_setup.

  const before = (await loadQueue(hubRoot)).entries.length;
  const { ctx, captured } = captureOut();
  const code = await run(
    ["fix the blank login page", "--project", "ghost"],
    { cpbRoot, ...ctx },
  );
  const after = (await loadQueue(hubRoot)).entries.length;

  assert.equal(code, ExitCode.FixNeedsSetup, "missing project -> FixNeedsSetup (64)");
  assert.equal(after, before, "a failed readiness must not append a queue entry");
  assert.equal(after, 0, "queue stays empty");
  // The user-facing nextAction points at cpb init.
  assert.ok(
    captured.all.some((l) => /cpb init/i.test(l)),
    "output must surface a cpb init nextAction",
  );
});

test("(a-unit) failing readiness never calls enqueue (trap enqueue)", async () => {
  // Strongest proof of the invariant at the unit level: enqueue throws if it is
  // ever called, and a failing readiness short-circuits before it.
  let enqueueCalls = 0;
  const deps: Partial<FixDeps> = {
    assertFixReadiness: async () => ({
      ok: false,
      category: "needs_setup",
      reason: "fixture",
      nextAction: "Run `cpb init` to set up the project.",
    }),
    enqueue: async () => {
      enqueueCalls += 1;
      throw new Error("enqueue must not be called when readiness fails");
    },
    loadQueue: async () => ({ entries: [] }),
    loadRegistry: async () => ({ projects: {} }),
    resolveHubRoot: () => "/tmp/fix-trap-hub",
    projectTaskView: async () => null,
    resolveTaskRoute: (input) => ({ workflow: "standard", planMode: "auto", ...input }),
  };
  const { ctx, captured } = captureOut();
  const code = await run(["fix it", "--project", "p"], { cpbRoot: "/tmp", deps, ...ctx });

  assert.equal(code, ExitCode.FixNeedsSetup);
  assert.equal(enqueueCalls, 0, "enqueue must not be called on readiness failure");
  assert.ok(captured.all.some((l) => /cpb init/i.test(l)));
});

// ─── (b) successful fix enqueues exactly one, prints taskId, exit 0 ─────────

test("(b) successful fix enqueues exactly one entry, prints taskId, exit 0", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("b-success");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const before = (await loadQueue(hubRoot)).entries.length;
  const { ctx, captured } = captureOut();
  const code = await run(
    ["fix the blank login page", "--project", "myproj"],
    { cpbRoot, ...ctx },
  );
  const after = (await loadQueue(hubRoot)).entries.length;

  assert.equal(code, ExitCode.FixAccepted, "success -> FixAccepted (0)");
  assert.equal(after - before, 1, "exactly one new queue entry");

  const queue = await loadQueue(hubRoot);
  const entry = queue.entries[queue.entries.length - 1];
  assert.ok(entry.id, "the enqueued entry has an id");
  assert.equal(entry.projectId, "myproj");
  assert.equal(entry.description, "fix the blank login page");
  assert.equal(entry.type, "cli_pipeline", "fix mirrors the pipeline entry type");
  assert.equal(entry.priority, "P2");
  assert.equal(entry.metadata?.source, "cli");
  assert.equal(entry.metadata?.autoFinalize, true);
  // workflow / planMode are resolved by the SAME resolveTaskRoute call pipeline
  // makes (triage is on by default); assert they are present + valid rather than
  // pinned to a specific routed value, so the test is robust to routing changes.
  assert.equal(
    typeof entry.metadata?.workflow,
    "string",
    "workflow must be resolved onto the entry",
  );
  assert.ok(
    typeof entry.metadata?.workflow === "string" && (entry.metadata.workflow as string).length > 0,
  );
  assert.equal(typeof entry.metadata?.planMode, "string", "planMode must be resolved onto the entry");
  assert.ok(
    typeof entry.metadata?.planMode === "string" && (entry.metadata.planMode as string).length > 0,
  );

  // The printed taskId equals the queue entry id, and the output is public-only.
  assert.ok(
    captured.all.some((l) => l.includes(entry.id!)),
    "output must include the enqueued taskId",
  );
  assert.ok(
    captured.all.some((l) => /Task .* accepted\./.test(l)),
    "output must announce acceptance",
  );
  assert.ok(
    captured.all.some((l) => /cpb task/.test(l)),
    "output must point the user at `cpb task <id>`",
  );
  assertNoInternalTerms(captured.all, "success output");
  assertNoForbiddenNames(captured.all);
});

// ─── (b-empty) empty problem -> invalid_request, no readiness, no enqueue ────

test("(b-empty) empty problem -> FixInvalidRequest with no readiness / enqueue call", async () => {
  let readinessCalls = 0;
  let enqueueCalls = 0;
  const deps: Partial<FixDeps> = {
    assertFixReadiness: async () => {
      readinessCalls += 1;
      return { ok: true };
    },
    enqueue: async () => {
      enqueueCalls += 1;
      return { id: "q-leak" };
    },
    loadQueue: async () => ({ entries: [] }),
    loadRegistry: async () => ({ projects: {} }),
    resolveHubRoot: () => "/tmp/fix-empty-hub",
    projectTaskView: async () => null,
    resolveTaskRoute: (input) => ({ workflow: "standard", planMode: "auto", ...input }),
  };
  const { ctx } = captureOut();
  const code = await run(["   ", "--project", "p"], { cpbRoot: "/tmp", deps, ...ctx });

  assert.equal(code, ExitCode.FixInvalidRequest, "empty problem -> FixInvalidRequest (65)");
  assert.equal(readinessCalls, 0, "empty problem must not even call readiness");
  assert.equal(enqueueCalls, 0, "empty problem must not enqueue");
});

// ─── (c) --idempotency-key active reuse ─────────────────────────────────────

test("(c) --idempotency-key with an active same-key entry reuses it (no new entry)", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("c-active");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const KEY = "user-key-active";
  const hashed = hashTaskKey(KEY);
  const EXISTING_ID = "q-existing-active";
  await seedQueue(hubRoot, [
    {
      id: EXISTING_ID,
      projectId: "myproj",
      status: "pending",
      description: "prior submit",
      priority: "P2",
      type: "cli_pipeline",
      metadata: { queueDedupeKey: hashed, source: "cli" },
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
  ]);

  const before = (await loadQueue(hubRoot)).entries.length;
  const { ctx, captured } = captureOut();
  const code = await run(
    ["fix the blank login page", "--project", "myproj", "--idempotency-key", KEY],
    { cpbRoot, ...ctx },
  );
  const after = (await loadQueue(hubRoot)).entries.length;

  assert.equal(code, ExitCode.FixAccepted, "reuse is still an acceptance");
  assert.equal(after, before, "no new queue entry when an active match is reused");
  assert.ok(
    captured.all.some((l) => l.includes(EXISTING_ID)),
    "output must surface the EXISTING taskId, not a new one",
  );
  assertNoInternalTerms(captured.all, "reuse output");
});

// ─── (d) --idempotency-key terminal -> new entry ────────────────────────────

test("(d) --idempotency-key with only a terminal entry creates a new entry", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("d-terminal");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const KEY = "user-key-terminal";
  const hashed = hashTaskKey(KEY);
  const PRIOR_ID = "q-prior-done";
  await seedQueue(hubRoot, [
    {
      id: PRIOR_ID,
      projectId: "myproj",
      status: "completed",
      description: "prior done",
      priority: "P2",
      type: "cli_pipeline",
      metadata: { queueDedupeKey: hashed, source: "cli" },
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:01:00.000Z",
    },
  ]);

  const before = (await loadQueue(hubRoot)).entries.length;
  const { ctx, captured } = captureOut();
  const code = await run(
    ["fix the blank login page", "--project", "myproj", "--idempotency-key", KEY],
    { cpbRoot, ...ctx },
  );
  const after = (await loadQueue(hubRoot)).entries.length;

  assert.equal(code, ExitCode.FixAccepted);
  assert.equal(after, before + 1, "a terminal match must NOT block a fresh submit");

  // The NEW entry carries the hashed key so the NEXT same-key submit dedupes.
  const queue = await loadQueue(hubRoot);
  const fresh = queue.entries.find((e) => e.id !== PRIOR_ID);
  assert.ok(fresh, "a new entry was created");
  assert.equal(
    fresh!.metadata?.queueDedupeKey,
    hashed,
    "the new entry persists the hashed dedupe key (never plaintext)",
  );
  assert.equal(
    typeof fresh!.metadata?.queueDedupeKey,
    "string",
    "the dedupe key is a primitive string hash",
  );
  // Plaintext key must NEVER be persisted.
  for (const e of queue.entries) {
    const meta = JSON.stringify(e.metadata || {});
    assert.doesNotMatch(meta, new RegExp(KEY), "plaintext key must never be persisted");
  }
  assert.ok(
    captured.all.some((l) => l.includes(fresh!.id!)),
    "output must surface the NEW taskId",
  );
});

// ─── (e) --follow exit codes ────────────────────────────────────────────────
//
// Inject the full dep bundle so the poll loop is fully deterministic: a stub
// projectTaskView returns the terminal state on the first sample, and a stub
// signal prevents the production SIGINT handler from being installed.

function makeFollowDeps(view: TaskView | null): { deps: FixDeps; sampled: boolean[] } {
  const sampled: boolean[] = [];
  return {
    deps: {
      assertFixReadiness: async () => ({ ok: true }),
      enqueue: async (_hubRoot, input) => ({ id: "q-follow-target", ...(input as object) }),
      loadQueue: async () => ({ entries: [] }),
      loadRegistry: async () => ({ projects: {} }),
      resolveHubRoot: () => "/tmp/fix-follow-hub",
      projectTaskView: async () => {
        sampled.push(true);
        return view;
      },
      resolveTaskRoute: (input) => ({ workflow: "standard", planMode: "auto", ...input }),
    },
    sampled,
  };
}

const FOLLOW_HOOKS: FollowHooks = {
  now: () => 0,
  sleep: async () => {
    /* deterministic: never actually wait */
  },
  signal: { aborted: false },
};

test("(e1) --follow on a succeeded task exits FollowCompletedVerified", async () => {
  const { deps, sampled } = makeFollowDeps(makeView("q-follow-target", TaskState.Succeeded));
  const { ctx } = captureOut();
  const code = await run(
    ["fix it", "--project", "p", "--follow"],
    { cpbRoot: "/tmp", deps, followHooks: FOLLOW_HOOKS, ...ctx },
  );
  assert.equal(code, ExitCode.FollowCompletedVerified, "succeeded -> 0");
  assert.equal(sampled.length, 1, "a terminal first sample exits after one poll");
});

test("(e2) --follow on a failed task exits FollowFailed", async () => {
  const { deps } = makeFollowDeps(makeView("q-follow-target", TaskState.Failed));
  const { ctx } = captureOut();
  const code = await run(
    ["fix it", "--project", "p", "--follow"],
    { cpbRoot: "/tmp", deps, followHooks: FOLLOW_HOOKS, ...ctx },
  );
  assert.equal(code, ExitCode.FollowFailed, "failed -> 1");
});

test("(e3) --follow times out -> FollowTimeout when no terminal state is reached", async () => {
  // projectTaskView returns a non-terminal running view forever; the injected
  // now() advances past the deadline on the second sample so the loop exits.
  let ticks = 0;
  const deps: FixDeps = {
    assertFixReadiness: async () => ({ ok: true }),
    enqueue: async (_hubRoot, input) => ({ id: "q-follow-timeout", ...(input as object) }),
    loadQueue: async () => ({ entries: [] }),
    loadRegistry: async () => ({ projects: {} }),
    resolveHubRoot: () => "/tmp/fix-follow-hub",
    projectTaskView: async () => makeView("q-follow-timeout", TaskState.Running),
    resolveTaskRoute: (input) => ({ workflow: "standard", planMode: "auto", ...input }),
  };
  const hooks: FollowHooks = {
    now: () => {
      const t = ticks;
      ticks += 1;
      // First sample at t=0 (before deadline), then jump past the 1ms deadline.
      return t === 0 ? 0 : 10_000;
    },
    sleep: async () => {
      /* no-op */
    },
    signal: { aborted: false },
  };
  const code = await run(
    ["fix it", "--project", "p", "--follow"],
    { cpbRoot: "/tmp", deps, followTimeoutMs: 1, followPollIntervalMs: 1, followHooks: hooks },
  );
  assert.equal(code, ExitCode.FollowTimeout, "no terminal state within budget -> FollowTimeout (5)");
});

test("(e4) --follow on a canceled task exits FollowCanceled", async () => {
  const { deps } = makeFollowDeps(makeView("q-follow-target", TaskState.Canceled));
  const { ctx } = captureOut();
  const code = await run(
    ["fix it", "--project", "p", "--follow"],
    { cpbRoot: "/tmp", deps, followHooks: FOLLOW_HOOKS, ...ctx },
  );
  assert.equal(code, ExitCode.FollowCanceled, "canceled -> 2");
});

// ─── unit: parseFixArgs ─────────────────────────────────────────────────────

test("parseFixArgs: problem is the first positional; flags parsed correctly", () => {
  const parsed = parseFixArgs([
    "fix",
    "the",
    "login",
    "--project",
    "myproj",
    "--follow",
    "--idempotency-key",
    "abc",
  ]);
  assert.equal(parsed.problem, "fix the login");
  assert.equal(parsed.project, "myproj");
  assert.equal(parsed.follow, true);
  assert.equal(parsed.idempotencyKey, "abc");
  assert.equal(parsed.help, false);
});

test("parseFixArgs: --help and -h set help=true", () => {
  assert.equal(parseFixArgs(["--help"]).help, true);
  assert.equal(parseFixArgs(["-h"]).help, true);
});

test("parseFixArgs: empty args -> empty problem", () => {
  const parsed = parseFixArgs([]);
  assert.equal(parsed.problem, "");
  assert.equal(parsed.project, "");
  assert.equal(parsed.follow, false);
});

test("parseFixArgs: quoted-style single positional is preserved verbatim", () => {
  const parsed = parseFixArgs(["fix the login page goes blank"]);
  assert.equal(parsed.problem, "fix the login page goes blank");
});

// ─── unit: exitCodeForFollowState covers the full Follow map ────────────────

test("exitCodeForFollowState: succeeded -> FollowCompletedVerified", () => {
  assert.equal(exitCodeForFollowState(TaskState.Succeeded), ExitCode.FollowCompletedVerified);
});

test("exitCodeForFollowState: failed/blocked/needs_input/canceled map distinctly", () => {
  assert.equal(exitCodeForFollowState(TaskState.Failed), ExitCode.FollowFailed);
  assert.equal(exitCodeForFollowState(TaskState.Blocked), ExitCode.FollowBlocked);
  assert.equal(exitCodeForFollowState(TaskState.NeedsInput), ExitCode.FollowNeedsInput);
  assert.equal(exitCodeForFollowState(TaskState.Canceled), ExitCode.FollowCanceled);
});

test("exitCodeForFollowState: non-terminal states return null (keep polling)", () => {
  assert.equal(exitCodeForFollowState(TaskState.Running), null);
  assert.equal(exitCodeForFollowState(TaskState.Queued), null);
  assert.equal(exitCodeForFollowState(TaskState.Verifying), null);
  assert.equal(exitCodeForFollowState(TaskState.Accepted), null);
});

// ─── unit: buildFixEnqueueInput mirrors the pipeline shape ──────────────────

test("buildFixEnqueueInput: mirrors pipeline entry shape + sets queueDedupeKey", () => {
  const registered = { sourcePath: "/repo", github: { fullName: "owner/repo" } };
  const route = { workflow: "standard", planMode: "auto", decision: "auto" };
  const hashed = hashTaskKey("k");
  const input = buildFixEnqueueInput("fix the bug", "myproj", registered, route, hashed, 1_700_000_000_000);

  assert.equal(input.projectId, "myproj");
  assert.equal(input.sourcePath, "/repo");
  assert.equal(input.priority, "P2");
  assert.equal(input.description, "fix the bug");
  assert.equal(input.type, "cli_pipeline");
  const metadata = input.metadata as Record<string, unknown>;
  assert.equal(metadata.source, "cli");
  assert.equal(metadata.autoFinalize, true);
  assert.equal(metadata.workflow, "standard");
  assert.equal(metadata.planMode, "auto");
  assert.equal(metadata.triageMode, null);
  assert.equal(metadata.repo, "owner/repo");
  assert.equal(metadata.issueTitle, "fix the bug");
  assert.equal(metadata.maxRetries, 3);
  assert.equal(metadata.queueDedupeKey, hashed, "hashed dedupe key is attached");
  assert.match(metadata.requestedAt as string, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildFixEnqueueInput: omits queueDedupeKey when no idempotency key", () => {
  const input = buildFixEnqueueInput("fix the bug", "myproj", null, {}, null, 0);
  const metadata = input.metadata as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, "queueDedupeKey"), false);
  assert.equal(input.sourcePath, null, "null registered -> null sourcePath");
});

// ─── unit: autoDetectProject ────────────────────────────────────────────────

test("autoDetectProject: matches cwd against a registered sourcePath", async () => {
  const tmp = await tempRoot("cpb-fix-autodetect");
  const projectDir = path.join(tmp, "repo");
  await mkdir(projectDir, { recursive: true });
  const loadRegistry: FixDeps["loadRegistry"] = async () => ({
    projects: { myproj: { sourcePath: projectDir } },
  });
  const id = await autoDetectProject(loadRegistry, "/tmp/hub", projectDir);
  assert.equal(id, "myproj");
});

test("autoDetectProject: matches a cwd nested under a registered sourcePath", async () => {
  const tmp = await tempRoot("cpb-fix-autodetect-nested");
  const projectDir = path.join(tmp, "repo");
  const nested = path.join(projectDir, "packages", "web");
  await mkdir(nested, { recursive: true });
  const loadRegistry: FixDeps["loadRegistry"] = async () => ({
    projects: { myproj: { sourcePath: projectDir } },
  });
  const id = await autoDetectProject(loadRegistry, "/tmp/hub", nested);
  assert.equal(id, "myproj");
});

test("autoDetectProject: returns empty string when no match", async () => {
  const loadRegistry: FixDeps["loadRegistry"] = async () => ({
    projects: { myproj: { sourcePath: "/elsewhere" } },
  });
  const id = await autoDetectProject(loadRegistry, "/tmp/hub", "/tmp/elsewhere-elsewhere");
  assert.equal(id, "");
});

test("autoDetectProject: a registry read failure resolves to empty (not a crash)", async () => {
  const loadRegistry: FixDeps["loadRegistry"] = async () => {
    throw new Error("read failed");
  };
  const id = await autoDetectProject(loadRegistry, "/tmp/hub", "/tmp");
  assert.equal(id, "");
});

// ─── unit: followTask exit-on-first-terminal + abort ────────────────────────

test("followTask: returns FollowCanceled when the injected signal is already aborted", async () => {
  const deps: FixDeps = {
    assertFixReadiness: async () => ({ ok: true }),
    enqueue: async () => ({ id: "x" }),
    loadQueue: async () => ({ entries: [] }),
    loadRegistry: async () => ({ projects: {} }),
    resolveHubRoot: () => "/tmp",
    projectTaskView: async () => makeView("x", TaskState.Succeeded),
    resolveTaskRoute: (input) => input,
  };
  const code = await followTask(deps, "/tmp", "p", "x", {
    hooks: { now: () => 0, sleep: async () => {}, signal: { aborted: true } },
  });
  assert.equal(code, ExitCode.FollowCanceled);
});
