# CPB Agent Secret Boundary

## What CPB Controls

CPB enforces secret protection at these boundaries:

### Child Process Environment

ACP/agent child processes receive only an explicit env allowlist:
- **Runtime basics**: `PATH`, `HOME`, `SHELL`, `TERM`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `CODEX_HOME`, `XDG_CACHE_HOME`, and CPB runtime vars.
- **Provider credentials**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION`.
- Arbitrary `*_TOKEN`, `*_KEY`, `*_SECRET`, `DATABASE_URL`, and similar env vars are **not** forwarded.

### Output Redaction

All CPB output surfaces redact secrets before persistence or emission:
- Diagnostics bundles (`/hub/diagnostics`)
- Observability summaries (`/hub/observability`)
- Event store persistence (JSONL event log)
- WebSocket broadcast output (stdout/stderr tails)
- Status responses and error messages

Redacted patterns: Bearer tokens, OpenAI/AWS/Google API keys, key=value pairs with secret-like keys, webhook URLs.

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

These boundaries remain outside CPB enforcement until OS/container sandboxing is added:

1. **Provider-internal filesystem access**: An ACP agent process can read files from the filesystem using its own I/O capabilities, bypassing CPB's broker. CPB only controls file reads that go through its own project-loader and knowledge-compose modules.

2. **Agent subprocess spawning**: If an ACP agent launches its own subprocesses outside CPB's terminal broker, those subprocesses are not subject to CPB's env allowlist or output redaction.

3. **Network exfiltration**: CPB cannot prevent an agent from sending data over the network if the agent has network access.

4. **In-process ACP pool**: The ACP pool (`bridges/acp-pool.mjs`) runs in-process and has access to the full `process.env`. Provider credentials passed to adapter processes are required for API calls and cannot be fully isolated within the same Node.js process.

5. **Already-running processes**: Secrets already present in the environment of a running CPB server or ACP adapter process cannot be recalled.

6. **Runtime binary**: The Rust runtime binary (`cpb-runtime`) receives the full parent env because it is a trusted CPB component performing file and state operations directly.

## Early Access Positioning

CPB **reduces risk** through worktrees, env scrubbing, output redaction, and CPB-controlled guards. It is **not yet a full sandbox**. Users should:

- Run only against repositories and machines they control.
- Avoid storing real production credentials in CPB-accessible paths.
- Assume that a determined agent process can exfiltrate data through channels CPB does not control.
