/**
 * GitPlatform adapter interface.
 *
 * Abstracts git hosting platform operations (GitHub, GitLab, Gitea, Gitee, etc.)
 * behind a common protocol-based interface.
 *
 * Platform adapters must implement all methods marked with {@link NotImplementedError}.
 * Returns structured data — no platform-specific types leak through.
 */

/**
 * Base class for all Git platform adapter errors.
 */
export class GitPlatformError extends Error {
  constructor(message, { code = "PLATFORM_ERROR", platform = null, cause = null } = {}) {
    super(message);
    this.name = "GitPlatformError";
    this.code = code;
    this.platform = platform;
    this.cause = cause;
  }
}

/**
 * Raised when a required method is not implemented by the adapter.
 */
export class NotImplementedError extends GitPlatformError {
  constructor(methodName, platform) {
    super(`Method '${methodName}' not implemented for platform '${platform}'`, {
      code: "NOT_IMPLEMENTED",
      platform,
    });
    this.name = "NotImplementedError";
  }
}

/**
 * Raised when platform authentication fails.
 */
export class AuthenticationError extends GitPlatformError {
  constructor(message, platform) {
    super(message, { code: "AUTHENTICATION_FAILED", platform });
    this.name = "AuthenticationError";
  }
}

/**
 * Raised when a requested resource is not found.
 */
export class NotFoundError extends GitPlatformError {
  constructor(message, platform) {
    super(message, { code: "NOT_FOUND", platform });
    this.name = "NotFoundError";
  }
}

/**
 * Raised when rate limit is exceeded.
 */
export class RateLimitError extends GitPlatformError {
  constructor(message, platform, { resetAt = null } = {}) {
    super(message, { code: "RATE_LIMIT_EXCEEDED", platform });
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

/**
 * Base GitPlatform adapter class.
 *
 * All platform adapters extend this class and implement the abstract methods.
 *
 * @example
 * class GitHubAdapter extends GitPlatform {
 *   name = "github";
 *   async getIssue({ repo, issueNumber }) { ... }
 *   // ... implement all abstract methods
 * }
 */
export class GitPlatform {
  /**
   * Platform identifier (e.g., "github", "gitlab", "gitea", "gitee").
   * @type {string}
   */
  name = "base";

  /**
   * Post a comment to an issue or pull request.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {number} params.issueNumber - Issue or PR number
   * @param {string} params.body - Comment body (markdown)
   * @returns {Promise<{url: string|null, id: number|null}>}
   */
  async postComment({ repo, issueNumber, body }) {
    throw new NotImplementedError("postComment", this.name);
  }

  /**
   * Create a pull request.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {string} params.title - PR title
   * @param {string} params.body - PR body (markdown)
   * @param {string} params.head - Head branch (e.g., "feature-branch")
   * @param {string} params.base - Base branch (e.g., "main")
   * @param {boolean} [params.draft=true] - Whether to create as draft
   * @returns {Promise<{url: string|null, html_url: string|null, number: number|null}>}
   */
  async createPullRequest({ repo, title, body, head, base, draft = true }) {
    throw new NotImplementedError("createPullRequest", this.name);
  }

  /**
   * Get an issue by number.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {number} params.issueNumber - Issue number
   * @returns {Promise<{number: number, title: string, state: string, body: string, url: string|null, labels: string[], createdAt: string|null, updatedAt: string|null}>}
   */
  async getIssue({ repo, issueNumber }) {
    throw new NotImplementedError("getIssue", this.name);
  }

  /**
   * List changed files in a pull request.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {number} params.prNumber - PR number
   * @returns {Promise<Array<{path: string, status: string, additions: number, deletions: number}>}
   */
  async listChangedFiles({ repo, prNumber }) {
    throw new NotImplementedError("listChangedFiles", this.name);
  }

  /**
   * Close an issue.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {number} params.number - Issue number
   * @param {string} [params.body] - Optional closing comment
   * @returns {Promise<{url: string|null, html_url: string|null, number: number|null, state: string|null}>}
   */
  async closeIssue({ repo, number, body }) {
    throw new NotImplementedError("closeIssue", this.name);
  }

  /**
   * Verify a webhook signature.
   *
   * @param {Object} params
   * @param {string} params.signature - Signature from header (e.g., "sha256=...")
   * @param {string} params.payload - Raw request body
   * @param {string} [params.secret] - Webhook secret (if applicable)
   * @returns {Promise<boolean>}
   */
  async verifyWebhook({ signature, payload, secret }) {
    throw new NotImplementedError("verifyWebhook", this.name);
  }

  /**
   * Get branch information.
   *
   * @param {Object} params
   * @param {string} params.repo - Repository in format "owner/repo"
   * @param {string} params.branch - Branch name
   * @returns {Promise<{name: string, commit: string|null, protected: boolean}>}
   */
  async getBranch({ repo, branch }) {
    throw new NotImplementedError("getBranch", this.name);
  }

  /**
   * Check if the adapter is properly configured and ready.
   *
   * @returns {Promise<{healthy: boolean, diagnostics: Array<{level: string, message: string}>}>}
   */
  async healthCheck() {
    return {
      healthy: false,
      diagnostics: [
        { level: "error", message: `Platform '${this.name}' health check not implemented` },
      ],
    };
  }
}
