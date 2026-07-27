# CPB Phase 0 — 字段可见性决策表

> 范围：冻结"哪些字段只能留在 debug/raw-stream，哪些字段可进入公共 TaskView 投影"的决策表，作为 Phase 0 契约冻结产物。
>
> 来源：产品入口与执行内核计划 §3.2（`docs/product/cpb-product-entry-execution-kernel-plan-2026-07-27.md`，2026-07-27 提案）。

## 0. 契约现状（重要）

**`core/contracts/task-view-fields.ts` 当前不存在。**

- `core/contracts/` 目录现有文件：`failure-recovery.ts`、`failure.ts`、`git-platform.ts`、`phase-result.ts`、`supervisor-decision.ts`、`types.ts`、`worktree-ownership.ts`。**无 `task-view-fields.ts`**。
- 全仓 `grep "TaskView"` 在 `core/` 与 `server/` 下**零命中**——TaskView 符号尚未定义。
- TaskView v1 是 `cpb-product-entry-execution-kernel-plan-2026-07-27.md` §3.2 的**提案**，计划在 Phase 1/2 落地（`server/services/task/task-view.ts`，见计划 §4 阶段 1）。

**本文件即该契约的 Phase 0 冻结文本。** 当 Phase 1/2 创建 `core/contracts/task-view-fields.ts` 时，必须以本表为权威字段集合；任何新增字段需先在本表登记并通过审查。计划明确要求 Phase 0 "明确哪些字段只能留在 debug/raw stream，哪些字段可进入公共投影"（计划 §4 阶段 0 工作项 5）。

## 1. 公共 TaskView 白名单（v1）

这 10 个字段是 TaskView 公共投影允许暴露的**完整**集合。其他字段一律不得进入 `cpb task <task-id>` 默认输出或任何面向普通用户的面板。

| 字段 | 语义 | 备注 |
|---|---|---|
| `schemaVersion` | TaskView schema 版本 | 允许未来演进，但 v1 冻结后变更需登记 |
| `taskId` | 不透明任务标识 | **直接复用现有 queue entry id**，不新建 task→job 双注册表（计划 §3.2） |
| `state` | 任务状态（见 §2 状态枚举） | 从 queue/job/event/gate/finalizer 派生，不得直接抄 `job.status` |
| `summary` | 人类可读任务摘要 | 来自 task 文本，非内部架构名词 |
| `progress` | 进度信息 | stage / label / percent 类（参考 `server/services/dispatch/dispatch.ts:719-732` 的 `humanNextAction` 同源数据） |
| `checks` | 验证检查项 | 来自 acceptance-checklist + completion gate 的逐项 verdict |
| `changedFiles` | 改动文件列表 | repo-relative posix 路径；来源参考 `core/workflow/probe-runner.ts:70` 的 `changedFiles()` |
| `nextAction` | 用户可执行的下一步 | "Open, not queued" / "Start a CPB worker" 等（参考 `dispatch.ts:722-732`） |
| `createdAt` | 任务创建时间 | queue entry 创建时刻 |
| `updatedAt` | 任务最近更新时间 | 来自 event projection 的 `updatedAt`（`job-projection.ts:40`） |

## 2. TaskView 状态枚举（v1）

下列 9 个状态是公共投影允许出现的状态值。**`needs_setup`、`invalid_request`、`runtime_unavailable` 属于提交前失败，不产生任务、不进 queue、不出现在 TaskView。**

```
accepted
queued
running
verifying
succeeded
needs_input
blocked
failed
canceled
```

状态映射必须来自现有权威数据链（计划 §4 阶段 2），不得把 `job.status=completed` 直接翻译成"已修好"：

```
queue entry → job / assignment / attempt → event projection
            → completion gate → finalizer receipt
```

公共结果至少分开表达三态：`completed` / `verified` / `deliveryReady`。只有 completion gate 为 complete **且** verify verdict 为 PASS **且** candidate identity 校验通过 **且** clean replay 通过 **且** 无缺失/过期/污染/不匹配证据时，才显示"验证通过"。

## 3. Debug / raw-stream 专属字段（禁止进入公共投影）

