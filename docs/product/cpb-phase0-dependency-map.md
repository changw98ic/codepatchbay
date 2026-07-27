# CPB Phase 0 — 关键模块依赖图

> 范围：记录当前（2026-07-27，分支 `codex/complete-durable-release-evolution`）执行内核与编排胶水之间的静态依赖方向，作为 Phase 0 characterization 基线。
>
> 方法：边均经 codegraph（335 文件 / 6729 nodes / 15553 edges）+ `grep` 验证源码 `import` 语句。本文件不改源码。

## 1. 分层不变量（红线）

**`core/` 严禁 import `server/`。**

这是 CLAUDE.md 声明的分层不变量：领域核心可被任何宿主复用，不得反向依赖编排层。当前源码事实：

- `grep "from \"../../server\|server/services\|server/orchestrator"` 在 `core/` 下唯一的文本命中是 `core/handoff/handoff-bundle.ts:19` 的**注释**：

  ```
  /**
   * Redact secrets and strip control chars from text.
   * Mirrors server/services/provider-quota.js:redactSecrets — kept here
   * to avoid core/ → server/ import boundary violation.
   */
  ```

  即 `core/` **故意复制** `redactSecrets` 而非 import，正是为了不破坏该边界。无任何真实 `import ... from ".../server/..."` 语句。

- `server/` → `core/` 方向合法且大量存在（见 §3 桥）。

`core/engine/run-job.ts` 头部注释同样声明："All infrastructure services (createJob, appendEvent, etc.) are injected via ctx — no server/ imports in core/."（`core/engine/run-job.ts:7-8`）

## 2. 执行内核主干：`core/engine/run-job.ts`

`runJob(ctxInput)` 是 native phase 状态机主入口与 crash barrier。它把流程委派给一组同目录 sibling 模块。`core/engine/run-job.ts:11-20` 的 import 即依赖契约：

| 依赖（`core/engine/...`） | 使用的符号 | 职责 |
|---|---|---|
| `run-job-ports.ts` | `RunJobContext`（type） | `RunJobContext = RunJobState & RunJobPorts`（`run-job-ports.ts:101`）——ctx 的类型形状；所有 ctx 字段集中定义处 |
| `run-job-lifecycle.ts` | `finalizeAuditTrail`, `handleRunJobPanic` | 终态审计收尾 + panic 兜底（成功/失败/blocked 三路径都跑） |
| `run-job-prepare.ts` | `createJobAndHandleBlocked`, `prepareTaskAndRiskMap` | 建 job（含 operator-blocked 短路）+ prepare task/riskMap/sourceContext |
| `run-job-assurance.ts` | `runHighAssurancePlanning` | 高保证计划锦标赛（独立双 planner + critique + arbitration） |
| `run-job-checklist-dag.ts` | `freezeChecklistAndMaterializeDag` | **checklist-first 不变量边界**：冻结 acceptance-checklist → 校验 → 事件索引 → 物化 workflow DAG → 生成并 fail-closed 校验 dynamic agent plan |
| `run-job-execute-dag.ts` | `executeWorkflowDag` | DAG 节点顺序/受限并行执行（`DagRunSession`、`runDagNode`、retry/fallback、scope guard、phase result 收敛） |
| `run-job-shared.ts` | `JobRunResult`（type）、（间接）`AppendEvent`/`BlockJob`/`CompleteJob`/`CompletePhase`/`FailJob`/`JobRecord`/`ProgressReporter` | 跨 run-job-* 模块共享的类型与 helper（`blockPreparedJob`/`failPreparedJob`/`reportProgress`/`ts`） |
| `../policy/phase-budget.js` | `resolveAgentPhaseTimeoutMs` | 解析 phase 超时预算（attachPreDagTimeouts） |
| `../contracts/types.js` | `isRecord`, `recordValue`, `LooseRecord` | 动态 JSON 边界的 record narrowing 工具 |

### `run-job-planning.ts` 的位置（重要订正）

任务描述把 `run-job-planning` 列为 `run-job.ts` 直接产物，但**源码事实是**：`run-job.ts` 并不直接 import `run-job-planning.js`。`run-job-planning.js` 被**间接**消费：

- `core/engine/run-job-execute-dag.ts:49` — `} from "./run-job-planning.js";`
- `core/engine/run-job-checklist-dag.ts:23` — `} from "./run-job-planning.js";`

即 `run-job-planning` 是 `run-job.ts` 的二度依赖（经 execute-dag / checklist-dag），仍是 `run-job-*` 家族成员。该 family 完整集合（目录实存文件）：

```
run-job.ts                  主入口（crash barrier + runJobInner）
run-job-ports.ts            RunJobContext / RunJobState / RunJobPorts 类型形状
run-job-shared.ts           跨模块共享类型 + helper（block/fail/reportProgress/ts）
run-job-lifecycle.ts        终态审计 + panic 兜底
run-job-prepare.ts          createJob + prepareTask/riskMap
run-job-checklist-dag.ts    checklist 冻结 + DAG 物化 + plan 校验
run-job-planning.ts         planning 工具（被 execute-dag / checklist-dag 消费）
run-job-execute-dag.ts      DAG 执行（runDagNode / retry / fallback / scope guard）
run-job-assurance.ts        高保证计划锦标赛
```

