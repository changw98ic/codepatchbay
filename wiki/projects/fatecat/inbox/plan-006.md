# plan-006 - Replace detached result paw with connected result-cat pose

## Problem

The generated reach paw improved art quality, but it still read as an external limb placed behind the center cat rather than the cat naturally extending its own paw.

## Scope

- Generate a cohesive result sprite containing the cat bust and extended foreleg in one connected image.
- Replace the result wheel overlay with this connected sprite.
- Remove the prior isolated reach-paw asset from the project.
- Keep the button-press generated paw asset.
- Verify tests, build, and simulator result screen.

## Acceptance Criteria

- The result paw visibly originates from the same cat body.
- The result wheel no longer uses detached paw composition.
- The selected result remains visible.
- Build and tests continue to pass.
