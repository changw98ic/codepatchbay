## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: plan-008 — Add modulo (%) operator support
- **Timestamp**: 2026-05-14T08:04:00Z
- **Plan-Ref**: 008

### Implemented
- Added `%` as a binary arithmetic operator in `calculator.js` using the existing operator pattern.
- `%` is tokenized alongside `+`, `-`, `*`, `/` in `tokenize()`.
- `%` is parsed in `parseTerm()` with the same precedence as `*` and `/`.
- `%` is evaluated through a `modulo(a, b)` function that throws on division by zero.
- Added focused test coverage in `test-calculator.js` covering both direct `modulo()` calls and `evaluate()` expressions, including the plan-suggested case `10 % 3 = 1`.

### Files Changed
- `calculator.js` — Added `modulo()` function; extended `tokenize()` to accept `%`; extended `parseTerm()` to dispatch `%` to `modulo()`; exported `modulo` and `evaluate`.
- `test-calculator.js` — Imported `modulo` and `evaluate`; added assertions for `modulo(9, 4)`, `modulo(10, 3)`, `modulo(10, 2)`, `modulo(5, 2)`; added assertions for `evaluate('9 % 4')`, `evaluate('10 % 3')`, `evaluate('10 % 2')`, and precedence check `evaluate('2 + 6 % 4')`.

### Evidence

**测试结果**:
```
PASS add(2, 3): 5
PASS add(-1, 4): 3
PASS subtract(7, 4): 3
PASS subtract(0, 5): -5
PASS modulo(9, 4): 1
PASS modulo(10, 3): 1
PASS modulo(10, 2): 0
PASS modulo(5, 2): 1
PASS evaluate("9 % 4"): 1
PASS evaluate("10 % 3"): 1
PASS evaluate("10 % 2"): 0
PASS evaluate("2 + 6 % 4"): 4

All tests passed.
```

**Diff 摘要**:
```diff
+ function modulo(a, b) { if (b === 0) throw new Error('Modulo by zero'); return a % b; }
  tokenize:  ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%'
  parseTerm: tokens[pos].value === '*' || tokens[pos].value === '/' || tokens[pos].value === '%'
    else { left = modulo(left, right); }
+ module.exports = { add, subtract, multiply, divide, modulo, evaluate };
```

### Unresolved
- 无

### Risks
- 无新增风险。`%` 与 JS 原生 `%` 语义一致（remainder），在负操作数上的行为与数学模运算不同，但符合计算器现有设计。

## Next-Action
验证实现是否满足 plan-008.md 中的 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [x] `%` 被接受为与其他二元算术运算符同级的运算符（tokenize + parseTerm）。
- [x] `%` 返回正确的余数（`modulo(10, 3) === 1`，`evaluate('10 % 3') === 1`）。
- [x] 现有算术测试（add, subtract）仍通过。
- [x] 变更范围仅限于 `calculator.js` 和 `test-calculator.js`。
