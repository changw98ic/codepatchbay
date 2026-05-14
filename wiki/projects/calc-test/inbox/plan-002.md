# Add multiply and divide functions to calculator.js

codex->claude
Phase: plan
Task: Add multiply and divide functions to `calculator.js`
Source constraints:
- Must write only under `/Users/chengwen/dev/flow/wiki/projects/calc-test/inbox/`
- Must read only allowed locations under project/system/profile/template paths
- Execution mode: planning-only (no terminal commands)

## Objective
- Add `multiply` and `divide` functionality to `calculator.js` with behavior aligned to existing project conventions.

## Preconditions
- Confirm the existing function style, export pattern, and error/edge-case policy in `calculator.js`.
- Confirm current test framework, test data shape, and naming conventions in the project context.
- Confirm whether division by zero is expected to:
  - return JS native `Infinity`/`NaN`, or
  - be validated and rejected as an error.

## Scope
- Scope is intentionally limited to function implementation and wiring for calculator operations.
- Do not add unrelated refactors, UI changes, or package/runtime dependency changes.

## Plan
1. Review current contract and implementation surface in `calculator.js`.
   - Acceptance criteria:
     - Current export method (`module.exports`, named exports, or class methods) is identified.
     - Existing validation style for numeric inputs is identified.
     - Existing error behavior patterns (if any) are documented.
2. Add `multiply(a, b)` using existing numeric-op style.
   - Acceptance criteria:
     - Function returns `a * b`.
     - Input/output type behavior matches existing operation implementations.
     - Naming and formatting match established project conventions.
3. Add `divide(a, b)` with the same signature style as existing operations.
   - Acceptance criteria:
     - Function returns `a / b` for valid inputs.
     - Division by zero follows the project’s agreed convention (documented in Step 1 and implemented consistently).
4. Export both new functions from `calculator.js`.
   - Acceptance criteria:
     - `multiply` and `divide` are publicly available through the same API surface as other calculator operations.
     - Existing exports for current operations remain unchanged.
5. Add/adjust tests for both functions.
   - Acceptance criteria:
     - Tests cover typical cases (positive, negative, zero, decimal).
     - Tests include divide-by-zero case per the project convention from Step 1.
     - New tests fail before implementation and pass after implementation.
6. Update minimal docs/comments only if existing project practice requires operation lists in docs.
   - Acceptance criteria:
     - If an operations list exists, it now includes multiply and divide.
     - No non-operative text or behavior changes are introduced.
7. Final verification checklist before handoff.
   - Acceptance criteria:
     - Only intended files are modified (calculator code, tests, and any required operation list.
     - No behavior regression is introduced for existing add/subtract/multiply-like operations.

## Handoff to execute lane
- Execute in the following order:
  1) `calculator.js` implementation
  2) tests
  3) optional docs list update
- Return:
  - `calculator.js` diff summary
  - test outcomes with pass/fail and concrete examples for multiply/divide
  - note on divide-by-zero policy and whether it was intentionally preserved or changed
