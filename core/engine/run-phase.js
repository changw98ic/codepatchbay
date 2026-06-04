import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";

const ADAPTER_CACHE = {};

async function loadAdapter(phase) {
  if (ADAPTER_CACHE[phase]) return ADAPTER_CACHE[phase];
  const mod = await import(`../phases/${phase}.js`);
  const fn = mod[`run${phase.charAt(0).toUpperCase() + phase.slice(1)}`];
  if (typeof fn !== "function") throw new Error(`phase adapter missing export: run${phase.charAt(0).toUpperCase() + phase.slice(1)}`);
  ADAPTER_CACHE[phase] = fn;
  return fn;
}

export async function runPhase(ctx) {
  const adapter = await loadAdapter(ctx.phase);
  try {
    return await adapter(ctx);
  } catch (err) {
    // Re-throw PoolExhaustedError so callers (managed-worker) can detect it
    if (err.code === "POOL_EXHAUSTED" || err.name === "PoolExhaustedError") throw err;
    return phaseFailed({
      phase: ctx.phase,
      failure: failure({
        kind: FailureKind.UNKNOWN,
        phase: ctx.phase,
        reason: err.message,
        retryable: false,
        cause: { stack: err.stack },
      }),
    });
  } finally {
    await releasePhaseAcpResources(ctx);
  }
}

async function releasePhaseAcpResources(ctx) {
  const releaseWorktree = ctx.pool?.releaseWorktree;
  if (typeof releaseWorktree !== "function") return;
  const cwd = ctx.sourcePath || ctx.cwd || ctx.cpbRoot;
  if (!cwd) return;
  try {
    await releaseWorktree.call(
      ctx.pool,
      cwd,
      `phase_${ctx.phase || "unknown"}_complete`,
      { closeProvider: true },
    );
  } catch {
    // Phase results must not be masked by best-effort resource cleanup.
  }
}
