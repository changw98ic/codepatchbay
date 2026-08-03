import {
  captureProcessIdentity,
  type ProcessIdentity,
} from "./process-tree.js";

export type ProcessIdentityMode = "required" | "fenced";

export const PROCESS_IDENTITY_MODE_ENV = "CPB_PROCESS_IDENTITY_MODE";

function capabilityError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

export function resolveProcessIdentityMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProcessIdentityMode {
  const value = String(env[PROCESS_IDENTITY_MODE_ENV] || "required").trim().toLowerCase();
  if (value === "required" || value === "fenced") return value;
  throw capabilityError(
    `${PROCESS_IDENTITY_MODE_ENV} must be 'required' or 'fenced', received ${JSON.stringify(value)}`,
    "PROCESS_IDENTITY_MODE_INVALID",
  );
}

export type ProcessIdentityCapability = {
  ok: boolean;
  mode: ProcessIdentityMode;
  identityAvailable: boolean;
  staleOwnerRecovery: boolean;
  reason: string | null;
};

export function inspectProcessIdentityCapability({
  mode = resolveProcessIdentityMode(),
  pid = process.pid,
  captureIdentity = (candidatePid: number) => captureProcessIdentity(candidatePid, { strict: true }),
}: {
  mode?: ProcessIdentityMode;
  pid?: number;
  captureIdentity?: (pid: number) => ProcessIdentity | null;
} = {}): ProcessIdentityCapability {
  let identity: ProcessIdentity | null = null;
  try {
    identity = captureIdentity(pid);
  } catch {
    identity = null;
  }

  const identityAvailable = Boolean(identity && identity.birthIdPrecision === "exact");
  if (identityAvailable) {
    return {
      ok: true,
      mode,
      identityAvailable: true,
      staleOwnerRecovery: true,
      reason: null,
    };
  }
  if (mode === "fenced") {
    return {
      ok: true,
      mode,
      identityAvailable: false,
      staleOwnerRecovery: false,
      reason: "exact process identity unavailable; stale lock recovery disabled",
    };
  }
  return {
    ok: false,
    mode,
    identityAvailable: false,
    staleOwnerRecovery: false,
    reason: "exact process identity unavailable",
  };
}

export function captureLockProcessIdentity({
  mode = resolveProcessIdentityMode(),
  captureIdentity = () => captureProcessIdentity(process.pid, { strict: true }),
}: {
  mode?: ProcessIdentityMode;
  captureIdentity?: () => ProcessIdentity | null;
} = {}): ProcessIdentity | null {
  try {
    const identity = captureIdentity();
    if (identity?.birthIdPrecision === "exact") return identity;
  } catch (error) {
    if (mode === "required") throw error;
  }
  if (mode === "required") {
    throw capabilityError(
      "exact process identity unavailable for lock ownership",
      "PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  return null;
}
