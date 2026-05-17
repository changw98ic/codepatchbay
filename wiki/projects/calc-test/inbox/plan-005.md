# server/services/review-session.js: sessionFile/getSession/updateSession derive session paths from unvalidated sessionId values, so crafted IDs with separators can escape reviewsDir and target arbitrary JSON files outside the session store.

## Handshake
- From: codex
- To: claude
- Phase: plan
- Date: 2026-05-17
- Task: Prevent path traversal in review-session session storage functions by validating `sessionId` before filesystem resolution.

## Objective
- Stop untrusted `sessionId` values from influencing absolute/escaped paths in `sessionFile`, `getSession`, and `updateSession`.
- Preserve existing session lookup/write behavior for valid IDs.
- Add guardrails so malformed IDs fail fast with explicit, non-sensitive errors.

## Scope
- Primary target: `server/services/review-session.js`
- No behavioral changes outside review session pathing and error handling.
- No schema changes or data migrations required.

## Plan (7 steps)

1. Audit current call sites and boundary conditions.
   - Review existing implementations of `sessionFile`, `getSession`, `updateSession`, plus all call paths that pass `sessionId`.
   - Acceptance criteria:
     - All paths to `sessionFile/getSession/updateSession` are enumerated.
     - A list of currently accepted session ID formats (including any historical exceptions) is documented.
     - No other filesystem writes/read logic is planned to change unless it depends on validated IDs.

2. Define a strict session ID contract for `review-session` storage.
   - Implement a canonical rule that constrains `sessionId` to safe characters only (for example:
     `^[A-Za-z0-9_-]+$` with fixed length limits, plus any existing required prefix/suffix rules).
   - Reject any separator-like, whitespace, control, dot-dot, or path separator characters before path construction.
   - Acceptance criteria:
     - Exactly one validator exists and is used by all three target functions.
     - Inputs with `/`, `\`, `..`, `%2F`, `%5C`, newline, null byte, and absolute-path prefixes are rejected.

3. Add a dedicated normalization/validation utility in `server/services/review-session.js`.
   - Create a private helper (e.g. `normalizeSessionId(sessionId)`) that:
     - checks type (`string`, non-empty),
     - applies the contract from Step 2,
     - returns sanitized ID (or throws domain error),
     - optionally returns a deterministic file-safe token if normalization is needed.
   - Acceptance criteria:
     - Utility rejects all malicious samples with a deterministic error type.
     - Utility preserves previously valid IDs unchanged to avoid breaking IDs already in store.

4. Refactor `sessionFile` construction to be non-traversable by design.
   - Replace direct interpolation/concatenation with `path.join(reviewsDir, `${safeSessionId}.json`)` after validation.
   - Ensure path is resolved and confirmed to be within `reviewsDir` before use (`path.resolve` + prefix check, if needed).
   - Acceptance criteria:
     - For malicious IDs, `sessionFile` never points outside `reviewsDir`.
     - For valid IDs, `sessionFile` path format remains stable and backward-compatible.

5. Wire `getSession` and `updateSession` to the validated path helper and tighten error behavior.
   - Both functions should call the same validator before any filesystem operation.
   - On invalid ID:
     - do not touch filesystem,
     - return/throw a clear validation error,
     - preserve existing status mapping expected by upstream callers.
   - Acceptance criteria:
     - Invalid IDs are rejected at function entry.
     - No `fs` calls are executed for rejected IDs.
     - Valid ID behavior for existing records is unchanged (read/write success unaffected).

6. Add regression coverage for traversal attempts and valid behavior.
   - Add/update unit/integration tests for:
     - valid IDs (existing/expected format),
     - IDs with `/`, `\`, `../`, `..\\`, null byte, newline, and encoded separators,
     - boundary empty/non-string/session IDs.
   - Acceptance criteria:
     - At least one test proves malicious ID cannot create or read files outside `reviewsDir`.
     - At least one test proves valid ID still reads/writes intended file.
     - CI (or equivalent) test selector for this area passes with no behavior regressions in unrelated tests.

7. Deploy and verify with an explicit security-focused check list.
   - Re-run code review for `review-session.js`, focusing on:
     - centralized validation,
     - no duplicated or bypassable parsing logic,
     - explicit error path for invalid IDs.
   - Include pre/post diff notes documenting threat mitigation and remaining assumptions.
   - Acceptance criteria:
     - Manual review confirms no remaining raw `sessionId` concatenation in these three functions.
     - Any attempted path traversal in local reasoning walkthrough fails by validator before path resolution.

## Rollout criteria
- Implementation is complete when all 7 steps are done and all acceptance criteria are demonstrably met.
- Any unresolved risk (for example encoding ambiguities or legacy ID format expectations) must be called out before merge.
