// DEPRECATED: Use server/adapters/github-adapter.js instead
// This file re-exports from the GitHub adapter for backward compatibility.

export {
  normalizeGithubLabels,
  normalizeGithubIssue,
  readGithubIssues,
  writeGithubIssues,
  closeGithubIssueWithGh,
  syncGithubIssuesFromGh,
} from "../adapters/github-adapter.js";
