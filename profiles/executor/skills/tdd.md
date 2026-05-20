---
name: tdd
description: Test-Driven Development discipline — Red-Green-Refactor cycle with verification gates
---

# Test-Driven Development

Adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT).

## Core Principle

Never write implementation without a failing test first. Tests define behavior, not verify it.

## The Cycle

```
RED   → Write a failing test that defines desired behavior
GREEN → Write minimum code to make it pass
REFACTOR → Clean up without changing behavior (tests still pass)
```

## Rules

1. **One test at a time.** Don't write multiple failing tests.
2. **Smallest possible change** to make the test pass. No "while I'm here" additions.
3. **Run tests after every change.** If you haven't run tests, you're guessing.
4. **Refactor only on green.** Never refactor with a failing test.

## Anti-Rationalization Table

When you catch yourself thinking this, stop and do the opposite:

| Rationalization | Reality |
|----------------|---------|
| "This is too simple to test" | Simple things break in simple ways |
| "I'll add tests after it works" | You won't. Tests define "works." |
| "The test would be the same as the impl" | That's a tautology test — test behavior, not implementation |
| "It's just a quick fix" | Quick fixes cause quick regressions |
| "Mocking is too complex" | Your design has too many dependencies |

## Verification Checklist

Before claiming "done":
- [ ] Every test was written BEFORE its implementation
- [ ] Every test was RED before going GREEN
- [ ] Refactoring only happened on GREEN
- [ ] No test was disabled, skipped, or commented out
- [ ] Tests pass without external state or manual setup
