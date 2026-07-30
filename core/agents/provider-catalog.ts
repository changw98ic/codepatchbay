import { readFileSync, statSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LooseRecord } from "../../shared/types.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PROVIDER_FILE_BYTES = 1024 * 1024;

function record(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function envName(value: unknown): string | null {
  const candidate = text(value);
  return candidate && ENV_NAME.test(candidate) ? candidate : null;
}

function envNames(value: unknown): string[] {
  if (typeof value === "string") return envName(value) ? [String(value).trim()] : [];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(envName).filter((item): item is string => Boolean(item)))];
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function configuredHome(env: Record<string, string | undefined>) {
  const explicitHome = text(env.CPB_HOME) || text(env.CPB_HUB_ROOT);
  return path.resolve(explicitHome || path.join(text(env.HOME) || os.homedir(), ".cpb"));
}

/** The one global provider configuration file used by CPB. */
export function providerCatalogPath(env: Record<string, string | undefined> = process.env) {
  return path.resolve(text(env.CPB_PROVIDERS_FILE) || path.join(configuredHome(env), "providers.json"));
}

/** Create an empty global catalog without ever replacing an existing file. */
export async function ensureProviderCatalog(env: Record<string, string | undefined> = process.env) {
  const filePath = providerCatalogPath(env);
  try {
    const info = await lstat(filePath);
    if (info.isFile()) return filePath;
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{\n  "providers": {}\n}\n', { encoding: "utf8", flag: "wx" });
    return filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return filePath;
    return null;
  }
}

function rawProviderEntries(value: unknown): Record<string, LooseRecord> {
  const root = record(value);
  const source = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
    ? record(root.providers)
    : root;
  const result: Record<string, LooseRecord> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!PROVIDER_NAME.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    result[name] = raw as LooseRecord;
  }
  return result;
}

/**
 * Read providers.json as data only. A missing, malformed, oversized, or
 * non-regular file is treated as an empty catalog; credentials are never
 * printed or included in an error message.
 */
