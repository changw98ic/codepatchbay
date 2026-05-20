## Handoff: codex -> claude — GitHub issue #27: P0.9b: Add project-aware parallel scheduling across multiple projects

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: GitHub issue #27: P0.9b: Add project-aware parallel scheduling across multiple projects
- **Timestamp**: 2026-05-20T00:00:00+08:00

### Decided
- Source of truth is GitHub issue #27: https://github.com/changw98ic/codepatchbay/issues/27
- Implement project-aware queue claiming in CPB, centered on `claimEligible({ workerId, projectId?, maxActivePerProject })`.
- Same-project mutating work is serialized by default: treat queue entries as mutating unless `entry.metadata.mutating === false`.
- Different projects may be claimed concurrently as long as provider/global capacity is available.
- Project lock state should be derived from active queue entries, not stored as a separate durable lock file.
- Preserve the existing top-level queue status fields and add per-project status so current callers remain compatible.

### Rejected
- Global FIFO `dequeue()` selection — it blocks workers behind a busy project and is the bug described in the issue.
- Treating provider slot exhaustion as a project lock — provider/global limits must stay separate from project mutation locks.
- Rewriting the whole worker/runtime stack — issue scope is queue claiming, worker startup mode, status/API/UI visibility, and focused tests only.
- Adding new dependencies for locking — use a small local lock/atomic update pattern consistent with existing file-backed queue code.

### Evidence
- Issue body requires project-aware queue claiming, default same-project mutation serialization, cross-project concurrency, skipping busy projects, active project/busy reason tracking, separate provider/global concurrency limits, and worker startup for one project or a project pool.
- Current public surface found in the repository includes `server/services/hub-queue.js`, `bridges/project-worker.mjs`, `server/routes/hub.js`, `cpb`, and dashboard files under `web/src/pages/`.

### Files
- `server/services/hub-queue.js`
- `server/routes/hub.js`
- `server/services/runtime-cli.js`
- `runtime/cpb-runtime/**` if the existing Rust queue runtime mirrors Node queue functions
- `bridges/project-worker.mjs`
- `cpb`
- `web/src/pages/Dashboard.jsx`
- `web/src/pages/Dashboard.test.jsx`
- `tests/hub-queue.test.mjs`
- `tests/hub-queue-contract.test.mjs`
- `tests/cpb-worker-cli.test.mjs`
- `tests/cpb-hub-queue-cli.test.mjs`
- `tests/routes-hub.test.mjs`

### Scope

**目标**: Implement issue #27 with focused CPB changes: workers must skip busy projects, claim eligible work from other projects, keep same-project mutating tasks serialized, report per-project queue/lock state, and expose enough API/UI detail for active/busy/eligible work.

**涉及文件**:
- `server/services/hub-queue.js` — add `claimEligible`, stale claim recovery, per-project active/lock projection, and per-project queue status counts.
- `server/routes/hub.js` — expose project-aware claim behavior through `/hub/queue/dequeue` or a new `/hub/queue/claim` route while keeping existing response shape compatible.
- `server/services/runtime-cli.js` and `runtime/cpb-runtime/**` — keep Rust runtime queue behavior in parity only if the current queue functions are already mirrored there.
- `bridges/project-worker.mjs` — replace `peekNext` + `updateEntry` claiming with `claimEligible`; allow a worker to serve one project or a pool of eligible projects.
- `cpb` — add a tight worker startup flag such as `cpb worker run --pool` while preserving existing `cpb worker run [path] [name]` behavior.
- `web/src/pages/Dashboard.jsx` — show active projects, busy/blocked project reason, and eligible queued work from the new queue status payload.
- `web/src/pages/Dashboard.test.jsx` — cover the new dashboard rendering without broad UI rewrites.
- `tests/hub-queue.test.mjs` and `tests/hub-queue-contract.test.mjs` — unit/contract coverage for project-aware claiming, serialization, stale recovery, provider exhaustion, and status projection.
- `tests/cpb-worker-cli.test.mjs`, `tests/cpb-hub-queue-cli.test.mjs`, `tests/routes-hub.test.mjs` — focused integration coverage for worker pool startup, CLI status output, and route payloads.

**实现步骤**:
1. Add queue helpers in `server/services/hub-queue.js`:
   - `isMutatingEntry(entry)` returns true unless `entry.metadata?.mutating === false`.
   - `prioritySort(a, b)` reuses existing priority and created-at ordering.
   - `buildProjectQueueStatus(entries)` returns counts by project plus active lock details: `busy`, `busyReason`, `activeMutating`, `claimedBy`, `claimedAt`, `workerId`, and active entry IDs.
   - A local queue write lock for claim/update critical sections so concurrent workers cannot claim two mutating entries for the same project.
2. Implement `claimEligible(hubRoot, { workerId, projectId, maxActivePerProject = 1, claimTimeoutMs, providerSlotsAvailable = true } = {})`:
   - If `providerSlotsAvailable === false`, return `{ entry: null, reason: "provider-slots-exhausted" }` and do not mutate queue entries.
   - Recover stale `in_progress` entries older than `claimTimeoutMs` by resetting them to `pending` before computing active project locks.
   - Filter pending entries by optional `projectId`.
   - Sort by priority/created time.
   - Skip mutating entries whose project already has `maxActivePerProject` active mutating entries.
   - Claim the first eligible entry by setting `status: "in_progress"`, `claimedBy`, `workerId`, `claimedAt`, and `updatedAt`.
   - Return enough metadata for callers/UI: claimed entry, skipped busy projects, active project locks, and no-eligible reason.
