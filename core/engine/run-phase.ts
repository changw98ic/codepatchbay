import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { PhaseResult } from "../../shared/types.js";

type LooseRecord = Record<string, unknown>;
type PhasePool = {
  releaseWorktree?: (cwd: string, reason: string, options: { closeProvider: boolean }) => Promise<unknown> | unknown;
};
export type PhaseContext = LooseRecord & {
  phase: string;
  pool?: LooseRecord | null;
  sourcePath?: string;
  cwd?: string;
  cpbRoot?: string;
};
type PhaseAdapter = (ctx: PhaseContext) => Promise<PhaseResult> | PhaseResult;

const ADAPTER_CACHE: Record<string, PhaseAdapter> = {};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

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
  const mod = await import(`../phases/${phase}.js`) as LooseRecord;
  const exportNames = phaseExportNames(phase);
  const fn = exportNames.map((name) => mod[name]).find((candidate) => typeof candidate === "function");
  if (typeof fn !== "function") throw new Error(`phase adapter missing export: ${exportNames.join(" or ")}`);
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
  const releaseWorktree = (ctx.pool as PhasePool | undefined)?.releaseWorktree;
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
