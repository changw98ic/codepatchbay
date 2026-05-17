## Handoff: codex -> claude — Add modulo operator: support % in calculator.js and add tests

- **From**: codex
- **To**: claude
- **Project**: calc-test
- **Phase**: plan
- **Task-Ref**: TASK-009
- **Timestamp**: 2026-05-14T00:00:00+08:00

### Decided
- Add `%` as a first-class calculator operator in `calculator.js`, matching the existing operator dispatch/style rather than introducing a new parsing architecture.
- Add focused regression tests for modulo behavior alongside the existing calculator tests.
- Preserve existing calculator behavior for `+`, `-`, `*`, `/`, invalid operators, and division-by-zero handling.

### Rejected
- Rewriting the calculator parser/evaluator — out of scope for adding one operator and increases regression risk.
- Adding dependencies for expression parsing or math evaluation — unnecessary for `%` support and not requested.
- Changing existing test doubles, fixtures, or unrelated snapshots — this task should be covered by production code and direct calculator tests only.

### Scope

**目标**: Implement modulo operator support so calculator operations using `%` return the JavaScript remainder result, and add tests proving the new operator works without regressing existing behavior.

**涉及文件**:
- `calculator.js` — add `%` support in the existing operation/operator handling path.
- Existing calculator test file, likely named `calculator.test.js`, `test/calculator.test.js`, or similar — add modulo regression tests near the existing arithmetic operator tests.

**实现步骤**:
1. Inspect `calculator.js` and identify the current operator dispatch path for `+`, `-`, `*`, and `/`.
2. Add a `%` branch/case using the same style as the existing operators, returning `left % right` or the equivalent operand names already used by the file.
3. Confirm the error path for unsupported operators remains unchanged except that `%` is no longer rejected.
4. Locate the existing calculator test suite and add focused `%` tests in the same style and assertion framework already used.
5. Cover at least positive modulo behavior and one edge case that fits the existing calculator contract, such as `10 % 3 === 1` and `10 % 5 === 0`.
6. Run the existing test command for the project and capture the exact command plus pass/fail output in `deliverable-009.md`.

**注意事项**:
- Keep the implementation minimal and consistent with the current code style.
- Do not alter behavior for division by zero unless the existing implementation has an equivalent explicit zero-check for modulo and tests already imply that behavior.
- Do not broaden the task into expression parsing, operator precedence, CLI behavior, UI behavior, or package configuration changes unless the current tests prove those surfaces are already part of calculator operator support.
- If test file names differ from the likely names above, use the existing calculator-related test file rather than creating a parallel duplicate suite.

## Next-Action
Implement `%` support in `calculator.js`, add matching calculator tests, run the project test suite, and write `deliverable-009.md` with changed files, test evidence, and any remaining risk.

## Acceptance-Criteria
- [ ] `calculator.js` accepts `%` through the same public API/operator path as existing arithmetic operators.
- [ ] `10 % 3` returns `1` through the calculator API.
- [ ] `10 % 5` returns `0` through the calculator API.
- [ ] Existing supported operators still pass their current tests.
- [ ] Unsupported-operator behavior remains unchanged for operators other than `%`.
- [ ] All relevant tests pass, with the exact test command and output recorded in `deliverable-009.md`.
- [ ] Code style and test style match the surrounding project conventions.
