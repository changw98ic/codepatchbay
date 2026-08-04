# Real-provider E2E evidence

This directory holds archived, redacted real-provider E2E evidence records. New runtime evidence is written **outside the source tree** to `CPB_LIVE_E2E_EVIDENCE_ROOT` (defaulting to `~/.cpb/evidence/live-e2e` — see `tests/live-e2e/flagship-pipeline.test.ts`); the records kept here are historical and have been sanitized of absolute paths, hostnames, and secrets. A flagship record is valid release evidence only when it has:

- `realProviderRequired: true` and `fakeProvider: false`;
- completed queue, assignment, and managed-worker result statuses;
- `execute` and `verify` phases;
- an acceptance checklist artifact and `audit_finalized` event;
- `evidence.editedFile: "target.txt"`.

Direct-provider records also include `jobId`, `attempt`, `providerKey`, and the ACP audit event names. Failed provider runs retain `ok: false` and a redacted failure reason so missing authentication or provider startup failures are visible rather than skipped.

The summary is retained for review. Disposable runtime directories, worktrees, raw prompts, and provider output are removed after the test and are not release evidence. Provider authentication is never written to these records.
