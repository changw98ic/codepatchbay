# deliverable-004 - Visual polish for button animation, result marker, and FateCat logo

## Source Plan

- `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/inbox/plan-004.md`

## Execution Mode

- Direct ACP Claude execution for first implementation pass.
- Codex review/rescue for runtime path correction, verification, simulator launch, and PRD ledger.

## Changed Files

- `/Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateCatHomeView.swift`
- `/Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/CatStageView.swift`
- `/Users/chengwen/Documents/FateCat/FateCatIOS/FateCat/Views/FateWheelView.swift`

## Delivered Behavior

- Replaced the visible header brand from `命猫` to an English `FateCat` logo using a calligraphic system font treatment, gold gradient, and glow.
- Reworked button-press presentation so the press phase uses the SwiftUI cat squash/tilt/ripple path instead of the bundled `cat_press_button.json`, which was too crude for the requested quality bar.
- Removed the accidental duplicate in-stage fake command button; the real bottom command button now depresses during `pressingButton`.
- Kept the selected wheel label visible on result completion and highlighted it with pale gold styling.
- Added a guaranteed SwiftUI paw/foreleg marker on the result wheel, while preserving Lottie as an optional enhancement layer.

## Visual Evidence

- Launch screenshot: `/tmp/fatecat-plan004-launch-fixed.png`
- Result screenshot: `/tmp/fatecat-plan004-result.png`

## Notes

- Codex corrected the first Claude pass because it changed only the fallback path while the bundled Lottie resource would still have owned the button-press runtime path.
- The selected result and paw marker were manually exercised through the iPhone 17 Pro simulator cpb.
