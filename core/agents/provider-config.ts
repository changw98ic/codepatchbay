import type { LooseRecord } from "../../shared/types.js";
import {
  configuredProviderDescriptor,
  configuredProviderEnvironmentKeys,
  configuredProviderCredentialInputKeys,
  getConfiguredProvider,
} from "./provider-catalog.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ProviderFallbackConfig = {
  providerKey: string;
  agent: string;
  variant?: string | null;
  providerFallback?: boolean;
};

export type ProviderCapsuleConfig = {
  nativeExecutable: {
    basename: string | null;
    pathContains: string[];
    env: string | null;
    targetEnv: string | null;
    kind: "node" | "native" | null;
  } | null;
};

export type ProviderQuotaRule = {
  pattern: string;
  status: string;
  confidence: number;
  reason: string | null;
};

export type ProviderQuotaConfig = {
  region: string | null;
  timezone: string;
  policy: LooseRecord;
  rules: ProviderQuotaRule[];
} | null;

export type NormalizedProviderConfig = {
  key: string | null;
  keyTemplate: string | null;
  variant: string | null;
  variantAliases: string[];
  family: string | null;
  credentialEnv: string[];
  credentialInputs: string[];
  environment: Record<string, string[]>;
  derived: Record<string, string>;
  values: Record<string, string>;
  runtimeEnv: string[];
  required: string[];
  normalizers: Record<string, string>;
  fallbacks: ProviderFallbackConfig[];
  cliCommand: string | null;
  cliCommandEnv: string | null;
  cliArgs: string[];
  cliModelEnv: string;
  cliModelArg: string | null;
  homeAgent: string | null;
  capsule: ProviderCapsuleConfig;
  quota: ProviderQuotaConfig;
};

export type ProviderSelectionOptions = {
  variant?: string | null;
  provider?: string | null;
  model?: string | null;
};

function record(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function envName(value: unknown): string | null {
  const candidate = text(value);
  return candidate && ENV_NAME.test(candidate) ? candidate : null;
}

function envNames(value: unknown): string[] {
  return unique(stringArray(value).map(envName).filter((item): item is string => Boolean(item)));
}

function environmentMap(value: unknown): Record<string, string[]> {
  const source = record(value);
  const result: Record<string, string[]> = {};
  for (const [target, rawSources] of Object.entries(source)) {
    const targetName = envName(target);
    if (!targetName) continue;
    const sources = envNames(rawSources);
    if (sources.length > 0) result[targetName] = sources;
  }
  return result;
}

function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(source)) {
    const target = envName(key);
    const sourceName = text(rawValue);
    if (target && sourceName) result[target] = sourceName;
  }
  return result;
}

function capsuleConfig(value: unknown): ProviderCapsuleConfig {
  const capsule = record(value);
  const native = record(capsule.nativeExecutable);
  if (Object.keys(native).length === 0) return { nativeExecutable: null };
  const basename = text(native.basename);
  const pathContains = stringArray(native.pathContains);
  const env = envName(native.env);
  const targetEnv = envName(native.targetEnv);
  const kind = native.kind === "node" || native.kind === "native" ? native.kind : null;
  if (!basename || !env || !targetEnv || pathContains.length === 0 || !kind) {
    return { nativeExecutable: null };
  }
  return {
    nativeExecutable: { basename, pathContains, env, targetEnv, kind },
  };
}

function quotaConfig(value: unknown): ProviderQuotaConfig {
  const quota = record(value);
  if (Object.keys(quota).length === 0) return null;
  const policy = record(quota.policy);
  const rules = Array.isArray(quota.rules)
    ? quota.rules.flatMap((raw) => {
      const rule = record(raw);
      const pattern = text(rule.pattern);
      const status = text(rule.status);
      if (!pattern || !status) return [];
      const confidence = Number(rule.confidence);
      return [{
        pattern,
        status,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.8,
        reason: text(rule.reason),
      }];
    })
    : [];
  return {
    region: text(quota.region),
    timezone: text(quota.timezone) || "UTC",
    policy,
    rules,
  };
}

