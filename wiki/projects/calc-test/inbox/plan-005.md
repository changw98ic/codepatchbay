# Add modulo (%) operator support to calculator.js, with test case in test-calculator.js

Handshake: codex -> claude, Phase: plan

## Objective
Add support for the modulo (`%`) operator in `calculator.js` and add at least one explicit test case in `test-calculator.js`.

## Scope
- Files to change in implementation: `calculator.js`, `test-calculator.js` (no other files).
- Delivery format: direct arithmetic modulo behavior consistent with existing operator conventions in the project.
- No API or CLI changes.

## Step 1 — Audit current operator model in `calculator.js`
- Inspect how operators are defined, how tokenization is done, and how precedence is enforced.
- Confirm how division-by-zero, non-numeric inputs, and parse errors are currently handled so modulo behavior matches current semantics.
- **Acceptance criteria:** A decision matrix is documented in this plan for:
  1. operator registration,
  2. parser/precedence path,
  3. evaluator execution path,
  4. error behavior for invalid modulo usage.

## Step 2 — Add `%` operator symbol support
- Register `%` in the same operator list/map used by the parser.
- Ensure parser recognizes `%` as a binary infix operator and not as part of a number token (unless project syntax already requires this handling).
- **Acceptance criteria:** `calculator.js` can parse expressions containing `%` without tokenization failures.

## Step 3 — Bind modulo precedence with `*` and `/`
- Insert `%` into the same precedence tier as `*` and `/` unless current architecture defines a different precedence rule.
- Ensure associativity behavior matches the project convention for other same-precedence operators.
- **Acceptance criteria:** Expression like `10 + 20 % 3` is evaluated per declared precedence rules and not as left-to-right flat arithmetic.

## Step 4 — Implement modulo execution in evaluator
   - Implement evaluation logic for `a % b` using the project’s existing safe numeric operation path.
   - Match existing behavior for error conditions (e.g., zero divisor) based on current division-by-zero handling.
   - Keep return type/rounding behavior consistent with the current engine.
- **Acceptance criteria:** `%` computes successfully for valid operands and follows same error pattern as existing arithmetic operators.

## Step 5 — Add regression test in `test-calculator.js`
- Add at least one dedicated test case for modulo.
- Recommended minimal coverage:
  1. `10 % 3` → `1`
  2. `10 + 20 % 3` with precedence check (if precedence differs by design, document expected result explicitly)
  3. `10 % 0` invalid/div-by-zero behavior consistent with existing division tests.
- **Acceptance criteria:** New test(s) fail on old implementation and pass with the new `%` behavior.

## Step 6 — Run targeted verification before handoff
- Execute the calculator test file or equivalent scoped test target.
- Confirm no unrelated snapshots/regressions changed.
- Verify updated expected outputs are deterministic.
- **Acceptance criteria:** `test-calculator.js` green + no accidental behavior changes in non-modulo math operations.

## Non-negotiables
- Keep the change minimal and consistent with project math style.
- Do not alter input/output formats or public interfaces beyond adding `%`.
- If precedence or error semantics for modulo conflict with existing tests, update only the modulo-related tests and preserve established behavior for other operators.
