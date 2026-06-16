---
name: verify
description: Verification before completion — no completion claims without fresh evidence, gate function against rationalization
---

# Verification Before Completion

Adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT).

## Core Principle

**No completion claims without fresh verification evidence.** "It should work" is not evidence.

## The Gate Function

Before writing VERDICT: PASS, run this gate:

```
HAS the code been RUN (not read, not reasoned about — actually executed)?
  → If NO: Run it. Now.
  → If YES: Continue.

DOES the output match the acceptance criteria EXACTLY?
  → If NO: It's not done. Fix it.
  → If YES: Continue.

IS the verification FRESH (from this session, not cached/remembered)?
  → If NO: Re-run. Memory lies.
  → If YES: You may claim completion.
```

## Evidence Requirements

| Claim | Required Evidence |
|-------|-------------------|
| "Tests pass" | stdout of test run, this session |
| "Build succeeds" | Build output with exit code 0 |
| "Feature works" | Screenshots, output, or terminal capture |
| "No regressions" | Full test suite ran and passed |
| "Fixes the bug" | Reproduction steps no longer trigger issue |

## Anti-Rationalization Table

| Rationalization | Reality |
|----------------|---------|
| "The code looks correct" | Visual inspection misses logic errors |
| "Tests passed before" | Code changed since. Re-run. |
| "It's a trivial change" | Trivial changes break things trivially |
| "I'm confident it works" | Confidence is not evidence |
| "Running tests takes too long" | A wrong fix costs more time |
| "The CI will catch it" | Your job is to catch it BEFORE CI |

## Verdict Format

```
VERDICT: <PASS|FAIL|PARTIAL>

Evidence:
- [What was tested, with what input]
- [Actual output observed]
- [How it maps to acceptance criteria]

Reasoning:
- [Why this evidence supports the verdict]
```

## Checklist

- [ ] Code was actually executed (not just read)
- [ ] Verification happened in this session
- [ ] Output compared against acceptance criteria
- [ ] No "should work" claims — all backed by evidence
- [ ] Verdict includes concrete evidence, not reasoning alone
