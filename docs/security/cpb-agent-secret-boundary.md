# CPB Agent Secret Boundary

## What CPB Controls

CPB enforces secret protection at these boundaries:

### Child Process Environment

ACP/agent child processes, CPB-brokered terminal commands, and CPB-launched
Hub/UI backend servers receive only an explicit env allowlist:
- **Runtime basics**: `PATH`, `HOME`, `SHELL`, `TERM`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `CODEX_HOME`, `XDG_CACHE_HOME`, and CPB runtime vars.
- **Provider credentials**: provider/API variables are allowlisted, then scoped
  again for known ACP agents. Codex receives OpenAI/Azure-compatible keys;
  Claude receives Anthropic-compatible keys, AWS Bedrock region/session keys,
  and configured Claude provider-variant keys such as Kimi/Ollama Cloud or
  Xiaomi/MiMo; Gemini receives Gemini/Google keys. Unknown/custom agents keep
  the full provider allowlist for compatibility.
- Arbitrary `*_TOKEN`, `*_KEY`, `*_SECRET`, `DATABASE_URL`, and similar env vars are **not** forwarded.

CPB-launched dependency-install helpers and the local Vite UI dev server use a
narrower runtime-only allowlist and do not receive provider credentials.

The Hub service-token authorization file is configured by absolute path through
`CPB_HUB_SERVICE_TOKENS_FILE`. Only the Hub server child receives that path;
orchestrator, worker, quota-delegate, installer, and agent children do not. The
file stores token SHA-256 digests rather than plaintext bearer tokens and must
remain outside the Hub root so backups do not copy credential material.

The Hub OIDC authorization policy is configured by absolute path through
`CPB_HUB_OIDC_CONFIG_FILE`. That path is likewise forwarded only to the Hub
server child, not to orchestrators, workers, installers, quota delegates, or
agents. Resource-server JWT verification uses pinned public JWKS and does not
require an OAuth client secret. The policy file remains integrity-sensitive
because it maps identity-provider groups to Hub scopes and projects.

`CPB_HUB_BACKUP_SIGNING_KEY` and
`CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY` remain in the invoking control
process. `cpb hub start` completes interrupted restore/audit-archive recovery
before spawning the long-running Hub server and does not forward either
signing key to that child, orchestrator, workers, quota delegate, installers,
or agents. A directly invoked `server/index.js` may read the audit-archive key
only to authenticate an interrupted archive during startup recovery.

### Agent Process Sandbox

ACP provider adapter processes and CPB-brokered terminal commands can be
launched through an OS/container sandbox before the provider code runs:

- `CPB_AGENT_SANDBOX=off` keeps the legacy unsandboxed launch path.
- `CPB_AGENT_SANDBOX=best-effort` uses a supported sandbox when available and
  otherwise keeps running without one.
- `CPB_AGENT_SANDBOX=required` fails closed if no supported sandbox is
  available and denies network access by default.
- `CPB_AGENT_SANDBOX=strict` is `required` plus default subprocess
  denial. If the selected sandbox provider cannot enforce a requested
  restriction, `required`/`strict` fails closed instead of silently downgrading.

When no mode is configured, CPB uses `required` for all agent phases and fails
closed when no provider is available. `off` and `best-effort` are explicit
development compatibility choices. Production deployments should verify the
provider with `CPB_AGENT_SANDBOX_SELF_TEST=1`. Read-only
Claude-compatible phases retain that configured sandbox mode in addition to
provider tool-deny policy; they no longer disable an explicit sandbox request.

Built-in providers are macOS `sandbox-exec` and Linux `bwrap` when present.
The macOS provider can enforce filesystem, network, and process-exec policy.
The Linux `bwrap` provider enforces filesystem and network policy, but not
subprocess denial, so `strict` on Linux requires a site-managed wrapper.
The default filesystem roots are the job working directory, temporary
directories, explicit `CODEX_HOME`/XDG roots, and paths listed in
`CPB_AGENT_SANDBOX_ALLOW_READ` or `CPB_AGENT_SANDBOX_ALLOW_WRITE`; CPB does not
allow the whole user home directory by default. For built-in sandbox providers,
CPB also adds the resolved executable's containing directory as a read root so
provider CLIs installed outside system paths can start without broad home
access. `CPB_AGENT_SANDBOX_COMMAND` can point at a site-managed wrapper; CPB
appends the real command and args after any optional `CPB_AGENT_SANDBOX_ARGS`.
`required` and `strict` modes are the only modes that make provider-internal
filesystem, subprocess, and network restrictions part of the enforced launch
contract.

`cpb doctor` reports the sandbox posture as structured evidence. By default it
does not launch a live sandbox probe. Set `CPB_AGENT_SANDBOX_SELF_TEST=1` to make
doctor run a minimal sandboxed Node process and fail the self-test check if the
configured sandbox cannot execute commands.

### Trusted Verification Probes

Acceptance-checklist `expectedEvidence` is descriptive text and is never
executed. Command and test checklist items can run only when the target
repository already contains a maintainer-reviewed policy at
`.cpb/verification-probes.json` in `HEAD`:

```json
{
  "schemaVersion": 1,
  "probes": [
    {
      "predicateId": "unit-tests",
      "executable": "npm",
      "args": ["test"]
    }
  ]
}
```

