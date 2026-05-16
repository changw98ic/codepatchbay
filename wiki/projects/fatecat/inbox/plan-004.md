# Handshake: codex -> claude

Phase: plan
Status: ready_for_direct_acp_execute
Project: fatecat
From: codex
To: claude
Artifact: __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/inbox/plan-004.md

## Handoff

Fix three user-observed visual issues in the running FateCat iOS app:

1. The button-press animation is too crude and abstract.
2. After the wheel completes, the selected option text disappears and the cat paw marker is not visible.
3. The header should say `FateCat` in an English calligraphic/logo-like style instead of `命猫`.

This is a P0 visual polish slice. Keep the app light and local-only. Do not add dependencies, screens, accounts, cloud sync, monetization, or economy systems.

## Evidence From Code

- `FateCatHomeView.header` currently renders `Text("命猫")`.
- `FateWheelView.wheelLabels` explicitly hides the selected result label with `if !(phase == .result && result == option)`.
- `WheelCenterCatOverlay.resultPawLayer` uses `LottieCatAnimationView(phase: .resultPress) { EmptyView() }`, so if the bundled Lottie loads but is visually weak/invisible, there is no SwiftUI paw fallback.
- `CatStageView.fallbackCat` only scales and drops the cat for button press, which reads as crude.

## Required Source Reads

Read these files before implementation:

- __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/context.md
- __ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/decisions.md
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateCatHomeView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateWheelView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/CatStageView.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/DesignTokens.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Core/FateModels.swift
- /Users/chengwen/Documents/FateCat/FateCatIOS/FateCatTests/FateCatStoreTests.swift

## Execution Plan

1. Improve the header logo.
   - Acceptance criteria: replace `命猫` header text with `FateCat`.
   - Acceptance criteria: use a calligraphic/logo-like treatment using built-in iOS typography and SwiftUI styling only, for example `Snell Roundhand` or a graceful fallback, gold gradient, subtle glow, and compact sizing.
   - Acceptance criteria: keep the gear button and header layout intact.

2. Improve button-press animation.
   - Acceptance criteria: when `animationPhase == .buttonPress`, the fallback should read as a deliberate paw/button press, not a random vertical drop.
   - Acceptance criteria: add visual cues such as a silver/gold command button plate, paw contact ring, small spark/ripple, and more polished squash/tilt motion.
   - Acceptance criteria: keep Lottie support intact; improve fallback and any surrounding stage composition so the effect is visible even when Lottie is absent or weak.
   - Acceptance criteria: no generated assets or dependencies required for this slice.

3. Keep selected result text visible on wheel completion.
   - Acceptance criteria: remove the logic that hides the selected result label.
   - Acceptance criteria: selected result label remains legible and visually highlighted in `.result` phase.
   - Acceptance criteria: non-selected labels remain visible enough to preserve context.

4. Make cat paw result marker reliably visible.
   - Acceptance criteria: add a visible SwiftUI paw/foreleg layer in result phase even when Lottie is present.
   - Acceptance criteria: paw marker should appear to pin or point at the selected result without covering the selected text.
   - Acceptance criteria: center cat medallion remains visible and the result overlay does not erase labels.

5. Verify.
   - Acceptance criteria: run `swift test`.
   - Acceptance criteria: run an iOS simulator build.
   - Acceptance criteria: install and launch the app on the booted simulator, capture screenshots, and visually confirm:
     - header says `FateCat`,
     - selected result text remains visible after completion,
     - cat paw marker is visible after completion,
     - button press visual is less crude.

## Guardrails

- Use direct ACP Claude execution per DEC-001; do not invoke `cpb execute`.
- Do not write CodePatchbay deliverable/verdict files from Claude. Codex will record PRD ledger artifacts after verification.
- Do not introduce new dependencies or generated assets unless absolutely necessary.
- Do not revert user or other-agent changes.
- Prefer SwiftUI polish over large animation-system rewrites.

## Completion Definition

The task is complete when the app launches in simulator, the three user-observed issues are addressed, tests and simulator build pass, and Codex records deliverable/verdict.

## Acceptance-Criteria

- [ ] Header displays `FateCat` in an English calligraphic/logo-like style.
- [ ] Button-press fallback/stage animation reads as intentional and less abstract.
- [ ] Selected option text remains visible after wheel completion.
- [ ] Cat paw marker is visibly present after wheel completion.
- [ ] `swift test` passes.
- [ ] iOS simulator build passes.
- [ ] Simulator screenshot evidence is captured after launch/result cpb.
