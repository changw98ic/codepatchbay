/**
 * assertFixReadiness — the pre-submit readiness gate for the thin product
 * facades (`cpb fix` / `cpb task`).
 *
 * This is a PURE READ GATE. It answers one question: "may this request be
 * accepted into the queue right now?" It performs the four readiness steps in
 * the FIXED order mandated by the product-entry plan (§阶段1):
 *
 *   1. resolve project            (missing/unregistered -> needs_setup)
 *   2. validate runtime root      (missing            -> runtime_unavailable)
 *   3. validate agent executable  (unconfigured       -> runtime_unavailable)
 *   4. hub reachable              (not alive          -> runtime_unavailable)
 *
 * HARD CONTRACTS:
 *
 *   - ZERO WRITE SIDE EFFECTS. The function never appends a queue entry, never
 *     spawns a hub, never mutates registry/state/config. A failed readiness
 *     check MUST NOT produce an orphan queue entry (plan exit condition). The
 *     only subprocesses it spawns are read-only PATH lookups (`command -v`)
 *     during agent-executable resolution.
 *
 *   - FAIL-CLOSED on the hub. It never auto-starts a control plane — not even
 *     a local one. "Connect to existing Hub or safely start local Hub" is the
 *     overall readiness contract; THIS function is the assertion half. The
 *     caller (`fix.ts`, a later wave) owns any start decision and must re-pass
 *     readiness afterward. When in doubt, runtime_unavailable.
 *
 *   - REUSE, do not duplicate. Project lookup, hub-config read, project-config
 *     read, agent-spec merge, and hub liveness all go through the existing
 *     services (`hub-registry.ts`, `agent-config.ts`). The narrow per-agent
 *     executable probe mirrors `acp-client.ts` / `readiness-checks.ts` rather
 *     than invoking the heavy `runReadinessChecks` aggregator, which spawns
 *     subprocesses for the entire toolchain and is too broad (and too
 *     non-deterministic) for a per-submit gate.
 *
 * The stabilization freeze is respected: no new agent/workflow/provider/
 * scheduler types are introduced. The agent-executable table here mirrors the
 * already-frozen ACP adapter table elsewhere.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import {
  PreSubmitFailure,
  type PreSubmitFailureValue,
} from "../../../core/contracts/task-view.js";
import {
  getProject,
  readHubLiveness,
  resolveHubRoot,
} from "../hub/hub-registry.js";
import {
  mergeAgentConfig,
  readHubConfig,
  readProjectConfig,
} from "../agent/agent-config.js";

// ─── public result shape ───────────────────────────────────────────────────

export type FixReadinessOk = { ok: true };

export type FixReadinessFailure = {
  ok: false;
  category: PreSubmitFailureValue;
  /** Short diagnostic reason. May include implementation detail. */
  reason: string;
  /**
   * The next concrete, USER-FACING action. Must be non-empty and must never
   * surface internal architecture terms (Hub/Worker/ACP/Provider/lease/queue/
   * orchestrator/...) outside of literal `cpb ...` command references.
   */
  nextAction: string;
};

export type FixReadinessResult = FixReadinessOk | FixReadinessFailure;

export type AssertFixReadinessOptions = {
  cpbRoot: string;
  project: string;
};

// ─── frozen agent-executable table (mirrors acp-client.ts ACP_ADAPTERS) ─────
//
// Kept in sync with the already-frozen adapter table; do NOT add entries here
// without also extending the production table — the stabilization freeze gates
// new agent types.

const ACP_EXECUTABLES: Record<
  string,
  { command: string; npxPkg: string | null }
> = Object.freeze({
  codex: { command: "codex-acp", npxPkg: "@agentclientprotocol/codex-acp" },
  claude: { command: "claude-agent-acp", npxPkg: "@agentclientprotocol/claude-agent-acp" },
  reasonix: { command: "reasonix", npxPkg: null },
});

const SYSTEM_DEFAULT_AGENT = "codex";

