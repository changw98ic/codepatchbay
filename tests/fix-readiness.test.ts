import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { assertFixReadiness } from "../server/services/task/readiness.js";
import { loadQueue } from "../server/services/hub/hub-queue.js";
import {
  getHubRuntime,
  resetInstances,
} from "../server/services/hub/hub-registry.js";
import { tempRoot, writeJson } from "./helpers.js";

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// assertFixReadiness resolves the hub root via resolveHubRoot(cpbRoot), which
// honors CPB_HUB_ROOT before falling back to ~/.cpb. The test runner clears
// CPB_* at init, so each test (re)sets CPB_HUB_ROOT to its temp hub root and
// the suite restores the original env afterwards.

const SAVED_HUB_ROOT = process.env.CPB_HUB_ROOT;

before(() => {
  resetInstances();
});

afterEach(() => {
  // Ensure one test's hub-root override never leaks into the next.
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

interface Fixture {
  root: string;
  cpbRoot: string;
  hubRoot: string;
  runtimeRoot: string;
  sourcePath: string;
}

async function freshFixture(prefix: string): Promise<Fixture> {
  const root = await tempRoot(`cpb-fix-readiness-${prefix}`);
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
    projectRevisions: Object.fromEntries(
      Object.keys(projects).map((id) => [id, 1]),
    ),
    mutationId: "fix-readiness-test",
  };
  await writeJson(path.join(hubRoot, "projects.json"), registry);
}

async function writeProjectAgents(
  cpbRoot: string,
  project: string,
  agents: unknown,
): Promise<void> {
  await writeJson(path.join(cpbRoot, "wiki", "projects", project, "project.json"), {
    agents,
  });
}

/**
 * Persist a LIVE hub state via the canonical writer so readHubLiveness reports
 * alive:true (the hub.json carries the current test process's identity).
 */
async function writeLiveHub(cpbRoot: string, hubRoot: string): Promise<void> {
  const runtime = getHubRuntime(cpbRoot, hubRoot);
  await runtime.persist();
}

async function queueEntryCount(hubRoot: string): Promise<number> {
  const queue = await loadQueue(hubRoot);
  return queue.entries.length;
}

// Internal architecture terms that must NEVER appear in a user-facing
// nextAction outside of a literal `cpb ...` command reference.
const INTERNAL_TERM_RE =
  /\b(hub|worker|acp|provider|lease|queue|orchestrator|finalizer|supervisor|assignment|attempt|pid|session|evidence|checkpoint|registry)\b/i;

function assertUserFacingNextAction(nextAction: string): void {
  assert.ok(typeof nextAction === "string", "nextAction must be a string");
  assert.match(nextAction, /\S/, "nextAction must be non-empty");
  // Strip literal command references (`cpb ...`) before scanning: the command
  // namespace legitimately contains words like "hub" (`cpb hub start`), but the
  // explanatory prose must not lean on internal architecture vocabulary.
  const prose = nextAction.replace(/`[^`]*`/g, "");
  assert.doesNotMatch(
    prose,
    INTERNAL_TERM_RE,
    `nextAction must not surface internal terms outside command refs: "${nextAction}"`,
  );
}

function assertFailure(
  result: { ok: boolean; category?: string; reason?: string; nextAction?: string },
  category: string,
): asserts result is {
  ok: false;
  category: string;
  reason: string;
  nextAction: string;
} {
  assert.equal(result.ok, false, `expected readiness failure (${category})`);
  assert.equal(result.category, category, `expected category ${category}`);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, "reason must be non-empty");
  assertUserFacingNextAction(result.nextAction!);
}

// ─── step 1: missing project -> needs_setup + cpb init nextAction ────────────

test("missing project -> needs_setup with a cpb init nextAction and no queue write", async () => {
  const { cpbRoot, hubRoot } = await freshFixture("missing-project");
  // No projects.json -> getProject returns null.

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "ghost" });
  const after = await queueEntryCount(hubRoot);

  assertFailure(result, "needs_setup");
  assert.match(result.nextAction, /cpb init/i);
  assert.equal(after, before, "a failed readiness check must not append a queue entry");
});

test("empty registry -> needs_setup (project absent, not just file missing)", async () => {
  const { cpbRoot, hubRoot } = await freshFixture("empty-registry");
  await writeRegistry(hubRoot, {});

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "ghost" });
  const after = await queueEntryCount(hubRoot);

  assertFailure(result, "needs_setup");
  assert.equal(after, before, "readiness must not enqueue even when the registry file exists");
});

// ─── step 2: missing runtime root -> runtime_unavailable ─────────────────────

test("missing runtime root -> runtime_unavailable with a user-facing nextAction", async () => {
  const { cpbRoot, hubRoot, sourcePath } = await freshFixture("missing-runtime-root");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath }, // no projectRuntimeRoot
  });
  // Set up later steps (agent + live hub) so the ONLY remaining failure is
  // step 2 — proving the runtime-root gate is what rejects the request.
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "myproj" });
  const after = await queueEntryCount(hubRoot);

  assertFailure(result, "runtime_unavailable");
  assert.equal(after, before, "a failed readiness check must not append a queue entry");
});

// ─── step 3: bad agent config -> runtime_unavailable ─────────────────────────

test("unconfigured agent executable -> runtime_unavailable", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("bad-agent");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  // An agent name with no PATH entry and no npx fallback must fail.
  await writeProjectAgents(cpbRoot, "myproj", {
    default: { agent: "definitely-not-a-real-coding-agent-xyz" },
  });
  // Persist a live hub so step 4 would pass — the ONLY failure must be step 3.
  await writeLiveHub(cpbRoot, hubRoot);

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "myproj" });
  const after = await queueEntryCount(hubRoot);

  assertFailure(result, "runtime_unavailable");
  assert.equal(after, before, "a failed readiness check must not append a queue entry");
});

// ─── step 4: hub unreachable -> runtime_unavailable ──────────────────────────

test("hub not running -> runtime_unavailable with a cpb hub start nextAction", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("hub-unreachable");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  // A resolvable agent (claude resolves via primary binary or npx fallback) so
  // the agent step passes and the hub step is the one that fails.
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  // Intentionally do NOT persist hub state -> readHubLiveness -> alive:false.

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "myproj" });
  const after = await queueEntryCount(hubRoot);

  assertFailure(result, "runtime_unavailable");
  assert.match(result.nextAction, /cpb hub start/i);
  assert.equal(after, before, "a failed readiness check must not append a queue entry");
});

// ─── green path: fully initialized -> { ok: true }, still no queue write ─────

test("fully initialized fixture -> { ok: true } with no queue write", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("ok");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const before = await queueEntryCount(hubRoot);
  const result = await assertFixReadiness({ cpbRoot, project: "myproj" });
  const after = await queueEntryCount(hubRoot);

  assert.deepEqual(result, { ok: true }, "readiness success must be exactly { ok: true }");
  assert.equal(after, before, "readiness must not enqueue even on success (enqueue is a later step)");
});

// ─── the ok branch carries no extra (forbidden) fields ───────────────────────

test("ok result never carries a forbidden TaskView field", async () => {
  const { cpbRoot, hubRoot, runtimeRoot, sourcePath } = await freshFixture("ok-clean");
  await writeRegistry(hubRoot, {
    myproj: { id: "myproj", sourcePath, projectRuntimeRoot: runtimeRoot },
  });
  await writeProjectAgents(cpbRoot, "myproj", { default: { agent: "claude" } });
  await writeLiveHub(cpbRoot, hubRoot);

  const result = await assertFixReadiness({ cpbRoot, project: "myproj" }) as Record<string, unknown>;
  assert.equal(result.ok, true);
  // The public ok shape is EXACTLY { ok: true }; it must not leak job/lease/
  // session/provider internals that a TaskView is forbidden from exposing.
  const forbidden = ["jobId", "attemptId", "provider", "agent", "lease", "leaseId", "session", "pid", "prompt", "env"];
  for (const field of forbidden) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, field),
      false,
      `ok result must not carry forbidden field "${field}"`,
    );
  }
  assert.deepEqual(Object.keys(result).sort(), ["ok"], "ok result must have exactly one key: ok");
});
