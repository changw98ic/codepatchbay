# CPB coding-task comparison

`npm run compare:coding -- --manifest <manifest.json> --output <report.json>` runs a generic coding-task comparison across three lanes:

1. `native_codex`: `codex exec --json` in a fresh worktree.
2. `cpb_codex`: the production CPB task route with every selected phase fixed to Codex.
3. `cpb_smart`: the same production task route with normal agent routing defaults.

This is not a benchmark adapter. The manifest accepts only repository, base revision, ordinary task text, Codex model/reasoning budget, total timeout, and post-terminal executable checks. Fields that encode an expected patch, reference answer, oracle, or expected test transition are rejected.

## Isolation boundary

Each lane starts from a detached worktree created from a comparison-local mirror. Before timing starts, CodeGraph is initialized for every lane. The solver permission contract is the same maximum worktree access, headless tool surface, approval policy, CodeGraph capability, and task timeout.

CPB workflow and plan mode come from the normal task router. Ordinary unprotected tasks use the existing `standard/light` path; protected or genuinely complex work can still select full planning and review. The comparison runner does not choose a shorter route based on evaluator data.

Within the light path, CPB may remove redundant model turns using production rules that are independent of the evaluator:

- An exact, unique CodeGraph symbol match may produce the frozen static file scope without a planner model turn. Ambiguous or missing matches fall back to normal checklist decomposition.
- Verification may remain deterministic only when risk is explicitly low or medium, no adversarial or real-path evidence is required, every required checklist item is static, candidate identity is stable, and at least one non-skipped focused test actually passed. Otherwise the normal verifier model runs.

These are fail-closed optimizations. They do not inspect post-terminal checks and they do not apply to high-risk, ambiguous, command-probe, manual, or real-path requirements.

Codex execution keeps native tool choice for small explicit scopes. CodeGraph remains available and is preferred for broad or ambiguous discovery, but CPB does not force a redundant first MCP call when a direct focused lookup is narrower. Codex's ACP message stream is also the default structured-result transport: CPB parses the compact final JSON response and persists the deliverable itself. It does not ask Codex to spend an extra tool call writing CPB metadata. Other agents retain the structured-file fallback, and operators can force either mode with `CPB_EXECUTOR_OUTPUT_TRANSPORT=file|chat`.

Codex phases use Codex's native phase sandbox by default: `workspace-write` for execute/remediate and `read-only` for other phases. This avoids a nested CPB `sandbox-exec` boundary changing git, package-manager, toolchain, and MCP availability relative to native Codex. An operator's explicit CPB outer-sandbox configuration still wins. The effective inner/outer enforcement is recorded in the ACP launch audit.

Headless Codex lanes disable the default `apps`, `plugins`, and `remote_plugin` features. This prevents an isolated coding run from opening the signed-in product-service MCP as an undeclared remote dependency. The comparison runner then adds only its declared local CodeGraph MCP. Both the native and CPB lanes use this boundary.

When outcome history is insufficient, every coding role retains Codex as the quality baseline. An alternative provider can replace it only through explicit configuration, a required independence rule, a concrete recovery handoff, or outcome evidence that clears the configured sample, confidence, score, and margin thresholds.

The two CPB solvers run in separate Node processes. Each worker starts the normal quota-delegate control-plane service before the job, records its startup and exit state in `solver.controlPlane`, and stops it before returning. This keeps provider failure recording and recovery behavior equivalent to a production worker instead of allowing a missing delegate to hide the original failure. Their serialized input deliberately omits evaluator commands and arguments. The parent waits for the solver process to exit or be killed at the hard deadline before it captures the candidate and starts any evaluator. Native Codex receives only the ordinary task text as its prompt.

Candidate identity is captured with CPB's production candidate-artifact implementation before evaluation. It is captured again after evaluation; a check that changes the candidate tree makes the evaluation inconclusive rather than silently scoring a different patch.

For CPB lanes, the post-terminal result is appended as `external_evaluation_recorded` audit evidence and then included in the normal job replay. It is never consumed by routing, retry, prompts, checklist construction, verification, or the completion gate.

## Manifest

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "ordinary-defect",
      "repository": "/absolute/or/manifest-relative/repository",
      "base": "HEAD",
      "task": "Fix the defect while preserving the public API.",
      "model": "gpt-5.5",
      "reasoningEffort": "high",
      "timeoutMs": 300000,
      "checks": [
        {
          "id": "independent-check",
          "command": "node",
          "args": ["/absolute/path/to/post-terminal-check.mjs"],
          "timeoutMs": 120000
        }
      ]
    }
  ]
}
```

Commands are executed directly without a shell. `cwd`, when supplied, must remain under the lane worktree. Lane order rotates by task index to reduce fixed ordering bias. `--keep-worktrees` retains the isolated runtime roots for diagnosis; otherwise only the report is retained.

Every solver is launched under process-tree control. Timeout and abort cleanup captures detached descendants before terminating the root, then performs TERM and KILL passes. After a lane reaches any terminal state, the runner also removes residual processes whose command line still references that lane's exact worktree. This covers MCP servers that detach during an otherwise normal solver exit.

## Evidence and interpretation

The report separates solver time from evaluator time and retains unknown token/tool telemetry as `null`. It records input, evaluator, and permission-contract fingerprints; base SHA; candidate/tree/patch identities; correctness; first-pass status; repair count; failed tool calls; CLI/adapter versions; CPB replay; and the internal-versus-external decision boundary.

The primary regression signal is `native_codex` correct while `cpb_codex` is incorrect for the same fingerprinted task. Diagnose that result from the first trace divergence and remove CPB restrictions or orchestration overhead before adding any new policy layer.

An equally important signal is a correct external result paired with a non-completed CPB status. The replay classifies this as a decision-boundary defect rather than a solver defect. For example, a legitimate agent-written regression test must be associated with already scoped production changes; it must not make a correct candidate fail merely because the frozen production scope did not predeclare a new test file. The association remains fail-closed: every non-test file must already be mapped, and any unrelated production/configuration/script change still blocks completion.

External test-transition failures should therefore be diagnosed by evidence boundary, not by special-casing their names:

- A previously failing behavior still fails: implementation, task understanding, localization, or test-selection failure.
- A previously passing behavior regresses: compatibility or blast-radius failure.
- All independent checks pass but CPB fails: internal verifier/completion false negative.
- CPB completes but an independent check fails: evidence-selection or completion false positive.
- No internal completion decision exists before timeout: orchestration-budget or recovery failure.

The external evaluator supplies the final observation only after termination. It never supplies the expected transition to the solver.
