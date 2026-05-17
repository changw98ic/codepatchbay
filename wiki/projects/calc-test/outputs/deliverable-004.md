## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: plan-006
- **Timestamp**: 2026-05-17T12:00:00Z

### Implemented
- Added bounded spawn error handling to `spawnPipeline` in `server/routes/channels.js`, matching the established pattern from `spawnBridge` in `server/routes/tasks.js`.
- Three-layer defense: try/catch for synchronous spawn errors (e.g. null bytes in args), `child.on('error')` for async launch failures (ENOENT, EACCES), and a `settled` boolean guard preventing double resolution.
- On spawn failure, returns `{ accepted: false, taskId, error }` with a `task:error` broadcast — no uncaught exceptions.
- On successful spawn, `'spawn'` event triggers `registerTask` and resolves `{ accepted: true, taskId, pid }`.
- Task registration only happens after confirmed successful spawn; no orphan registrations on failure.
- `handleReviewCommand` caller updated to `await spawnPipeline(...)` since the function now returns a Promise.

### Files Changed
- `server/routes/channels.js` — rewrote `spawnPipeline` with try/catch + Promise + settled guard + error/spawn/exit listeners; added `await` at `handleReviewCommand` call site

### Evidence

**Test results**:
```
ℹ tests 338
ℹ suites 54
ℹ pass 338
ℹ fail 0
ℹ duration_ms 40311.32625
```

**Key code snippet**:
```javascript
let child;
try {
  child = spawn("bash", [scriptPath, project, task, "3", "0"], { ... });
} catch (err) {
  log?.error(`spawnPipeline sync error for ${taskId}: ${err.message}`);
  return { accepted: false, taskId, error: err.message };
}

return new Promise((resolve) => {
  let settled = false;
  let registered = false;

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    broadcast({ type: "task:error", taskId, project, error: err.message, code: err.code || "SPAWN_FAILURE" });
    resolve({ accepted: false, taskId, error: err.message });
  });

  child.on("spawn", () => {
    if (settled) return;
    settled = true;
    registered = true;
    registerTask(taskId, project, "run-pipeline.sh", child.pid);
    resolve({ accepted: true, taskId, pid: child.pid });
  });

  child.on("exit", (code) => {
    if (registered) unregisterTask(taskId);
    broadcast({ type: "task:complete", ... });
  });
});
```

### Unresolved
- None

### Risks
- The `review-dispatch.mjs` spawn in `handleReviewCommand` (line ~92) uses fire-and-forget `.unref()` without error handling, but that was out of scope per plan constraints.

## Next-Action
Verify implementation satisfies plan-006.md Acceptance-Criteria. Key checks:
1. Spawn launch failure returns bounded failure payload, does not crash server.
2. No uncaught child-process `'error'` events for spawn invocation failures.
3. Successful pipeline behavior unchanged (response shape `{ accepted: true, taskId, pid }` preserved).
4. Changes limited to `server/routes/channels.js`.

## Acceptance-Criteria
- [x] Process launch failure returns `{ accepted: false, taskId, error }` — no crash
- [x] No uncaught child-process `'error'` events for spawn failures
- [x] Successful pipeline response format unchanged
- [x] Task only registered on confirmed successful spawn
- [x] `settled` guard prevents double resolution
- [x] Change limited to `server/routes/channels.js`
- [x] All 338 existing tests pass with zero regressions
