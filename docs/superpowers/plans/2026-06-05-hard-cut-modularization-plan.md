# 硬切模块化改造计划

## 要求摘要

目标：把当前拆层后的 CodePatchBay 继续模块化，优先解决发布、边界、队列恢复、provider 运行时、worker 执行和调度控制面的结构性问题。

硬约束：

- 不做兼容。
- 不保留旧路径兼容入口。
- 不新增兼容 re-export。
- 不维护同一能力的新旧双轨调用。
- 迁移完成后，旧入口必须删除，或改为明确失败并提示唯一新入口。
- 文档、测试和代码都使用中文说明，代码标识符和路径除外。

主要依据：

- `docs/architecture/runtime-boundaries.md`
- `docs/architecture/system-risk-register.md`
- `docs/architecture/system-dimensional-flows.md`
- `docs/architecture/unit-flowcharts.md`

## 决策

采用“先硬切基础设施，再模块化控制面”的两阶段路线。

原因：

- 当前最危险的不是模块还不够漂亮，而是发布和旧入口残留会让系统在提交、release 或运行时断裂。
- 先收敛唯一入口和边界测试，后续模块化才不会继续背兼容债。
- 调度控制面是最大收益项，但它依赖队列、worker、provider 三块协议先稳定。

## 交付顺序

### 阶段 0：提交与发布安全闸

目标：先消除“源码树能跑，但提交/发布缺文件”的风险。

涉及：

- `server/services/acp-client-core.mjs`
- `server/services/apply-variant.js`
- `server/services/delete-guard.js`
- `bridges/*`
- 已删除的 CLI bridge 早期方案
- `tests/*boundary.test.mjs`
- `docs/architecture/*`

实施步骤：

1. 用 `git status --short` 列出所有新增文件。
2. 确认新增文件都属于本次拆层和文档范围。
3. 把新增文件纳入提交清单。
4. 用 `npm pack --dry-run --json` 检查包内容包含所有新增入口、server service、runtime 文件和 docs。
5. 不修复任何旧入口兼容；发现旧入口只登记为删除项。

验收标准：

- `git status --short` 中没有“应提交但未纳入”的新增代码文件。
- `npm pack --dry-run --json` 产物包含新增 bridge、server service、boundary tests 和 docs。
- `docs/architecture/system-risk-register.md` 中 `RISK-003` 可标记为已处理。

验证命令：

```bash
git status --short
npm pack --dry-run --json
```

### 阶段 1：Release / Executor Root 模块化

目标：把 executor root 校验从“检查几个薄入口”升级为“检查唯一入口和关键传递依赖”。

涉及：

- `server/services/executor-root.js`
- `server/services/release-store.js`
- `server/services/readiness-checks.js`
- `scripts/e2e-npm-pack.mjs`

模块边界：

- `executor-root.js` 负责 executor root 定位和必需文件校验。
- `release-store.js` 负责 release 安装、manifest、当前 release 选择。
- `readiness-checks.js` 负责 doctor / release doctor 的用户可见诊断。

实施步骤：

1. 在 `executor-root.js` 中定义唯一的 executor manifest。
2. 将 worker、multi-evolve、CLI bridge、server service 的关键传递依赖纳入校验。
3. 给 `readiness-checks.js` 增加 executor import smoke：
   - `runtime/worker/managed-worker.js`
   - `runtime/evolve/multi-evolve.js`
   - `bridges/engine-bridge.js`
   - `cli/cpb.mjs`
4. 修复 `scripts/e2e-npm-pack.mjs` 的 tarball 版本硬编码，从 `package.json` 或 `npm pack --json` 读取产物名。
5. 不提供旧 executor root 兼容路径。

验收标准：

- 缺少任一关键传递依赖时，`assertExecutorRoot()` 明确失败。
- release doctor 能指出缺失文件名。
- `scripts/e2e-npm-pack.mjs` 不再引用固定版本 tarball。
- `RISK-002`、`RISK-010` 可标记为已处理。

验证命令：

```bash
node --test tests/*release*.test.mjs tests/*executor*.test.mjs
node scripts/e2e-npm-pack.mjs --keep-state
```

如现有测试文件不足，新增 focused tests，避免跑真实 provider。

### 阶段 2：Boundary Scanner 模块化

目标：把四套边界测试的扫描逻辑收敛成一个测试工具，覆盖动态穿层形态。

涉及：

- `tests/core-boundary.test.mjs`
- `tests/server-boundary.test.mjs`
- `tests/runtime-boundary.test.mjs`
- `tests/cli-boundary.test.mjs`
- 新增测试工具，例如 `tests/helpers/boundary-scanner.mjs`

