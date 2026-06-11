export function phasePassed({ phase, artifact = null, diagnostics = {} }: { phase: string; artifact?: unknown; diagnostics?: Record<string, unknown> }) {
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

export function phaseFailed({ phase, failure, diagnostics = {} }: { phase: string; failure: unknown; diagnostics?: Record<string, unknown> }) {
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

export function isPhasePassed(result: { status?: string } | null | undefined) {
  return result?.status === "passed";
}
