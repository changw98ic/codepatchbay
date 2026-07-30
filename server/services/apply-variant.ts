import type { LooseRecord } from "../../shared/types.js";
import { getDescriptor } from "../../core/agents/registry.js";
import {
  applyProviderEnvironment,
  providerVariantFromEnvironment,
} from "../../core/agents/provider-config.js";

type EnvRecord = Record<string, string | undefined>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function descriptorFor(agent: string) {
  try {
    return getDescriptor(agent) as LooseRecord | null;
  } catch {
    return null;
  }
}

function agentFor(env: LooseRecord, opts: LooseRecord = {}) {
  return text(opts.agent)
    || text(opts.agentName)
    || text(env.CPB_PROVIDER_AGENT)
    || text(env.CPB_ACP_AGENT)
    || null;
}

/**
 * Resolve the provider configuration for one registered agent without
 * relying on provider-name branches in the runtime. Secrets remain in the
 * process environment; the descriptor only declares which names to read and
 * how to map them into the selected transport's environment.
 */
export function resolveVariantConfig(env: LooseRecord = process.env, opts: LooseRecord = {}): LooseRecord {
  const agent = agentFor(env, opts);
  if (!agent) return { variant: "none" };
  const descriptor = descriptorFor(agent);
  if (!descriptor) return { agent, variant: text(opts.variant) || "none" };
  const next = { ...env } as EnvRecord;
  const variant = providerVariantFromEnvironment(agent, next, text(opts.variant));
  return applyProviderEnvironment(next, agent, descriptor, {
    variant,
    provider: text(opts.provider) || text(opts.providerId) || text(next.CPB_PROVIDER) || text(next.CPB_PROVIDER_ID),
    model: text(opts.model) || text(opts.modelName) || text(next.CPB_MODEL) || text(next.CPB_MODEL_NAME),
  }) as unknown as LooseRecord;
}

export function applyVariantToEnv(env: LooseRecord = process.env, opts: LooseRecord = {}): LooseRecord {
  const agent = agentFor(env, opts);
  if (!agent) return { variant: "none" };
  const descriptor = descriptorFor(agent);
  if (!descriptor) {
    // Some low-level ACP pool tests and capsule probes construct the pool
    // before async registry loading. They do not have a provider mapping to
    // apply; the later command resolver still fails closed if the agent is
    // actually unknown.
    return { agent, variant: text(opts.variant) || "none" };
  }
  const variant = providerVariantFromEnvironment(agent, env as EnvRecord, text(opts.variant));
  const result = applyProviderEnvironment(env as EnvRecord, agent, descriptor, {
    variant,
    provider: text(opts.provider) || text(opts.providerId) || text(env.CPB_PROVIDER) || text(env.CPB_PROVIDER_ID),
    model: text(opts.model) || text(opts.modelName) || text(env.CPB_MODEL) || text(env.CPB_MODEL_NAME),
  });
  return {
    ...result,
    displayName: text(descriptor.displayName) || agent,
  } as unknown as LooseRecord;
}

export function applyVariant(opts: LooseRecord = {}) {
  return applyVariantToEnv(process.env, opts);
}
