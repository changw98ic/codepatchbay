# Handshake: codex -> claude

Phase: plan
Status: ready_for_execute
Project: fatecat
From: codex
To: claude
Artifact: __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/inbox/plan-001.md

## Mission

Implement the next FateCat iOS MVP slice: persist recent decision options plus the sound/haptics settings locally, keep the existing SwiftUI UX intact, and add focused XCTest coverage. This is a P0/MVP task only. Do not add coins, ads, IAP, accounts, cloud sync, godfall/rebirth, or other post-MVP systems.

## Required Source Reads

Read these files before implementation:

- __ABS_WORKSPACE_CPB_PATH__/profiles/claude/soul.md
- __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/context.md
- __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/decisions.md
- __ABS_WORKSPACE_CPB_PATH__/wiki/system/handshake-protocol.md
- __ABS_WORKSPACE_CPB_PATH__/templates/handoff/execute-to-review.md
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateModels.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateCatStore.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateCatHomeView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/OptionEditorView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/SettingsView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCatTests/FateCatStoreTests.swift

Planner note: the current app already has in-memory recent options, sound/haptics toggles, a template-driven option editor, and Store tests. The missing MVP behavior is local persistence so the app remains useful across launches.

## Execution Plan

1. Inspect the current store and tests.
   - Acceptance criteria: identify how `FateCatStore` owns `optionDrafts`, `recentOptions`, `soundEnabled`, `hapticsEnabled`, `activeOptions`, and phase transitions.
   - Acceptance criteria: confirm whether the iOS target and SwiftPM-style test target can compile the same core files without introducing a new dependency.

2. Add persistence in the smallest existing boundary.
   - Acceptance criteria: recent options are loaded at store initialization and saved when valid options are confirmed or reused.
   - Acceptance criteria: `soundEnabled` and `hapticsEnabled` are loaded at store initialization and saved when toggled.
   - Acceptance criteria: persisted recent options are normalized with the same blank/duplicate filtering rules and ignored if fewer than two valid choices remain.
   - Acceptance criteria: the implementation remains local-only, preferably via `UserDefaults` with injectable storage for tests.

3. Keep the SwiftUI UX unchanged unless persistence requires minimal binding adjustments.
   - Acceptance criteria: the settings sheet still uses toggles for sound and haptics.
   - Acceptance criteria: the home view still offers “用上次选项” only when at least two recent options exist.
   - Acceptance criteria: no new screens, onboarding, monetization, account, or cloud UI appears.

4. Add focused regression tests.
   - Acceptance criteria: one test proves confirmed options are persisted and loaded by a new store using the same injected storage.
   - Acceptance criteria: one test proves sound/haptics setting changes are persisted and loaded by a new store.
   - Acceptance criteria: one test proves invalid persisted recent options do not enable reuse.
   - Acceptance criteria: existing Store tests continue to pass.

5. Run verification.
   - Acceptance criteria: run the relevant XCTest or Swift test command available in the repo.
   - Acceptance criteria: if full iOS simulator tests are unavailable in the ACP environment, run the best available compile/test command and document the exact limitation.
   - Acceptance criteria: do not claim success without command output evidence.

6. Produce the execute-phase handoff.
   - Acceptance criteria: write the deliverable report to the path provided by the execute prompt.
   - Acceptance criteria: follow `execute-to-review.md` / `handshake-protocol.md`.
   - Acceptance criteria: list changed files, tests/checks run, simplifications made, remaining risks, and whether the task is complete or blocked.

## Guardrails

- Treat `context.md` and `decisions.md` as authoritative over assumptions in this plan.
- Prefer deletion, reuse, and narrow edits over new abstractions.
- Do not modify unrelated files or revert user changes.
- Verify before claiming completion.

## Completion Definition

The task is complete when the implementation matches the project context, relevant verification passes, the executor handoff is written, and no known task-scoped blocker remains.
