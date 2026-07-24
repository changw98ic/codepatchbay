# 测试债修复计划 — 2026-07-24

> 将 `--unit` 从「13s、存在失败」收敛到「0 fail」。`d123a179` 将 fast path 从 298s 降到约 13s，并暴露了此前被慢测试遮住的失败。这里区分“失败分组”和“失败子测试”，不把 13s 当作跨机器的硬性指标。

## 当前状态与口径

`d123a179` 的提交说明报告了 9 个 fast-path failure group。当前工作树已经包含两处未提交的本版回归修复：

- `tests/stabilization-gate.test.ts` 补上 `npm run verify:commit-size` 的两个期望值。
- `tests/event-extension-gate.test.ts` 将 materializer 源文件路径从 `.js` 改为 `.ts`。

在这些本地修复存在的前提下，剩余失败是 8 个子测试，按根因分为：shared-boundary ×2、event-extension-gate ×2、cli-boundary ×1、finalizer ×3。修复完成的验收条件是这些测试 0 fail；历史上的“9”应保留为 d123a179 的基线 failure-group 口径。

这些失败相对于 d123a179 都是 pre-existing，但没有证据表明它们全部由 `b952c61a` 引入。执行时以当前代码和下面的可复现根因为准，不以提交归因替代验证。

## 失败分类与修法

### 1. shared-boundary ×2 — import 路径错误

`shared/orchestrator/finalizer-candidate.ts:5` 从 shared 反向导入 core：

```ts
import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
```

`shared/types.ts` 已提供相同的 `LooseRecord` 和 `isRecord`，兄弟模块也从 `../types.js` 导入。

修复：将 import 改为 `../types.js`。这是低风险的 1 行边界修复，但仍需跑 shared-boundary 两个断言确认没有其他违规。

### 2. event-extension-gate ×2 — 测试源路径与 registry 不一致

`EVENT_MATERIALIZER` 的 `.ts` 源路径修复已经在当前工作树中完成；提交时要保留这处改动。剩余的测试文件检查仍使用 `meta.testFile` 的 `.js` 后缀，而 registry 指向的是 source checkout 中的测试文件。读取前将 `.js` 转换为 `.ts`，例如：

```ts
const sourceTestFile = meta.testFile.replace(/\.js$/, ".ts");
const testPath = path.resolve("tests", sourceTestFile);
```

当前 materializer 缺少 registry 条目的只有 4 个：

- `artifact_created`：回归测试使用 `tests/checklist-artifact-index.test.ts`。
- `audit_finalized`、`runtime_context_snapshot`：回归测试使用 `tests/checklist-runtime-context-audit.test.ts`。
- `runtime_failure_recorded`：回归测试使用 `tests/runtime-failure-recorder.test.ts`。

`plan_cache_decision`、`plan_cache_updated`、`review_bundle_accepted`、`review_bundle_rejected` 仍在 materializer 中有 handler，必须保留 registry 条目；不能按“已移除/改名”删除。新增条目的 `class`、`consumer` 和 `testMatch` 要根据对应 producer、handler 和测试中的实际字段填写，不要只凭事件名猜测。

这部分只修改测试 registry 和测试路径，不修改事件生产或 materializer 生产代码。

### 3. cli-boundary ×1 — doctor 直接依赖 core/runtime

`cli/commands/doctor.ts` 当前从 `core/runtime` 导入 bounded-read 和 process identity，命中了 CLI 对 `runtime/` 的禁止 fragment。

修复方案确定为直接导入 shared primitive：

- `readBoundedRegularFileNoFollow` → `../../shared/primitives/durable-directory-lock.js`；该函数已经存在。
- `captureProcessIdentity`、`sameProcessIdentity`、`ProcessIdentity` → `../../shared/primitives/process-tree.js`。

不新增 `core/diagnostics.ts`，也不放宽 CLI boundary scanner。`core/runtime` 下的对应文件本身只是 shared primitive 的 core-facing re-export，不能作为绕过边界检查的 facade。

### 4. finalizer ×3 — 同一个过时 fixture 根因

3 个失败都在 `appendFinalizerJournal` 的 normalize 前置校验处失败，但不是 3 个独立的生产逻辑 bug。`normalizeFinalizerJournalRecord` 要求：

```text
claim.claimId = finalizerJournalClaimId({
  finalizationId,
  ownerDigest: String(claim.ownerDigest),
  claimGeneration: Number(claim.claimGeneration),
})
```

当前 fixture 有两处没有满足这个不变量：

- `tests/finalizer-journal.test.ts` 的 `prInitialRecord()` 重算了 PR 记录的 `finalizationId`，却沿用了 remote 初始记录的 `claimId`。
- `tests/finalizer-recovery.test.ts` 直接使用 `ORIGINAL_CLAIM_ID`，没有根据 fixture 的 `finalizationId` 和 `ownerDigest` 推导 claim ID。

修复：在两个 fixture helper 中统一通过 `finalizerJournalClaimId(...)` 重建 claim ID；recovery 测试中的 takeover 也使用这个合法的初始 claim ID。保持生产侧 normalize 校验不变，并补一个 fixture-level 断言，确保构造出的初始 record 能通过 normalize。

这使该项成为测试 fixture 修复，而不是最高风险的生产逻辑修改。

## 验证

先从 source checkout 构建测试产物，避免 focused test 运行过期的 `dist-tests`：

```sh
npm run build:node
npm run build:tests
```

然后按组运行：

```sh
node dist-tests/scripts/run-node-tests.js tests/shared-boundary.test.ts
node dist-tests/scripts/run-node-tests.js tests/event-extension-gate.test.ts
node dist-tests/scripts/run-node-tests.js tests/cli-boundary.test.ts
node dist-tests/scripts/run-node-tests.js tests/finalizer-journal.test.ts
node dist-tests/scripts/run-node-tests.js tests/finalizer-recovery.test.ts
```

全部修复后运行：

```sh
node dist-tests/scripts/run-node-tests.js --unit
npm run typecheck
```

验收标准是 `--unit` 结果为 0 fail；13s 仅作为 d123a179 环境下的性能基线。若最终改动继续触及生产代码，再补跑 `typecheck:strict:engine`、`typecheck:type-debt:engine` 及相应稳定性门禁，不提前声称它们“不受影响”。

## 风险与执行顺序

1. shared-boundary：单行 shared import。
2. cli-boundary：两个 import 直接切到已有 shared primitive。
3. event-extension-gate：测试路径转换和 registry 补齐，不改生产事件逻辑。
4. finalizer：只修 fixture 的 claim ID 推导，保持 normalize 不变。

## 关键文件

- `shared/orchestrator/finalizer-candidate.ts`
- `tests/event-extension-gate.test.ts`
- `cli/commands/doctor.ts`
- `shared/primitives/durable-directory-lock.ts`
- `shared/primitives/process-tree.ts`
- `server/services/finalizer-journal.ts`
- `tests/finalizer-recovery.test.ts`
- `tests/finalizer-journal.test.ts`

## 另行处理

runner 在父进程退出后留下 `node --test` 子进程的问题不并入本次测试债修复。若要纳入，应单独补充复现步骤、信号转发/进程组清理策略和“runner 退出后无存活测试子进程”的验收测试；否则作为独立任务跟踪。