function fallbackCandidates(value: unknown): ProviderFallbackConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    const providerKey = text(item.providerKey);
    const agent = text(item.agent) || text(item.name);
    if (!providerKey || !agent) return [];
    return [{
      providerKey,
      agent,
      variant: text(item.variant),
      providerFallback: item.providerFallback !== false,
    }];
  });
}

function normalizeProviderRaw(descriptor: LooseRecord): LooseRecord {
  const provider = record(descriptor.provider);
  // The old top-level capability fields remain metadata for routing, but all
  // execution behavior is read from this one provider object. This also lets
  // user descriptors omit fields that are irrelevant to their transport.
  return provider;
}

function mergeProviderRecord(base: LooseRecord, selected: LooseRecord): LooseRecord {
  const selectedEnvironment = record(selected.environment);
  const selectedDerived = record(selected.derived);
  const selectedValues = record(selected.values);
  const selectedNormalizers = record(selected.normalizers);
  const baseEnvironment = record(base.environment);
  const baseDerived = record(base.derived);
  const baseValues = record(base.values);
  const baseNormalizers = record(base.normalizers);
  const selectedHasEnvironment = Object.keys(selectedEnvironment).length > 0;
  const selectedHasDerived = Object.keys(selectedDerived).length > 0;
  const selectedHasValues = Object.keys(selectedValues).length > 0;
  const selectedRequired = (selected as Record<string, unknown>).required;
  const baseRequired = (base as Record<string, unknown>).required;

  return {
    ...base,
    ...selected,
    // A selected global provider is a complete credential mapping when it
    // declares one. Do not leak the agent's old provider mapping into it.
    environment: selectedHasEnvironment ? selectedEnvironment : baseEnvironment,
    derived: selectedHasDerived ? selectedDerived : baseDerived,
    values: selectedHasValues ? selectedValues : baseValues,
    normalizers: Object.keys(selectedNormalizers).length > 0
      ? { ...baseNormalizers, ...selectedNormalizers }
      : baseNormalizers,
    cli: { ...record(base.cli), ...record(selected.cli) },
    capsule: selected.capsule === undefined ? base.capsule : selected.capsule,
    quota: selected.quota === undefined ? base.quota : selected.quota,
    // Undefined fields from the base descriptor must not reintroduce a
    // variant/key template after a project selected a plain provider id.
    keyTemplate: selected.keyTemplate === undefined ? null : selected.keyTemplate,
    variant: selected.variant === undefined ? null : selected.variant,
    variantAliases: selected.variantAliases === undefined ? [] : selected.variantAliases,
    required: Array.isArray(selectedRequired)
      ? selectedRequired
      : (selectedHasEnvironment
        ? Object.keys(selectedEnvironment)
        : (Array.isArray(baseRequired) ? baseRequired : [])),
  } as unknown as LooseRecord;
}

/** Apply one providers.json entry on top of an agent's transport descriptor. */
export function descriptorForProviderSelection(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined = null,
  env: Record<string, string | undefined> = process.env,
) {
  const providerId = text(provider);
  if (!providerId) return descriptor || {};
  const configured = configuredProviderDescriptor(providerId, text(model), env) as LooseRecord | null;
  if (!configured) throw new Error(`Unknown configured provider '${providerId}'`);
  const base = record(descriptor?.provider);
  const selected = mergeProviderRecord(base, configured);
  void agent;
  return { ...(descriptor || {}), provider: selected };
}

export function normalizeProviderConfigForSelection(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  selection: ProviderSelectionOptions = {},
  env: Record<string, string | undefined> = process.env,
) {
  const effective = descriptorForProviderSelection(agent, descriptor, selection.provider, selection.model, env);
  return normalizeProviderConfig(agent, effective);
}

export function providerEnvironmentKeysForSelection(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  provider: string | null | undefined = null,
  model: string | null | undefined = null,
  env: Record<string, string | undefined> = process.env,
) {
  const selected = text(provider);
  if (!selected) return providerEnvironmentKeys(normalizeProviderConfig(agent, descriptor));
  return providerEnvironmentKeys(normalizeProviderConfigForSelection(agent, descriptor, { provider: selected, model }, env));
}

