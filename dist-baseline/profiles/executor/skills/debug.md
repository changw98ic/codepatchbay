---
name: debug
description: Systematic debugging methodology — 4-phase root cause analysis, hypothesis-driven investigation
---

# Systematic Debugging

Adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT).

## Core Principle

Debugging is hypothesis testing, not random poking. If you can't explain what's broken, you can't fix it.

## 4-Phase Method

### Phase 1: Root Cause Identification
```
WHAT exactly is the symptom?
  - Error message (exact text)
  - Expected vs actual behavior
  - First occurrence (when did it start?)

WHERE does it happen?
  - File and line number
  - Input/state that triggers it
  - Environment (test, dev, prod)
```

### Phase 2: Pattern Recognition
```
IS this a known pattern?
  - Similar past bugs
  - Common framework pitfalls
  - Dependency version issues

HAS anything changed recently?
  - git log / git blame
  - Dependency updates
  - Config changes
```

### Phase 3: Hypothesis + Experiment
```
FORMULATE: "I believe X causes Y because Z"
TEST: Minimal reproduction that proves/disproves
ITERATE: If disproved, form new hypothesis
```

### Phase 4: Fix + Verify
```
FIX: Address root cause, not symptom
VERIFY: Test confirms fix
REGRESSION: Ensure no new breakage
```

## The 3-Failure Rule

If 3 different approaches fail:
1. **STOP** implementing more fixes
2. **QUESTION** your understanding of the system
3. **RE-READ** the relevant documentation/source
4. **EXPLAIN** the problem to someone (or rubber duck)
5. **RECONSIDER** your mental model

## Anti-Patterns

| Anti-Pattern | Why It's Wrong |
|-------------|----------------|
| Print-statement debugging | Use a debugger or structured logs |
| "Let me try changing X randomly" | Form a hypothesis first |
| Fixing symptoms | Root cause will resurface |
| Assuming the bug is where the error is | The error may be downstream |
| Skipping "it works" verification | Untested fixes are guesses |

## Checklist

Before calling a bug "fixed":
- [ ] Can reproduce the original bug reliably
- [ ] Identified root cause (not just symptom)
- [ ] Fix addresses root cause
- [ ] Test confirms fix works
- [ ] No regressions in related functionality
