# Plan: Create a simple calculator.js with add and subtract functions

## Handshake
- sender: codex
- receiver: claude
- phase: plan
- project: __ABS_WORKSPACE_CPB_PATH__/wiki/projects/calc-test

## Objective
Create `calculator.js` that exports two functions:
- `add(a, b)` — returns numeric sum
- `subtract(a, b)` — returns numeric difference

## Scope and constraints
- Scope is limited to `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/calc-test/inbox/`.
- No terminal commands, no tests, no implementation-only work in this phase.
- File to be created for execution step: `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/calc-test/inbox/calculator.js`.

## Step 1: Define minimal file contract
- Add a simple module interface with exactly two functions: `add` and `subtract`.
- Keep behavior explicit and deterministic for two positional numeric inputs.
- Acceptance criteria:
  - The file contains only the `add` and `subtract` function definitions.
  - No additional side effects, dependencies, or I/O in module initialization.

## Step 2: Implement `add(a, b)`
- Implement `add(a, b)` as strict arithmetic on the two arguments.
- Keep it pure and symmetric for input order.
- Acceptance criteria:
  - `add(2, 3)` resolves to `5`.
  - `add(-1, 4)` resolves to `3`.

## Step 3: Implement `subtract(a, b)`
- Implement `subtract(a, b)` as strict arithmetic returning first minus second.
- Keep it pure and consistent with `add` input assumptions.
- Acceptance criteria:
  - `subtract(7, 4)` resolves to `3`.
  - `subtract(0, 5)` resolves to `-5`.

## Step 4: Export and handoff format
- Export both functions as named exports (or module-compatible equivalent per project conventions).
- Keep naming and casing exactly as required by task wording.
- Acceptance criteria:
  - Consumers can import and use both `add` and `subtract`.
  - No additional public API is introduced.
