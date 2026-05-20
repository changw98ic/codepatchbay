VERDICT: FAIL

Verification scope: inspected `deliverable-001.md`, referenced `inbox/plan-001.md`, and current implementation files `server/services/project-lock.js`, `bridges/run-pipeline.mjs`, and `server/services/supervisor.js` using non-terminal file preview. No terminal commands were executed.

Passed:
- The deliverable references the correct TASK-P0.7 scope and maps most plan acceptance criteria to changed files.
- A project-lock service exists with owner metadata, TTL fields, inspect/reconcile/force-clear APIs, and operation classifiers.
- `run-pipeline.mjs` and `recoverOneJob()` both attempt to acquire a project lock before mutating execution paths.

Failed:
- `acquireProjectLock()` is not atomic. It reads the lock file, then writes a temp file and renames it. Two concurrent callers can both read no existing lock, both return success, and the last rename wins. This fails the central requirement that mutating runs serialize through a canonical project-level mutation lock.
- `run-pipeline.mjs` does not release the project lock in a true top-level `finally`. The lock is acquired before `createJob`, setup, blocked-workflow handling, and phase execution; the release `finally` only wraps the later phase block. Errors before that block, and the `workflow === "blocked"` early return, can leave stale locks behind.
- Supervisor recovery acquires the project lock but does not renew it. A recovered job running longer than the default 30-minute TTL can have its lock expire while still active, allowing another mutating run to acquire the same project lock.
- The deliverable claims full acceptance, but the inspected implementation does not prove explicit Hub queued same-project behavior is preserved; the shown pipeline path marks dispatch started before lock acquisition and marks it failed on `project_lock_busy`.

Next:
- Rework lock acquisition to use an exclusive atomic create/claim strategy or another compare-and-swap-safe primitive.
- Wrap the entire post-acquisition pipeline lifecycle in one `try/finally`, including job creation, setup, blocked workflow, and all early returns.
- Add supervisor lock renewal/heartbeat for active recovered jobs.
- Add or expose focused tests that exercise true concurrent acquisition, early-return lock release, long-running supervisor recovery, and explicit Hub queue/claim behavior.