export function providerCredentialInputKeysForSelection(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  provider: string | null | undefined = null,
  model: string | null | undefined = null,
  env: Record<string, string | undefined> = process.env,
) {
  const selected = text(provider);
  if (!selected) return providerCredentialInputKeys(normalizeProviderConfig(agent, descriptor));
  return providerCredentialInputKeys(normalizeProviderConfigForSelection(agent, descriptor, { provider: selected, model }, env));
}

export function providerEnvironmentKeysForAllConfiguredProviders(
  env: Record<string, string | undefined> = process.env,
) {
  return configuredProviderEnvironmentKeys(env);
}

export function providerCredentialInputKeysForAllConfiguredProviders(
  env: Record<string, string | undefined> = process.env,
) {
  return configuredProviderCredentialInputKeys(env);
}

export function configuredProviderExists(provider: string | null | undefined, env = process.env) {
  return Boolean(getConfiguredProvider(provider, env));
}

export function normalizeProviderConfig(
  agent: string,
  descriptor: LooseRecord | null | undefined,
): NormalizedProviderConfig {
  const source = descriptor || {};
  const provider = normalizeProviderRaw(source);
  const cli = record(provider.cli);
  const environment = environmentMap(provider.environment);
  const derived = stringMap(provider.derived);
  const values: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record(provider.values))) {
    const key = envName(rawKey);
    if (key && typeof rawValue === "string") values[key] = rawValue;
  }
  const runtimeEnv = envNames(provider.runtimeEnv);
  const cliCommandEnv = envName(cli.commandEnv);
  const credentialEnv = unique([
    ...envNames(provider.credentialEnv),
    ...envNames(Object.values(environment).flat()),
    ...envNames(Object.keys(environment)),
    ...envNames(Object.keys(derived)),
    ...envNames(Object.values(derived)),
    ...envNames(Object.keys(values)),
    ...runtimeEnv,
    ...envNames(cli.commandEnv),
    ...envNames(cli.modelEnv),
  ]);
  const credentialInputs = unique([
    ...envNames(provider.credentialEnv),
    ...envNames(Object.values(environment).flat()),
  ]).filter((key) => key !== cliCommandEnv);
  const required = envNames(provider.required || provider.requiredEnv);
  const normalizers = Object.fromEntries(
    Object.entries(record(provider.normalizers))
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => [key, String(value).trim()]),
  );
  const key = text(provider.key) || text(source.providerKey);
  const keyTemplate = text(provider.keyTemplate);
  const variant = text(provider.variant) || text(source.providerVariant);
  const variantAliases = unique(stringArray(provider.variantAliases).map((item) => item.toLowerCase()));
  const family = text(provider.family) || text(source.providerFamily);
  const cliArgs = stringArray(cli.args);
  const cliCommand = text(cli.command);
  const cliModelEnv = envName(cli.modelEnv) || "ANTHROPIC_MODEL";
  const cliModelArg = cli.modelArg === null ? null : text(cli.modelArg) || "--model";

  // `agent` is deliberately consumed here so malformed custom descriptors
  // cannot produce an unbound provider config. The normalized object keeps the
  // name out of the data contract; callers already own the agent identity.
  void agent;
  return {
    key,
    keyTemplate,
    variant,
    variantAliases,
    family,
    credentialEnv,
    credentialInputs,
    environment,
    derived,
    values,
    runtimeEnv,
    required,
    normalizers,
    fallbacks: fallbackCandidates(provider.fallbacks),
    cliCommand,
    cliCommandEnv,
    cliArgs,
    cliModelEnv,
    cliModelArg,
    homeAgent: text(provider.homeAgent),
    capsule: capsuleConfig(provider.capsule),
    quota: quotaConfig(provider.quota),
  };
}

export function providerEnvironmentKeys(config: NormalizedProviderConfig): Set<string> {
  return new Set(config.credentialEnv);
}

export function providerCredentialInputKeys(config: NormalizedProviderConfig): Set<string> {
  return new Set(config.credentialInputs);
}

