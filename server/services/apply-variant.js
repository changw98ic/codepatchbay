#!/usr/bin/env node
// apply-variant.mjs — Claude provider variant overlay (shared between Node and shell)
//
// Node usage:
//   import { applyVariant } from "./apply-variant.mjs";
//   applyVariant(); // modifies process.env in-place
//
// Shell usage:
//   eval "$(node server/services/apply-variant.js --export)"

function envFirst(env, ...names) {
  for (const name of names) {
    const val = env[name];
    if (val) return val;
  }
  return undefined;
}

function normalizeVariant(requested) {
  return (requested || "").trim().toLowerCase();
}

function resolveVariant(env = process.env) {
  const requested =
    env.CPB_CLAUDE_VARIANT ||
    env.CPB_BUILDER_VARIANT ||
    env.CPB_ACP_CLAUDE_VARIANT ||
    "";

  if (requested) return normalizeVariant(requested);

  return "none";
}

function applyXiaomi(env = process.env) {
  const variant = "mimo-v2.5pro";
  const baseUrl = envFirst(env, "XIAOMI_BASE_URL", "MIMO_BASE_URL");
  const authToken = envFirst(env, "XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN", "MIMO_API_KEY", "MIMO_AUTH_TOKEN");
  const model = envFirst(env, "XIAOMI_MODEL", "MIMO_MODEL") || "mimo-v2.5pro";

  if (!baseUrl || !authToken) {
    throw new Error(`Missing base URL or API key for variant '${variant}'. Set XIAOMI_BASE_URL + XIAOMI_API_KEY (or MIMO_BASE_URL + MIMO_API_KEY).`);
  }

  return { variant, displayName: "MiMo v2.5 Pro", baseUrl, authToken, model };
}

function resolveConfig(env = process.env) {
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

    default:
      throw new Error(`Unknown Claude variant: '${normalized}'. Use mimo-v2.5pro, or none.`);
  }
}

export function resolveVariantConfig(env = process.env) {
  return resolveConfig(env);
}

/**
 * Apply the Claude provider variant overlay to process.env.
 * @param {object} [opts]
 * @param {string} [opts.variant] - Override variant name
 * @returns {object} Resolved config
 */
export function applyVariantToEnv(env = process.env, opts = {}) {
  if (opts.variant) {
    env.CPB_CLAUDE_VARIANT = opts.variant;
  }
  const config = resolveConfig(env);

  if (config.variant === "none") {
    env.CPB_ACTIVE_CLAUDE_VARIANT = "none";
    return config;
  }

  const { variant, displayName, baseUrl, authToken, model } = config;

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
  env.CPB_ACTIVE_CLAUDE_VARIANT = variant;

  return config;
}

export function applyVariant(opts = {}) {
  return applyVariantToEnv(process.env, opts);
}

// --- CLI mode: node server/services/apply-variant.js [--export] [--json] [--variant <name>] ---
const isDirect = process.argv[1] && process.argv[1].endsWith("apply-variant.mjs");
if (isDirect) {
  const args = process.argv.slice(2);
  const exportMode = args.includes("--export");
  const jsonMode = args.includes("--json");
  const variantIdx = args.indexOf("--variant");
  if (variantIdx !== -1 && args[variantIdx + 1]) {
    process.env.CPB_CLAUDE_VARIANT = args[variantIdx + 1];
  }

  try {
    const config = resolveConfig();

    if (jsonMode) {
      process.stdout.write(JSON.stringify(config) + "\n");
    } else if (exportMode) {
      if (config.variant === "none") {
        process.stdout.write("export CPB_ACTIVE_CLAUDE_VARIANT='none'\n");
      } else {
        const vars = {
          ANTHROPIC_BASE_URL: config.baseUrl,
          ANTHROPIC_AUTH_TOKEN: config.authToken,
          ANTHROPIC_MODEL: config.model,
          ANTHROPIC_CUSTOM_MODEL_OPTION: config.model,
          ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: config.displayName,
          ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: `CodePatchbay provider variant: ${config.variant}`,
          ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
          CLAUDE_CODE_SUBAGENT_MODEL: config.model,
          CPB_ACTIVE_CLAUDE_VARIANT: config.variant,
        };
        for (const [key, val] of Object.entries(vars)) {
          const escaped = String(val).replace(/'/g, "'\\''");
          process.stdout.write(`export ${key}='${escaped}'\n`);
        }
      }
    } else {
      console.log(`variant: ${config.variant}${config.model ? ` model: ${config.model}` : ""}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
