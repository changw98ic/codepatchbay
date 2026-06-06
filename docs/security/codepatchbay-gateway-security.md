# CodePatchBay Gateway Security

This document describes the security model, threat boundaries, and safeguards
in CodePatchBay (CPB). CPB runs entirely on your local machine and never
operates a hosted service.

## Install and Supply Chain Safety

CPB is not currently published as a public npm registry package. Install it
from a trusted checkout or release tarball with `npm install -g .` or
`sh scripts/install.sh`. There is no separate CodePatchBay-hosted artifact
registry for the local CLI package.

- Pin the source by checking out a specific Git tag or release tarball, and use
  `npm ci` inside the checkout to avoid unexpected dependency resolution.
- The CPB CLI does not download or execute remote code at runtime beyond the
  ACP adapter commands you configure (e.g. `codex-acp`, `claude-agent-acp`).
- ACP adapter commands are resolved from your local PATH or the explicit path
  you set via `CPB_ACP_*` environment variables. Verify adapter binaries before
  first use.

### Install Plan Safety

When `cpb agents install <agent> --yes` runs a third-party install command, the
following safeguards apply:

- Every install plan carries `requiresExplicitConfirmation: true` metadata. The
  execution engine refuses to run any plan without this flag.
- Each plan includes a `sourceUrl` for supply-chain review, a `rollback`
  uninstall command, and `supplyChainNotes` reminding the user to review the
  source before executing.
- Shell-script install commands (using pipes, redirections, or subshells) are
  flagged with `shell: true` so users can assess risk before consenting.
- Without `--yes`, the install command prints the plan and exits without
  spawning any child process.
- Install attempts are recorded to a local JSONL audit log with a SHA-256 hash
  of the command (not the command text itself), start/end timestamps, and exit
  code. Error messages in events are redacted.

## Auth Model

CPB uses provider-native authentication. Each coding agent (Codex, Claude Code,
etc.) manages its own login flow and credential storage.

- **CPB does not copy provider tokens.** Provider credentials (API keys, auth
  tokens) remain in the process environment of the agent process and are never
  written to disk by CPB.
- **CPB never stores provider or API tokens** in its event logs, wiki files,
  job state, or any persistent artifact.
- The child environment for agent processes and CPB-brokered terminal commands
  is built from an explicit allowlist (`core/policy/child-env.js`). Only known
  runtime variables and relevant provider credential variables are forwarded;
  everything else is stripped.
- For known ACP agents, provider credentials are narrowed before launch:
  Codex receives OpenAI/Azure-compatible credentials, Claude receives
  Anthropic-compatible credentials and configured Claude provider-variant keys,
  and Gemini receives Gemini/Google credentials. Unknown/custom agents keep the
  full provider allowlist for compatibility. CPB does not read, log, or persist
  these values.

## Secret Handling and Redaction Boundaries

CPB enforces multiple layers of secret protection:

### Recursive Redaction

All event log writes and webhook payloads pass through `redactSecrets()`, which
recursively scans for and replaces:

- Bearer tokens, OpenAI-style keys (`sk-...`), GitHub tokens (`ghp_`, `gho_`,
  etc.), AWS access keys (`AKIA...`), Google API keys (`AIza...`).
- Any object key matching secret-like names (`api_key`, `auth_token`, `secret`,
  `password`, `credential`, `webhook`, etc.) is replaced with `[REDACTED]`.
- Webhook URLs and query-string secrets are also redacted.

### Secret Input Rejection

User task input is scanned before processing. If a raw secret is detected (e.g.
an API key pasted into a task description), CPB rejects the input and emits a
`secret_input_rejected` event with the redacted evidence. The original input
is never persisted.

### Secret Artifact Blocking

Artifact paths and contents are checked against secret-path patterns (`.env`,
`.pem`, `.key`, `id_rsa`, `credentials.json`, etc.) and secret-content patterns
(private key blocks, provider key formats). Matches are blocked and a
`secret_blocked` event is logged instead of the artifact.

## Instant Messaging (IM) / Channel Safety

CPB integrates with Slack and Discord channels for status, queueing, and
operator actions.

- **Instant messaging key submission is forbidden.** Users must never paste API
  keys, tokens, or credentials into Slack, Discord, GitHub comments, or any
  other IM channel connected to CPB.
- Slack and Discord requests are verified before command parsing. Slack uses
  request signatures; Discord uses Ed25519 interaction signatures.
- State-changing IM actions such as approve, cancel, and retry must pass the
  configured channel policy before they mutate job state.
- The `detectSecretInput()` function scans all incoming channel messages. Any
  message containing a raw secret pattern is rejected before processing.

### Channel Permission Model

Channel commands are governed by a rule-based access control system
(`server/services/channel-policy.js`):

- Policies are defined as arrays of `allow` or `deny` rules matching on channel,
  project, channel ID, user ID, and action. Wildcards (`*`) are supported.
- **Deny rules take precedence** over allow rules (deny-first evaluation). If no
  rule matches, the default is `allow` unless the policy sets `default: "deny"`.
- Read-only actions (e.g. `status`) can be allowed separately from write actions
  (e.g. `run`, `approve`, `cancel`).
