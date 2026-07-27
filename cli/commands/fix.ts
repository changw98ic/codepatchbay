/**
 * `cpb fix` — the thin product-entry facade (Phase 1, WAVE 2).
 *
 * Mandated by `docs/product/cpb-product-entry-execution-kernel-plan-2026-07-27.md`
 * §3.1 / §3.3 / §3.4 / §四 阶段 1. This is a FACADE: it parses the request,
 * runs the readiness gate, dedupes via the idempotency contract, and enqueues
 * through the SAME `enqueue()` the `pipeline`/`run` commands use. It does NOT
 * implement a state machine, does NOT spawn workers, and does NOT duplicate the
 * pipeline. The stabilization freeze is respected: no new agent/workflow/
 * provider/scheduler type is introduced.
 *
 * STRICT FLOW ORDER (plan §阶段1 — "任一步失败都不得写 queue"):
 *
 *   1. parse args            (problem positional; --project / --follow /
 *                              --idempotency-key flags)
 *   2. resolve project       (--project OR cwd auto-detect against the
 *                              registered sourcePaths; failure -> invalid_request)
 *   3. assertFixReadiness    ({ok:false} -> print nextAction, exit
 *                              `exitCodeForPreSubmitFailure(category)`, and
 *                              DO NOT enqueue — the load-bearing invariant)
 *   4. idempotency           (--idempotency-key -> hashTaskKey +
 *                              selectIdempotentEntry over the project's active
 *                              queue entries; active match -> REUSE its taskId,
 *                              skip enqueue; terminal-only match -> new entry)
 *   5. enqueue               (mirror `cli/commands/pipeline.ts` entry shape
 *                              EXACTLY; set metadata.queueDedupeKey = hashedKey
 *                              so the NEXT same-key submit dedupes while active)
 *   6. print public result   (taskId + a plain-language nextAction; exit
 *                              `FixAccepted`)
 *
 * `--follow`: after enqueue, poll `projectTaskView` until the task reaches a
 * state where waiting cannot help (terminal OR blocked OR needs_input), or a
 * timeout / abort fires; exit per `ExitCode.Follow*`. The poll loop's clock,
 * sleeper and abort signal are injectable so the follow path is deterministic
 * under test without real timers or SIGINT.
 *
 * OUTPUT BOUNDARY: every line written reaches a public consumer, so it carries
 * ONLY whitelisted info — the opaque `taskId` and a user-facing nextAction. It
 * NEVER surfaces jobId/attemptId/provider/agent/lease/session/PID/prompt/env/
 * absolute paths, and it NEVER uses Hub/Worker/ACP/Provider/lease jargon
 * outside of literal `cpb ...` command references (which the readiness
 * nextActions already vet).
 */

import path from "node:path";

import type { LooseRecord } from "../../shared/types.js";
import { ExitCode, exitCodeForPreSubmitFailure } from "../../core/contracts/exit-code.js";
import type { FixReadinessResult, FixReadinessFailure } from "../../server/services/task/readiness.js";
import {
  TaskState,
  type TaskView,
} from "../../core/contracts/task-view.js";
import {
  hashTaskKey,
  selectIdempotentEntry,
  type IdempotencyQueueEntry,
} from "../../core/contracts/idempotency.js";
import {
  checkStatusById,
  humanResultLine,
} from "./task.js";

// ─── public types ───────────────────────────────────────────────────────────

/**
 * The service surface `fix` delegates to. Every member is injectable via
 * `FixCtx.deps` so the command is unit-testable without spawning real hubs,
 * workers or agents. Production resolves each member with a dynamic `import()`
 * of the canonical module (mirroring `cli/commands/pipeline.ts`), so the
 * facade stays a thin delegate rather than owning the services.
 */