模块职责：

- 扫静态 import。
- 扫副作用 import。
- 扫 dynamic import。
- 扫 `new URL(...)`。
- 扫 `path.join(...)` / `path.resolve(...)`。
- 扫 child process 可执行路径。
- 输出统一 violation。

实施步骤：

1. 新增 `boundary-scanner` 测试 helper。
2. 四个 boundary test 改为声明规则，不再各自复制扫描逻辑。
3. 为扫描器增加 fixture 或内联用例，锁住以下绕法：
   - `import "../server/foo.js"`
   - `await import(path.join(root, "server/services/foo.js"))`
   - `new URL("../runtime/foo.js", import.meta.url)`
   - `path.join(root, "server/services/foo.js")`
   - `spawn(process.execPath, ["runtime/worker/managed-worker.js"])`
4. 删除旧的重复扫描函数。

验收标准：

- 四个 boundary tests 仍通过。
- 人工注入任一绕法时，对应测试失败。
- `RISK-009` 可标记为已处理。

验证命令：

```bash
node --test tests/core-boundary.test.mjs tests/server-boundary.test.mjs tests/runtime-boundary.test.mjs tests/cli-boundary.test.mjs
```

### 阶段 3：唯一 Worker 入口硬切

目标：删除旧 worker 可执行入口语义，所有进程启动统一走唯一 bridge worker。

涉及：

- `runtime/worker/managed-worker.js`
- `runtime/worker/managed-worker.js`
- `runtime/evolve/multi-evolve.js`
- `server/orchestrator/worker-supervisor.js`
- `tests/managed-worker.test.mjs`

模块边界：

- `runtime/worker/managed-worker.js` 是唯一 worker 进程入口。
- `multi-evolve` 和 `worker-supervisor` 都只能启动 `runtime/worker/managed-worker.js`。

实施步骤：

1. 将 `runtime/evolve/multi-evolve.js` 的 worker 启动路径统一为 canonical worker。
2. 调整测试只通过 canonical worker 入口启动。
3. 增加边界测试：旧薄入口不得回归。
5. 不保留旧路径透传。

验收标准：

- 搜索不到旧薄 worker 入口。
- `node runtime/worker/managed-worker.js --worker-id ...` 是唯一可执行路径。
- `RISK-007` 可标记为已处理。

验证命令：

```bash
node --test tests/managed-worker.test.mjs tests/runtime-boundary.test.mjs
rg -n "bridges/managed-worker|../worker/managed-worker" runtime server bridges tests
```

### 阶段 4：旧入口删除

目标：删除服务级旧路径入口，统一到唯一服务和唯一可执行入口。

涉及：

- `server/services/acp-client-core.mjs`
- runtime 旧 ACP / guard / variant 入口
- `server/services/acp-client-core.mjs`
- `server/services/delete-guard.js`
- `server/services/apply-variant.js`

模块边界：

- 服务实现统一在 `server/services/`。
- 可执行 ACP client 如仍需要，必须选一个唯一入口。
- runtime 下不保留服务级 re-export。

实施步骤：

1. 列出所有导入旧 runtime service 路径的调用方。
2. 将调用方改到唯一服务入口或唯一 bridge 入口。
3. 删除 runtime 旧服务路径 re-export。
4. `apply-variant` 服务实现移除 CLI side effect。
5. 如果旧路径仍被执行，改成明确失败，而不是透传。

验收标准：

- 搜索不到服务级旧路径导入。
- `server/services/apply-variant.js` import 时没有 stdout/stderr side effect。
- `RISK-008` 可标记为已处理。

验证命令：

```bash
rg -n "runtime/(acp-client-core|delete-guard|apply-variant)" server runtime bridges cli tests
node --input-type=module -e "await import('./server/services/apply-variant.js'); console.log('ok')"
```

### 阶段 5：Queue Claim / Recovery 模块化

目标：消除队列 claim 和 stale recovery 的双路径语义差异。

涉及：

- `server/services/hub-queue.js`
- `server/orchestrator/scheduler.js`
- `server/routes/hub.js`
- `shared/orchestrator/assignment-store.js`

模块边界：

- 新增或抽取唯一队列 claim 服务，例如 `server/services/queue-claim.js`。
- `Scheduler.nextCandidate()` 和正式 claim API 都调用同一套规则。
- stale recovery 必须查询 assignment 活跃状态。

实施步骤：

