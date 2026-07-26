import { phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure, isValidFailureKind } from "../contracts/failure.js";
import type { PhaseResult } from "../../shared/types.js";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";
export type PhaseContext = LooseRecord & {
  phase: string;
  pool?: LooseRecord | null;
  sourcePath?: string;
  cwd?: string;
  cpbRoot?: string;
};
type PhaseAdapter = (ctx: PhaseContext) => Promise<unknown> | unknown;
type PhaseAdapterRegistration = {
  exportName: string;
};
type PhaseAdapterContractCode =
  | "PHASE_ADAPTER_IDENTIFIER_INVALID"
  | "PHASE_ADAPTER_LOAD_FAILED"
  | "PHASE_ADAPTER_EXPORT_INVALID"
  | "PHASE_RESULT_INVALID";

const PHASE_ADAPTER_REGISTRY = {
  plan: { exportName: "runPlan" },
  execute: { exportName: "runExecute" },
  review: { exportName: "runReview" },
  verify: { exportName: "runVerify" },
  remediate: { exportName: "runRemediate" },
  adversarial_verify: { exportName: "runAdversarialVerify" },
} satisfies Record<string, PhaseAdapterRegistration>;

type CanonicalPhase = keyof typeof PHASE_ADAPTER_REGISTRY;

const ADAPTER_CACHE = new Map<string, PhaseAdapter>();
const PHASE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;

class PhaseAdapterContractError extends Error {
  readonly code: PhaseAdapterContractCode;