export type FixDeps = {
  assertFixReadiness: (
    opts: { cpbRoot: string; project: string },
  ) => Promise<FixReadinessResult>;
  enqueue: (
    hubRoot: string,
    input: LooseRecord,
  ) => Promise<LooseRecord & { id?: string }>;
  loadQueue: (hubRoot: string) => Promise<{
    entries?: IdempotencyQueueEntry[];
  }>;
  loadRegistry: (
    hubRoot: string,
  ) => Promise<LooseRecord & {
    projects?: Record<string, LooseRecord>;
  }>;
  resolveHubRoot: (cpbRoot: string) => string;
  projectTaskView: (
    cpbRoot: string,
    project: string,
    taskId: string,
    opts?: { dataRoot?: string; hubRoot?: string },
  ) => Promise<TaskView | null>;
  /** Pure task router shared with `pipeline`; resolves workflow + planMode. */
  resolveTaskRoute: (input: LooseRecord) => LooseRecord;
};

/**
 * Hooks for the `--follow` poll loop. All optional; defaults use real timers
 * and a real SIGINT listener. Tests inject `now` + `sleep` + `signal` so the
 * loop is fully deterministic (no waiting, no process-wide signal handlers).
 */
export type FollowHooks = {
  /** Monotonic-now in ms; default `Date.now`. */
  now?: () => number;
  /** Default `(ms) => new Promise(r => setTimeout(r, ms))`. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort handle (e.g. AbortSignal); aborted -> `FollowCanceled`. */
  signal?: { readonly aborted: boolean } | null;
};

/**
 * The command context. `cpbRoot` / `executorRoot` / `command` are supplied by
 * the CLI dispatcher exactly as for `pipeline`/`status`. The remaining fields
 * are OPTIONAL test seams:
 *
 *   - `deps`     — override any service in `FixDeps`.
 *   - `out`      — capture stdout/stderr lines (default `console.log/error`).
 *   - `follow*`  — timing knobs for the poll loop.
 */
export type FixCtx = LooseRecord & {
  cpbRoot?: string;
  executorRoot?: string;
  command?: string;
  deps?: Partial<FixDeps>;
  out?: { log?: (line: string) => void; err?: (line: string) => void };
  followTimeoutMs?: number;
  followPollIntervalMs?: number;
  /** Forwarded to `followTask`; tests inject a stub signal/sleep/now. */
  followHooks?: FollowHooks;
};

// ─── pure: arg parsing ──────────────────────────────────────────────────────

export type ParsedFixArgs = {
  problem: string;
  project: string;
  follow: boolean;
  idempotencyKey: string;
  help: boolean;
};

/**
 * Parse `cpb fix` args. The FIRST non-flag positional begins the problem text;
 * subsequent positionals are joined with spaces (so a copy-pasted multi-word
 * problem without quotes still works). Flags:
 *
 *   --project <id>            target project id
 *   --follow                  block until a follow-terminal state
 *   --idempotency-key <key>   dedupe against active same-key entries
 *   -h / --help               usage
 *
 * Unknown flags are folded into the problem text rather than rejected, matching
 * the forgiving posture of a普通用户 entry; readiness catches malformed input.
 */
export function parseFixArgs(args: readonly string[]): ParsedFixArgs {
  let project = "";
  let follow = false;
  let idempotencyKey = "";
  let help = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--follow") {
      follow = true;
    } else if (arg === "--project" && i + 1 < args.length) {
      project = args[++i];
    } else if (arg === "--idempotency-key" && i + 1 < args.length) {
      idempotencyKey = args[++i];
    } else {
      positional.push(arg);
    }
  }

  const problem = positional.join(" ").trim();
  return { problem, project, follow, idempotencyKey, help };
}

// ─── pure: enqueue-input shape (mirrors cli/commands/pipeline.ts) ───────────

