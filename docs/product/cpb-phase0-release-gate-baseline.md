# CPB Phase 0 — Release Gate 基线（2026-07-27）

> 范围：记录当前 release-gate 状态，作为 Phase 0 characterization 基线。
>
**分支**：`codex/complete-durable-release-evolution` · **HEAD**：`cd9f1fa0`（"Keep release evidence gates out of PR CI"）· **记录时间**：2026-07-27。

## 0. 执行约定（重要）

Phase 0 工作流要求**不在本工作流内运行任何 build 或 test 命令**——controller 会在本工作流结束后一次性 build+run 所有测试，以避免并行 `dist/` 写入竞争。因此：

- **已运行**：仅 `--noEmit` 的类型检查（不写 `dist/`，无竞争）。
- **未运行（controller 负责）**：所有需要 build 的 gate（见 §2）。本文件登记命令与职责，标注"controller to run"。

## 1. 已运行结果（`--noEmit` 类型检查）

### 1.1 `npm run typecheck`

- **命令**：`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.tests.json --noEmit`
- **性质**：纯 `--noEmit`（两次 tsc 调用均带 `--noEmit`，package.json:48）
- **结果**：**PASS**（exit 0）
- **覆盖**：node 源码（`tsconfig.node.json`）+ 测试源码（`tsconfig.tests.json`）

输出尾行：
```
> codepatchbay@0.4.1 typecheck
> tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.tests.json --noEmit
EXIT=0
```

### 1.2 `npm run typecheck:strict:engine`

- **命令**：`tsc -p tsconfig.strict-engine.json --noEmit`
- **性质**：纯 `--noEmit`（package.json:49）
- **结果**：**PASS**（exit 0）
- **覆盖**：`core/engine/*.ts` 子集（`tsconfig.strict-engine.json` 的 `include`），开启 `strict` + `noImplicitAny` + `noEmitOnError`。include 列表含：`adversarial-verdict-events`、`candidate-artifact`、`candidate-replay`、`completion-{checklist-artifacts,failure,gate,gate-runner,success}`、`dag-{builder,node-resume,node-lifecycle-events,node-failure}`、`phase-{policy,agent-routing,artifact-tracker,retry}`、`run-job{,-assurance,-checklist-dag,-execute-dag,-planning,-ports,-shared,-lifecycle,-prepare}.ts`、`run-job.ts`、`run-phase`、`runtime-{artifact-events,failure-recorder}`、`scope-guard{,-runner}`、`session-pin`、`poisoned-session{,-gate}`、`solver-loop`、`workflow-runner`、`provider-{handoff,preflight,quota-fallback,usage-recorder}` 等。
- **意义**：这是 CLAUDE.md 称为"稳定化周期红线"的 strict engine 门禁。当前 HEAD 通过。

输出尾行：
```
> codepatchbay@0.4.1 typecheck:strict:engine
> tsc -p tsconfig.strict-engine.json --noEmit
EXIT=0
```

### 1.3 `npm run typecheck:type-debt:engine` — ⚠️ 未运行（见 §2.1）

此命令被列入任务清单，但**经 package.json 核实并非 `--noEmit`**：它执行 `npm run build:node && node dist/scripts/type-debt-guard.js`，会写 `dist/`。按 §0 约定不在本工作流内运行。详见 §2.1。

## 2. 未运行（controller 负责，需要 build）

下表每条命令都先 `npm run build:node` / `npm run build:tests`（`node scripts/build-output.mjs`），会写 `dist/` 与 `dist-tests/`，故由 controller 在工作流外统一执行。

### 2.1 `npm run typecheck:type-debt:engine`

- **命令**：`npm run build:node && node dist/scripts/type-debt-guard.js`（package.json:50）
- **性质**：**需要 build**（非 `--noEmit`）→ **controller to run**
- **为何未在此运行**：`build:node` 编译 TS 到 `dist/`，与 §0 的"本工作流不 build"约定冲突。任务描述把该命令归入"ONLY --noEmit checks"系误判——package.json 显示其首步即 `npm run build:node`。
- **脚本职责**（`scripts/type-debt-guard.ts`，未运行，仅读源码确认意图）：扫描 `core/engine` 目录，统计 broad-any 模式——`AnyRecord`、`Record<string, any>`、`as any`、`unknown as`、`@ts-ignore`、`@ts-expect-error`——并与 `scripts/type-debt-allowlist.json` 比对，超出 allowlist 即失败。
- **预期**：controller 运行后登记实际结果。CLAUDE.md 称之为"broad-any 债务守卫"。

### 2.2 `npm run verify:release-gate`

