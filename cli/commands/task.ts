/**
 * `cpb task <task-id> [--project <id>]` — Phase 1 product thin entry.
 *
 * This is a READ-ONLY, user-facing facade mandated by
 * `docs/product/cpb-product-entry-execution-kernel-plan-2026-07-27.md` §3.1 / §四
 * 阶段 1. It does NOT introduce a new state machine, task entity, or
 * task→job registry. It resolves the project, projects the public TaskView via
 * `projectTaskView` (which reuses the existing queue/job/gate services), and
 * renders a plain-language summary a stranger can understand.
 *
 * Output boundary (load-bearing):
 *   - Renders ONLY public TaskView fields, mapped to human prose.
 *   - NEVER prints internal architecture terms (Hub, Worker, ACP, Provider,
 *     lease, session, Evidence, ...) or forbidden runtime fields (jobId,
 *     attemptId, provider, agent, lease, session, PID, prompt, env, absolute
 *     paths — see core/contracts/task-view-fields.ts).
 *   - The projection's `nextAction.message` is NOT echoed verbatim because it
 *     may carry internal terms (e.g. "worker"); instead `state` +
 *     `nextAction.kind` drive a clean command-side rendering. This keeps the
 *     forbidden-term invariant enforceable by a string assertion on the
 *     rendered output regardless of what the projection message contains.
 *
 * Stabilization freeze: reuses existing services; introduces NO new
 * agent/workflow/provider/scheduler type.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import type { LooseRecord } from "../../shared/types.js";
import {
  TaskState,
  type TaskStateValue,
  type TaskView,
  type TaskViewNextAction,
} from "../../core/contracts/task-view.js";

// ─── state → plain-language mapping ──────────────────────────────────────────

/**
 * Map a TaskState to a single human-readable line.
 *
 * The wording avoids every internal term enumerated in the plan (Hub, Worker,
 * ACP, Provider, lease, session, ...). A stranger reading just this line knows
 * where their task stands without learning any runtime vocabulary.
 */
function humanStateLine(state: TaskStateValue): string {
  switch (state) {
    case TaskState.Accepted:
      return "Accepted - waiting to start";
    case TaskState.Queued:
      return "Queued - waiting to start";
    case TaskState.Running:
      return "Working on it";
    case TaskState.Verifying:
      return "Checking the change";
    case TaskState.Succeeded:
      return "Done";
    case TaskState.NeedsInput:
      return "Needs your input";
    case TaskState.Blocked:
      return "Waiting on something";
    case TaskState.Failed:
      return "Did not succeed";
    case TaskState.Canceled:
      return "Canceled";
    default:
      // Unknown / transitional state — surface as active rather than crashing.
      return "Working on it";
  }
}

/**
 * Map the projected next-action kind to a plain next step. Returns a clean
 * command-side line; never echoes `nextAction.message` (which may carry
 * internal terms like "worker").
 */
function humanNextStep(next: TaskViewNextAction | null | undefined): string {
  const kind = next?.kind;
  switch (kind) {
    case "respond":
      return "Reply with what it needs to continue.";
    case "wait":
      return "Nothing for you to do right now.";
    case "review":
      return "Take a look at the result when you have time.";
    case "retry":
      return "You can try again, or change the request and retry.";
    case "abandon":
      return "You can try again, or leave it as is.";
    case null:
    case undefined:
    default:
      return "Nothing for you to do right now.";
  }
}

// ─── rendering ───────────────────────────────────────────────────────────────

/**
 * Render the public TaskView as plain text on stdout. Deliberately does NOT
 * emit taskId/jobId/attemptId/provider/agent/lease/session/prompt/env/abs paths
 * — only the four product-facing fields (summary, state, progress, next step).
 */
