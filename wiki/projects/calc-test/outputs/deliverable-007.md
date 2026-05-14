## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: Add modulo (%) operator support to calculator.js, with test case in test-calculator.js
- **Timestamp**: 2026-05-14T08:04:14Z
- **Plan-Ref**: 007

### Implemented
- Added `modulo(a, b)` function to `calculator.js` with zero-division guard (`throw new Error('Modulo by zero')`).
- Added `%` token recognition in `tokenize()` at `calculator.js:54`.
- Added `%` dispatch in `parseTerm()` at `calculator.js:89-100` with same precedence as `*` and `/`.
- Added modulo regression tests in `test-calculator.js`: direct `modulo()` calls (`9 % 4`, `10 % 2`, `5 % 2`) and `evaluate()` calls (`'9 % 4'`, `'10 % 2'`, `'2 + 6 % 4'`).

### Files Changed
- `calculator.js` — added `modulo` function, `%` token support, and `%` operator dispatch in parser
- `test-calculator.js` — added `modulo` and `evaluate` imports, 6 new modulo test assertions

### Evidence

**测试结果**:
```
$ node test-calculator.js
PASS add(2, 3): 5
PASS add(-1, 4): 3
PASS subtract(7, 4): 3
PASS subtract(0, 5): -5
PASS modulo(9, 4): 1
PASS modulo(10, 2): 0
PASS modulo(5, 2): 1
PASS evaluate("9 % 4"): 1
PASS evaluate("10 % 2"): 0
PASS evaluate("2 + 6 % 4"): 4

All tests passed.
```

**关键代码片段**:
```javascript
function modulo(a, b) {
  if (b === 0) {
    throw new Error('Modulo by zero');
  }
  return a % b;
}
```

### Unresolved
- 无

### Risks
- `modulo` 的零除行为与 `divide` 一致（抛出 `Error`），但项目目前没有明确的异常处理测试规范。

## Next-Action
验证实现是否满足 plan-007.md 中的 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [x] `calculator.js` supports `%` as an operator.
- [x] `test-calculator.js` includes a modulo test case.
- [x] Existing addition, subtraction, multiplication, and division tests still pass.
- [x] The new modulo test passes through the same public API used by other calculator tests.
- [x] No new dependencies or unrelated files are changed.
