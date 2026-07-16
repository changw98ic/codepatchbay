import path from "node:path";

import { isRecord } from "../contracts/types.js";

export const TRUSTED_PROBE_POLICY_PATH = ".cpb/verification-probes.json";

export type TrustedProbeSpec = {
  predicateId: string;
  executable: string;
  args: string[];
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function trustedProbeSpec(value: unknown): TrustedProbeSpec | null {
  if (!isRecord(value)) return null;
  const predicateId = text(value.predicateId);
  const executable = text(value.executable);
  const args = Array.isArray(value.args) ? value.args : null;
  if (!predicateId || !executable || !args || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) return null;
  if (executable.includes("\0")) return null;

  const basename = path.basename(executable).toLowerCase();
  const shellNames = new Set(["sh", "bash", "dash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
  if (shellNames.has(basename) && args.some((arg) => ["-c", "/c", "-command", "-encodedcommand"].includes(String(arg).toLowerCase()))) {
    return null;
  }
  return { predicateId, executable, args: args.map(String) };
}

/** Parse the complete maintainer-owned policy fail-closed. */
export function parseTrustedProbePolicy(value: unknown): Map<string, TrustedProbeSpec> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.probes)) return new Map();
  const probes = value.probes as unknown[];
  const specs = probes.map(trustedProbeSpec).filter((entry): entry is TrustedProbeSpec => Boolean(entry));
  if (specs.length !== probes.length) return new Map();
  const policy = new Map<string, TrustedProbeSpec>();
  for (const spec of specs) {
    if (policy.has(spec.predicateId)) return new Map();
    policy.set(spec.predicateId, spec);
  }
  return policy;
}

export function trustedProbePredicateIds(value: unknown) {
  return new Set(parseTrustedProbePolicy(value).keys());
}
