/**
 * Provider quota adapters are projections of descriptor configuration.
 *
 * A provider descriptor may declare its region, timezone, quota policy and
 * limit-error rules. The runtime turns those declarative rules into the
 * small adapter interface consumed by quota and usage code. Unknown or
 * descriptor-less keys deliberately use the generic adapter.
 */
import { recordValue, type LooseRecord } from "../../shared/types.js";
import {
  getProviderConfig,
  listAgents,
} from "../../core/agents/registry.js";
import {
  normalizeProviderConfig,
  providerKeyForDescriptor,
  type NormalizedProviderConfig,
} from "../../core/agents/provider-config.js";
import {
  configuredProviderForKey,
  providerDescriptorFromConfig,
  listConfiguredProviders,
} from "../../core/agents/provider-catalog.js";
import { parseResetTime } from "./provider-quota.js";

const genericAdapter = Object.freeze({
  providerKeyPattern: "generic",
  region: "global",
  timezone: "UTC",
  quotaPolicy: { type: "unknown", description: "default fallback" },
  parseLimitError: null,
  parseResetTime: (message: string) => parseResetTime(message, "UTC"),
});

function descriptorForProviderKey(providerKey: string) {
  try {
    for (const descriptor of listAgents()) {
      if (typeof descriptor?.name !== "string") continue;
      const exact = providerKeyForDescriptor(descriptor.name, descriptor);
      if (exact === providerKey || descriptor.name === providerKey) return descriptor;
    }
    const agent = providerKey.split(":", 1)[0];
    return listAgents().find((descriptor) => descriptor?.name === agent) || null;
  } catch {
    return null;
  }
}

function adapterFromConfig(providerKey: string, config: NormalizedProviderConfig) {
  const quota = config.quota;
  if (!quota) return null;
  const timezone = quota.timezone || "UTC";
  return Object.freeze({
    providerKeyPattern: providerKey,
    region: quota.region || "global",
    timezone,
    quotaPolicy: quota.policy,
    parseLimitError: quota.rules.length > 0
      ? ({ error, stderr }: LooseRecord) => {
        const err = recordValue(error);
        const message = `${err.message || ""}\n${stderr || ""}`;
        for (const rule of quota.rules) {
          let matched = false;
          try {
            matched = new RegExp(rule.pattern, "i").test(message);
          } catch {
            // Invalid user regexes are ignored; descriptor validation remains
            // non-executable and quota classification must stay fail-safe.
          }
          if (!matched) continue;
          return {
            isQuota: true,
            status: rule.status,
            confidence: rule.confidence,
            reason: rule.reason || message.slice(0, 200),
          };
        }
        return null;
      }
      : null,
    parseResetTime: (message: string) => parseResetTime(message, timezone),
  });
}

/**
 * Get the adapter for a provider key. Exact descriptor provider keys win;
 * agent-level descriptors are used for unknown variants, then generic state.
 */
export function getProviderAdapter(providerKey: string) {
  const key = String(providerKey || "").trim();
  const configured = configuredProviderForKey(key);
  if (configured) {
    try {
      const configuredDescriptor = providerDescriptorFromConfig(configured.id, configured.config);
      const config = normalizeProviderConfig(configured.id, { provider: configuredDescriptor });
      return adapterFromConfig(key, config) || genericAdapter;
    } catch {
      return genericAdapter;
    }
  }
  const descriptor = descriptorForProviderKey(key);
  if (!descriptor || typeof descriptor.name !== "string") return genericAdapter;
  try {
    const config = getProviderConfig(descriptor.name);
    return config ? (adapterFromConfig(key, config) || genericAdapter) : genericAdapter;
  } catch {
    return genericAdapter;
  }
}

/** List configured provider adapter keys plus the generic fallback. */
export function listAdapterKeys() {
  const keys = new Set<string>(["generic"]);
  try {
    for (const descriptor of listAgents()) {
      if (typeof descriptor?.name !== "string") continue;
      keys.add(providerKeyForDescriptor(descriptor.name, descriptor));
    }
    for (const { id, config } of listConfiguredProviders()) {
      keys.add(String(config.key || config.providerKey || id));
    }
  } catch {
    // Registry loading is optional for callers that only need generic quota
    // classification.
  }
  return [...keys];
}
