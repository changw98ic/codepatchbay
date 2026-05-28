# ACP Provider Validation

Deterministic fake-agent tests cover the persistent ACP pool lifecycle: process
spawn, reuse, recycle by request count, recycle by age, recycle by idle timeout,
429 handling, generic error handling, timeout cleanup, and pool shutdown.

Real providers still need live validation because they introduce behavior the
fake agent cannot model:

- Long-lived session continuity and response quality over multi-hour use.
- Provider-specific 429 formats and cooldown windows.
- Stdio transport stability under repeated prompts.
- Tool-call protocol compatibility for file writes and session updates.
- Process growth under concurrent project scans.

Recommended live validation:

```bash
export CPB_ACP_PERSISTENT_PROCESS=1
export CPB_ACP_CLAUDE_COMMAND=claude-agent-acp

./cpb hub acp --json
./cpb soak --live --max-duration-ms 28800000 --status-interval-ms 300000 --max-process-count 5
```

During the run, inspect `./cpb hub acp --json` and confirm:

- `providerProcessReuse` is `true`.
- `providerProcessPid` remains stable across multiple prompts.
- `providerProcessHealthy` remains `true` between requests.
- `spawnCount` stays low unless recycle thresholds are reached.
- `recycleCount` and `lastRecycleReason` match intentional recycle triggers.
- `rateLimitedUntil` is set on 429 and clears after cooldown.
- `sessionAgeMs` grows between requests.

The live soak is the acceptance gate for provider-specific behavior. Fake-agent
tests prove deterministic pool policy, not unattended real-provider reliability.

## Headless vs UI ACP Lanes

All normal code phases (plan, execute, verify, review, repair, retries, fixes)
resolve to `acpProfile: "headless"` unless explicitly configured as `ui`.

Headless `codex-acp` launches receive process-local config overrides that
disable Computer Use, Browser, Chrome plugins, and clear notify hooks. Global
Codex config is never modified.

Codex ACP cannot accept non-empty `session/new.mcpServers`, so CPB still sends
`mcpServers: []` for Codex sessions in both headless and UI lanes. Built-in
CodeRAG is mounted through process-local Codex config instead: CPB launches
`codex-acp` with
`mcp_servers.coderag.*` overrides that bridge the CodeRAG SSE endpoint through
`supergateway`. Other ACP providers continue to receive CodeRAG through
`session/new.mcpServers`.

At runtime, headless sessions deny Computer Use, Browser, Chrome, desktop
automation, and MCP-shaped UI tool calls before side effects occur. Every
denial is recorded as an audit event.

**Explicit UI lane**: set `acpProfile: "ui"` with a non-empty `uiLaneReason`
via CLI (`--acp-profile ui --ui-lane-reason "..."`), API request body, or
queue entry metadata.

**Why prompt-only gating is insufficient**: mounted UI tools can still be
selected by the model regardless of prompt instructions. CPB enforces at three
layers: launch (config overrides strip plugins), request (tool call denial),
and audit (structured denial events).

**Escalation markers**: agents may emit `needs_ui_observation`,
`needs_browser_check`, or `blocked_requires_ui_lane` when UI access is
necessary. CPB records these as structured events for manual review.