1. 抽出 `recoverStaleEntries()`，参数必须包含 `assignmentStore`。
2. 抽出 `selectNextCandidate()`，统一优先级、项目并发、index freshness gate。
3. `Scheduler.nextCandidate()` 改为调用新模块。
4. 判断 `/hub/queue/claim` 是否仍是正式 API：是则直连唯一模块，否则删除路由。
5. 删除 `hub-queue.js` 中不查 assignment 的 stale recovery。

验收标准：

- 不存在两个不同 stale recovery 实现。
- 活跃 assignment 对应的 `in_progress` 队列项不会被 API claim 重置。
- `RISK-004` 可标记为已处理。

验证命令：

```bash
node --test tests/queue-orchestrator.test.mjs tests/assignment-reconciler.test.mjs
```

### 阶段 6：Provider Runtime 模块化

目标：把 provider preflight、handoff、usage、quota delegate 收成稳定 contract。

涉及：

- `core/engine/run-job.js`
- `bridges/engine-bridge.js`
- `server/services/provider-quota.js`
- `server/services/provider-adapters.js`
- `server/services/quota-delegate-client.js`
- `tests/engine-provider-event.test.mjs`

模块边界：

- 新增 provider runtime contract，例如：
  - `assertAvailable()`
  - `selectFallback()`
  - `markUnavailable()`
  - `recordHandoff()`
  - `recordUsage()`
- `core/engine/run-job.js` 只消费该 contract，不认识 server 具体服务。
- `server/services/engine-runner.js` 负责构造完整 contract；`bridges/engine-bridge.js` 只保留 runtime-facing 边界入口。

实施步骤：

1. 修改 `runJobWithServices()`：`undefined` 不覆盖默认 provider services，部分对象与默认 contract 合并。
2. 定义 `providerServices: null` 为显式禁用测试开关；生产路径不使用。
3. 在 `run-job.js` 中维护独立 `handoffState`。
4. usage enqueue 使用 `handoffState`，不从最终成功 `result.failure` 推断 fallback。
5. 补 preflight fallback、mid-run fallback 成功、partial providerServices override 测试。

验收标准：

- 部分 override 不会关闭默认 preflight / quota delegate / usage。
- fallback usage 能记录 from/to/reason/count。
- `RISK-005`、`RISK-006` 可标记为已处理。

验证命令：

```bash
node --test tests/engine-provider-event.test.mjs tests/core-boundary.test.mjs
```

### 阶段 7：Worker Execution 模块化

目标：把 worker 协议和 worker 生命周期从大文件里拆成稳定模块。

涉及：

- `runtime/worker/managed-worker.js`
- `shared/orchestrator/worker-store.js`
- `shared/orchestrator/assignment-store.js`
- `server/orchestrator/worker-supervisor.js`

候选模块：

- `runtime/worker/inbox-protocol.js`
- `runtime/worker/heartbeat-protocol.js`
- `runtime/worker/attempt-result.js`
- `runtime/worker/worktree-lifecycle.js`
- `server/orchestrator/worker-lifecycle.js`

实施步骤：

1. 先抽协议纯函数，不改变行为。
2. 再抽 worktree 创建/清理。
3. 再抽 result 写入和 finalize 写入。
4. 明确 worker retry budget 属于 assignment 还是 worker。
5. 删除未使用的 `MAX_RESTARTS`，或真正接入 worker registry。

验收标准：

- `managed-worker.js` 只保留 main orchestration。
- inbox / heartbeat / result 协议有 focused tests。
- `RISK-011` 可标记为已处理。

验证命令：

```bash
node --test tests/managed-worker.test.mjs tests/assignment-reconciler.test.mjs
```

### 阶段 8：Runtime Control Plane 模块化

目标：把常驻调度从 dispatcher 升级为资源控制面。

涉及：

- `server/orchestrator/scheduler.js`
- `server/orchestrator/hub-orchestrator.js`
- `server/orchestrator/worker-supervisor.js`
- `server/services/acp-pool.js`
- `server/services/provider-quota.js`
- `server/services/agent-metrics.js`

模块边界：

- 新增 `server/orchestrator/runtime-control-plane.js` 或等价模块。
- 输入：
  - queue entries
  - assignments
  - worker registry
  - provider quota
  - ACP pool status
  - agent metrics
- 输出：
  - candidate score
  - backpressure reason
  - worker allocation decision
  - provider pressure summary

实施步骤：

1. 先只做只读 snapshot，不改变调度结果。
2. 将 snapshot 写入 debug / status 输出。
3. 用 snapshot 替换 scheduler 内部散落的状态读取。
4. 加候选打分，但默认权重保持现有行为。
5. 引入 provider / worker backpressure。
6. 最后考虑 P0/P1 快速通道或并发配额。

验收标准：

