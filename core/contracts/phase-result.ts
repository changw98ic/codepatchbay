import type { LooseRecord } from "../../shared/types.js";
import { PhaseResult, PhaseFailure, PhaseArtifact } from "../../shared/types.js";

export function phasePassed({ phase, artifact = null, diagnostics = {} }: { phase: string; artifact?: PhaseArtifact | null; diagnostics?: LooseRecord }): PhaseResult {
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

export function phaseFailed({ phase, failure, diagnostics = {} }: { phase: string; failure: PhaseFailure; diagnostics?: LooseRecord }): PhaseResult {
  return {
    schemaVersion: 1,
    phase,
    status: "failed",
    artifact: null,
    failure,
    diagnostics,
    createdAt: new Date().toISOString(),
  };
}

export function isPhasePassed(result: { status?: unknown } | null | undefined) {
  return result?.status === "passed";
}
