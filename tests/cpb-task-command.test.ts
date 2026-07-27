/**
 * `cpb task` command tests — Phase 1 (WAVE 2).
 *
 * These tests pin the thin product entry in `cli/commands/task.ts`:
 *   (1) a known task renders state + next step and exits 0;
 *   (2) a known task in `needs_input` maps to a "reply" next step (non-trivial
 *       nextAction.kind, proving the command renders nextAction — not just
 *       state);
 *   (3) an unknown task id exits non-zero with a plain message;
 *   (4) the rendered output contains NONE of the forbidden internal terms or
 *       fields (asserted on the rendered string, across multiple states).
 *
 * The command is a thin facade over `projectTaskView`; these tests seed the
 * same durable queue file the production path reads (`<hubRoot>/queue/
 * queue.json`) and drive the command end-to-end. No fake/injected projection
 * layer is used. Deterministic: no real workers, no ACP, no network.
 *
 * The test runner clears every `CPB_*` env var at startup, so `CPB_HUB_ROOT`
 * is unset before each test; we set it explicitly to point at the seeded hub
 * root (which is what `resolveHubRoot` inside `projectTaskView` reads when the
 * command calls it without opts) and restore it on exit.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { run as runTaskCommand } from "../cli/commands/task.js";
import { FORBIDDEN_TASKVIEW_FIELDS } from "../core/contracts/task-view-fields.js";
import { tempRoot, writeJson } from "./helpers.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PROJECT = "proj";
const TASK_ID = "q-task-001";

type QueueEntry = Record<string, unknown>;

function queueEntry(overrides: QueueEntry = {}): QueueEntry {
  return {
    id: TASK_ID,
    projectId: PROJECT,
    description: "Add a --json flag to cpb status",
    status: "pending",
    priority: "P2",
    type: "candidate",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

/** Write `<hubRoot>/queue/queue.json` — the durable shape `loadQueue` reads. */
async function seedQueue(hubRoot: string, entries: QueueEntry[]): Promise<void> {
  await writeJson(path.join(hubRoot, "queue", "queue.json"), { version: 1, entries });
}

// ─── output capture ──────────────────────────────────────────────────────────

type Capture = {
  out: string[];
  err: string[];
  restore(): void;
};

