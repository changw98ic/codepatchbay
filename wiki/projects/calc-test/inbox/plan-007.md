# Add modulo (%) operator support to calculator.js, with test case in test-calculator.js

## Handshake

From: codex
To: claude
Phase: plan
Task: Add modulo (%) operator support to calculator.js, with test case in test-calculator.js

## Objective

Add first-class support for the `%` operator in `calculator.js` and prove it with a focused regression test in `test-calculator.js`. Keep the change narrow: only implement modulo behavior and its test coverage.

## Scope

In scope:
- Update `calculator.js` so the calculator recognizes `%`.
- Use JavaScript numeric remainder semantics for modulo: `left % right`.
- Add at least one test in `test-calculator.js` that fails before the implementation and passes after it.
- Run the existing calculator test command and report the exact result.

Out of scope:
- No parser rewrite.
- No new dependencies.
- No formatting-only churn outside touched lines.
- No behavior changes for existing operators.
- No unrelated test rewrites.

## Execution Plan

1. Inspect the current calculator implementation.
   - Read `calculator.js`.
   - Identify how existing operators are represented, dispatched, and how unsupported operators are handled.
   - Acceptance: executor can state the exact code path where `+`, `-`, `*`, and `/` are handled.

2. Add the modulo operator using the existing local pattern.
   - Add `%` beside the existing arithmetic operators.
   - Preserve the current function signatures, exports, and error handling style.
   - For normal numeric inputs, return `a % b`.
   - Acceptance: `10 % 3` returns `1` through the calculator's public API.

3. Add a focused regression test in `test-calculator.js`.
   - Follow the current assertion style in the file.
   - Add a test case for a simple non-zero divisor, preferably `10 % 3 === 1`.
   - If the existing tests cover negative numbers or edge cases in a table-driven style, add `%` to that same table rather than creating a parallel pattern.
   - Acceptance: the new test fails if `%` support is removed.

4. Run the existing test suite.
   - Use the repository's current test command from package scripts or the existing test file convention.
   - Acceptance: all existing tests plus the new modulo test pass.

5. Self-review the diff.
   - Confirm only `calculator.js` and `test-calculator.js` changed for implementation.
   - Confirm no existing operator behavior was edited except as required to extend the operator list/dispatch.
   - Confirm the final report includes changed files, verification command, and any residual risk.

## Acceptance Criteria

- `calculator.js` supports `%` as an operator.
- `test-calculator.js` includes a modulo test case.
- Existing addition, subtraction, multiplication, and division tests still pass.
- The new modulo test passes through the same public API used by other calculator tests.
- No new dependencies or unrelated files are changed.

## Expected Final Report

Include:
- Changed files: `calculator.js`, `test-calculator.js`.
- Behavior added: modulo/remainder operator support.
- Verification evidence: exact test command and passing result.
- Remaining risks: note only if existing calculator behavior around invalid operators, division by zero, or modulo by zero is ambiguous or untested.

## Planner Self-Review

- The plan addresses only: Add modulo (%) operator support to calculator.js, with test case in test-calculator.js.
- The steps are concrete and executable without placeholders.
- The acceptance criteria are scoped to the requested behavior.
- The plan avoids unrelated cleanup, dependency changes, and broad refactors.
