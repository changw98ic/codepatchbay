// @ts-nocheck
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";

const ADAPTER_CACHE = {};

function phaseExportNames(phase) {
  const pascal = String(phase || "")
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const legacy = phase.charAt(0).toUpperCase() + phase.slice(1);
  return [`run${pascal}`, `run${legacy}`];
}

async function loadAdapter(phase) {
  if (ADAPTER_CACHE[phase]) return ADAPTER_CACHE[phase];
  const mod = await import(`../phases/${phase}.js`);
  const exportNames = phaseExportNames(phase);
  const fn = exportNames.map((name) => mod[name]).find((candidate) => typeof candidate === "function");
  if (typeof fn !== "function") throw new Error(`phase adapter missing export: ${exportNames.join(" or ")}`);
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
