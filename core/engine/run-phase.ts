import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { PhaseResult } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";
export type PhaseContext = LooseRecord & {
  phase: string;
  pool?: LooseRecord | null;
  sourcePath?: string;
  cwd?: string;
  cpbRoot?: string;
};
type PhaseAdapter = (ctx: PhaseContext) => Promise<PhaseResult> | PhaseResult;

const ADAPTER_CACHE: Record<string, PhaseAdapter> = {};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function phaseExportNames(phase: string) {
  const pascal = String(phase || "")
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const legacy = phase.charAt(0).toUpperCase() + phase.slice(1);
  return [`run${pascal}`, `run${legacy}`];
}

async function loadAdapter(phase: string): Promise<PhaseAdapter> {
  if (ADAPTER_CACHE[phase]) return ADAPTER_CACHE[phase];
  // retain: dynamic import — module namespace is external/uncontrolled, cast to LooseRecord for field access
  const mod = await import(`../phases/${phase}.js`) as LooseRecord;
  const exportNames = phaseExportNames(phase);
  const fn = exportNames.map((name) => mod[name]).find((candidate) => typeof candidate === "function");
  if (typeof fn !== "function") throw new Error(`phase adapter missing export: ${exportNames.join(" or ")}`);
  // retain: dynamic module boundary — fn is a runtime-validated export, cannot narrow Function to PhaseAdapter signature statically
  const adapter = fn as PhaseAdapter;
  ADAPTER_CACHE[phase] = adapter;
  return adapter;
}

export async function runPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const adapter = await loadAdapter(ctx.phase);
  try {
    return await adapter(ctx);
  } catch (err) {
    const errorRecord = recordValue(err);
    const errorCode = stringValue(errorRecord.code);
    const errorName = stringValue(errorRecord.name);
    // Re-throw PoolExhaustedError so callers (managed-worker) can detect it
    if (errorCode === "POOL_EXHAUSTED" || errorName === "PoolExhaustedError") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    return phaseFailed({
      phase: ctx.phase,
      failure: failure({
        kind: FailureKind.UNKNOWN,
        phase: ctx.phase,
        reason,
        retryable: false,
        cause: { stack },
      }),
    });
  } finally {
    await releasePhaseAcpResources(ctx);
  }
}

async function releasePhaseAcpResources(ctx: PhaseContext) {
  // Attempt-scoped conversations are owned by the job/worktree lifecycle.
  // Closing them after each phase destroys the executor context that semantic
  // repair needs. The managed worker releases the whole worktree at terminal
  // job cleanup; legacy phase calls without a conversation key keep the old
  // eager cleanup behavior.
  if (typeof ctx.conversationKey === "string" && ctx.conversationKey) return;
  const pool = ctx.pool;
  // retain: dynamic caller-injected pool shape — verify releaseWorktree at runtime before invoking
  const releaseWorktree = pool?.releaseWorktree;
  if (typeof releaseWorktree !== "function") return;
  const cwd = ctx.sourcePath || ctx.cwd || ctx.cpbRoot;
  if (!cwd) return;
  try {
    await releaseWorktree.call(
      pool,
      cwd,
      `phase_${ctx.phase || "unknown"}_complete`,
      { closeProvider: true },
    );
  } catch {
    // Phase results must not be masked by best-effort resource cleanup.
  }
}
