function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function pushStringError(errors, manifest, key) {
  if (!isNonEmptyString(manifest?.[key])) {
    errors.push(`${key} must be a non-empty string`);
  }
}

function validateInstall(errors, install) {
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    errors.push("install must be an object with at least one method");
    return;
  }

  const entries = Object.entries(install);
  if (entries.length === 0) {
    errors.push("install must define at least one method");
    return;
  }

  for (const [method, config] of entries) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      errors.push(`install.${method} must be an object`);
      continue;
    }
    if (!isNonEmptyString(config.label)) {
      errors.push(`install.${method}.label must be a non-empty string`);
    }
    if (!isNonEmptyString(config.command)) {
      errors.push(`install.${method}.command must be a non-empty string`);
    }
    if (!isNonEmptyString(config.sourceUrl)) {
      errors.push(`install.${method}.sourceUrl must be a non-empty string`);
    }
    if (config.notes !== undefined && !isStringArray(config.notes)) {
      errors.push(`install.${method}.notes must be a non-empty string array when present`);
    }
  }
}

export function validateSetupAgentManifest(manifest) {
  const errors = [];
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

  return { valid: errors.length === 0, errors };
}

export function assertValidSetupAgentManifest(manifest) {
  const result = validateSetupAgentManifest(manifest);
  if (!result.valid) {
    const id = manifest?.id || "<unknown>";
    throw new Error(`Invalid setup agent manifest '${id}': ${result.errors.join("; ")}`);
  }
  return manifest;
}

export function assertValidSetupAgentCatalog(agents) {
  if (!Array.isArray(agents)) {
    throw new Error("Setup agent catalog must be an array");
  }
  for (const agent of agents) {
    assertValidSetupAgentManifest(agent);
  }
  return agents;
}