3. Keep existing APIs compatible:
   - Make existing `dequeue()` delegate to `claimEligible()` with a generated or provided worker identity where practical.
   - Extend `queueStatus()` to preserve `total`, `pending`, `inProgress`, `completed`, `failed`, and `cancelled`, and add `projects`, `activeProjects`, and `eligibleProjects`/`eligibleQueued` fields.
   - Update `listQueue()` only as needed for `projectId` and status filters; avoid behavior changes outside the issue.
4. Update routes and CLI:
   - In `server/routes/hub.js`, pass `workerId`, optional `projectId`, `maxActivePerProject`, and provider-slot signal from request body/query to the claim path.
   - Keep `/hub/queue/dequeue` usable by existing clients; optionally add `/hub/queue/claim` if that is cleaner, but do not remove existing endpoints.
   - In `cpb hub queue-status`, print per-project pending/active counts and busy reason in human output; keep `--json` as the full status object.
5. Update `bridges/project-worker.mjs`:
   - Replace `peekNext()` and the manual `updateEntry()` claim with `claimEligible()`.
   - Preserve single-project mode with `--project <id>`.
   - Add pool mode, e.g. `--pool`, where no single project is required and the worker claims from all eligible queued projects.
   - For pool mode execution, load the project from `entry.projectId`, use that project `sourcePath`, and include worker identity in queue/dispatch records.
   - Before claiming, check provider/global capacity separately from project locks; if exhausted, do not claim and sleep until the next poll.
6. Update UI:
   - In `Dashboard.jsx`, consume the extended queue status payload.
   - Show active projects, busy reason such as `active-mutating-task`, claimed worker identity/time, and eligible queued work by project.
   - Keep the UI small and dashboard-local; no navigation or design-system rewrite.
7. Add focused tests:
   - Two projects: with project A already `in_progress`, `claimEligible` skips pending A work and claims project B.
   - Same project: two mutating pending entries cannot both be active when claimed by concurrent/sequential workers with `maxActivePerProject: 1`.
   - Stale recovery: old active claim resets and can be reclaimed; non-stale active claim continues to block same-project mutating work.
   - Provider exhaustion: when provider/global slots are unavailable, no entry is claimed even if project locks are free.
   - Queue status: reports pending/active counts by project and includes active project busy reason/worker fields.
   - Worker pool mode: startup can run without a single `--project`, claims eligible queued work from another project, and still preserves existing single-project startup behavior.
   - Route/CLI/UI tests assert the new status fields are exposed and rendered.

**注意事项**:
- Keep issue scope tight; do not refactor unrelated ACP, dispatch, dashboard, or pipeline behavior.
- Do not edit fake/mock responders, snapshots, fixtures, or test doubles merely to force tests through; only add/update tests that directly cover issue #27 behavior.
- Make queue status additions backward compatible so existing callers reading top-level counts still work.
- Do not allow a provider/global slot check to mark a project busy; provider exhaustion is a separate scheduler no-claim reason.
- Keep non-mutating opt-out narrow and explicit with `metadata.mutating === false`; default remains serialized mutating work.
- If Rust runtime queue commands are active under tests or production flags, update them for parity or deliberately route the new claim API through Node with a documented test.

### Risks
- Concurrent file-backed claims can race if `claimEligible` is not protected by a queue-level critical section.
- Rust runtime parity may be required if `shouldUseRustRuntime()` is enabled in CI or user environments.
- Provider slot availability may not expose exactly the same shape across ACP pool modes; keep the capacity helper defensive and covered by tests.
- Dashboard tests may need small mock payload updates to include the new queue status structure.

## Next-Action
Implement the scoped CPB change above for GitHub issue #27, run the focused Node/web tests plus existing affected queue/worker tests, then write `deliverable-128.md` with changed files, test output, and any remaining risk.

## Acceptance-Criteria
- [ ] `claimEligible({ workerId, projectId?, maxActivePerProject })` exists and is used by worker/route claiming instead of global FIFO dequeue for scheduler work.
- [ ] With two projects and one active mutating task in project A, a worker can skip project A pending entries and claim project B.
- [ ] Same-project mutating tasks remain serialized by default and never run concurrently when `maxActivePerProject` is 1.
- [ ] Different projects can be active concurrently when provider/global capacity is available.
- [ ] Provider/global slot exhaustion prevents claiming without recording a project busy lock.
- [ ] Stale active claims are recovered according to claim timeout and then become claimable.
- [ ] Queue entries track `claimedBy`, `claimedAt`, and `workerId` on claim.
- [ ] Queue status reports pending/active counts by project plus active project busy reason and worker identity.
- [ ] Worker startup supports both one-project mode and pool-of-projects mode.
- [ ] Dashboard shows active projects, busy project reason, and eligible queued work.
- [ ] Focused tests cover two-project parallelism, same-project serialization, stale claim recovery, provider slot exhaustion, route/CLI status, and dashboard rendering.
- [ ] All affected tests pass and code style remains consistent with existing CPB patterns.