/**
 * Build the `enqueue` input for a fix request.
 *
 * The shape is a 1:1 mirror of `cli/commands/pipeline.ts`'s enqueue call
 * (same `projectId` / `sourcePath` / `priority` / `description` / `type` /
 * `metadata.source` / `actor` / `autoFinalize` / `workflow` / `planMode` /
 * `triageMode` / `routeDecision` / `maxRetries` / `issueNumber` / `issueUrl` /
 * `repo` / `issueTitle` / `requestedAt` keys) so fix tasks travel the SAME
 * pipeline path. The only fix-specific addition is `metadata.queueDedupeKey`,
 * set to the hashed idempotency key when supplied (rule 3 of the idempotency
 * contract: the key is persisted as a HASH, never plaintext).
 *
 * `fix` does not expose the agent/model/per-role knobs `pipeline` does, so
 * those are omitted (they are optional on `QueueEntryInput` and default to
 * undefined upstream, exactly as when `pipeline` is invoked without them).
 */
export function buildFixEnqueueInput(
  problem: string,
  project: string,
  registered: LooseRecord | null,
  route: LooseRecord,
  hashedDedupeKey: string | null,
  nowMs: number,
): LooseRecord {
  const github = (registered && (registered.github as LooseRecord | null)) || null;
  const metadata: LooseRecord = {
    source: "cli",
    workflow: route.workflow ?? "standard",
    planMode: route.planMode ?? "auto",
    triageMode: null,
    routeDecision: route.decision || undefined,
    actor: "cli",
    autoFinalize: true,
    maxRetries: 3,
    issueNumber: null,
    issueUrl: null,
    repo: github?.fullName || null,
    issueTitle: problem,
    requestedAt: new Date(nowMs).toISOString(),
  };
  if (hashedDedupeKey) metadata.queueDedupeKey = hashedDedupeKey;
  return {
    projectId: project,
    sourcePath: (registered && (registered.sourcePath as string | null)) || null,
    priority: "P2",
    description: problem,
    type: "cli_pipeline",
    metadata,
  };
}

// ─── pure: --follow view → exit code (verified-gated) ───────────────────────

/**
 * Map a projected TaskView to a `--follow` exit code, or `null` when polling
 * should continue (non-terminal-and-actionable state).
 *
 * Phase 2 gating (plan §四 阶段2 + exit-code.ts contract): `FollowCompletedVerified`
 * (0) is returned ONLY when the task is in the `succeeded` state AND the
 * evidence-driven `verified` check actually passed. A `succeeded` state WITHOUT
 * a passing verification gate — the queue-only fallback where a queue entry is
 * marked completed with no verifying job — resolves to `FollowFailed`, never 0.
 * This is the load-bearing honesty invariant: exit 0 means verified, not just
 * "the state label said succeeded".
 *
 * `blocked` and `needs_input` are surfaced as STOP states (not polled through)
 * because waiting cannot progress them — the user must act, so control is
 * handed back with the matching code.
 *
 * `succeeded`'s verification gate is read from the SAME `checks.verified`
 * dimension `cpb task` renders (via the shared `checkStatusById` helper), so
 * the exit code and the rendered distinction can never disagree.
 */
export function exitCodeForFollowView(view: TaskView | null): number | null {
  if (!view) return null;
  switch (view.state) {
    case TaskState.Succeeded:
      return checkStatusById(view, "verified") === "pass"
        ? ExitCode.FollowCompletedVerified
        : ExitCode.FollowFailed;
    case TaskState.Failed:
      return ExitCode.FollowFailed;
    case TaskState.Canceled:
      return ExitCode.FollowCanceled;
    case TaskState.Blocked:
      return ExitCode.FollowBlocked;
    case TaskState.NeedsInput:
      return ExitCode.FollowNeedsInput;
    default:
      // accepted / queued / running / verifying — keep polling.
      return null;
  }
}

// ─── --follow poll loop ─────────────────────────────────────────────────────

export const DEFAULT_FOLLOW_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FOLLOW_POLL_INTERVAL_MS = 1000;

/**
 * Poll `projectTaskView` for `taskId` until a stop state, timeout, or abort.
 *
 * Determinism: `hooks.now`, `hooks.sleep` and `hooks.signal` are injectable so
 * tests drive the loop without real timers or SIGINT. The default `signal`
 * wires a real `SIGINT` handler (removed on return) so an interactive `--follow`
 * can be Ctrl-C'd; the injected path passes a stub and skips the handler.
 *
 * Returns the exit code the caller should propagate.
 */
