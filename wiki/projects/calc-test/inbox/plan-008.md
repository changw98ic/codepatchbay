# Add modulo (%) operator support to calculator.js, with test case in test-calculator.js

## Handshake

- From: codex
- To: claude
- Phase: plan
- Task: Add modulo (%) operator support to `calculator.js`, with test case in `test-calculator.js`
- Status: ready-for-execute

## Scope

Implement `%` as a binary modulo operator in the calculator and add test coverage that proves the operator works without regressing existing arithmetic behavior.

## Files To Change

- `calculator.js`
- `test-calculator.js`

## Execution Plan

1. Inspect the current calculator implementation in `calculator.js`.
   - Identify where supported operators are parsed, dispatched, or evaluated.
   - Confirm whether existing operators share precedence handling or simple expression dispatch.
   - Acceptance criteria: the exact code path for adding `%` is known before editing.

2. Add `%` support in `calculator.js` using the existing operator pattern.
   - Treat `%` as a binary arithmetic operator.
   - Match JavaScript remainder semantics unless the existing calculator defines custom arithmetic behavior.
   - If the calculator has operator precedence, give `%` the same precedence as multiplication and division.
   - Acceptance criteria: an expression or operation equivalent to `10 % 3` returns `1`.

3. Add a focused test case in `test-calculator.js`.
   - Use the same test style and assertion helper already present in the file.
   - Cover a normal modulo example, preferably `10 % 3 = 1`.
   - Keep existing tests unchanged except where adding the new assertion requires extending an existing table of operator cases.
   - Acceptance criteria: the new test fails without the production change and passes with it.

4. Run the project’s existing calculator test command.
   - Use the same command or pattern already documented or used for this project.
   - Confirm the new modulo test and all existing calculator tests pass.
   - Acceptance criteria: `test-calculator.js` completes successfully with no failed assertions.

5. Self-review the diff before handoff.
   - Confirm only `calculator.js` and `test-calculator.js` were modified.
   - Confirm no unrelated formatting, refactor, fixture, or snapshot changes were introduced.
   - Confirm the implementation follows the existing style rather than adding a new abstraction.
   - Acceptance criteria: the diff is minimal, behavior-focused, and ready for review.

## Completion Criteria

- `%` is accepted anywhere the calculator accepts comparable binary arithmetic operators.
- `%` returns the correct remainder for the added test case.
- Existing arithmetic tests still pass.
- The final change set is limited to `calculator.js` and `test-calculator.js`.

## Risks And Notes

- If the calculator uses expression parsing with precedence, `%` must be grouped with `*` and `/`; adding it only to evaluation dispatch may be insufficient.
- If the calculator uses a flat operator table, prefer extending that table rather than adding a separate conditional branch.
- Do not update mocks, fixtures, snapshots, or unrelated files to force tests to pass.