function renderTaskView(view: TaskView): void {
  const rawSummary = typeof view.summary === "string" ? view.summary.trim() : "";
  const summary = rawSummary || "(no description given)";
  const stateLine = humanStateLine(view.state);
  const progressLabel =
    view.progress && typeof view.progress.label === "string"
      ? view.progress.label.trim()
      : "";
  const nextStep = humanNextStep(view.nextAction);

  const lines: string[] = [];
  lines.push(summary);
  lines.push("");
  lines.push(`State:    ${stateLine}`);
  if (progressLabel) lines.push(`Progress: ${progressLabel}`);
  lines.push(`Next:     ${nextStep}`);
  console.log(lines.join("\n"));
}

function printHelp(): void {
  console.log(`Usage: cpb task <task-id> [--project <id>]

Show the current state of a task in plain language.

Arguments:
  <task-id>        The task id shown when you submitted it.

Options:
  --project <id>   The project the task belongs to. When omitted, the
                   project is detected from the current directory.
  -p <id>          Shortcut for --project.
  --help, -h       Show this help.`);
}

// ─── project resolution (mirrors cli/commands/pipeline.ts run mode) ──────────

/**
 * Auto-resolve the project id from the environment, in this order:
 *   1. cwd matches a registered project's source path;
 *   2. cwd contains a package.json with a name;
 *   3. fall back to the current directory name (sanitized).
 *
 * Never throws — a best-effort id is always returned so the projection can run
 * and return its own "not found" result when the guess is wrong.
 */
async function autoResolveProject(cpbRoot: string): Promise<string> {
  // 1. Registered project whose source path covers cwd.
  try {
    const { resolveHubRoot, loadRegistry } = await import(
      "../../server/services/hub/hub-registry.js"
    );
    const hubRoot = resolveHubRoot(cpbRoot);
    const registry = await loadRegistry(hubRoot);
    const cwd = path.resolve(process.cwd());
    const projects = (registry?.projects || {}) as Record<string, LooseRecord>;
    for (const [id, proj] of Object.entries(projects)) {
      const src = proj?.sourcePath ? path.resolve(String(proj.sourcePath)) : null;
      if (src && (src === cwd || cwd.startsWith(src + path.sep))) {
        return id;
      }
    }
  } catch {
    // fall through to the next strategy
  }

  // 2. package.json name in cwd.
  try {
    const pkgRaw = await readFile(path.join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name) {
      const derived = pkg.name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      if (derived) return derived;
    }
  } catch {
    // fall through
  }

  // 3. Directory basename.
  const fallback = path
    .basename(process.cwd())
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return fallback || "default";
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * `cpb task <task-id> [--project <id>]`.
 *
 * Returns 0 on success (task found and rendered), non-zero when the task id
 * matches no queue entry or the invocation is malformed. Never writes to the
 * queue or any runtime state — this is a read-only projection.
 */
export async function run(
  args: string[],
  ctx: LooseRecord = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  // Parse flags: --project <id> | --project=<id> | -p <id>; first positional is
  // the task id. Remaining positionals are ignored (the public surface takes a
  // single task id).
  let project = "";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      if (i + 1 < args.length) {
        project = args[++i];
      }
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else {
      positional.push(arg);
    }
  }
  const taskId = positional[0] || "";

  if (!taskId) {
    console.error("Usage: cpb task <task-id> [--project <id>]");
    return 1;
  }

  const cpbRoot = ctx.cpbRoot || process.env.CPB_ROOT || process.cwd();

  if (!project) {
    project = await autoResolveProject(cpbRoot);
  }

  // Reuse the Wave 1 projection — no new state machine, no duplicated pipeline.
  const { projectTaskView } = await import("../../server/services/task/task-view.js");
  const view: TaskView | null = await projectTaskView(cpbRoot, project, taskId);

  if (!view) {
    // Plain message; no internal terms. The caller already holds the id, so we
    // do not echo secrets — just confirm the miss.
    console.error(`No task found with id "${taskId}".`);
    return 1;
  }

  renderTaskView(view);
  return 0;
}
