import { isValidPlatform, validateGitPlatformAdapter } from "../../core/contracts/git-platform.js";
import { createGithubAdapter } from "./git-adapters/github.js";

const DEFAULT_PLATFORM = "github";

const adapterCache = new Map();

export function resolveGitPlatform(platformHint, options = {}) {
  let platform;
  if (typeof platformHint === "string" && platformHint.length > 0) {
    platform = platformHint;
  } else {
    platform = options.platform || DEFAULT_PLATFORM;
  }

  const cached = adapterCache.get(platform);
  if (cached) return cached;

  if (platform === "github") {
    const adapter = createGithubAdapter();
    adapterCache.set(platform, adapter);
    return adapter;
  }

  throw new Error(`git-platform: unsupported platform '${platform}'. Supported: github`);
}

export function clearAdapterCache() {
  adapterCache.clear();
}

export function registerAdapter(adapter) {
  const validated = validateGitPlatformAdapter(adapter);
  adapterCache.set(validated.platform, validated);
  return validated;
}
