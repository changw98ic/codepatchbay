// DEPRECATED: Use server/adapters/github-adapter.js instead
// This file re-exports from the GitHub adapter for backward compatibility.

export {
  githubAppConfigPath,
  validateGithubAppConfig,
  redactGithubAppConfig,
  saveGithubAppConfig,
  loadGithubAppConfig,
  buildGithubAppReadiness,
  resolveSecretRef,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
} from "../adapters/github-adapter.js";
