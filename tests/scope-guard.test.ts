import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateScopeGuard } from "../core/engine/scope-guard.js";

test("evaluateScopeGuard strips porcelain paths and reports only changes outside fix_scope", () => {
  const result = evaluateScopeGuard({
    changedFiles: ["M  src/app/main.ts", "?? docs/out-of-scope.md", "M src/app/secondary.ts"],
    fixScope: ["src/app"],
  });

  assert.deepEqual(result, {
    withinScope: false,
    violations: ["docs/out-of-scope.md"],
    changedFiles: ["src/app/main.ts", "docs/out-of-scope.md", "src/app/secondary.ts"],
    fixScope: ["src/app"],
  });
});

test("evaluateScopeGuard passes when fix_scope is empty or changes are absent", () => {
  assert.deepEqual(evaluateScopeGuard({ changedFiles: ["M  src/app/main.ts"], fixScope: [] }), {
    withinScope: true,
    violations: [],
    changedFiles: ["src/app/main.ts"],
    fixScope: [],
  });
  assert.deepEqual(evaluateScopeGuard({ changedFiles: [], fixScope: ["src/app"] }), {
    withinScope: true,
    violations: [],
    changedFiles: [],
    fixScope: ["src/app"],
  });
});
