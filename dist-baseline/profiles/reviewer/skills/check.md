---
name: check
description: Verify deliverable meets plan acceptance criteria
---

## Instructions
1. Read the plan file (inbox/plan-*.md) for acceptance criteria
2. Read the deliverable file (outputs/deliverable-*.md)
3. For each acceptance criterion:
   - Map to specific deliverable sections
   - Verify implementation covers the criterion
   - Mark as: MET, PARTIAL, MISSING, UNCLEAR
4. Check for scope creep: deliverable implements things NOT in the plan
5. Check for gaps: plan requirements NOT addressed in deliverable

## Output Format
### Verification Matrix

| # | Acceptance Criterion | Status | Evidence |
|---|---------------------|--------|----------|
| 1 | {criterion} | MET/PARTIAL/MISSING | {reference} |
| 2 | {criterion} | MET/PARTIAL/MISSING | {reference} |
| ... | ... | ... | ... |

### Summary
- **Total Criteria**: {n}
- **MET**: {n} ({percent}%)
- **PARTIAL**: {n}
- **MISSING**: {n}

### Gaps (MISSING criteria)
- {criterion}: {what's needed}

### Scope Creep (extra work not in plan)
- {item}: {why it's out of scope}