### `runJobInner` 的顺序契约（`core/engine/run-job.ts:108-192`）

```
1. createJobAndHandleBlocked      → operator-blocked 短路
2. prepareTaskAndRiskMap          → riskMap + phaseSourceContext + dynamicAgentPlan
3. runHighAssurancePlanning       → 高保证 plan（可选；kind=skipped 即跳过）
4. freezeChecklistAndMaterializeDag → checklist 冻结 + DAG 物化（fail-closed）
5. executeWorkflowDag             → DAG 节点执行（返回 JobRunResult）
finalizeAuditTrail 在 runJob 外层 try/catch 两侧都跑（best-effort）
```

## 3. 桥：`server/services/engine-runner.ts`

`server/services/engine-runner.ts` 是**唯一的 composition root**：它组装生产级 `RunJobPorts` 并注入 `core/engine/run-job.ts`。这是 `server/ → core/` 的合法依赖路径。

`engine-runner.ts:1-22` 的 import 即依赖契约：

| 来源（`server/services/...`） | 符号 | 注入为 port |
|---|---|---|
| `./job/job-store.js` | `createJob`, `startPhase`, `completePhase`, `completeJob`, `failJob`, `blockJob` | 状态迁移 port |
| `./event/event-store.js` | `appendEvent` | 事件日志 port（`EventRecord` from `./event/event-types.js`） |
| `./acp/acp-pool.js` | `getManagedAcpPool` | `getPool()`（Provider/ACP 池） |
| `./provider-quota.js` | `assertProviderAvailable` | `providerServices.assertProviderAvailable` |
| `./provider-adapters.js` | `getProviderAdapter` | `providerServices.getProviderAdapter` |
| `./provider-usage.js` | `readAgentRoutingMetrics` | `providerServices.readAgentRoutingMetrics` |
| `./quota-delegate-client.js` | `delegateMarkProviderUnavailable`, `delegateEnqueueProviderUsage` | providerServices delegate |
| `./project/project-loader.js` | `prepareTask` | `prepareTask` port（`CPB_ACP_FAKE_ACP_COMMAND` 时换 fake fixture） |
| `./job/job-projection.js` | `buildArtifactIndex` | `getArtifactIndex` port |
| `./hub/hub-registry.js` | `resolveHubRoot`, `getProject` | 解析 sourcePath / hubRoot / projectRuntimeRoot |
| `./infra.js` | `addChildPid` | `processHooks.registerChild`（verify hard-gate child PID 持久化） |
| `../../core/engine/run-job.js` | `runJob` | 调用目标（核心） |
| `../../core/engine/run-job-ports.js` | `CreateJobPort`, `RunJobPorts`（type） | port 类型 |
| `../../core/engine/provider-handoff.js` | `normalizeProviderServices` | providerServices 规范化 |
| `../../core/engine/run-job-shared.js` | `JobRecord`（type） | createJob 返回类型 |
| `../../shared/orchestrator/worker-broker-client.js` | `WorkerBrokerClient` | broker 路径（managed-worker 进程外派发时 port 绑定到 broker） |

关键函数：

- `buildServices(cpbRoot, { hubRoot, env, dataRoot, workerBrokerClient })`（`engine-runner.ts:73`）——组装 `ports` 对象（`satisfies RunJobPorts`）。当 `workerBrokerClient` 存在（managed-worker 进程外执行）时，port 绑定到 broker；否则绑定到本地 `job-store` / `event-store` 函数（带 `dataRoot`）。
- `runJobWithServices(opts)`（`engine-runner.ts:130`）——解析 `sourcePath`/`hubRoot`/`projectRuntimeRoot`，构造 env，调用：

  ```
  runJob({ ...jobOptions, cpbRoot, project, hubRoot, dataRoot, env, sourcePath,
           routing, agentAvailability, agentHealth, teamPolicy, processHooks,
           ...services, providerServices })
  ```

  即**所有 ctx 注入从这里发生**。`core/engine/run-job.ts` 本身不 import 任何 server/ 模块。

## 4. Job 持久化与投影