function interpolate(value: string, context: { agent: string; variant: string | null; providerKey: string; model?: string | null }) {
  return value
    .replaceAll("${agent}", context.agent)
    .replaceAll("${variant}", context.variant || "")
    .replaceAll("${providerKey}", context.providerKey)
    .replaceAll("${model}", context.model || "");
}

export function providerVariantForDescriptor(
  descriptor: LooseRecord | null | undefined,
  variant: string | null | undefined = null,
) {
  const config = normalizeProviderConfig("", descriptor);
  const requested = text(variant);
  if (!requested) return config.variant;
  if (config.variant && (requested === config.variant || config.variantAliases.includes(requested.toLowerCase()))) {
    return config.variant;
  }
  return requested;
}

/**
 * Read a selected provider variant from the generic environment contract.
 * The agent-specific key is generated from the descriptor name; the remaining
 * names are retained only as compatibility inputs for older CPB launchers.
 */
export function providerVariantFromEnvironment(
  agent: string,
  env: Record<string, string | undefined> = {},
  explicit: string | null | undefined = null,
) {
  const agentEnvName = String(agent || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const candidates = [
    explicit,
    env.CPB_PROVIDER_VARIANT,
    env.CPB_ACP_AGENT_VARIANT,
    agentEnvName ? env[`CPB_ACP_${agentEnvName}_VARIANT`] : undefined,
    env.CPB_CLAUDE_VARIANT,
    env.CPB_BUILDER_VARIANT,
    env.CPB_ACP_CLAUDE_VARIANT,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || null;
}

export function providerKeyForDescriptor(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  variant: string | null | undefined = null,
) {
  const config = normalizeProviderConfig(agent, descriptor);
  const resolvedVariant = providerVariantForDescriptor(descriptor, variant);
  const base = config.key || agent;
  if (config.keyTemplate) {
    return interpolate(config.keyTemplate, {
      agent,
      variant: resolvedVariant,
      providerKey: base,
    });
  }
  return base;
}

export function providerKeyForSelection(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  provider: string | null | undefined = null,
  variant: string | null | undefined = null,
  model: string | null | undefined = null,
  env: Record<string, string | undefined> = process.env,
) {
  const selected = text(provider);
  if (!selected) return providerKeyForDescriptor(agent, descriptor, variant);
  const effective = descriptorForProviderSelection(agent, descriptor, selected, model, env);
  return providerKeyForDescriptor(agent, effective, variant);
}

export function providerVariantFromKey(
  agent: string,
  descriptor: LooseRecord | null | undefined,
  providerKey: string,
) {
  const config = normalizeProviderConfig(agent, descriptor);
  if (config.keyTemplate && config.keyTemplate.includes("${variant}")) {
    const prefix = config.keyTemplate.split("${variant}", 1)[0];
    const suffix = config.keyTemplate.split("${variant}", 2)[1] || "";
    if (providerKey.startsWith(prefix) && providerKey.endsWith(suffix)) {
      const end = suffix ? providerKey.length - suffix.length : providerKey.length;
      return providerKey.slice(prefix.length, end) || null;
    }
  }
  if (config.key === providerKey) return config.variant;
  const prefix = `${agent}:`;
  return providerKey.startsWith(prefix) ? providerKey.slice(prefix.length) || null : null;
}

function normalizeValue(value: string, normalizer: string | undefined) {
  switch (normalizer) {
    case "strip-trailing-bracket-suffix":
    case "model":
      return value.replace(/\[[^\]]+\]$/, "");
    case "trim":
      return value.trim();
    case undefined:
    case "":
      return value;
    default:
      throw new Error(`unknown provider environment normalizer: ${normalizer}`);
  }
}

export function applyProviderEnvironment(
  env: Record<string, string | undefined>,
  agent: string,
  descriptor: LooseRecord | null | undefined,
  options: ProviderSelectionOptions = {},
) {
  const selectedProvider = text(options.provider) || text(env.CPB_PROVIDER) || text(env.CPB_PROVIDER_ID);
  const selectedModel = text(options.model) || text(env.CPB_MODEL) || text(env.CPB_MODEL_NAME);
  const effectiveDescriptor = descriptorForProviderSelection(
    agent,
    descriptor,
    selectedProvider,
    selectedModel,
    env,
  );
  const config = normalizeProviderConfig(agent, effectiveDescriptor);
  const variant = providerVariantForDescriptor(effectiveDescriptor, options.variant);
  const providerKey = providerKeyForDescriptor(agent, effectiveDescriptor, variant);
  const context = { agent, variant, providerKey, model: selectedModel };

  for (const [target, sources] of Object.entries(config.environment)) {
    const source = sources.find((name) => typeof env[name] === "string" && env[name]);
    if (!source) continue;
    env[target] = normalizeValue(String(env[source]), config.normalizers[target]);
  }
  for (const [target, source] of Object.entries(config.derived)) {
    if (typeof env[source] !== "string" || !env[source]) continue;
    env[target] = normalizeValue(String(env[source]), config.normalizers[target]);
  }
  for (const [target, rawValue] of Object.entries(config.values)) {
    env[target] = interpolate(rawValue, context);
  }
  // A project may pin a model without changing the transport provider. The
  // CLI model variable is the canonical target for that agent descriptor.
  if (selectedModel && (selectedProvider || Object.keys(record(record(effectiveDescriptor.provider).cli)).length > 0)) {
    env[config.cliModelEnv] = selectedModel;
  }

  for (const required of config.required) {
    if (typeof env[required] !== "string" || !env[required]) {
      throw new Error(`Missing configured provider environment '${required}' for agent '${agent}'`);
    }
  }

  const resolvedEnvironment: Record<string, string> = {};
  for (const target of new Set([
    ...Object.keys(config.environment),
    ...Object.keys(config.derived),
    ...Object.keys(config.values),
  ])) {
    if (typeof env[target] === "string") resolvedEnvironment[target] = env[target] as string;
  }

  return {
    ...config,
    agent,
    providerKey,
    variant,
    provider: selectedProvider,
    model: selectedModel,
    resolvedEnvironment,
  };
}

export function providerFallbacksFromDescriptor(
  agent: string,
  descriptor: LooseRecord | null | undefined,
) {
  const config = normalizeProviderConfig(agent, descriptor);
  const key = providerKeyForDescriptor(agent, descriptor);
  return config.fallbacks.map((candidate) => ({
    ...candidate,
    providerKey: candidate.providerKey || key,
  }));
}

export function isValidProviderConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provider = value as LooseRecord;
  for (const key of ["key", "keyTemplate", "variant", "family", "homeAgent"] as const) {
    if (provider[key] !== undefined && provider[key] !== null && typeof provider[key] !== "string") return false;
  }
  if (provider.credentialEnv !== undefined && !envNames(provider.credentialEnv).length && stringArray(provider.credentialEnv).length > 0) return false;
  if (provider.variantAliases !== undefined && !Array.isArray(provider.variantAliases)) return false;
  if (provider.runtimeEnv !== undefined && !Array.isArray(provider.runtimeEnv)) return false;
  for (const key of ["environment", "derived", "values", "normalizers"] as const) {
    if (provider[key] !== undefined && (!provider[key] || typeof provider[key] !== "object" || Array.isArray(provider[key]))) return false;
  }
  if (provider.required !== undefined && !Array.isArray(provider.required)) return false;
  if (provider.requiredEnv !== undefined && !Array.isArray(provider.requiredEnv)) return false;
  if (provider.fallbacks !== undefined && !Array.isArray(provider.fallbacks)) return false;
  if (provider.cli !== undefined && (!provider.cli || typeof provider.cli !== "object" || Array.isArray(provider.cli))) return false;
  if (provider.capsule !== undefined && (!provider.capsule || typeof provider.capsule !== "object" || Array.isArray(provider.capsule))) return false;
  if (provider.quota !== undefined && (!provider.quota || typeof provider.quota !== "object" || Array.isArray(provider.quota))) return false;
  return true;
}
