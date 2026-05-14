---
name: plan
description: Writing implementation plans — bite-sized tasks, no placeholders, self-review before handoff
---

# Writing Implementation Plans

Adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT).

## Core Principle

A plan is executable by someone who wasn't in the room. If the executor needs to guess, the plan failed.

## Plan Structure

```markdown
## Overview
[One paragraph: what we're building and why]

## Acceptance Criteria
- [ ] Criterion 1 (testable, specific)
- [ ] Criterion 2
- [ ] ...

## Steps

### Step 1: [Concrete action]
- What: [exact change]
- Where: [file:line or path]
- Verify: [how to confirm it worked]

### Step 2: [Next concrete action]
...
```

## Rules

1. **Bite-sized tasks.** Each step is completable in <30 minutes. If it's bigger, split it.
2. **No placeholders.** "TODO: figure out later" = plan is incomplete.
3. **Verify after each step.** Every step must have a verification method.
4. **Dependencies explicit.** If Step 3 needs Step 1's output, say so.
5. **One deliverable per plan.** Multiple unrelated changes = multiple plans.

## Anti-Patterns

| Anti-Pattern | Fix |
|-------------|-----|
| "Implement the auth system" | Break into: schema → middleware → routes → tests |
| "Fix all the bugs" | List each bug as a separate step |
| "Refactor for better code" | Specify what changes where |
| "Add tests" | Specify which functions, what behaviors |
| Steps depend on "context" or "judgment" | Make the criteria explicit |

## Self-Review Checklist

Before handing off a plan:
- [ ] Can someone unfamiliar execute this without asking questions?
- [ ] Each step has concrete input/output
- [ ] Verification method for each step
- [ ] No circular dependencies
- [ ] Acceptance criteria are binary (pass/fail, not "looks good")
- [ ] Total scope matches the task (no scope creep, no gaps)

## Execution Handoff

When handing to Claude (executor):
1. Plan file written to `inbox/plan-{id}.md`
2. Handshake metadata included (Phase: plan, From: codex, To: claude)
3. Acceptance criteria at the END (most critical, must be seen)
