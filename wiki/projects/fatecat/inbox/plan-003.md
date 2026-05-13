# Handshake: codex -> claude

Phase: plan
Status: ready_for_direct_acp_execute
Project: fatecat
From: codex
To: claude
Artifact: /Users/chengwen/dev/flow/wiki/projects/fatecat/inbox/plan-003.md

## Handoff

Implement the next FateCat iOS MVP slice: result-page cat feedback copy variety. The current UI hardcodes one result line: `它看起来早就知道了。` PRD P0 requires the result page to show a clear result plus one cat feedback line, and acceptance TC-10 requires P0 feedback copy to avoid medical, legal, investment, dangerous-action, or reality-prediction claims.

This is a local-only P0 task. Do not add screens, routes, accounts, cloud sync, monetization, economy, or dependencies.

## Required Source Reads

Read these files before implementation:

- /Users/chengwen/dev/flow/profiles/claude/soul.md
- /Users/chengwen/dev/flow/wiki/projects/fatecat/context.md
- /Users/chengwen/dev/flow/wiki/projects/fatecat/decisions.md
- /Users/chengwen/dev/flow/wiki/system/handshake-protocol.md
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateModels.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateCatStore.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateCatHomeView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCatTests/FateCatStoreTests.swift

## Execution Plan

1. Add focused failing tests first.
   - Acceptance criteria: add one test proving `finishSpin()` sets a deterministic result feedback line through injection.
   - Acceptance criteria: add one test proving the built-in P0 feedback copy pool is non-empty and avoids banned high-stakes wording such as medical, legal, investment, danger, win cash, prediction, guarantee, or certainty claims.
   - Acceptance criteria: run `swift test` and observe the new tests fail before production changes.

2. Add a minimal Store-level feedback model.
   - Acceptance criteria: add a small result feedback surface to `FateCatStore`, for example `selectedReactionLine` or `selectedFeedbackLine`.
   - Acceptance criteria: add an injectable feedback picker with a default random picker, similar in spirit to `resultPicker`.
   - Acceptance criteria: keep feedback local to the result completion path; do not store it as long-term history unless already needed by tests.

3. Add a safe P0 copy pool.
   - Acceptance criteria: include 2-3 categories implied by PRD, such as mysterious, pleased, and mildly smug/aloof.
   - Acceptance criteria: copy remains playful and entertainment-only; no real-world prediction, health/legal/finance advice, dangerous-action encouragement, cash/reward, or certainty language.
   - Acceptance criteria: expose the built-in pool in a testable internal surface without making it public API unnecessarily.

4. Wire feedback into result completion and UI.
   - Acceptance criteria: `finishSpin()` sets the feedback line only after a valid result is selected.
   - Acceptance criteria: reroll/next spin clears the previous feedback line along with `selectedResult`.
   - Acceptance criteria: the result page displays the Store-provided feedback instead of the current hardcoded single sentence.
   - Acceptance criteria: no visible layout restructure is required.

5. Preserve existing behavior.
   - Acceptance criteria: result selection, recent options/settings persistence, recent result history, reroll, and edit flow still pass existing tests.
   - Acceptance criteria: no new dependencies, generated assets, or post-MVP systems.

6. Verify.
   - Acceptance criteria: run `swift test` and include exact pass/fail output in the execution report.
   - Acceptance criteria: if feasible, run an iOS build or XCTest command; otherwise document the exact limitation.

## Guardrails

- Use direct ACP Claude execution per DEC-001; do not invoke `flow execute`.
- Do not write Flow deliverable/verdict files from Claude. Codex will record PRD ledger artifacts after verification.
- Do not edit fake/mock assets or weaken tests merely to pass.
- Prefer the smallest production change that satisfies the new tests and PRD P0 copy requirement.
- Do not revert user or other-agent changes.

## Completion Definition

The task is complete when result feedback copy is Store-driven, deterministic under test injection, rendered by the result page, safe-copy tests pass, existing tests still pass, and Codex records deliverable/verdict.

## Acceptance-Criteria

- [ ] Feedback tests are added and observed failing before implementation.
- [ ] `FateCatStore` exposes a selected result feedback line after `finishSpin()`.
- [ ] Feedback line generation is injectable for deterministic tests.
- [ ] Built-in P0 feedback copy pool is safe and non-empty.
- [ ] Result page uses Store-provided feedback rather than a hardcoded single sentence.
- [ ] Existing result/history/persistence behavior remains intact.
- [ ] `swift test` passes.
