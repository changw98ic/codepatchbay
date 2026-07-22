import type { LooseRecord } from "../../shared/types.js";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function envFirst(env: LooseRecord, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = env[name];
    if (typeof val === "string" && val) return val;
  }
  return undefined;
}

function normalizeVariant(requested: unknown): string {
  return (typeof requested === "string" ? requested : "").trim().toLowerCase();
}

function normalizeProviderModel(value: unknown): string {
  return stringValue(value).replace(/\[[^\]]+\]$/, "");
}

function resolveVariant(env: LooseRecord = process.env): string {
  const requested =
    env.CPB_CLAUDE_VARIANT ||
    env.CPB_BUILDER_VARIANT ||
    env.CPB_ACP_CLAUDE_VARIANT ||
    "";

  if (requested) return normalizeVariant(requested);

  return "none";
}

function applyXiaomi(env: LooseRecord = process.env): LooseRecord {
  const variant = "mimo-v2.5pro";
  const baseUrl = envFirst(env, "XIAOMI_BASE_URL", "MIMO_BASE_URL");
  const authToken = envFirst(env, "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN", "MIMO_API_KEY", "MIMO_AUTH_TOKEN");
  const model = normalizeProviderModel(envFirst(env, "XIAOMI_MODEL", "MIMO_MODEL") || "mimo-v2.5-pro");

  if (!baseUrl || !authToken) {
    throw new Error(`Missing base URL or API key for variant '${variant}'. Set XIAOMI_BASE_URL + XIAOMI_API_KEY (or MIMO_BASE_URL + MIMO_API_KEY).`);
  }

  return { variant, displayName: "MiMo v2.5 Pro", baseUrl, authToken, model };
}

function applyZhipu(env: LooseRecord = process.env): LooseRecord {
  const variant = "glm";
  const baseUrl = envFirst(env, "ZHIPU_BASE_URL", "GLM_BASE_URL");
  const authToken = envFirst(env, "ZHIPU_API_KEY", "ZHIPU_AUTH_TOKEN", "GLM_API_KEY", "GLM_AUTH_TOKEN");
  const model = normalizeProviderModel(envFirst(env, "ZHIPU_MODEL", "GLM_MODEL"));

  if (!baseUrl || !authToken || !model) {
    throw new Error(`Missing base URL, API key, or model for variant '${variant}'. Set ZHIPU_BASE_URL + ZHIPU_API_KEY + ZHIPU_MODEL (or GLM_BASE_URL + GLM_API_KEY + GLM_MODEL).`);
  }

  return { variant, displayName: "GLM", baseUrl, authToken, model };
}

function resolveConfig(env: LooseRecord = process.env): LooseRecord {
  const normalized = resolveVariant(env);

  switch (normalized) {
    case "none":
    case "off":
    case "default":
    case "anthropic":
    case "claude":
      return { variant: "none" };

    case "xiaomi":
    case "mimo":
    case "mimo-v2.5pro":
      return applyXiaomi(env);

    case "zhipu":
    case "glm":
    case "glm-compatible":
      return applyZhipu(env);

    default:
      throw new Error(`Unknown Claude variant: '${normalized}'. Use mimo-v2.5pro, glm, or none.`);
  }
}

export function resolveVariantConfig(env: LooseRecord = process.env): LooseRecord {
  return resolveConfig(env);
}

export function applyVariantToEnv(env: LooseRecord = process.env, opts: LooseRecord = {}): LooseRecord {
  if (opts.variant) {
    env.CPB_CLAUDE_VARIANT = stringValue(opts.variant);
  }
  const config = resolveConfig(env);

  if (config.variant === "none") {
    env.CPB_ACTIVE_CLAUDE_VARIANT = "none";
    return config;
  }

  const variant = stringValue(config.variant);
  const displayName = stringValue(config.displayName);
  const baseUrl = stringValue(config.baseUrl);
  const authToken = stringValue(config.authToken);
  const model = stringValue(config.model);

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = authToken;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = model;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = displayName;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `CodePatchbay provider variant: ${variant}`;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CPB_ACTIVE_CLAUDE_VARIANT = variant;

  return config;
}

export function applyVariant(opts: LooseRecord = {}) {
  return applyVariantToEnv(process.env, opts);
}
