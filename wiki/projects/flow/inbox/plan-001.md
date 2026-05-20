## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-P0.7-project-concurrency-guard-supervisor-upgrade-boundary
- **Timestamp**: 2026-05-19T07:55:52+08:00

### Task

Use the promotion readiness plan plus the merged task-scope notes as source of truth:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-cpb-executable-app.md`
- `/Users/chengwen/dev/flow/docs/project-shortcomings-plan-plain.md`

Keep changes scoped, add/adjust tests, preserve existing behavior, and do not broaden into unrelated cleanup.

Implement merged P0.7: Project-Level Concurrency Guard plus supervisor upgrade checkpoint boundary. Add the project-level mutation lock for CPB-managed mutating runs; allow read-only/status without the lock; fail fast with project_lock_busy or explicitly queue through Hub for same-project concurrent mutations; support stale lock reconciliation and inspect/clear guidance. Fold in the executable-app supervisor safety boundary: no code hot-swap while a job is active, no new job claim when the current release differs from the supervisor executor, and emit a clear restart/re-exec-needed event between jobs. Different projects may still run concurrently only when their write scopes and locks are independent.

### Decided

- Treat the three task documents listed above as the implementation source of truth before editing code; do not implement adjacent P0/P1 items from those documents.
- Add one central project-level mutation guard for CPB-managed mutating runs instead of scattering ad hoc checks across command handlers.
- Direct same-project mutating runs should fail fast with `project_lock_busy`; Hub-submitted same-project mutations may queue only through the existing explicit Hub queue/claim path.
- Read-only and status operations must bypass the mutation lock and must remain usable while a mutation is active.
- Lock identity must be project-scoped and based on the existing canonical project identifier; include write-scope metadata so independent projects with independent write scopes can still run concurrently.
- Lock records must include enough metadata for operators and tests: project id, write scopes, owner job/run id, owner process/session when available, acquired timestamp, heartbeat or expiry timestamp, release/executor id when available, and stale/clear guidance.
- Supervisor release safety is a checkpoint boundary between jobs: no executor hot-swap while a job is active; after the active job exits, a release mismatch prevents new job claims and emits a restart/re-exec-needed event.
- Prefer existing state, logging, event, queue, and test patterns. Do not add dependencies.

### Rejected

- Global process-wide lock | It would incorrectly block different projects whose write scopes are independent.
- Locking read-only/status commands | It would make observability worse during exactly the failures operators need to inspect.
- Silent waiting for direct same-project mutations | It hides contention and makes callers believe work has started when it has not.
- Supervisor code hot-swap during active jobs | It risks executing one job with mixed release semantics.
- Updating fake LLM responders, snapshots, or broad fixtures just to make tests pass | Production behavior should be verified through focused lock/supervisor tests or purpose-built test doubles.
- Broad cleanup/refactor while touching orchestration code | The task is a promotion-readiness must-have and should stay reviewable.

### Files

- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source document for P0.7 readiness requirements.
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-cpb-executable-app.md` — read-only source document for supervisor executable-app upgrade boundary.
- `/Users/chengwen/dev/flow/docs/project-shortcomings-plan-plain.md` — read-only source document for merged task-scope notes.
- CPB mutating-run entrypoint files — locate the existing code path that creates/claims CPB-managed runs and add lock acquisition/release there.
- CPB read-only/status handler files — locate existing status/inspection paths and verify they bypass the lock.
- Hub queue/claim files — locate the existing Hub queue behavior and route explicit queued same-project mutations through it without hidden waiting in direct execution paths.
- Supervisor executor/release checkpoint files — locate where the supervisor identifies the current executor/release and claims jobs; add mismatch gating and restart/re-exec event emission there.
- Existing orchestration tests plus new focused tests — add or adjust tests only for project lock behavior, stale lock reconciliation, Hub/direct contention behavior, independent-project concurrency, and supervisor release checkpoint behavior.

### Evidence

- Planning-only phase: no terminal commands were run.
- The task statement explicitly requires writing this codex-to-claude plan to `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/plan-001.md`.
- The plan is constrained to merged P0.7 only and references the three provided source documents by absolute path.

### Risks

- The exact lock storage surface is unknown until implementation reads the code. Use the repository's existing durable state or Hub coordination storage rather than adding a new persistence layer.
- Stale-lock criteria can accidentally clear a live job if based only on elapsed time. Reconcile using heartbeat/owner liveness and Hub active-job state when available.
- The supervisor release identifier may already exist under a different name. Reuse the existing release/build/executor identity instead of inventing a parallel concept.
- Concurrency tests can become flaky if they rely on wall-clock sleeps. Prefer deterministic barriers, fake clocks, temp state directories, and explicit lock heartbeats.

### Scope

**目标**: Implement the merged P0.7 promotion-readiness must-have: project-level mutation serialization for CPB-managed mutating work plus supervisor release checkpoint safety between jobs.

**涉及文件**:
- The three source documents listed in `Files` are read-only references.
- The implementation files are the existing owners of CPB run classification, mutating-run start/claim, Hub queue/claim, lock/state persistence, status/inspection, event emission, and supervisor release/job-claim logic.
- The test files are the existing nearest tests for CPB orchestration, Hub queue behavior, lock/state behavior, and supervisor job claiming, with new focused tests added where coverage is missing.

