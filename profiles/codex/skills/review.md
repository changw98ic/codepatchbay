---
name: review
description: Structured code review with severity grading
---

## Instructions
1. Read the target files or deliverable
2. Evaluate against these dimensions:
   - Correctness: logic errors, edge cases, off-by-one
   - Security: injection, auth, data exposure
   - Performance: O(n²) loops, unnecessary allocations, N+1 queries
   - Maintainability: naming, complexity, duplication
   - Error handling: missing catches, silent failures
3. Grade each finding by severity: P0 (blocker), P1 (critical), P2 (major), P3 (minor)
4. Provide specific line references and fix suggestions

## Output Format
### Code Review Summary
- **Files Reviewed**: {n}
- **P0 Blockers**: {n}
- **P1 Critical**: {n}
- **P2 Major**: {n}
- **P3 Minor**: {n}

### Findings

#### P0 — Blocker
- `{file}:{line}` — {issue}
  - **Fix**: {suggestion}

#### P1 — Critical
- `{file}:{line}` — {issue}
  - **Fix**: {suggestion}

#### P2 — Major
- `{file}:{line}` — {issue}

#### P3 — Minor
- `{file}:{line}` — {issue}
