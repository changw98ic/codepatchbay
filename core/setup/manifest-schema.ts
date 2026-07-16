import { recordValue, type LooseRecord } from "../../shared/types.js";
function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function pushStringError(errors: string[], manifest: LooseRecord, key: string) {
  if (!isNonEmptyString(manifest?.[key])) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function validateMethodEntry(errors: string[], prefix: string, config: unknown) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const entry = recordValue(config);
  if (!isNonEmptyString(entry.label)) {
    errors.push(`${prefix}.label must be a non-empty string`);
  }
  if (!isNonEmptyString(entry.command)) {
    errors.push(`${prefix}.command must be a non-empty string`);
  }
  if (entry.sourceUrl !== undefined && !isNonEmptyString(entry.sourceUrl)) {
    errors.push(`${prefix}.sourceUrl must be a non-empty string when present`);
  }
  if (entry.notes !== undefined && !isStringArray(entry.notes)) {
    errors.push(`${prefix}.notes must be a non-empty string array when present`);
  }
}

function validateInstall(errors: string[], install: unknown) {
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    errors.push("install must be an object with at least one method");
    return;
  }

  const entries = Object.entries(recordValue(install));
  if (entries.length === 0) {
    errors.push("install must define at least one method");
    return;
  }

  for (const [method, config] of entries) {
    const entry = recordValue(config);
    validateMethodEntry(errors, `install.${method}`, config);
    if (entry.pinnedCommandTemplate !== undefined && !isNonEmptyString(entry.pinnedCommandTemplate)) {
      errors.push(`install.${method}.pinnedCommandTemplate must be a non-empty string when present`);
    }
  }
}

function validateUpgrade(errors: string[], upgrade: unknown) {
  if (upgrade === undefined) return;
  if (!upgrade || typeof upgrade !== "object" || Array.isArray(upgrade)) {
    errors.push("upgrade must be an object when present");
    return;
  }
  for (const [method, config] of Object.entries(recordValue(upgrade))) {
    validateMethodEntry(errors, `upgrade.${method}`, config);
  }
}

export function validateSetupAgentManifest(manifest: LooseRecord) {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  for (const key of ["id", "displayName", "binary", "sourceUrl"]) {
    pushStringError(errors, manifest, key);
  }
  if (!isStringArray(manifest.roles)) {
    errors.push("roles must be a non-empty string array");
  }
  if (!isStringArray(manifest.capabilities)) {
    errors.push("capabilities must be a non-empty string array");
  }
  validateInstall(errors, manifest.install);
  validateUpgrade(errors, manifest.upgrade);

  // Optional adapter field validation
  if (manifest.adapter !== undefined) {
    if (!manifest.adapter || typeof manifest.adapter !== "object" || Array.isArray(manifest.adapter)) {
      errors.push("adapter must be an object when present");
    } else {
      const adapter = recordValue(manifest.adapter);
      const validProtocols = new Set(["acp", "cli", "unknown"]);
      if (!validProtocols.has(String(adapter.protocol))) {
        errors.push("adapter.protocol must be one of: acp, cli, unknown");
      }
      if (typeof adapter.command !== "string" || !adapter.command.trim()) {
        errors.push("adapter.command must be a non-empty string");
      }
      if (adapter.npxPkg !== undefined && typeof adapter.npxPkg !== "string") {
        errors.push("adapter.npxPkg must be a string when present");
      }
      if (adapter.args !== undefined && !Array.isArray(adapter.args)) {
        errors.push("adapter.args must be an array when present");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidSetupAgentManifest(manifest: LooseRecord) {
  const result = validateSetupAgentManifest(manifest);
  if (!result.valid) {
    const id = manifest?.id || "<unknown>";
    throw new Error(`Invalid setup agent manifest '${id}': ${result.errors.join("; ")}`);
  }
  return manifest;
}

export function assertValidSetupAgentCatalog(agents: LooseRecord[]) {
  if (!Array.isArray(agents)) {
    throw new Error("Setup agent catalog must be an array");
  }
  for (const agent of agents) {
    assertValidSetupAgentManifest(agent);
  }
  return agents;
}