**实现步骤**:
1. Read the three source documents and extract only the merged P0.7 requirements. Record any discovered names for current Hub queueing, supervisor release identity, status handlers, and existing event conventions in the final deliverable.
2. Identify the existing CPB operation classification point. Add or reuse a small explicit classifier that distinguishes mutating runs from read-only/status operations. Mutating operations include any CPB-managed path that can write project files, change run state, claim jobs, update worktree/task state, or perform execution. Read-only/status paths include inspection, status, logs, and lock inspection.
3. Implement the project mutation lock at the narrowest shared mutating-run boundary. Acquisition must be atomic for a canonical project id, must include write scopes, and must release in a `finally`/completion path. If acquisition fails for a direct run, return/emit `project_lock_busy` with project id, lock owner metadata, age, stale status, and inspect/clear guidance.
4. Preserve explicit Hub queue semantics. If same-project work enters through the Hub queue path, keep it queued/claimed according to existing Hub behavior and ensure the claim path acquires the project mutation lock before executing. Do not add implicit waiting to direct local mutating runs.
5. Allow read-only/status without the lock. Add tests proving status/log/inspection commands succeed while a same-project mutation lock is active and do not mutate or clear the lock.
6. Add stale lock reconciliation. A stale lock may be reconciled only when the heartbeat/expiry is stale and the recorded owner is not active according to available owner liveness or Hub active-job state. Provide lock inspect output and clear guidance. Manual clear must require an explicit clear/force path and must report what lock was cleared.
7. Add independent-project concurrency behavior. Lock keys must not collapse all projects into one global guard. Tests should prove two different canonical project ids with independent write scopes can acquire separate locks concurrently.
8. Add the supervisor upgrade checkpoint boundary. Capture the supervisor executor/release id at supervisor startup or executor initialization. While a job is active, keep using that executor and do not hot-swap code. Before claiming a new job, compare the current release id to the supervisor executor release id.
9. On supervisor release mismatch between jobs, refuse new job claims and emit a clear restart/re-exec-needed event using the existing event/log channel. If no existing event name fits, use `restart_reexec_needed` with fields for supervisor executor release, current release, project/job context when available, and restart guidance.
10. Add focused tests before or alongside implementation. Cover direct same-project contention, Hub explicit queue/claim behavior, read-only/status bypass, stale lock inspect/reconcile/clear guidance, independent project concurrency, active-job no-hot-swap, release-mismatch no-new-claim, and restart/re-exec-needed event emission.
11. Run the repository's relevant unit/integration test commands and any lint/typecheck commands that are standard for this project. Do not change fake/mock responders, snapshots, or unrelated fixtures unless a test double itself is the product bug and the deliverable explains why.
12. Write `deliverable-001.md` with changed files, tests run, important outputs, remaining risks, and any deviations from this plan.

**注意事项**:
- Keep the diff small and local to orchestration/lock/supervisor owners.
- Preserve existing external behavior except for the required contention, stale-lock, and supervisor-upgrade safety outcomes.
- Use existing error/result/event shapes where possible, but the contention code must be externally recognizable as `project_lock_busy`.
- Do not broaden into unrelated cleanup, UI work, model routing, or non-P0.7 promotion readiness tasks.
- Do not use a global lock that serializes unrelated projects.
- Do not let stale-lock cleanup clear a live active job.

## Next-Action

Implement the scoped P0.7 changes above, add/adjust the focused tests, run the relevant verification commands, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-001.md` for Codex review.

## Acceptance-Criteria

- [ ] The implementation explicitly cites or summarizes the relevant P0.7 requirements from all three source documents in the deliverable.
- [ ] CPB-managed mutating runs acquire a canonical project-level mutation lock before mutation/claim/execution begins.
- [ ] A second direct mutating run for the same project fails fast with `project_lock_busy` and includes owner, age/staleness, inspect, and clear guidance.
- [ ] Same-project mutations submitted through the explicit Hub queue path do not run concurrently; they queue/claim through Hub and still acquire the project lock before execution.
- [ ] Read-only/status/log/inspection operations succeed without acquiring the project mutation lock, including while a same-project mutating run is active.
- [ ] Stale lock reconciliation is implemented and tested with deterministic stale-owner conditions; live active jobs are not cleared as stale.
- [ ] Operators have an inspect path and an explicit clear path/guidance for stale locks.
- [ ] Different projects with independent write scopes can run concurrently and have independent lock records.
- [ ] The supervisor does not hot-swap executor code while a job is active.
- [ ] When the current release differs from the supervisor executor release, the supervisor does not claim a new job after the current job finishes.
- [ ] A clear restart/re-exec-needed event is emitted between jobs on release mismatch.
- [ ] Focused tests cover direct contention, Hub queued behavior, read-only/status bypass, stale reconciliation, independent-project concurrency, and supervisor release mismatch.
- [ ] Relevant lint/typecheck/test commands pass, or any failure is documented with root cause and residual risk.
- [ ] No unrelated cleanup, dependency additions, fake responder rewrites, or broad fixture/snapshot updates are included.