  constructor(code: PhaseAdapterContractCode, message: string) {
    super(message);
    this.name = "PhaseAdapterContractError";
    this.code = code;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isAbortError(value: unknown) {
  const errorRecord = recordValue(value);
  return stringValue(errorRecord.name) === "AbortError"
    || stringValue(errorRecord.code) === "ABORT_ERR";
}

function isRateLimitError(errorRecord: LooseRecord, reason: string) {
  return stringValue(errorRecord.name) === "RateLimitError"
    || stringValue(errorRecord.status) === "rate_limited"
    || stringValue(errorRecord.code) === "RATE_LIMITED"
    || /\b429\b|\brate[-_ ]?limit/i.test(reason);
}

function isProviderTransportError(errorRecord: LooseRecord, reason: string) {
  const code = stringValue(errorRecord.code);
  return code === "EPIPE"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || /stream disconnected|transport.*disconnect|error sending request|socket hang up|connection reset/i.test(reason);
}

function phaseExportName(phase: string) {
  const pascal = phase
    .split(/[_-]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `run${pascal}`;
}

function adapterRegistration(phase: string): {
  phase: string;
  registration: PhaseAdapterRegistration;
} {
  if (Object.prototype.hasOwnProperty.call(PHASE_ADAPTER_REGISTRY, phase)) {
    const canonicalPhase = phase as CanonicalPhase;
    return {
      phase: canonicalPhase,
      registration: PHASE_ADAPTER_REGISTRY[canonicalPhase],
    };
  }
  if (!PHASE_IDENTIFIER.test(phase)) {
    throw new PhaseAdapterContractError(
      "PHASE_ADAPTER_IDENTIFIER_INVALID",
      `phase adapter identifier is invalid: "${phase || "<empty>"}"`,
    );
  }
  return {
    phase,
    registration: {
      exportName: phaseExportName(phase),
    },
  };
}

export function resolvePhaseAdapterExport(phase: string, moduleValue: unknown): PhaseAdapter {
  const { registration } = adapterRegistration(phase);
  const candidate = isRecord(moduleValue) ? moduleValue[registration.exportName] : undefined;
  if (typeof candidate !== "function") {
    throw new PhaseAdapterContractError(
      "PHASE_ADAPTER_EXPORT_INVALID",
      `phase adapter "${phase}" must export callable ${registration.exportName}`,
    );
  }
  return (ctx) => Reflect.apply(candidate, undefined, [ctx]);
}

function invalidPhaseResult(phase: string, detail: string): never {
  throw new PhaseAdapterContractError(
    "PHASE_RESULT_INVALID",
    `phase adapter "${phase}" returned an invalid PhaseResult: ${detail}`,
  );
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function validatePhaseResult(phase: string, value: unknown): PhaseResult {
  if (!isRecord(value)) invalidPhaseResult(phase, "result must be an object");
  if (value.schemaVersion !== 1) invalidPhaseResult(phase, "schemaVersion must equal 1");
  if (value.phase !== phase) {
    invalidPhaseResult(phase, `expected phase "${phase}", received "${stringValue(value.phase) || "<missing>"}"`);
  }
  if (value.status !== "passed" && value.status !== "failed") {
    invalidPhaseResult(phase, 'status must be "passed" or "failed"');
  }
  if (!isRecord(value.diagnostics)) invalidPhaseResult(phase, "diagnostics must be an object");
  if (value.createdAt !== undefined
    && (typeof value.createdAt !== "string" || !value.createdAt || Number.isNaN(Date.parse(value.createdAt)))) {
    invalidPhaseResult(phase, "createdAt must be a valid timestamp string");
  }
  if (value.artifact !== null && !isRecord(value.artifact)) {
    invalidPhaseResult(phase, "artifact must be an object or null");
  }
  if (isRecord(value.artifact)) {
    for (const field of ["id", "kind", "name", "path"] as const) {
      if (!isNullableString(value.artifact[field])) {
        invalidPhaseResult(phase, `artifact.${field} must be a string or null when present`);
      }
    }
  }

  if (value.status === "passed") {
    if (value.failure !== null) invalidPhaseResult(phase, "passed result must have failure=null");
  } else {
    if (value.artifact !== null) invalidPhaseResult(phase, "failed result must have artifact=null");
    if (!isRecord(value.failure)) invalidPhaseResult(phase, "failed result must include a failure object");
    if (!isValidFailureKind(value.failure.kind)) {
      invalidPhaseResult(phase, "failure.kind must be a canonical FailureKind");
    }
    if (typeof value.failure.reason !== "string") {
      invalidPhaseResult(phase, "failure.reason must be a string");
    }
    if (typeof value.failure.retryable !== "boolean") {
      invalidPhaseResult(phase, "failure.retryable must be a boolean");
    }
  }

  // Every PhaseResult field used by engine state is checked above at the
  // adapter boundary; retain any additional phase-specific diagnostics.
  return {
    ...value,
    createdAt: value.createdAt ?? new Date().toISOString(),
  } as PhaseResult;
}

async function loadAdapter(phase: string): Promise<PhaseAdapter> {
  const { phase: validatedPhase, registration } = adapterRegistration(phase);
  const cached = ADAPTER_CACHE.get(validatedPhase);
  if (cached) return cached;

  let moduleValue: unknown;
  try {
    // Keep the import target dynamic after validating the identifier. Literal
    // imports make every phase implementation part of the strict engine type
    // boundary even though this module intentionally treats adapters as wire
    // contracts and validates their named export at runtime.
    moduleValue = await import(`../phases/${validatedPhase}.js`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PhaseAdapterContractError(
      "PHASE_ADAPTER_LOAD_FAILED",
      `failed to load phase adapter "${phase}": ${reason}`,
    );
  }
  const adapter = resolvePhaseAdapterExport(validatedPhase, moduleValue);
  ADAPTER_CACHE.set(validatedPhase, adapter);
  return adapter;
}

export async function runPhase(ctx: PhaseContext): Promise<PhaseResult> {
  try {
    const adapter = await loadAdapter(ctx.phase);
    const result = await adapter(ctx);
    return validatePhaseResult(ctx.phase, result);
  } catch (err) {
    const errorRecord = recordValue(err);
    const errorCode = stringValue(errorRecord.code);
    const errorName = stringValue(errorRecord.name);
    // Re-throw PoolExhaustedError so callers (managed-worker) can detect it
    if (errorCode === "POOL_EXHAUSTED" || errorName === "PoolExhaustedError") throw err;
    const reason = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (isAbortError(err)) {
      return phaseFailed({
        phase: ctx.phase,
        failure: failure({
          kind: FailureKind.RUNTIME_INTERRUPTED,
          phase: ctx.phase,
          reason,
          retryable: false,
          cause: { code: errorCode || null, stack },
        }),
      });
    }
    if (isRateLimitError(errorRecord, reason)) {
      return phaseFailed({
        phase: ctx.phase,
        failure: failure({
          kind: FailureKind.AGENT_RATE_LIMITED,
          phase: ctx.phase,
          reason,
          retryable: true,
          cause: {
            code: errorCode || null,
            providerKey: stringValue(errorRecord.providerKey) || null,
            status: stringValue(errorRecord.status) || "rate_limited",
            nextEligibleAt: typeof errorRecord.nextEligibleAt === "number" ? errorRecord.nextEligibleAt : null,
            confidence: typeof errorRecord.confidence === "number" ? errorRecord.confidence : null,
          },
        }),
      });
    }
    if (isProviderTransportError(errorRecord, reason)) {
      return phaseFailed({
        phase: ctx.phase,
        failure: failure({
          kind: FailureKind.AGENT_UNAVAILABLE,
          phase: ctx.phase,
          reason,
          retryable: true,
          cause: {
            code: errorCode || null,
            providerKey: stringValue(errorRecord.providerKey) || null,
            status: "transport_failure",
          },
        }),
        diagnostics: { transportFailure: true },
      });
    }
    const diagnostics = err instanceof PhaseAdapterContractError
      ? {
          phaseAdapterContract: {
            code: err.code,
            phase: ctx.phase,
            boundary: "phase-adapter",
          },
        }
      : {};
    return phaseFailed({
      phase: ctx.phase,
      failure: failure({
        kind: FailureKind.UNKNOWN,
        phase: ctx.phase,
        reason,
        retryable: false,
        cause: { stack },
      }),
      diagnostics,
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
