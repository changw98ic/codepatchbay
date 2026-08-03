# Real-provider E2E evidence

Each real-provider test writes a JSON summary here after every run. `flagship-pipeline.test.ts` records the full queue-to-finalizer path; `provider-edit.test.ts` records the direct Codex/Claude ACP path. A flagship record is valid release evidence only when it has:

- `realProviderRequired: true` and `fakeProvider: false`;
- completed queue, assignment, and managed-worker result statuses;
- `execute` and `verify` phases;
- an acceptance checklist artifact and `audit_finalized` event;
- `evidence.editedFile: "target.txt"`.

Direct-provider records also include `jobId`, `attempt`, `providerKey`, and the ACP audit event names. Failed provider runs retain `ok: false` and a redacted failure reason so missing authentication or provider startup failures are visible rather than skipped.

The summary is retained for review. Disposable runtime directories, worktrees, raw prompts, and provider output are removed after the test and are not release evidence. Provider authentication is never written to these records.
