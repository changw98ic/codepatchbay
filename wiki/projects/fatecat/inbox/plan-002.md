# Handshake: codex -> claude

Phase: plan
Status: ready_for_execute
Project: fatecat
From: codex
To: claude
Artifact: /Users/chengwen/dev/cpb/wiki/projects/fatecat/inbox/plan-002.md

## Handoff

Implement the next FateCat iOS MVP slice: lightweight local result history for completed decisions. The current test suite already contains result-history expectations, but `FateCatStore` does not yet expose `recentResults` or accept a `now:` clock injection, so `swift test` fails. Complete the production implementation without weakening tests.

This is a P0/MVP local-only task. Do not add screens, routes, accounts, cloud sync, monetization, economy, or new dependencies.

## Required Source Reads

Read these files before implementation:

- /Users/chengwen/dev/cpb/profiles/claude/soul.md
- /Users/chengwen/dev/cpb/wiki/projects/fatecat/context.md
- /Users/chengwen/dev/cpb/wiki/projects/fatecat/decisions.md
- /Users/chengwen/dev/cpb/wiki/system/handshake-protocol.md
- /Users/chengwen/dev/cpb/templates/handoff/execute-to-review.md
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateModels.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateCatStore.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCatTests/FateCatStoreTests.swift

## Current Failure Evidence

`swift test` currently fails because `FateCatStoreTests.swift` includes result-history tests that call:

- `FateCatStore(storage:resultPicker:now:)`
- `store.recentResults`
- `recentResults.first?.result`
- `recentResults.first?.options`
- `recentResults.first?.createdAt`

The production store currently has none of those result-history surfaces.

## Execution Plan

1. Inspect the current store and tests.
   - Acceptance criteria: identify existing persistence via `KeyValuePersisting`.
   - Acceptance criteria: identify `finishSpin()` as the completed-result boundary.
   - Acceptance criteria: map the existing result-history tests to concrete production behavior.

2. Add a minimal Swift result-history model.
   - Acceptance criteria: define a small `Codable` value type, for example `FateResultHistoryEntry`, with `result: String`, `options: [String]`, and `createdAt: Date`.
   - Acceptance criteria: keep the type in the existing core boundary, preferably `FateCatStore.swift` unless `FateModels.swift` is clearly a better local fit.
   - Acceptance criteria: do not introduce IDs, UI-only fields, or unrelated state unless required by tests.

3. Extend `FateCatStore` with result-history persistence.
   - Acceptance criteria: add `@Published private(set) var recentResults: [FateResultHistoryEntry] = []`.
   - Acceptance criteria: add `now: () -> Date` injection to the existing initializer while preserving current default call sites.
   - Acceptance criteria: load persisted history from `KeyValuePersisting` at initialization using a dedicated key such as `fatecat.recentResults`.
   - Acceptance criteria: malformed or missing history data should load as an empty list without affecting plan-001 recent-options/settings persistence.

4. Record history only when a spin completes.
   - Acceptance criteria: in `finishSpin()`, after selecting the result, prepend a completed history entry with the selected result, current `activeOptions`, and `now()`.
   - Acceptance criteria: keep newest results first.
   - Acceptance criteria: trim history to the five most recent completed decisions.
   - Acceptance criteria: persist the trimmed list after each completed spin.
   - Acceptance criteria: do not record failed, invalid, or in-progress decisions.

5. Preserve existing MVP UX and plan-001 behavior.
   - Acceptance criteria: no visible UI changes are required.
   - Acceptance criteria: recent options still persist and reuse exactly as before.
   - Acceptance criteria: sound/haptics settings still persist exactly as before.
   - Acceptance criteria: no new dependencies or generated assets.

6. Verify.
   - Acceptance criteria: run `swift test` and include exact pass/fail output in the deliverable.
   - Acceptance criteria: if feasible, run an iOS build or XCTest command; if not feasible, document the exact limitation.
   - Acceptance criteria: do not claim success without command evidence.

7. Produce the execute-phase handoff.
   - Acceptance criteria: write the deliverable to the path provided by the execute prompt.
   - Acceptance criteria: follow `execute-to-review.md` and `handshake-protocol.md`.
   - Acceptance criteria: list changed files, tests/checks run, simplifications made, remaining risks, and completion/blocker status.

## Guardrails

- Treat `context.md` and `decisions.md` as authoritative.
- Do not edit fake/mock assets or tests merely to make tests pass.
- Prefer the smallest production change that satisfies the existing result-history tests.
- Do not revert user or other-agent changes.
- Keep the repository local-only and MVP-scoped.

## Completion Definition

The task is complete when the current result-history tests pass, plan-001 persistence behavior remains intact, the execute handoff is written, and no task-scoped blocker remains.

## Acceptance-Criteria

- [ ] `FateCatStore` supports `now:` injection with a default `Date.init` behavior.
- [ ] `recentResults` is loaded at store initialization from local `KeyValuePersisting` storage.
- [ ] `finishSpin()` records completed decisions with result, options, and timestamp.
- [ ] Result history is newest-first and capped at five entries.
- [ ] Result history survives store recreation with the same injected storage.
- [ ] Existing recent-options/settings persistence behavior remains intact.
- [ ] `swift test` passes without weakening tests.