export async function followTask(
  deps: FixDeps,
  cpbRoot: string,
  project: string,
  taskId: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    hooks?: FollowHooks;
    onState?: (view: TaskView | null) => void;
    out?: OutSink;
  } = {},
): Promise<number> {
  const now = opts.hooks?.now ?? (() => Date.now());
  const sleep =
    opts.hooks?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const injectedSignal = opts.hooks?.signal ?? null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_FOLLOW_POLL_INTERVAL_MS;
  const out = opts.out ?? {
    log: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  };
  const deadline = now() + timeoutMs;

  // Only install a real SIGINT handler when no signal was injected (production).
  // Tests pass a stub signal and never touch process-wide signal handling.
  let interrupted = false;
  let onSigint: (() => void) | null = null;
  if (injectedSignal === null) {
    onSigint = () => {
      interrupted = true;
    };
    process.once("SIGINT", onSigint);
  }

  try {
    while (true) {
      if (interrupted || injectedSignal?.aborted) return ExitCode.FollowCanceled;

      let view: TaskView | null = null;
      try {
        view = await deps.projectTaskView(cpbRoot, project, taskId);
      } catch {
        // A transient projection failure must not crash follow; treat as a
        // missed sample and keep polling until deadline.
        view = null;
      }
      opts.onState?.(view);
      if (view) {
        const exit = exitCodeForFollowView(view);
        if (exit !== null) {
          // Surface the evidence-driven distinction on the terminal sample so
          // a `--follow` consumer sees the SAME honest status `cpb task` shows
          // (verified / not-verified / ready-to-deliver), then propagate the
          // verdict-driven exit code. Empty for non-succeeded stop states —
          // the exit code is their signal, matching `cpb task`'s State line.
          const resultLine = humanResultLine(view);
          if (resultLine) out.log(resultLine);
          return exit;
        }
      }

      if (now() >= deadline) return ExitCode.FollowTimeout;
      await sleep(pollIntervalMs);
    }
  } finally {
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}

// ─── output helper ──────────────────────────────────────────────────────────

type OutSink = { log: (line: string) => void; err: (line: string) => void };

function resolveOut(ctx: FixCtx): OutSink {
  return {
    log: ctx.out?.log ?? ((line: string) => console.log(line)),
    err: ctx.out?.err ?? ((line: string) => console.error(line)),
  };
}

// ─── usage ──────────────────────────────────────────────────────────────────

const HELP = `Usage: cpb fix "<problem>" [--project <id>] [--follow] [--idempotency-key <key>]

Submit a problem to be diagnosed and fixed. Returns a task id you can check.

Options:
  --project <id>       Target project id (auto-detected from cwd if omitted)
  --follow             Block until the task finishes, then exit with the result
  --idempotency-key <key>  Reuse an in-flight task submitted with the same key
  -h, --help           Show this help

Examples:
  cpb fix "login page goes blank after signing in"
  cpb fix "login page goes blank after signing in" --project my-app
  cpb fix "login page goes blank after signing in" --follow`;

// ─── project auto-detection ─────────────────────────────────────────────────

/**
 * Resolve the project id from the current working directory by matching
 * against registered projects' `sourcePath` (the most reliable signal). Returns
 * "" when no registered project contains the cwd. Mirrors the cwd-match step
 * of `pipeline` run-mode without the package.json/dirname guessing (which
 * produces unregistered names and a confusing readiness failure downstream).
 */
export async function autoDetectProject(
  loadRegistry: FixDeps["loadRegistry"],
  hubRoot: string,
  cwd: string,
): Promise<string> {
  let registry: Awaited<ReturnType<typeof loadRegistry>>;
  try {
    registry = await loadRegistry(hubRoot);
  } catch {
    return "";
  }
  const projects = registry?.projects || {};
  for (const [id, proj] of Object.entries(projects)) {
    const src = proj?.sourcePath;
    if (typeof src !== "string" || !src) continue;
    const abs = path.resolve(src);
    if (abs === cwd || cwd.startsWith(abs + path.sep)) return id;
  }
  return "";
}

// ─── dependency resolution ──────────────────────────────────────────────────

async function resolveDeps(ctx: FixCtx): Promise<FixDeps> {
  const o = ctx.deps ?? {};
  // Dynamic imports are cached by the runtime, so loading the real modules
  // here is cheap even when every service is overridden (and every one of
  // them is already imported by the existing readiness/task-view tests, so
  // there is no new startup cost being introduced). Casts reconcile the real
  // QueueEntryInput/QueueState parameter types with the LooseRecord seam the
  // facade (and its stubs) operate on.
  const [readinessMod, hubQueueMod, hubRegistryMod, taskViewMod, autoRouteMod] = await Promise.all([
    import("../../server/services/task/readiness.js"),
    import("../../server/services/hub/hub-queue.js"),
    import("../../server/services/hub/hub-registry.js"),
    import("../../server/services/task/task-view.js"),
    import("../../core/workflow/auto-route.js"),
  ]);
  return {
    assertFixReadiness: o.assertFixReadiness ?? readinessMod.assertFixReadiness,
    enqueue: o.enqueue ?? (hubQueueMod.enqueue as unknown as FixDeps["enqueue"]),
    loadQueue: o.loadQueue ?? (hubQueueMod.loadQueue as unknown as FixDeps["loadQueue"]),
    loadRegistry:
      o.loadRegistry ?? (hubRegistryMod.loadRegistry as unknown as FixDeps["loadRegistry"]),
    resolveHubRoot: o.resolveHubRoot ?? hubRegistryMod.resolveHubRoot,
    projectTaskView: o.projectTaskView ?? taskViewMod.projectTaskView,
    resolveTaskRoute:
      o.resolveTaskRoute ?? (autoRouteMod.resolveTaskRoute as unknown as FixDeps["resolveTaskRoute"]),
  };
}

// ─── the command ────────────────────────────────────────────────────────────

/**
 * `cpb fix "<problem>" [--project <id>] [--follow] [--idempotency-key <key>]`.
 *
 * Returns the exit code (always a number). See the module docstring for the
 * strict flow order and the load-bearing "readiness failure must not enqueue"
 * invariant.
 */
// TS does not reliably narrow the imported FixReadinessResult discriminated union
// at this call site (cross-module type-alias narrowing); an explicit predicate does.
function isReadinessFailure(r: FixReadinessResult): r is FixReadinessFailure {
  return r.ok === false;
}

export async function run(args: string[], ctx: FixCtx = {}): Promise<number> {
  const out = resolveOut(ctx);

  const parsed = parseFixArgs(args);
  if (parsed.help) {
    out.log(HELP);
    return ExitCode.FixAccepted;
  }

  // Step 1 — validate the problem text. An empty problem is invalid_request:
  // the user must state what to fix. No queue write, no readiness call.
  if (!parsed.problem) {
    out.err('Usage: cpb fix "<problem>" [--project <id>] [--follow] [--idempotency-key <key>]');
    return ExitCode.FixInvalidRequest;
  }

  // Resolve the project id (explicit flag OR cwd auto-detect). Auto-detect
  // failure is invalid_request: no project could be identified at all, which
  // is distinct from needs_setup (project named but not initialized).
  const cpbRoot = ctx.cpbRoot || process.env.CPB_ROOT || process.cwd();
  const deps = await resolveDeps(ctx);
  const hubRoot = deps.resolveHubRoot(cpbRoot);

  let project = parsed.project;
  if (!project) {
    project = await autoDetectProject(deps.loadRegistry, hubRoot, path.resolve(process.cwd()));
  }
  if (!project) {
    out.err(
      'No project found. Pass `--project <id>`, or run from a registered project directory. To register one, run `cpb init <path> <id>`.',
    );
    return ExitCode.FixInvalidRequest;
  }

  // Step 2 — readiness. {ok:false} -> print the nextAction, exit the mapped
  // pre-submit code, and DO NOT enqueue. This is the key product invariant.
  const readiness = await deps.assertFixReadiness({ cpbRoot, project });
  if (isReadinessFailure(readiness)) {
    out.err(readiness.nextAction);
    return exitCodeForPreSubmitFailure(readiness.category);
  }

  // Step 3 — idempotency. Hash the key (never persist plaintext) and look for
  // an ACTIVE (non-terminal) same-key entry in this project's queue. Active
  // match -> reuse its taskId, skip enqueue. Terminal-only match -> fall
  // through and create a new entry (terminal tasks do not hold a key forever).
  let hashedKey: string | null = null;
  if (parsed.idempotencyKey) {
    hashedKey = hashTaskKey(parsed.idempotencyKey);
    let queue: { entries?: IdempotencyQueueEntry[] };
    try {
      queue = await deps.loadQueue(hubRoot);
    } catch {
      queue = { entries: [] };
    }
    const entries = Array.isArray(queue?.entries) ? queue.entries : [];
    const projectEntries = entries.filter(
      (e) => e != null && typeof e === "object" && e.projectId === project,
    );
    const existing = selectIdempotentEntry(projectEntries, hashedKey);
    if (existing && typeof existing.id === "string" && existing.id) {
      out.log(`Task ${existing.id} is already in progress.`);
      out.log(`Check progress: \`cpb task ${existing.id}\``);
      if (parsed.follow) {
        return await followTask(deps, cpbRoot, project, existing.id, {
          timeoutMs: ctx.followTimeoutMs,
          pollIntervalMs: ctx.followPollIntervalMs,
          hooks: ctx.followHooks,
          out,
        });
      }
      return ExitCode.FixAccepted;
    }
  }

  // Step 4 — resolve the registered project (for sourcePath / github repo) and
  // the task route, then enqueue. The entry shape mirrors pipeline EXACTLY so
  // the task flows through the same plan→execute→verify pipeline.
  let registered: LooseRecord | null = null;
  try {
    const reg = await deps.loadRegistry(hubRoot);
    registered = reg?.projects?.[project] ?? null;
  } catch {
    registered = null;
  }

  const route = deps.resolveTaskRoute({
    task: parsed.problem,
    workflow: "standard",
    planMode: "auto",
    triageMode: null,
    workflowExplicit: false,
    planModeExplicit: false,
    actor: "cli",
  });

  const enqueueInput = buildFixEnqueueInput(
    parsed.problem,
    project,
    registered,
    route,
    hashedKey,
    Date.now(),
  );

  let entry: LooseRecord & { id?: string };
  try {
    entry = await deps.enqueue(hubRoot, enqueueInput);
  } catch (err) {
    // Enqueue itself can fail on hub I/O; surface as runtime_unavailable.
    const message = err instanceof Error ? err.message : String(err);
    out.err(`Could not submit the task right now. ${message}`);
    return ExitCode.FixRuntimeUnavailable;
  }

  const taskId = typeof entry?.id === "string" ? entry.id : "";
  if (!taskId) {
    out.err("Could not submit the task right now. The submission returned no task id.");
    return ExitCode.FixRuntimeUnavailable;
  }

  // Step 5 — public result. Only the opaque taskId + a plain-language
  // nextAction; no internal identifiers or architecture jargon.
  out.log(`Task ${taskId} accepted.`);
  out.log(`Check progress: \`cpb task ${taskId}\``);

  if (parsed.follow) {
    return await followTask(deps, cpbRoot, project, taskId, {
      timeoutMs: ctx.followTimeoutMs,
      pollIntervalMs: ctx.followPollIntervalMs,
      hooks: ctx.followHooks,
      out,
    });
  }

  return ExitCode.FixAccepted;
}