- 调度决策能解释“为什么选中 / 为什么跳过”。
- provider 限流会影响候选调度，而不是只在 phase 内失败后 fallback。
- worker 容量和 project 并发统一进入一个 decision object。
- `RISK-001` 可降级或关闭。

验证命令：

```bash
node --test tests/queue-orchestrator.test.mjs tests/assignment-reconciler.test.mjs
npm test
```

### 阶段 9：Review / Intake 模块化

目标：把入口规范化和审查闭环收口，减少 API、GitHub、渠道、CLI 入队逻辑分散。

涉及：

- `server/routes/tasks.js`
- `server/routes/github.js`
- `server/routes/channels.js`
- `server/routes/review.js`
- `server/services/review-loop.js`
- `server/services/review-session.js`
- `cli/commands/run.js`
- `cli/commands/pipeline.js`

候选模块：

- `server/services/task-intake.js`
- `server/services/review-workflow.js`

实施步骤：

1. 抽统一 queue input builder。
2. API、GitHub、Slack/Discord、CLI 都产出同一 intake DTO。
3. 审查 session approve / review bundle reject 都走同一 correction queue builder。
4. 删除分散拼 metadata 的重复逻辑。

验收标准：

- 同一任务来源字段在 CLI/API/GitHub/渠道中一致。
- review reject 生成 correction queue entry 的字段稳定。
- 修改 queue metadata schema 时只改一个模块。

验证命令：

```bash
node --test tests/github-*.test.mjs tests/channel-*.test.mjs tests/*review*.test.mjs
```

## 总体验收标准

- `npm test` 通过。
- 四个 boundary tests 通过，并覆盖动态穿层绕法。
- `npm pack --dry-run --json` 确认包内容完整。
- 搜索不到旧路径兼容 re-export。
- 搜索不到 runtime worker 旧可执行入口被 child process 启动。
- `docs/architecture/system-risk-register.md` 中 P1 全部关闭，P2 至少关闭 `RISK-004`、`RISK-005`、`RISK-006`、`RISK-007`、`RISK-008`、`RISK-009`。

总体验证命令：

```bash
node --test tests/core-boundary.test.mjs tests/server-boundary.test.mjs tests/runtime-boundary.test.mjs tests/cli-boundary.test.mjs
node --test tests/engine-provider-event.test.mjs tests/managed-worker.test.mjs tests/queue-orchestrator.test.mjs tests/assignment-reconciler.test.mjs
npm pack --dry-run --json
npm test
```

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 硬切删除旧入口导致漏改调用方 | 先用边界扫描和 `rg` 列出所有旧路径调用，再删除入口 |
| Queue claim 收敛时改变调度行为 | 先写 active assignment stale recovery 回归测试 |
| Provider runtime contract 改动影响所有 job | 先补 provider fallback 和 usage 断言，再改 contract |
| Worker 拆分大文件引入细节回归 | 每次只抽一个协议模块，并跑 managed-worker / reconciler 测试 |
| Control Plane 范围过大 | 先只读 snapshot，不改变调度结果；确认观测稳定后再接入决策 |

## 推荐执行优先级

1. 阶段 0：提交与发布安全闸。
2. 阶段 1：Release / Executor Root 模块化。
3. 阶段 2：Boundary Scanner 模块化。
4. 阶段 3：唯一 Worker 入口硬切。
5. 阶段 4：旧入口删除。
6. 阶段 5：Queue Claim / Recovery 模块化。
7. 阶段 6：Provider Runtime 模块化。
8. 阶段 7：Worker Execution 模块化。
9. 阶段 8：Runtime Control Plane 模块化。
10. 阶段 9：Review / Intake 模块化。

## ADR

决策：采用硬切式模块化路线，不做兼容，不保留旧路径双轨。

驱动：

- 用户明确要求不做兼容。
- 当前风险集中在旧入口残留、发布校验浅、双路径恢复语义不一致。
- 模块化如果继续背兼容壳，会把边界债固化。

备选方案：

- 渐进兼容迁移：拒绝。会保留旧入口和新入口双轨，违反硬切原则。
- 先做 Runtime Control Plane：暂缓。收益高，但依赖队列、worker、provider 协议稳定。
- 只修 P1，不模块化：拒绝。能短期止血，但无法解决后续耦合复发。

后果：

- 短期会有更多调用方同步修改。
- 测试和边界扫描必须先补强。
- 旧脚本和旧入口会明确失效，需要文档指出唯一新入口。

后续：

- 每完成一个阶段，更新 `docs/architecture/system-risk-register.md` 对应风险状态。
- 每删除一个旧入口，补一条边界或 import smoke 测试防止回归。