The checklist `predicateId` must match a policy entry. CPB launches the
executable with an argument array and `shell: false`, rejects inline shell
evaluator flags such as `sh -c`, and passes a scrubbed environment without Hub,
Redis, or provider credentials. Worktree edits cannot authorize a new probe,
because policy is read from the committed `HEAD` version. Repositories without
this policy still support static and event-based evidence; command/test items
fail closed with a ledger-visible reason instead of executing model or issue
text.

### ACP Pool Environment Snapshot

The in-process ACP pool does not repeatedly consult the raw parent
`process.env` while launching provider clients. At pool construction time CPB
builds an allowlisted snapshot containing:
- child-process runtime/provider keys from the same allowlist above
- ACP pool controls such as `CPB_ACP_POOL_*`,
  `CPB_ACP_POOL_MAX_REQUESTS`, `CPB_ACP_POOL_MAX_AGE_MS`,
  `CPB_ACP_POOL_IDLE_MS`, and `CPB_ACP_RATE_LIMIT_BACKOFF_MS`

Later mutations to the host process environment do not change an existing
pool's client path, provider credentials, terminal/tool policy, write allow
paths, permission-request behavior, registry command overrides, or pool limits.
Arbitrary parent secrets such as `DATABASE_URL`, webhook secrets, and random
tokens are excluded from this snapshot.

The snapshot can retain provider credentials for multiple agents so one pool can
serve mixed Codex/Claude/Gemini work. Each ACP adapter launch and CPB-brokered
terminal command then narrows that snapshot to the requested agent before the
child process starts.

### Output Redaction

All CPB output surfaces redact secrets before persistence or emission:
- Diagnostics bundles (`/hub/diagnostics`)
- Observability summaries (`/hub/observability`)
- Event store persistence (JSONL event log)
- WebSocket broadcast output (stdout/stderr tails)
- Status responses and error messages

Redacted patterns: Bearer tokens, OpenAI/AWS/Google API keys, key=value pairs with secret-like keys, webhook URLs.

### Runtime Resource Bounds

Agent phases have a 30-minute hard timeout when no positive
`CPB_ACP_PHASE_TIMEOUT_MS`, `CPB_ACP_POOL_TIMEOUT_MS`, or job timeout is set.
Zero and invalid values fall back to the finite default rather than silently
creating an unbounded phase. Legacy bridge subprocess capture retains only the
newest 8 MiB per output stream by default; set a positive
`CPB_SUBPROCESS_OUTPUT_MAX_BYTES` to choose a different bound. Output may still
be streamed to the configured process log while the in-memory capture remains
bounded.

### CPB-Brokered File Reads

Project file loading (`project-loader`) and knowledge composition (`knowledge-compose`) deny reads of known secret paths:
- `.env`, `.env.*`
- `.npmrc`, `.pypirc`, `.netrc`
- SSH keys (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`)
- Cloud credentials (`.aws/credentials`, `.config/gcloud`, `.azure`, `.kube/config`)

Denied reads return `null` (file treated as absent) without exposing content.

### CPB-Managed Artifacts

Events with secret-like artifact names or content are blocked:
- Artifact is replaced with a `secret_blocked` event containing redacted metadata only.
- Raw secret content is never persisted to the event store.

## What CPB Does NOT Control

These boundaries remain outside CPB enforcement unless `CPB_AGENT_SANDBOX` is
set to `required` or `strict` with an available OS/container sandbox:

1. **Provider-internal filesystem access**: Without required sandboxing, an ACP agent process can read files from the filesystem using its own I/O capabilities, bypassing CPB's broker. CPB always controls file reads that go through its own project-loader and knowledge-compose modules.

2. **Agent subprocess spawning outside CPB**: Without required sandboxing, if an ACP agent launches its own subprocesses outside CPB's terminal broker, those subprocesses are not subject to CPB's env allowlist or output redaction. Subprocesses launched through CPB's terminal broker receive the same allowlisted environment as ACP adapter processes and the same sandbox wrapper when sandboxing is enabled.

3. **Network exfiltration**: `required` and `strict` deny network by default. If an operator explicitly sets `CPB_AGENT_SANDBOX_NETWORK=allow`, CPB cannot prevent an agent from sending data over that permitted network path.

4. **Trusted CPB host process**: The already-running CPB CLI/server process remains inside the trusted computing base. CPB-launched Hub/UI server children and ACP pool launches use allowlisted environments, but CPB cannot fully isolate secrets from a process that was itself started by the user with secrets already in its environment without moving that process into a separate OS/container boundary.

5. **Already-running processes**: Secrets already present in the environment of a running CPB server or ACP adapter process cannot be recalled.

6. **Future runtime binaries**: This package currently ships the Node runtime path. Any future separate runtime binary must use the same explicit env allowlist before being documented as part of CPB's controlled boundary.

## Early Access Positioning

CPB **reduces risk** through worktrees, env scrubbing, output redaction,
CPB-controlled guards, and default fail-closed process sandboxing. It is **not
automatically a full sandbox** unless required/strict OS sandboxing is enabled
and verified on the host. Users should:

- Run only against repositories and machines they control.
- Avoid storing real production credentials in CPB-accessible paths.
- Assume that a determined agent process can exfiltrate data through channels CPB does not control.
