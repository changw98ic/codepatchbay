# plan-005 - Replace hand-drawn paw with generated FateCat-matched assets

## Problem

The prior result paw was code-drawn and did not match the premium black-gold FateCat image style. The animation should be driven by project art assets instead of abstract SwiftUI drawing.

## Scope

- Generate project-bound bitmap paw assets using the image generation skill.
- Use the existing `FateCatSlim` visual identity as style reference.
- Add transparent app assets for:
  - result wheel reaching foreleg/paw
  - button press paw contact
- Remove hand-drawn paw/foreleg SwiftUI geometry from the result wheel.
- Stop using the old result-paw Lottie overlay so the generated asset owns the visual.
- Verify tests, iOS simulator build, and simulator result screen.

## Acceptance Criteria

- Result paw visually matches the black long-haired cat: fur texture, dark palette, gold rim light, realistic paw pads.
- Button press paw feedback uses generated art instead of a generic symbol.
- Result wheel still keeps selected text visible.
- Asset catalog compiles.
- Simulator screenshot confirms the generated paw appears in app.