- **命令**：`npm run build && npm run build:tests && node dist/scripts/verify-release-gate.js`（package.json:69）
- **性质**：需要 build → **controller to run**
- **触发条件**：PR 触及发布门禁时必跑（CLAUDE.md 稳定化周期红线）。
- **脚本职责**（`scripts/verify-release-gate.ts`，未运行，仅读源码确认意图）：spawn 一组 curated `dist-tests/tests/*.test.js`，含 `adversarial-verdict-events`、`checklist-{decompose-integration,artifact-index,completion-gate}`、`completion-{checklist-artifacts,failure,gate-runner,success}`、`assignment-finalizer`、`auto-finalizer`、`github-draft-pr`、`disposable-draft-pr-rehearsal`、`live-release-evidence`、`product-gate`、`release-readiness-report`、`dag-node-{resume,lifecycle-events,failure}`、`phase-{agent-routing,artifact-tracker}` 等。
- **预期**：controller 运行后登记实际结果。当前 HEAD 的近期提交（`cd9f1fa0` "Keep release evidence gates out of PR CI"、`c1225aa1` "Isolate deterministic lock fence tests"）表明 release-gate 集合近期被刻意收敛——controller 结果应与此基线对照。

### 2.3 `npm run verify:p0p1`

- **命令**：`npm run build && npm run build:tests && node dist/scripts/verify-p0-p1.js`（package.json:67）
- **性质**：需要 build → **controller to run**
- **脚本职责**（`scripts/verify-p0-p1.ts`，未运行，仅读源码确认意图）：跑聚焦的 P0/P1 `dist-tests`，含 `adversarial-verdict-events`、`setup-{manifest-registry,snapshot-contract,version-pin}`、`github-{signature,issue-queue,draft-pr}`、`artifact-index-contract`、`assignment-finalizer`、`auto-finalizer`、`job-artifact-detail`、`audit-export`、`runtime-{health-gate,artifact-events}` 等，支持 SKIP 语义。
- **预期**：controller 运行后登记实际结果。

## 3. 其他相关 gate（登记，不在 Phase 0 范围）

下列 gate 在 package.json 中存在但非本 Phase 0 基线必须项，仅登记供 controller 决策：

| 命令 | 脚本 | 性质 |
|---|---|---|
| `npm run verify:commit-size` | `build:node && node dist/scripts/verify-commit-size.js` | HEAD 提交 >1000 行或 30 文件须带说明 body（`CPB_COMMIT_SIZE_OVERRIDE` 绕过）；CLAUDE.md 提及 |
| `npm run verify:patch-integrity` | `build:node && node dist/scripts/verify-patch-integrity.js` | patch 完整性 |
| `npm run verify:product-gate` | `build:node && node dist/scripts/verify-product-gate.js` | 产品 gate（真实维护者/benchmark 证据） |
| `npm run verify:live-release-evidence` | `build:node && node dist/scripts/verify-live-release-evidence.js` | live release 证据 |
| `npm run report:release-readiness` | `build:node && node dist/scripts/release-readiness-report.js` | release readiness 报告 |
| `npm run verify:dependency-audit` | `npm audit ...` | 依赖审计（无 build） |

## 4. 基线小结

| 命令 | 类型 | 本工作流运行 | 结果 |
|---|---|---|---|
| `npm run typecheck` | `--noEmit` | 是 | **PASS**（exit 0） |
| `npm run typecheck:strict:engine` | `--noEmit` | 是 | **PASS**（exit 0） |
| `npm run typecheck:type-debt:engine` | 需要 build（非 `--noEmit`） | 否（§0 约定） | **controller to run** |
| `npm run verify:release-gate` | 需要 build | 否（§0 约定） | **controller to run** |
| `npm run verify:p0p1` | 需要 build | 否（§0 约定） | **controller to run** |

**Phase 0 类型层面基线**：node+tests `typecheck` 与 `strict:engine` 双双通过。执行内核（`core/engine/*`）当前满足 strict + noImplicitAny + noEmitOnError 红线。其余 gate 待 controller 在统一 build 后补齐结果。

## 5. 注意事项

- 若 controller 运行 §2 任一 gate 失败，需对照本基线判断是"本工作流的 3 份 docs 是否引入回归"（不应：本工作流仅新增 `docs/product/*.md`，未改源码）还是"基线本身已存在的状态"。
- `typecheck:type-debt:engine` 的 allowlist 文件为 `scripts/type-debt-allowlist.json`；若 controller 运行后 broad-any 计数与 allowlist 不符，属 type-debt 守卫失败，需在后续阶段处置（非本 Phase 0 范围）。
- 近期提交 `cd9f1fa0`/`c1225aa1`/`ed6604b6`/`c81e3afc` 主动调整了 release-gate / CI 的测试集合归属——解释 `verify:release-gate` 的 curated 列表与主 CI 流程的关系时需结合这些提交。
