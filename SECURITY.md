# Security Policy

CodePatchBay is a local coding-agent delivery runtime. Its CLI, Hub, workers, and agent processes can read files, write files, run commands, and modify projects that an operator places in scope.

## Supported versions

Only the latest version on the default branch is supported during the alpha period. Older application behavior and retired command paths are not maintained.

## Current security boundaries

- **CLI and workers:** Treat every `cpb pipeline` run as code execution against the target repository. Run CodePatchBay only against projects you control, review the plan and resulting changes, and avoid `--dangerous` unless unrestricted ACP permissions are intentional.
- **Hub API:** `cpb hub start` runs the native Node HTTP service in `server/index.ts`. It exposes authenticated identity, health, and project-list routes plus an internal worker-state route. The default bind is loopback. Configure `CPB_HUB_SERVICE_TOKENS_FILE` or `CPB_HUB_OIDC_CONFIG_FILE`; anonymous development mode is an explicit loopback-only exception. A non-loopback cleartext bind also requires `CPB_HUB_ALLOW_INSECURE_HTTP=1` and should sit behind a trusted TLS endpoint.
- **Stream service:** `cpb stream` runs the separate native HTTP/SSE service in `server/services/stream/stream-server.ts`. It exposes job, event-stream, and wiki data. Set `CPB_STREAM_BEARER_TOKEN`, restrict `CPB_STREAM_ALLOWED_ORIGINS`, and keep the default loopback bind unless the network is explicitly secured. `CPB_STREAM_ALLOW_ANONYMOUS_DEV=1` is loopback-only.
- **Agent execution:** The default required sandbox must be available or agent launch fails closed. `CPB_AGENT_SANDBOX=strict` also denies network and subprocess access by default. Provider-internal file access and any network access explicitly allowed by the operator remain outside CPB's full control.
- **GitHub ingress:** The current GitHub transport verifies HMAC-SHA256 webhook signatures when an external webhook entrypoint is wired. Starting the Hub alone does not create a generic public webhook route.

## Credentials and sensitive data

- Do not commit API keys, bearer tokens, signing keys, `.env*` files, runtime state, or provider credentials.
- Keep Hub token and OIDC policy files outside the Hub root with owner-only permissions so backups do not copy authorization material.
- Prefer environment-based stream tokens over command-line token arguments, which may remain in shell history or process listings.
- Do not place secrets in task text, issue comments, logs, or artifacts. CodePatchBay narrows child environments and redacts known secret patterns, but redaction is not proof that arbitrary secret formats cannot leak.
- Keep release-signing private keys and the verifier's trusted public-key store outside the candidate source tree.

## ACP headless policy

Headless ACP launches deny UI automation capabilities before side effects occur. Launch-time configuration removes UI plugins, runtime policy rejects UI tool calls, and denials are written as structured events. Prompt instructions alone are not the enforcement boundary.

An intentional UI lane requires `acpProfile: "ui"` and a non-empty `uiLaneReason` through the CLI, API request body, or queue metadata.

## Known alpha limitations

- CodePatchBay is designed for controlled local or private deployments, not direct public-internet exposure.
- TLS termination is external to the Node HTTP services.
- ACP adapter and provider behavior can affect the strength of permission enforcement.
- A process started with broader host credentials remains part of the trusted computing base; CodePatchBay cannot retroactively isolate secrets already available to that parent process.

See [Gateway security](docs/security/codepatchbay-gateway-security.md), [agent secret boundaries](docs/security/cpb-agent-secret-boundary.md), [Hub service tokens](docs/security/cpb-hub-service-tokens.md), [Hub OIDC authorization](docs/security/cpb-hub-oidc.md), and [Hub access-audit integrity](docs/security/cpb-hub-access-audit.md) for the detailed operating contracts.

## Reporting a vulnerability

Report security issues privately to the repository owner when possible. If no private contact is available, open a GitHub issue with minimal public detail and request a private disclosure path.

Include the affected version or commit, command or route, reproduction steps, expected impact, and whether credentials, filesystem access, or command execution are involved.
