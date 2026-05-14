# Add modulo (%) operator support to calculator.js, with test case in test-calculator.js

codex->claude  
Phase: plan

## Objective
Enable modulo (`%`) operator evaluation in `calculator.js` and add coverage in `test-calculator.js` so `%` behavior is validated alongside existing arithmetic operators.

## Scope
- Target files:
  - `/Users/chengwen/dev/cpb/wiki/projects/calc-test/inbox/calculator.js`
  - `/Users/chengwen/dev/cpb/wiki/projects/calc-test/inbox/test-calculator.js`
- No UI, config, fixture, or documentation changes.

## Plan

1. Inspect operator handling in `calculator.js` to locate current arithmetic dispatch (`+`, `-`, `*`, `/`, parentheses/precedence rules, tokenizer/parser, and evaluator/visitor).
   - Acceptance:
     - All existing operator branches remain unchanged.
     - `%` is not currently supported in any operator dispatch or grammar map.

2. Add modulo support in expression parsing/evaluation with the same precedence as `*` and `/`.
   - Implement `%` operator branch in the same code path that handles binary arithmetic operators.
   - Ensure parser/lexer accepts `%` tokens and evaluator computes result using JavaScript remainder semantics.
   - Acceptance:
     - Expression `9 % 4` resolves to `1`.
     - Expression `10 % 2` resolves to `0`.
     - Existing precedence still holds (e.g., `2 + 6 % 4` resolves consistently with multiplication/division precedence).

3. Add/update unit tests in `test-calculator.js`.
   - Add a dedicated test case for modulo success path.
   - Add a negative-case test if the current suite has error-path patterns (e.g., divisor zero behavior) to document current behavior (expected result behavior, not exception behavior).
   - Acceptance:
     - At least one positive test explicitly checks `%`.
     - New test names describe modulo behavior clearly and do not duplicate existing arithmetic tests.

4. Verify test intent and regression boundaries.
   - Manually review adjacent operator tests to keep spacing, naming, and assertion style consistent.
   - Acceptance:
     - `%` tests are isolated to arithmetic operator coverage.
     - No unrelated behavior is intentionally changed.
     - Plan handoff to execution remains ready for implementation.
