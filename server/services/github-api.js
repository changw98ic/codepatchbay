// DEPRECATED: Use server/adapters/github-adapter.js instead
// This file re-exports from the GitHub adapter for backward compatibility.

export {
  resolvePrivateKey,
  getInstallationToken,
  clearTokenCache,
  postGithubCommentWithApi,
  createPullRequestWithApi,
  closeGithubIssueWithApi,
  resolveGithubTransport,
} from "../adapters/github-adapter.js";
