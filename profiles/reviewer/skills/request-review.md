---
name: request-review
description: When and how to request code review — review early, review often, act on feedback by severity
---

# Requesting Code Review

Adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT).

## Core Principle

Review early, review often. Catch issues before they cascade.

## When to Request Review

**Mandatory:**
- After completing a major feature
- Before marking deliverable as done
- After fixing a complex bug

**Valuable:**
- When stuck (fresh perspective helps)
- Before refactoring (baseline check)
- When code touches security-sensitive areas

## How to Review

1. Read the deliverable in full
2. Read the plan/requirements it should satisfy
3. Evaluate against review criteria (correctness, readability, security, performance)
4. Rate each finding: Critical / Major / Minor / Suggestion
5. Write verdict: PASS (no Critical/Major) or FAIL

## Severity Definitions

| Severity | Definition | Action |
|----------|-----------|--------|
| **Critical** | Will cause system failure or data loss | Must fix before proceeding |
| **Major** | Functional defect or security vulnerability | Must fix before proceeding |
| **Minor** | Performance issue, poor design, missing edge case | Should fix, can defer |
| **Suggestion** | Style, naming, improvement | Optional |

## Acting on Feedback

```
Critical/Major issues:
  → Fix immediately
  → Re-verify after fix
  → No proceeding until resolved

Minor issues:
  → Fix if time permits
  → Document if deferring

Suggestions:
  → Apply if reasonable
  → Skip if no clear benefit
```

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Major issues
- Argue with valid technical feedback without evidence

**If reviewer is wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

## Checklist

- [ ] Deliverable read in full before reviewing
- [ ] Each finding has severity rating
- [ ] Critical/Major items have specific fix suggestions
- [ ] Verdict is PASS or FAIL (not ambiguous)
- [ ] Review covers correctness, security, performance
