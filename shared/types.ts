export type AnyRecord = Record<string, any>;

/**
 * Canonical phase-execution result. Consolidates the local `type PhaseResult`
 * definitions that were scattered across core/engine (run-phase as the source
 * of truth via phasePassed/phaseFailed, plus provider-quota-fallback /
 * phase-retry / dag-node-failure / poisoned-session-gate / phase-result-events
 * / adversarial-verdict-events / runtime-artifact-events). Shape is based on
 * what phasePassed/phaseFailed return (core/contracts/phase-result.ts) plus
 * the failure fields read by quota-fallback / retry consumers. Event helpers
 * may still narrow locally for their own field access; this type is the
 * cross-file contract for runPhase signatures.
 */
export type PhaseFailure = {
  kind?: string;
  reason?: string;
  retryable?: boolean;
  cause?: unknown;
  code?: string;
  [key: string]: unknown;
};

export type PhaseResult = {
  schemaVersion?: number;
  phase?: string;
  status?: string;
  artifact?: unknown;
  failure?: PhaseFailure | null;
  diagnostics?: Record<string, unknown>;
  createdAt?: string;
  [key: string]: unknown;
};
