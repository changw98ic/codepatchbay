## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: plan-005
- **Timestamp**: 2026-05-17T12:00:00Z

### Implemented
- Added `validateSessionId()` in `server/services/review-session.js` constraining session IDs to `^[A-Za-z0-9_-]{1,128}$`
- Wired validation into `sessionFile`, `getSession`, `updateSession` (entry-point validation + lock dir sanitization)
- Added defense-in-depth: `sessionFile` resolves and verifies the final path stays within `reviewsDir`
- Added 3 regression tests covering 14 traversal vectors (`../`, `..\\`, `%2F`, null byte, newline, empty, non-string, etc.)

### Files Changed
- `server/services/review-session.js` — Added `validateSessionId()` helper; validated `sessionId` at entry of `sessionFile`, `getSession`, `updateSession`; sanitized lock dir path; added `path.resolve` + prefix containment check in `sessionFile`
- `tests/review-session.test.mjs` — Added `path traversal prevention` describe block with 3 tests covering 14 malicious ID vectors and valid-ID regression

### Evidence

**Test Results**:
```
review-session service - 12 tests PASS
withFileLock concurrency - 4 tests PASS
path traversal prevention - 3 tests PASS
parseIssues - 4 tests PASS
tests 23 | pass 23 | fail 0

POST /api/review/:id/cancel - 3 tests PASS
A8: reviewer workflow - 9 tests PASS
tests 12 | pass 12 | fail 0
```

**Key Code**:
```javascript
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid sessionId: must be a non-empty string");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error("invalid sessionId: " + sessionId);
  }
  return sessionId;
}
```

### Unresolved
- None

### Risks
- The error message includes the rejected sessionId in logs. If sessionId values are user-controlled and logged, this is a minor info-leak. Acceptable for an internal tool.

## Next-Action
Verify all 7 acceptance criteria from plan-005.md are met. Confirm no raw sessionId concatenation remains in sessionFile, getSession, or updateSession. Run full test suite to confirm zero regressions.

## Acceptance-Criteria
- [x] All traversal vectors (/, \, .., %2F, %5C, newline, null byte, absolute paths) are rejected
- [x] Exactly one validator (validateSessionId) used by all three target functions
- [x] Invalid IDs fail before any filesystem operation
- [x] Valid IDs remain backward-compatible (all existing tests pass)
- [x] Lock dir path in updateSession uses validated ID
- [x] Defense-in-depth: sessionFile confirms resolved path stays within reviewsDir
- [x] At least one test proves malicious ID cannot create/read files outside reviewsDir
- [x] At least one test proves valid ID still reads/writes intended file