| 文件 | 关键符号 | 依赖方向 |
|---|---|---|
| `server/services/job/job-store.ts` | `createJob`（:511）、`startPhase`（:649）、`completePhase`（:723）、`blockJob`（:758）、`failJob`（:785）、`completeJob`（:1132）、`createRecoveryJob`（:930）、`requestCancelJob`（:1235）、`cancelJob`（:1292）、`requestRedirectJob`（:1322）、`getJob`（:1362）、`recordActivity`（:1202）、`recordFinalizerResult`（:1218） | 被 `engine-runner.ts` 与 `phase-runner.ts`/`auto-finalizer.ts`/`readiness-checks.ts` 等消费；`getJob` 有 27 个 caller |
| `server/services/job/job-projection.ts` | `ProjectionRecord`（:13）、`buildArtifactIndex`、`buildJobRunReport`（:542）、`jobVisibilityPanel`（:528）、`allJobs`（:990）、`inferKind`（:175） | 从 event log 派生只读投影；`buildArtifactIndex` 经 engine-runner 注入为 `getArtifactIndex` port |
| `shared/orchestrator/worker-broker-client.ts` | `createJob`（:176）、`WorkerBrokerClient` | managed-worker 进程外派发时，port 调用 broker 而非本地 job-store |

`jobVisibilityPanel`（`job-projection.ts:528-540`）返回 `{ project, jobId, status, updatedAt, completion, runtimePolicy }` —— 这是**当前最接近公开面板的现存投影**，但它包含 `jobId`，而按 Phase 0 TaskView 契约（见 `cpb-phase0-field-visibility.md`）`jobId` 属 debug-only，不得进入公共投影。

## 5. Worker 侧：`runtime/worker/assignment-finalizer.ts`

`runtime/worker/assignment-finalizer.ts` 是 managed-worker 完成态收尾的证据边界：

- 关键导出：`FinalizerMutationOperation`、`FinalizerMutationFence`、`AssertFinalizerMutationLease`、`ValidateFinalizerMutationReceipt`、`RecoverFinalizerOnly`。
- 关键内部函数：`maybeFinalizeSuccessfulAssignment`、`finalizeAndWriteSuccessfulResult`、`recoverAndWriteFinalizerOnlyResult`、`finalizerFailure`、`finalizerValidationBinding`。
- 依赖（`assignment-finalizer.ts:26-27`）：`shared/orchestrator/finalizer-candidate.js`、`shared/orchestrator/review-bundle-path.js`（`verifiedCanonicalReviewBundlePath`）。
- 协议：`FinalizerMutationFence`（`assignment-finalizer.ts:104-122`）携带 `assignmentId`/`entryId`/`attemptToken`/`orchestratorEpoch`/`workerId`/`workerIncarnation`/`processIdentity`（pid + startTimeTicks + bootId）/可选 `takeover`（owner-dead / explicit-handoff）——即 finalizer 单次发布的租约证据。
- 与 `server/services/auto-finalizer.ts` 的关系：`FinalizerRecord`（`auto-finalizer.ts:65-146`）是 finalizer 流程的宽记录类型；`assignment-finalizer.ts` 在 worker 进程侧产出，`auto-finalizer.ts` 在 hub 侧消费/落盘。两者经 `finalizeSuccessfulQueueEntry`（`FinalizeOptions`，`assignment-finalizer.ts:149`）对接。

## 6. 依赖方向总览（ASCII）

```
                       cli/cpb.ts  (纯 Node 路由)
                            │
                            ▼
              server/services/engine-runner.ts   ◄── composition root
              ┌─────────────┴──────────────┐
              │ 组装 RunJobPorts：           │
              │  job-store / event-store /  │
              │  acp-pool / provider-* /    │
              │  project-loader /           │
              │  job-projection / broker    │
              └─────────────┬──────────────┘
                            │ inject ctx (RunJobContext)
                            ▼
              core/engine/run-job.ts         ◄── 状态机主入口
              ┌─────────────┴──────────────┐
              │ run-job-prepare             │
              │ run-job-assurance           │
              │ run-job-checklist-dag       │
              │   └─ run-job-planning       │
              │ run-job-execute-dag         │
              │   └─ run-job-planning       │
              │ run-job-lifecycle           │
              │ run-job-shared (types/helper)│
              │ run-job-ports (ctx 形状)     │
              └─────────────────────────────┘
                            │
              (core/ 不反向 import server/)
                            │
                            ▼
              cpb-task/events/*.jsonl  (append-only event log)
              cpb-task/checkpoints/    (job 检查点)
              cpb-task/jobs-index.json (projection)

  runtime/worker/assignment-finalizer.ts ──► shared/orchestrator/*
                                            │
  server/services/auto-finalizer.ts ◄──────┘  (hub 侧消费 finalizer 证据)
  server/services/job/{job-store,job-projection}.ts
```

## 7. Phase 0 关注点（非本文件改源码）

- `run-job.ts` 直接 import 的 family 是 ports/shared/lifecycle/prepare/assurance/checklist-dag/execute-dag；`run-job-planning` 是它们的二度依赖。任何"把 planning 提为 run-job.ts 直接依赖"或反向拆分都需同步更新 §2 表与本图。
- `engine-runner.ts` 是唯一 ctx 注入点；任何新增 port 必须先扩展 `RunJobPorts`（`core/engine/run-job-ports.ts:55`）再在此处绑定，否则 core/server 边界会被绕过。
- `jobVisibilityPanel` 当前含 `jobId`，与 TaskView 公共白名单冲突——见 `cpb-phase0-field-visibility.md`。