- Every policy decision is recorded to a JSONL audit log with request details
  redacted via `redactSecrets()`.
- GitHub `/cpb approve` is further restricted to users with `OWNER`, `MEMBER`,
  or `COLLABORATOR` association, with cross-repo and cross-issue validation.

## GitHub Webhook Signature Verification

CPB verifies the authenticity of incoming GitHub webhook events using HMAC-SHA256
signature verification:

1. The webhook secret is resolved from a secret reference (`webhookSecretRef`)
   in the project configuration -- it is never stored in plaintext config.
2. For each incoming request, CPB computes `HMAC-SHA256(secret, rawBody)` and
   compares it against the `X-Hub-Signature-256` header using a constant-time
   comparison (`timingSafeEqual`).
3. Requests with missing, malformed, or non-matching signatures are rejected.

This prevents forged webhook deliveries from triggering pipeline actions.

## Worktree Isolation and Safety

CPB uses git worktrees for task isolation when enabled:

- Each durable job can run in an isolated git worktree under
  `cpb-task/worktrees/`, keeping the main working tree untouched.
- Worktree creation is controlled by `CPB_USE_WORKTREE` or per-project
  `worktree.enabled` config. Worktrees are off by default for the `demo`
  command.
- Worktrees track a base branch and a task-specific branch. The main branch is
  never checked out or modified by the executor.
- Completed job worktrees are retained for inspection by default. A retention
  policy controls archiving or deletion.

## Verifier Read-Only / Write Constraints

The verifier role is constrained to prevent unintended side effects:

1. **Do not modify** source code, project files, wiki inputs, git state,
   dependencies, caches, or runtime state.
2. **Write only** verdict artifacts under `wiki/projects/{name}/outputs/`.
3. **Terminal commands** are restricted to read-only inspection or validation.
4. Executor deliverables are treated as claims, not truth -- the verifier
   independently inspects the worktree and artifacts.

These constraints are enforced through the verifier role profile and the CPB
write-permission boundary (verifier agents write only to `outputs/verdict-*`).

### Role-Based Permission Matrix

All agent roles (planner, executor, verifier, remediator, reviewer) are subject
to a per-role permission matrix (`server/services/permission-matrix.js`):

| Scope | Planner | Executor | Verifier | Remediator | Reviewer |
|--------|---------|----------|----------|----------|----------|
| **Write** | `inbox/` only | `outputs/` + source | `outputs/` only | all under `cpbRoot` | `outputs/` only |
| **Execute** | read-only inspection | all except unsafe cmds | read-only + validation | all except unsafe cmds | read-only + validation |
| **Read** | broad (except secrets) | broad (except secrets) | broad (except secrets) | broad (except secrets) | broad (except secrets) |

Blocked command patterns include `sudo`, `rm -rf`, `dd`, `chmod`, `curl|sh`,
`git reset/clean/push`, and `npm publish/deploy`. Shell mutation syntax (`;`,
`&`, `|`, `<`, `>`, backticks, `$`) is detected and blocked for read-only
roles. All roles are denied access to secret/credential file paths via
`isSecretPath()`.

## Draft PR Policy and No Automatic Merge

CPB does not automatically merge branches or pull requests.

- When the GitHub integration creates a pull request, it is opened as a **draft
  PR** by default. This requires an explicit human action to mark as ready for
  review and subsequently merge.
- The merge-preview command shows a diff and classification of changed files
  without performing a merge. Merge classification may flag files that require
  human review (e.g. schema files, shared state).
- No CPB command or pipeline stage performs an automatic merge to the base
  branch. All merges require explicit user initiation.

## Event Log Integrity

- Event logs are append-only JSONL files. Once a job reaches a terminal status
  (`completed`, `failed`, `blocked`, `cancelled`, `superseded`), only a
  whitelist of post-terminal event types (e.g. `pr_opened`,
  `github_comment_posted`, `permission_denied`) may be appended.
- Project and job IDs are validated against `/^[A-Za-z0-9][A-Za-z0-9-]*$/` and
  path traversal is prevented by resolving and checking file paths against the
  events root directory.

## Agent Process Isolation

CPB provides layered isolation for agent processes:

- **Git worktree isolation** (see above): each job runs in an independent
  worktree with enforced `.gitignore` patterns (`.env`, `.env.*`,
  `node_modules/`, etc.) and a baseline commit anchor.
- **Agent home isolation**: each agent job gets its own HOME, XDG_CONFIG_HOME,
  XDG_DATA_HOME, and XDG_CACHE_HOME directories. Provider credentials are
  symlinked selectively (e.g. only `auth.json` and `config.toml` for Codex).
- **OS-level sandbox** (optional): `CPB_AGENT_SANDBOX` supports `off`,
  `best-effort`, `required`, and `strict` modes using macOS `sandbox-exec` or
  Linux `bwrap`. Strict mode denies network and subprocess by default.
- **Environment allowlist**: child processes receive only an explicit allowlist
  of runtime and provider-specific credential variables. Provider credentials
  are scoped per agent (Codex receives OpenAI keys, Claude receives Anthropic
  keys, etc.). See `docs/security/cpb-agent-secret-boundary.md` for the full
  boundary analysis.