下列字段只能出现在 debug 输出、原始 event stream（`cpb stream` SSE）或 operator 面板，**默认不得出现在 `cpb task` / `cpb fix` 默认输出**。

| 字段类别 | 具体字段 | 为何不能公开 |
|---|---|---|
| 内部身份 | `jobId` | 内部运行时身份；公开投影用 `taskId`（queue entry id）作为不透明标识即可 |
| 重试身份 | `attemptId` | 暴露内部重试/attempt 模型，对普通用户无意义 |
| Provider | `provider`、`providerKey`、`providerFamily`、`providerAdapter`、`providerRegion` | Provider 是内部 handoff 概念；冻结期不公开 provider 体系 |
| Agent | `agent`、`variant`、`producerAgent`、`executor`、`routing`、`agentAvailability`、`agentHealth` | 5 个语义角色（planner/executor/verifier/reviewer/remediator）是内部路由概念 |
| 租约/会话 | `lease`、`session`、`sessionId`、`executionBoundary`、`workerId`、`workerIncarnation`、`orchestratorEpoch`、`attemptToken` | managed-worker 恢复协议内部状态；泄露会暴露恢复边界 |
| 进程 | `PID` / `pid`、`startTimeTicks`、`bootId`、`processIdentity` | 进程级身份，与 finalizer 单次发布租约相关（`assignment-finalizer.ts:104-122` 的 `FinalizerMutationFence`） |
| 提示词 | `prompt`、`promptArtifact` | agent prompt 可能含任务原文/仓库细节/敏感上下文 |
| 环境 | 环境变量（`env`）、`CPB_*` 配置 | 可能含密钥/token/绝对路径 |
| 绝对路径 | 绝对运行时路径（`cpbRoot`、`hubRoot`、`dataRoot`、`sourcePath`、`projectRuntimeRoot`、eventLogPath、worktree path） | 暴露宿主文件系统布局；`changedFiles` 必须 repo-relative |

> **现存冲突点**：`server/services/job/job-projection.ts:528-540` 的 `jobVisibilityPanel` 返回 `{ project, jobId, status, updatedAt, completion, runtimePolicy }`，其中 `jobId` 属上表 debug-only 字段。Phase 1/2 落地 TaskView 时不得直接复用该函数作为公共投影；需新增仅产出 §1 白名单字段的映射层。

## 4. 决策规则

| 场景 | 规则 |
|---|---|
| 新增字段到 TaskView | 必须先加入 §1 白名单本表，再在 `core/contracts/task-view-fields.ts`（待创建）登记；未经本表登记的字段不得进入公共投影 |
| 字段同时存在于 debug 与 public | 默认 debug-only；只有列入 §1 才升级为 public |
| 错误信息 | 公共输出只给用户可执行下一步（`nextAction`），不得输出 Hub/Worker/ACP/Provider handoff/Evidence/lease 等内部术语（计划 §3.4） |
| Live PR / 外部副作用 | TaskView 默认只展示 dry-run/下一步，**不自动执行 live PR** 或其他外部副作用（计划 §4 阶段 2） |
| Idempotency key | 对外不写入明文 key，只保留哈希或不可逆引用（计划 §3.3） |
| 提交前失败 | `needs_setup`/`invalid_request`/`runtime_unavailable` 不产生任务、不进 queue、不出现在 TaskView 状态枚举（§2） |

## 5. 交叉引用

- 契约提案：`docs/product/cpb-product-entry-execution-kernel-plan-2026-07-27.md` §3.2（TaskView v1）、§3.3（幂等）、§3.4（exit code）、§4 阶段 0 工作项 5。
- 计划落点（Phase 1/2 待建）：`cli/commands/fix.ts`、`cli/commands/task.ts`、`server/services/task/task-view.ts`（计划 §4 阶段 1）。
- 待创建契约文件：`core/contracts/task-view-fields.ts`（本表为其 Phase 0 冻结文本）。
- 现存最近似投影（**含 debug 字段，不得直接复用为公共面板**）：`server/services/job/job-projection.ts:528` `jobVisibilityPanel`。
- 公开"下一步"措辞参考：`server/services/dispatch/dispatch.ts:722` `humanNextAction`。
- `changedFiles` 数据源参考：`core/workflow/probe-runner.ts:70`。