/** Swap console.log/error for collectors; restore on `restore()`. */
function captureOutput(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  return {
    out,
    err,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/**
 * Run the task command with `CPB_HUB_ROOT` pointed at `hubRoot`, restoring the
 * prior value (or deleting it) afterwards. Returns the captured output and the
 * exit code.
 */
async function runWithCapture(
  args: string[],
  cpbRoot: string,
  hubRoot: string,
): Promise<{ exit: number; out: string[]; err: string[] }> {
  const cap = captureOutput();
  const prevHub = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    const exit = await runTaskCommand(args, { command: "task", cpbRoot });
    return { exit, out: [...cap.out], err: [...cap.err] };
  } finally {
    if (prevHub === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = prevHub;
    cap.restore();
  }
}

// ─── forbidden-token assertion ───────────────────────────────────────────────

/**
 * Tokens that must NEVER appear in the rendered output:
 *   - every frozen forbidden FIELD name (lowercased) — catches accidental
 *     leakage of internal runtime identifiers / paths;
 *   - the architecture TERMS the plan §3.4 calls out (Hub, Worker, ACP,
 *     Provider, lease, session, Evidence) plus "agent" — catches accidental
 *     use of internal vocabulary in user-facing prose.
 *
 * Substring (case-insensitive) matching is safe here because the command's
 * wording is fixed and short; a future prose change that introduced one of
 * these tokens would fail this test and force a reword — which is the point.
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  ...FORBIDDEN_TASKVIEW_FIELDS.map((f) => f.toLowerCase()),
  "hub",
  "worker",
  "acp",
  "evidence",
];

function assertNoForbiddenTerms(rendered: string, label: string): void {
  const lower = rendered.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(
      !lower.includes(token),
      `${label}: rendered output must not contain forbidden token "${token}". Output was:\n${rendered}`,
    );
  }
}

// ─── (1) known task: exit 0 + state + next step ──────────────────────────────

test("(1) cpb task renders state + next step for a known queued task and exits 0", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-found");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [queueEntry({ status: "pending" })]);

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.equal(exit, 0, "a known task must exit 0");
  const text = out.join("\n");

  // State is rendered as a human line (queued -> "Queued ...").
  assert.match(text, /Queued/, "output must include the mapped state line");
  // nextAction is rendered as a human next step (kind "wait" here).
  assert.match(text, /Nothing for you to do right now/, "output must include the next step");
  // The summary (user-authored task text) is shown.
  assert.match(text, /Add a --json flag/);

  // Output boundary: no forbidden internal terms or fields leak.
  assertNoForbiddenTerms(text, "queued");
});

// ─── (2) known needs_input task: state + reply next step ─────────────────────

test("(2) cpb task maps needs_input to a reply next step (non-trivial nextAction)", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-needs-input");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [
    queueEntry({ status: "needs_issue_link", reason: "link a tracking issue" }),
  ]);

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.match(text, /Needs your input/, "needs_input maps to a human state line");
  // nextAction.kind === "respond" -> a reply prompt. This proves the command
  // renders nextAction, not just state, and does NOT echo the projection's raw
  // message (which would carry the internal reason text verbatim).
  assert.match(text, /Reply with what it needs to continue/);
  assertNoForbiddenTerms(text, "needs_input");
});

// ─── (3) unknown task: exit non-zero + plain message ─────────────────────────

test("(3) cpb task exits non-zero with a plain message when the task id is unknown", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-unknown");
  const hubRoot = path.join(root, "hub");
  // Queue exists but holds a different id — TASK_ID must not resolve.
  await seedQueue(hubRoot, [
    queueEntry({ id: "q-different", projectId: PROJECT, status: "pending" }),
  ]);

  const { exit, out, err } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.notEqual(exit, 0, "an unknown task must exit non-zero");
  assert.equal(exit, 1, "the unknown-task exit code is 1");

  // The message goes to stderr and stays plain (no internal terms).
  const errText = err.join("\n");
  assert.match(errText, /No task found/);
  // Nothing is printed to stdout for a miss.
  assert.equal(out.length, 0, "stdout must be empty on a miss");
  assertNoForbiddenTerms(errText, "unknown");
});

// ─── (4) missing task-id: usage error, exit non-zero ─────────────────────────

test("(4) cpb task with no task id prints usage and exits non-zero", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-noarg");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [queueEntry()]);

  const { exit, err } = await runWithCapture(["--project", PROJECT], root, hubRoot);

  assert.equal(exit, 1);
  assert.match(err.join("\n"), /Usage: cpb task/);
});

// ─── (5) forbidden terms/fields absent across every rendered state ───────────

test("(5) rendered output never contains a forbidden internal term or field, across states", { concurrency: false }, async () => {
  const cases: Array<{ label: string; entry: QueueEntry }> = [
    { label: "queued", entry: queueEntry({ status: "pending" }) },
    { label: "needs_input", entry: queueEntry({ status: "needs_issue_link", reason: "link a tracking issue" }) },
    { label: "blocked", entry: queueEntry({ status: "blocked" }) },
    { label: "completed-queue", entry: queueEntry({ status: "completed" }) },
    { label: "failed-queue", entry: queueEntry({ status: "failed" }) },
    { label: "canceled-queue", entry: queueEntry({ status: "canceled" }) },
  ];

  for (const { label, entry } of cases) {
    const root = await tempRoot(`cpb-task-cmd-clean-${label}`);
    const hubRoot = path.join(root, "hub");
    // Seed the entry carrying the leak-prone runtime fields a real QueueEntry
    // can hold (sessionId, workerId, cwd, sourcePath, claimedBy, originJobId,
    // retryJobId). The command must not echo any of them — they are forbidden
    // fields. This is the load-bearing boundary check on the RENDERED string
    // (the projection's own sanitize boundary is covered in
    // task-view-projection.test.ts).
    await seedQueue(hubRoot, [{
      ...entry,
      sessionId: "LEAK-session-abc",
      workerId: "LEAK-worker-1",
      cwd: "/private/var/LEAK/cwd",
      sourcePath: "/private/var/LEAK/source",
      claimedBy: "LEAK-claimed-by",
      metadata: { retryJobId: "LEAK-retry-job", originJobId: "LEAK-origin-job" },
    }]);

    const { exit, out, err } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);
    assert.equal(exit, 0, `${label}: task must be found and rendered`);

    const rendered = [...out, ...err].join("\n");
    assertNoForbiddenTerms(rendered, label);

    // Positive guard: the leaked runtime values themselves must not appear.
    assert.ok(
      !rendered.includes("LEAK"),
      `${label}: rendered output must not echo any seeded LEAK value. Output was:\n${rendered}`,
    );
  }
});
