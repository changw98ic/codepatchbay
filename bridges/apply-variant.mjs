#!/usr/bin/env node
// apply-variant.mjs — Claude provider variant overlay (shared between Node and shell)
//
// Node usage:
//   import { applyVariant } from "./apply-variant.mjs";
//   applyVariant(); // modifies process.env in-place
//
// Shell usage:
//   eval "$(node bridges/apply-variant.mjs --export)"

function envFirst(...names) {
  for (const name of names) {
    const val = process.env[name];
    if (val) return val;
  }
  return undefined;
}

function envAny(...names) {
  return names.some((name) => process.env[name]);
}

function normalizeVariant(requested) {
  return (requested || "").trim().toLowerCase();
}

function resolveVariant() {
  const requested =
    process.env.CPB_CLAUDE_VARIANT ||
    process.env.CPB_BUILDER_VARIANT ||
    process.env.CPB_ACP_CLAUDE_VARIANT ||
    "";

  if (requested) return normalizeVariant(requested);

  if (envAny("OLLAMA_CLOUD_URL", "OLLAMA_CLOUD_BASE_URL", "OLLAMACLOUD_BASE_URL", "OLLAMACLOUD_URL", "KIMI_BASE_URL", "MOONSHOT_BASE_URL")) {
    return "kimi-k2.6";
  }

  if (envAny("XIAOMI_BASE_URL", "MIMO_BASE_URL")) {
    return "mimo-v2.5pro";
  }

  return "none";
}

function applyKimi() {
  const variant = "kimi-k2.6";
  const baseUrl = envFirst("OLLAMA_CLOUD_URL", "OLLAMA_CLOUD_BASE_URL", "OLLAMACLOUD_BASE_URL", "OLLAMACLOUD_URL", "KIMI_BASE_URL", "MOONSHOT_BASE_URL");
  const authToken = envFirst("OLLAMA_CLOUD_KEY", "OLLAMA_CLOUD_API_KEY", "OLLAMACLOUD_API_KEY", "OLLAMACLOUD_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY");
  const model = envFirst("OLLAMA_CLOUD_MODEL", "OLLAMACLOUD_MODEL", "KIMI_MODEL", "MOONSHOT_MODEL") || "kimi-k2.6";

  if (!baseUrl || !authToken) {
    throw new Error(`Missing base URL or API key for variant '${variant}'. Set OLLAMA_CLOUD_URL + OLLAMA_CLOUD_KEY (or KIMI_BASE_URL + KIMI_API_KEY).`);
  }

  return { variant, displayName: "Kimi K2.6", baseUrl, authToken, model };
}

function applyXiaomi() {
  const variant = "mimo-v2.5pro";
  const baseUrl = envFirst("XIAOMI_BASE_URL", "MIMO_BASE_URL");
  const authToken = envFirst("XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN", "MIMO_API_KEY", "MIMO_AUTH_TOKEN");
  const model = envFirst("XIAOMI_MODEL", "MIMO_MODEL") || "mimo-v2.5pro";

  if (!baseUrl || !authToken) {
    throw new Error(`Missing base URL or API key for variant '${variant}'. Set XIAOMI_BASE_URL + XIAOMI_API_KEY (or MIMO_BASE_URL + MIMO_API_KEY).`);
  }

  return { variant, displayName: "MiMo v2.5 Pro", baseUrl, authToken, model };
}

function resolveConfig() {
  const normalized = resolveVariant();

  switch (normalized) {
    case "none":
    case "off":
    case "default":
    case "anthropic":
    case "claude":
      return { variant: "none" };

    case "kimi":
    case "kimi-k2.6":
    case "ollama":
    case "ollamacloud":
    case "ollama-cloud":
      return applyKimi();

    case "xiaomi":
    case "mimo":
    case "mimo-v2.5pro":
      return applyXiaomi();

    default:
      throw new Error(`Unknown Claude variant: '${normalized}'. Use kimi-k2.6, mimo-v2.5pro, or none.`);
  }
}

/**
 * Apply the Claude provider variant overlay to process.env.
 * @param {object} [opts]
 * @param {string} [opts.variant] - Override variant name
 * @returns {object} Resolved config
 */
export function applyVariant(opts = {}) {
  if (opts.variant) {
    process.env.CPB_CLAUDE_VARIANT = opts.variant;
  }
  const config = resolveConfig();

  if (config.variant === "none") {
    process.env.CPB_ACTIVE_CLAUDE_VARIANT = "none";
    return config;
  }

  const { variant, displayName, baseUrl, authToken, model } = config;

  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = authToken;
  process.env.ANTHROPIC_MODEL = model;
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = model;
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = displayName;
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `CodePatchbay provider variant: ${variant}`;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  process.env.CPB_ACTIVE_CLAUDE_VARIANT = variant;

  return config;
}

// --- CLI mode: node bridges/apply-variant.mjs [--export] [--json] [--variant <name>] ---
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
