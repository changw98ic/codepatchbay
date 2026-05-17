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