/**
 * Resolve whether a bare command name or path-like command is executable.
 *
 * Path-like commands (contain a path separator, or a win32 drive root) are
 * probed directly; bare names are resolved through PATH via `command -v`
 * (POSIX) or `where` (win32), exactly as `acp-client.ts` does. Read-only: no
 * mutation, no side effects beyond the spawned lookup.
 */
function commandExists(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  const isPathLike =
    command.includes(path.sep)
    || (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(command));
  try {
    if (isPathLike) {
      accessSync(command, fsConstants.X_OK);
      return true;
    }
    if (process.platform === "win32") {
      const result = spawnSync("where", [command], { encoding: "utf8" });
      return result.status === 0;
    }
    const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", command], {
      encoding: "utf8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Narrowed view of an agent spec record (`{ agent?: string | null, ... }`). */
function agentNameOf(spec: unknown): string {
  if (!spec || typeof spec !== "object") return "";
  const agent = (spec as { agent?: unknown }).agent;
  return typeof agent === "string" ? agent : "";
}

/**
 * Resolve the effective primary agent name for the project.
 *
 * Honors merged config (hub + project) exactly as enqueue-time resolution does
 * (`mergeAgentConfig`): the executor role is preferred because it is the role
 * that must run, then any other configured role, then the explicit `default`,
 * then the system baseline. Returns a non-empty string.
 */
function pickAgentName(merged: Record<string, unknown>): string {
  for (const role of ["executor", "planner", "verifier", "reviewer"]) {
    const agent = agentNameOf(merged[role]);
    if (agent) return agent;
  }
  const defaultAgent = agentNameOf(merged.default);
  if (defaultAgent) return defaultAgent;
  return SYSTEM_DEFAULT_AGENT;
}

/**
 * Resolve the executable command + npx fallback package for an agent name,
 * honoring the `CPB_ACP_{NAME}_COMMAND` env override (the same override the
 * ACP client honors). Returns `npxPkg: null` when no fallback exists.
 */
function resolveAgentExecutable(
  agentName: string,
  env: NodeJS.ProcessEnv,
): { command: string; npxPkg: string | null } {
  const envKey = `CPB_ACP_${agentName.toUpperCase()}_COMMAND`;
  const envCommand = env[envKey];
  if (envCommand) {
    return { command: envCommand, npxPkg: null };
  }
  const entry = ACP_EXECUTABLES[agentName];
  if (entry) {
    return { command: entry.command, npxPkg: entry.npxPkg };
  }
  // Unknown agent name: treat the name itself as the command, no fallback.
  return { command: agentName, npxPkg: null };
}

/**
 * True iff the agent's executable is available now OR can be fetched on demand
 * via `npx`. Mirrors `checkAcpAdapter` availability semantics: the npx fallback
 * counts as available (it is fetched lazily at first run); toolchain presence
 * of `npx` itself is verified here so the fallback is not advertised blindly.
 */
function agentExecutableAvailable(
  agentName: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const { command, npxPkg } = resolveAgentExecutable(agentName, env);
  if (commandExists(command)) return true;
  if (npxPkg && commandExists("npx")) return true;
  return false;
}

/**
 * True iff the resolved control plane is unambiguously local (and therefore a
 * candidate for a local safe-start by the caller). Today every resolved hub
 * root is a local filesystem path, so this is always true; the gate exists so
 * that a future remote/unknown control-plane indicator connects-only rather
 * than auto-starting. This function never spawns and never writes.
 */
function isLocalControlPlane(_hubRoot: string): boolean {
  return true;
}

function fail(
  category: PreSubmitFailureValue,
  reason: string,
  nextAction: string,
): FixReadinessFailure {
  return { ok: false, category, reason, nextAction };
}

// ─── the gate ──────────────────────────────────────────────────────────────

/**
 * Assert that a `cpb fix`-style request may be accepted into the queue. See the
 * module docstring for the fixed step order and the hard contracts (zero write
 * side effects; fail-closed on the hub).
 *
 * Returns `{ ok: true }` iff every step passes. Any failed step returns the
 * category, a short reason, and a non-empty user-facing nextAction. The
 * caller maps `category` to an exit code via `exitCodeForPreSubmitFailure`.
 */
export async function assertFixReadiness(
  opts: AssertFixReadinessOptions,
): Promise<FixReadinessResult> {
  const cpbRoot = path.resolve(opts.cpbRoot);
  const projectId = opts.project;
  const env = process.env;
  const hubRoot = resolveHubRoot(cpbRoot);

  // Step 1 — resolve project. Missing/unregistered -> needs_setup. The user
  // must register the project before any request can be accepted; we never
  // auto-register.
  let registered: Awaited<ReturnType<typeof getProject>>;
  try {
    registered = await getProject(hubRoot, projectId);
  } catch {
    registered = null;
  }
  if (!registered) {
    return fail(
      PreSubmitFailure.NeedsSetup,
      `project '${projectId}' is not registered under ${hubRoot}`,
      `Project "${projectId}" is not registered. Run \`cpb init <path> ${projectId}\` from the project directory to set it up.`,
    );
  }

  // Step 2 — validate runtime root. A registered project must carry a working
  // directory; without one the runtime cannot persist events or artifacts.
  const runtimeRoot =
    typeof registered.projectRuntimeRoot === "string"
      ? registered.projectRuntimeRoot
      : "";
  if (!runtimeRoot) {
    return fail(
      PreSubmitFailure.RuntimeUnavailable,
      `project '${projectId}' has no runtime root configured`,
      `Project "${projectId}" is missing its working directory. Re-run \`cpb init\` to configure it, then retry.`,
    );
  }

  // Step 3 — validate agent executable/config. Reuse the same hub+project
  // config merge the enqueue path performs, then probe the resolved
  // executable. An unconfigured/missing agent is runtime_unavailable.
  let hubAgents: Awaited<ReturnType<typeof readHubConfig>> = {};
  try {
    hubAgents = await readHubConfig(hubRoot);
  } catch {
    hubAgents = {};
  }
  let projectAgents: Awaited<ReturnType<typeof readProjectConfig>> = null;
  try {
    projectAgents = await readProjectConfig(runtimeRoot, projectId);
  } catch {
    projectAgents = null;
  }
  const merged = mergeAgentConfig(hubAgents.agents, projectAgents, null);
  const agentName = pickAgentName(merged);
  if (!agentExecutableAvailable(agentName, env)) {
    return fail(
      PreSubmitFailure.RuntimeUnavailable,
      `agent executable '${agentName}' is not available for project '${projectId}'`,
      `No coding agent is available for project "${projectId}". Install one (for example Codex or Claude) or run \`cpb agents install\`, then retry.`,
    );
  }

  // Step 4 — hub reachable AND in a safe state. Fail-closed: we never auto-start.
  // If the control plane were remote/unknown we would connect-only (never start);
  // today every plane is local, so the nextAction points at the local start
  // command. readHubLiveness returns alive:true with a `reason` only for
  // non-canonical states ("unsafe-state" = hub.json unreadable/corrupt,
  // "liveness-unknown" = leader identity check threw) — per the plan these MUST
  // be treated as unreachable, not as a green hub. Only alive:true with NO reason
  // is a clean, safe, identity-verified control plane.
  const localPlane = isLocalControlPlane(hubRoot);
  let liveness: Awaited<ReturnType<typeof readHubLiveness>>;
  try {
    liveness = await readHubLiveness(hubRoot);
  } catch {
    liveness = { alive: false, reason: "liveness-error" };
  }
  if (!liveness.alive || liveness.reason) {
    const nextAction = localPlane
      ? `The local service is not running. Start it with \`cpb hub start\`, then retry.`
      : `Could not reach the configured service. Verify the connection, then retry.`;
    return fail(
      PreSubmitFailure.RuntimeUnavailable,
      `hub not reachable at ${hubRoot} (reason: ${liveness.reason || "unknown"})`,
      nextAction,
    );
  }

  return { ok: true };
}
