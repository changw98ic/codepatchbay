# Security Policy

CodePatchbay is an alpha local workflow prototype for Codex and Claude Code. It can cause agent processes to read files, write files, run commands, and modify target projects through ACP.

## Supported versions

Only the latest version on the default branch is considered supported during the alpha period.

## Important safety notes

- Run CodePatchbay only against projects you control.
- Do not expose the local Web UI to untrusted networks.
- Do not commit credentials, API keys, channel tokens, or provider secrets.
- Keep `channels.json` and `.env*` files local and ignored.
- Treat every `cpb pipeline` run as code execution against the target repository.
- Review plans and deliverables before using CodePatchbay on important repositories.
- Avoid `--dangerous` unless you explicitly accept unrestricted ACP permissions.
- Webhook endpoints for Feishu and DingTalk should be protected with verification tokens or secrets.
- Treat self-evolve as experimental and high risk.

## Reporting a vulnerability

Please report security issues privately to the repository owner when possible. If private contact is not available, open a GitHub issue with minimal public detail and ask for a private disclosure path.

Include:

- affected version or commit
- affected command, route, or workflow
- reproduction steps
- expected impact
- whether credentials, filesystem access, or command execution are involved

## Known alpha limitations

- The Web UI does not include authentication or RBAC.
- CodePatchbay is designed for local/private experimentation, not public internet exposure.
- Agent permission behavior depends on ACP adapter behavior and CodePatchbay environment variables.
- Clean-machine setup and long-running recovery have not been proven yet.
