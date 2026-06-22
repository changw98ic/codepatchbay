import { PhaseResult, PhaseFailure } from "../../shared/types.js";

export function phasePassed({ phase, artifact = null, diagnostics = {} }: { phase: string; artifact?: unknown; diagnostics?: Record<string, unknown> }): PhaseResult {
  return {
    schemaVersion: 1,
    phase,
    status: "passed",
    artifact,
    failure: null,
    diagnostics,
    createdAt: new Date().toISOString(),
  };
}

export function phaseFailed({ phase, failure, diagnostics = {} }: { phase: string; failure: unknown; diagnostics?: Record<string, unknown> }): PhaseResult {
  return {
    schemaVersion: 1,
    phase,
    status: "failed",
    artifact: null,
    // failure arrives as unknown (callers pass failure({...}) or arbitrary cause
    // objects); narrow at this canonical boundary so consumers get PhaseFailure.
    failure: failure as PhaseFailure | null,
    diagnostics,
    createdAt: new Date().toISOString(),
  };
}

export function isPhasePassed(result: { status?: string } | null | undefined) {
  return result?.status === "passed";
}
