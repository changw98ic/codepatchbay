## Handoff: codex -> claude

# Add modulo operator: support % in calculator.js and add tests

- **From**: codex
- **To**: claude
- **Project**: calc-test
- **Phase**: plan
- **Task-Ref**: TASK-010
- **Timestamp**: 2026-05-14T00:00:00+08:00

### Decided
- Add `%` as a first-class binary arithmetic operator in `calculator.js`, following the existing operator dispatch/parsing style instead of introducing a new abstraction.
- Add focused regression tests for modulo behavior alongside the existing calculator tests.
- Treat `%` with the same numeric semantics as JavaScript's remainder operator unless the existing test suite or implementation documents a stricter calculator-specific behavior.

### Rejected
- Rewriting the calculator parser/evaluator — unnecessary for a single operator and increases regression risk.
- Adding dependencies for expression parsing or math evaluation — out of scope for this narrow feature.
- Changing unrelated operator behavior, formatting, or test fixtures — this task should remain limited to modulo support.

### Scope

**目标**: Add modulo operator support so calculator expressions using `%` evaluate correctly, and protect the behavior with tests.

**涉及文件**:
- `calculator.js` — add `%` recognition and evaluation in the existing calculator implementation.
- Existing calculator test file, for example `calculator.test.js`, `calculator.spec.js`, or the current project-specific test location — add modulo regression coverage using the existing test framework and naming conventions.

**实现步骤**:
1. Inspect `calculator.js` and identify how existing binary operators such as `+`, `-`, `*`, and `/` are tokenized, parsed, dispatched, or evaluated.
2. Add `%` to the same operator allowlist, parser branch, dispatch table, switch statement, or equivalent control path used by the existing arithmetic operators.
3. Implement modulo evaluation as `left % right`, preserving the existing number conversion, error handling, and precedence behavior already used by the calculator.
4. Add tests for straightforward modulo cases, including at least `5 % 2 = 1` and `10 % 5 = 0`.
5. Add one precedence/regression test if the calculator supports mixed-operator expressions, such as confirming `%` behaves at the same precedence level as `*` and `/`.
6. Run the existing test command used by the project and include the command plus result in `outputs/deliverable-010.md`.

**注意事项**:
- Keep the implementation minimal and consistent with the existing calculator style.
- Do not alter unrelated arithmetic behavior or error messages unless required for `%` to integrate with the existing code path.
- If the calculator currently has no precedence model and evaluates left-to-right, preserve that behavior and write tests that match the current semantics.
- If divide-by-zero has existing behavior, do not invent separate modulo-by-zero handling unless the current implementation already centralizes zero-division checks for all division-like operators.
- Do not update mocks, snapshots, fixtures, or unrelated tests just to force a passing run.

## Next-Action
Implement `%` support in `calculator.js`, add focused tests in the existing calculator test suite, run the project test command, then write `outputs/deliverable-010.md` with changed files, test evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] `calculator.js` accepts `%` wherever existing binary arithmetic operators are accepted.
- [ ] `5 % 2` evaluates to `1`.
- [ ] `10 % 5` evaluates to `0`.
- [ ] Mixed expressions preserve the calculator's existing precedence/evaluation rules, with `%` covered by at least one regression test when mixed expressions are supported.
- [ ] Existing addition, subtraction, multiplication, and division tests still pass without behavior changes.
- [ ] All project tests pass using the existing test command.
- [ ] Code style remains consistent with the surrounding implementation.