export function readProviderCatalog(env: Record<string, string | undefined> = process.env) {
  const filePath = providerCatalogPath(env);
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PROVIDER_FILE_BYTES) return {};
    return rawProviderEntries(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

export function getConfiguredProvider(
  providerId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  const name = text(providerId);
  if (!name || !PROVIDER_NAME.test(name)) return null;
  return readProviderCatalog(env)[name] || null;
}

export function listConfiguredProviders(env: Record<string, string | undefined> = process.env) {
  return Object.entries(readProviderCatalog(env)).map(([id, config]) => ({ id, config }));
}

export function configuredProviderForKey(
  providerKey: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  const key = text(providerKey);
  if (!key) return null;
  return listConfiguredProviders(env).find(({ id, config }) => (
    id === key
    || firstText(config, "key", "providerKey", "provider_key") === key
  )) || null;
}

function environmentMap(value: unknown) {
  const source = record(value);
  const result: Record<string, string[]> = {};
  for (const [target, rawSources] of Object.entries(source)) {
    const targetName = envName(target);
    const sources = envNames(rawSources);
    if (targetName && sources.length > 0) result[targetName] = sources;
  }
  return result;
}

function valuesMap(value: unknown) {
  const source = record(value);
  const result: Record<string, string> = {};
  for (const [target, rawValue] of Object.entries(source)) {
    const targetName = envName(target);
    if (targetName && typeof rawValue === "string") result[targetName] = rawValue;
  }
  return result;
}

function firstText(source: LooseRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

function targetEnvironment(source: LooseRecord, kind: "baseUrl" | "apiKey" | "authToken" | "model") {
  const explicit = firstText(
    source,
    `target${kind[0].toUpperCase()}${kind.slice(1)}Env`,
    `target_${kind}_env`,
    `${kind}TargetEnv`,
    `${kind}_target_env`,
  );
  if (explicit && ENV_NAME.test(explicit)) return explicit;

  const wireApi = (firstText(source, "wireApi", "wire_api", "protocol") || "anthropic").toLowerCase();
  const prefix = wireApi === "openai" || wireApi === "responses" ? "OPENAI" : "ANTHROPIC";
  return `${prefix}_${kind === "baseUrl" ? "BASE_URL" : kind === "apiKey" ? "API_KEY" : kind === "authToken" ? "AUTH_TOKEN" : "MODEL"}`;
}

function sourceEnvironment(source: LooseRecord, kind: "baseUrl" | "apiKey" | "authToken" | "model") {
  const camel = `${kind}Env`;
  const snake = `${kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_env`;
  return firstText(source, camel, snake);
}

/**
 * Convert the deliberately small providers.json format into the provider
 * descriptor shape understood by the runtime. Full descriptor fields remain
 * supported, so advanced providers can still supply environment/derived/
 * values/cli/quota directly.
 */
export function providerDescriptorFromConfig(
  providerId: string,
  rawConfig: LooseRecord,
  modelOverride: string | null | undefined = null,
) {
  const source = { ...rawConfig };
  const environment = environmentMap(source.environment);
  const values = valuesMap(source.values);
  const credentialEnv = unique([
    ...envNames(source.credentialEnv),
    ...envNames(source.credential_env),
  ]);

  const mappings: Array<["baseUrl" | "apiKey" | "authToken" | "model", string[]]> = [
    ["baseUrl", ["baseUrlEnv", "base_url_env"]],
    ["apiKey", ["apiKeyEnv", "api_key_env", "envKey", "env_key"]],
    ["authToken", ["authTokenEnv", "auth_token_env"]],
    ["model", ["modelEnv", "model_env"]],
  ];
  for (const [kind, keys] of mappings) {
    const sourceEnv = firstText(source, ...keys);
    const targetEnv = targetEnvironment(source, kind);
    if (sourceEnv && ENV_NAME.test(sourceEnv) && !environment[targetEnv]) {
      environment[targetEnv] = [sourceEnv];
      credentialEnv.push(sourceEnv);
    }
  }

  const apiKeySource = sourceEnvironment(source, "apiKey");
  const baseUrlSource = sourceEnvironment(source, "baseUrl");
  const authTokenSource = sourceEnvironment(source, "authToken") || apiKeySource;
  const modelSource = sourceEnvironment(source, "model");
  const authTokenTarget = targetEnvironment(source, "authToken");
  if (apiKeySource && !environment[authTokenTarget]) {
    environment[authTokenTarget] = [apiKeySource];
  }
  if (apiKeySource && ENV_NAME.test(apiKeySource)) credentialEnv.push(apiKeySource);
  if (baseUrlSource && ENV_NAME.test(baseUrlSource)) credentialEnv.push(baseUrlSource);
  if (authTokenSource && ENV_NAME.test(authTokenSource)) credentialEnv.push(authTokenSource);
  if (modelSource && ENV_NAME.test(modelSource)) credentialEnv.push(modelSource);

  const staticBaseUrl = firstText(source, "baseUrl", "base_url");
  const staticModel = modelOverride || firstText(source, "model", "modelName", "model_name");
  if (staticBaseUrl && !values[targetEnvironment(source, "baseUrl")]) {
    values[targetEnvironment(source, "baseUrl")] = staticBaseUrl;
  }
  if (staticModel && !values[targetEnvironment(source, "model")]) {
    values[targetEnvironment(source, "model")] = staticModel;
  }

  const required: string[] = Array.isArray(source.required)
    ? source.required.filter((item): item is string => typeof item === "string" && ENV_NAME.test(item))
    : Object.keys(environment).filter((target) => target.startsWith("ANTHROPIC_") || target.startsWith("OPENAI_"));

  return {
    ...source,
    key: firstText(source, "key", "providerKey", "provider_key") || providerId,
    family: firstText(source, "family", "providerFamily", "provider_family") || providerId,
    credentialEnv: unique(credentialEnv),
    environment,
    values,
    required,
  } as unknown as LooseRecord;
}

export function configuredProviderDescriptor(
  providerId: string | null | undefined,
  modelOverride: string | null | undefined = null,
  env: Record<string, string | undefined> = process.env,
) {
  const id = text(providerId);
  if (!id) return null;
  const config = getConfiguredProvider(id, env);
  return config ? providerDescriptorFromConfig(id, config, modelOverride) : null;
}

export function providerCredentialInputKeysFromConfig(config: LooseRecord): Set<string> {
  const keys = new Set<string>([
    ...envNames(config.credentialEnv),
    ...envNames(config.credential_env),
    ...envNames(config.baseUrlEnv),
    ...envNames(config.base_url_env),
    ...envNames(config.apiKeyEnv),
    ...envNames(config.api_key_env),
    ...envNames(config.authTokenEnv),
    ...envNames(config.auth_token_env),
    ...envNames(config.modelEnv),
    ...envNames(config.model_env),
    ...envNames(config.envKey),
    ...envNames(config.env_key),
  ]);
  for (const sources of Object.values(environmentMap(config.environment))) {
    for (const source of sources) keys.add(source);
  }
  return keys;
}

export function providerEnvironmentKeysFromConfig(config: LooseRecord): Set<string> {
  const descriptor = providerDescriptorFromConfig("configured", config);
  const keys = new Set<string>(providerCredentialInputKeysFromConfig(config));
  for (const [target, sources] of Object.entries(environmentMap(descriptor.environment))) {
    keys.add(target);
    for (const source of sources) keys.add(source);
  }
  for (const key of Object.keys(valuesMap(descriptor.values))) keys.add(key);
  for (const key of Object.keys(record(descriptor.derived))) {
    if (ENV_NAME.test(key)) keys.add(key);
  }
  for (const key of envNames(descriptor.runtimeEnv)) keys.add(key);
  const cli = record(descriptor.cli);
  for (const key of [cli.commandEnv, cli.modelEnv]) {
    const name = envName(key);
    if (name) keys.add(name);
  }
  return keys;
}

export function configuredProviderCredentialInputKeys(env: Record<string, string | undefined> = process.env) {
  const keys = new Set<string>();
  for (const { config } of listConfiguredProviders(env)) {
    for (const key of providerCredentialInputKeysFromConfig(config)) keys.add(key);
  }
  return keys;
}

export function configuredProviderEnvironmentKeys(env: Record<string, string | undefined> = process.env) {
  const keys = new Set<string>();
  for (const { config } of listConfiguredProviders(env)) {
    for (const key of providerEnvironmentKeysFromConfig(config)) keys.add(key);
  }
  return keys;
}

export function configuredProviderAgent(providerId: string | null | undefined, env = process.env) {
  const config = getConfiguredProvider(providerId, env);
  return config ? firstText(config, "agent", "agentName", "agent_name") : null;
}
