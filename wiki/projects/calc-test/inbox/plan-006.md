# server/routes/channels.js:spawnPipeline — spawns `bash` without an `'error'` listener, so process launch failures (`ENOENT`, exec permission, EACCES, etc.) can emit uncaught child-process errors and destabilize the server; add bounded error handling and return a failure payload instead of relying on default error behavior.

## codex->claude
Phase: plan

## Scope
File to change during execution: `server/routes/channels.js` only.

## Task objective
Prevent uncaught child process launch errors from `spawnPipeline` by attaching bounded `'error'` handling for `spawn("bash", ...)`, and return a deterministic failure payload when launch fails (e.g., `ENOENT`, `EACCES`, permission issues), while preserving normal success behavior.

## Execution plan (CodePatchbay lane)
1. Confirm current `spawnPipeline` contract and response shape
   - Locate `spawnPipeline` in `server/routes/channels.js`, identify:
     - request payload/response schema,
     - how errors are currently surfaced in this route,
     - where the spawned process instance is created.
   - Acceptance criteria:
     - Route response payload format for both success and failure is documented in the plan with exact fields.
     - Existing callback/resolve flow for process output is understood before changes.

2. Add launch-state tracking around `spawn` call
   - Introduce a local boolean guard (`settled`/`resolved`) and helper `fail()` in `spawnPipeline` before spawning the process to prevent multiple completions.
   - Add bounded timeout for launch/response if required by existing route behavior.
   - Acceptance criteria:
     - Only one terminal response can be sent for each request.
     - Launch-phase state is reset/clean on both success and failure paths.

3. Add `'error'` listener for spawn-time failures
   - Attach an `.once('error', ...)` listener to the spawned child process immediately after creation.
   - On error, call `fail()` and return a structured JSON payload containing:
     - human-readable message,
     - machine-readable failure code,
     - normalized reason.
   - Use a consistent HTTP status for internal spawn failures (or existing route-consistent status), with no thrown uncaught exception.
   - Acceptance criteria:
     - Launch failures (`ENOENT`, `EACCES`, exec permission errors, invalid binary path) do not bubble as uncaught `Error`.
     - Response body clearly indicates failure and contains an error code.

4. Keep successful path unchanged and detach listeners safely
   - Preserve existing `stdout`/`stderr` and `close`/`exit` handling logic.
   - Ensure success path removes or ignores launch-failure listener after the child starts successfully.
   - Acceptance criteria:
     - Existing success behavior and payload remain unchanged for normal runs.
     - No additional event listener leaks in repeated calls (bounded listener count in memory profile).

5. Return payload shape and messaging consistency
   - Define a failure payload that aligns with current API style (e.g., `{ ok: false, error: "...", code: "..." }` or repository-standard equivalent).
   - Include request correlation metadata if route already carries it.
   - Acceptance criteria:
     - Failure payload contains at least `ok:false` (or equivalent explicit failure indicator) and an error code.
     - No ambiguous fallback to raw exception strings in client responses.

6. Optional guardrails (no functional scope expansion)
   - Add/adjust tests or notes for spawn launch failure behavior only if the project currently has route-level tests.
   - If no existing test coverage exists for this route, document exact manual verification steps (invalid shell path simulation, permission denial simulation).
   - Acceptance criteria:
     - Manual or automated checks exist for each of:
       - `ENOENT`-like spawn failure,
       - permission/eaccess-like spawn failure,
       - normal successful spawn.

## Acceptance criteria (end-to-end)
- A process launch failure in `spawnPipeline` returns a bounded failure payload and does not crash the server.
- No uncaught child-process `'error'` events are emitted for spawn invocation failures.
- Successful pipeline execution behavior and successful payload format remain intact.
- Change stays limited to behavior around spawning and error handling in `server/routes/channels.js`.

## Execution constraints
- Do not broaden scope beyond `server/routes/channels.js`.
- Do not add external dependencies.
- Keep edits minimal and avoid behavior changes outside spawn failure handling.
