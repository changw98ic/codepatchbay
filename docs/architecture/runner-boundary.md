# Runner Boundary Contract

The runner-contract module (`core/workflow/runner-contract.js`) defines the boundary between the workflow orchestration layer and concrete runner implementations. It specifies the shape of data that crosses this boundary and the rules that enforce it.

## Job Input

Every runner receives a validated job input object with the following required fields:

| Field | Description |
|-------|-------------|
| `project` | Project identifier |
| `jobId` | Unique job identifier |
| `task` | Human-readable task description |
| `workflow` | Workflow type (e.g. "standard") |
| `sourcePath` | Absolute path to the project source |
| `worktree` | Absolute path to the task worktree |
| `envRefs` | Secret references (e.g. `secret-ref://vault/key`) |

## Artifact Output

Runners produce artifacts written to the project output directory. The contract specifies the output shape but does not prescribe the transport mechanism.

## Event Stream

Runners emit structured events to the job event log (JSONL). Events are append-only and materialized into job state by the event store.

## Secret Boundary

Secrets must cross the boundary as `envRefs` references, never as raw values. Job input containing a `secrets` field is rejected at the boundary. This ensures sensitive material never enters the core workflow layer as plaintext.

## Cancellation

Runners support cancellation via lease expiry or explicit cancel signals. The contract defines the cancellation semantics; concrete implementations handle the signaling mechanism.

## Scope Note

This module provides local runner adapter creation and validation only. A distributed runner is outside the scope of this task.
