import { BOUNDARY_VERSION, validateGitPlatformAdapter, validateTransportResult } from "../../../core/contracts/git-platform.js";
import { resolveGithubTransport } from "../github-api.js";
import { normalizeGithubWebhookEvent } from "../github-events.js";
import { matchGithubTrigger } from "../github-triggers.js";
import { normalizeGithubIssue, readGithubIssues, syncGithubIssuesFromGh } from "../github-issues.js";
import { buildGithubIssueBranchParts } from "../branch-names.js";
import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
  validateGithubAppConfig,
} from "../github-app.js";

export function createGithubAdapter() {
  const adapter = {
    boundaryVersion: BOUNDARY_VERSION,
    platform: "github",

    async resolveTransport(hubRoot, options: Record<string, any> = {}) {
      const transport = await resolveGithubTransport(hubRoot, { env: options.env });
      return validateTransportResult(transport);
    },

    normalizeWebhookEvent(raw) {
      return normalizeGithubWebhookEvent(raw);
    },

    matchTrigger(event, rules) {
      return matchGithubTrigger(event, rules);
    },

    normalizeIssue(raw, options = {}) {
      return normalizeGithubIssue(raw, options);
    },

    async readIssues(hubRoot) {
      return readGithubIssues(hubRoot);
    },

    async syncIssues(hubRoot, options = {}) {
      return syncGithubIssuesFromGh(hubRoot, options);
    },

    buildIssueBranchParts(options = {}) {
      return buildGithubIssueBranchParts(options);
    },

    async loadConfig(hubRoot) {
      return loadGithubAppConfig(hubRoot);
    },

    validateConfig(raw = {}) {
      return validateGithubAppConfig(raw);
    },

    resolveWebhookSecret(config, options = {}) {
      return resolveGithubWebhookSecret(config, options);
    },

    verifyWebhookSignature(options) {
      return verifyGithubWebhookSignature(options);
    },
  };

  return validateGitPlatformAdapter(adapter);
}
