# CPB trace and replay contract

CPB records a durable, generic coding-task trace. Benchmark metadata and
external evaluator answers are not solver inputs. An external evaluation may
only be appended after execution as `external_evaluation_recorded`; the event
is audit-only and is not materialized into job state, prompts, routing, retry,
or the completion gate.

## Trace chain

For a mutating job, `cpb jobs trace <project> <jobId> --replay --json` reports:

1. the original task and agent-routing decision;
2. prompt artifacts and ACP tool-call audit events;
3. attempt, retry, solver iteration, candidate, and provider-handoff identity;
4. verification commands, verifier results, and repair decisions;
5. the completion-gate decision and candidate identity;
6. a persisted candidate replay bundle containing the base commit, binary Git
   patch, patch digest, candidate tree, and bundle digest;
7. any post-completion independent evaluation and the boundary where it
   contradicts CPB.

The replay response contains a `coverage` matrix. Missing required links are
reported explicitly; an incomplete trace is not presented as a complete
explanation.

Test coverage is present when the completion report records verification commands or when the ACP trace contains an explicit recognized test command. ACP adapters may label a terminal command as either `terminal` or `execute`; replay accepts both labels but does not treat arbitrary execute tools as tests.

## Execution sandbox evidence

Every real ACP phase records an `agent_execution_policy` span from the launch
audit. It distinguishes the configured Codex sandbox from the effective phase
permission and identifies the enforcing layer. This distinction is required
because OS sandboxes such as macOS `sandbox-exec` cannot be nested reliably.

- With CPB's required outer sandbox active, Codex's redundant child sandbox is
  disabled and the bounded outer policy enforces the effective phase mode.
- Without a required outer sandbox, Codex enforces the effective phase mode.
- Only `execute` and `remediate` receive effective `workspace-write` access.
  Planning, review, and verification remain effectively `read-only`.

The span records `effective_sandbox_mode`, `sandbox_enforcement`, outer sandbox
provider, whether the worktree was writable, and the non-interactive approval
policy. A configured `danger-full-access` value is therefore never interpreted
without the accompanying effective mode and enforcing layer.

## Candidate reconstruction

The execute phase stores both `candidate-artifact` and
`candidate-replay-bundle`. The bundle is independent of the mutable worktree's
unreachable Git tree object. Replay validates the bundle hash, patch hash,
byte count, base commit, and resulting tree hash. Binary files, modes,
deletions, symlinks, and non-ignored untracked files participate in the
reconstructed tree.

The patch body is omitted from normal replay output. Include it explicitly:

```sh
cpb jobs trace <project> <jobId> --replay --include-patch --json
```

## External evaluation

Import a generic independent evaluator result after the job terminates:

```sh
cpb jobs record-evaluation <project> <jobId> \
  --file evaluation.json \
  --data-root <project-runtime-root>
```

The input shape is:

```json
{
  "evaluator": "independent-harness",
  "status": "failed",
  "candidateIdentityHash": "sha256:...",
  "summary": "A required behavior still fails",
  "checks": [
    {
      "name": "focused behavior check",
      "command": "project-specific test command",
      "status": "failed",
      "reason": "assertion failed"
    }
  ]
}
```

Replay classifies contradictions as:

- `evaluation_lineage_mismatch`: the evaluator scored a different candidate;
- `test_selection_gap`: external failing checks were absent from CPB evidence;
- `completion_false_positive`: the same candidate and covered checks failed
  after CPB declared completion;
- `completion_false_negative`: CPB rejected a candidate accepted externally;
- `decision_aligned`: internal and external outcomes do not contradict.

These classifications diagnose CPB's decision boundary. They never alter the
already completed task or trigger a solver retry.
