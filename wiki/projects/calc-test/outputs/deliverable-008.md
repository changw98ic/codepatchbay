## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: TASK-008
- **Timestamp**: 2026-05-14T08:55:00Z
- **plan-ref**: 008

### Implemented
- Added `%` (modulo) operator support to `calculator.js` as a binary arithmetic operator.
- Extended the existing recursive-descent parser so `%` is tokenized, parsed at the `parseTerm` level (same precedence as `*` and `/`), and evaluated via a new `modulo(a, b)` helper.
- Added test coverage in `test-calculator.js` covering both the raw `modulo()` function and expression evaluation via `evaluate()`.

### Files Changed
- `calculator.js` — Added `modulo()` function with divide-by-zero guard, extended `tokenize()` to recognize `%`, extended `parseTerm()` to dispatch `%` to `modulo()`, added `evaluate()` entry point, and updated `module.exports`.
- `test-calculator.js` — Imported `modulo` and `evaluate`, added 6 new assertions covering normal modulo cases and precedence (e.g., `2 + 6 % 4 == 4`).

### Evidence

**测试结果**:
```
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

function parseTerm(tokens, pos) {
  let [left, newPos] = parseFactor(tokens, pos);
  pos = newPos;
  while (pos < tokens.length && tokens[pos].type === 'operator' && (tokens[pos].value === '*' || tokens[pos].value === '/' || tokens[pos].value === '%')) {
    const op = tokens[pos].value;
    pos++;
    let [right, nextPos] = parseFactor(tokens, pos);
    pos = nextPos;
    if (op === '*') {
      left = multiply(left, right);
    } else if (op === '/') {
      left = divide(left, right);
    } else {
      left = modulo(left, right);
    }
  }
  return [left, pos];
}
```

### Unresolved
- 无。

### Risks
- 无已知风险。

## Next-Action
验证实现是否满足 plan-008.md 中的 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [x] `%` is accepted anywhere the calculator accepts comparable binary arithmetic operators.
- [x] `%` returns the correct remainder for the added test case.
- [x] Existing arithmetic tests still pass.
- [x] The final change set is limited to `calculator.js` and `test-calculator.js`.
- [x] 代码无安全隐患
- [x] 无遗漏的边界情况
