# Flow 统合计划调整版

> 目的：在保留原统合计划战略方向的前提下，修正短期执行顺序、遗漏触点和验收口径。
> 生成时间：2026-05-13
> 适用对象：替代 `2026-05-13-flow-unified-master-plan.md` 作为后续执行基线。

---

## 一、调整结论

原计划的核心方向继续成立：

1. `flow-task/events/` 是 durable job 的唯一事实来源。
2. `flow-task/` 是 Flow runtime root，Flow 不再写 `.omc/` 或 `.omx/`。
3. 不引入第二套 task runtime，继续演进当前 `job-store` / `event-store`。
4. 自动分类延后，MVP 使用显式 workflow input。
5. Profile、reviewer、parallel phase 都按需生长，不提前铺大架构。

需要调整的是短期路线。原 M1-M9 把若干控制面问题拆得过薄，容易出现“删掉兼容状态后 UI/CLI 断裂”“cancel 只能等 phase 结束”“redirect 重复注入”“workflow 与 supervisor/UI 不一致”等问题。

本调整版把短期路线改为 A0-A9：

```text
A0  Plan/doc sync
A1  Event-backed projection and compatibility state retirement
A2  Control-plane event contract: cancel + redirect request/consume
A3  Runner/supervisor control-plane enforcement
A4  Activity/liveness events with real consumers
A5  Per-tool ACP policy
A6  Workflow definition contract
A7  Profile loader v1
A8  Reviewer workflow
A9  Diff-based verification
```

---

## 二、当前事实基线

### 已验证状态

- `node --test tests/*.test.mjs` 当前结果：54 pass / 0 fail。
- `bash -n bridges/*.sh tests/*.sh` 当前结果：通过。

### 关键证据

| 证据 | 当前含义 | 对计划的影响 |
|------|----------|--------------|
| `bridges/run-pipeline.mjs:220-267` | Pipeline 仍写 `flow-task/state/pipeline-*.json` 兼容状态 | 不能在第一步直接删除 state writer |
| `server/routes/projects.js:30-35,59-62` | Projects API 仍从兼容 state 读 `pipelineState` | M1 必须先提供 event-backed projection |
| `server/services/watcher.js:6-25` | Watcher 仍监听 `flow-task/state` 并广播 `pipeline:update` | UI 更新通道要先迁移到 `job:update`/投影 API |
| `flow:106-113` | `flow status` 仍读兼容 state | CLI 是 M1 真实触点之一 |
| `server/services/supervisor.js:21-36` | Supervisor phase 顺序硬编码为 plan/execute/verify | workflow 支持不能只改 runner |
| `web/src/components/PipelineStatus.jsx:3-4` | UI phase 展示硬编码三段 | workflow 支持会影响 UI |
| `bridges/acp-client.mjs:452-463,465-468` | 现有权限只有全局 permission 和 terminal allow/deny | per-tool policy 是增量改造，不是新权限系统 |
| `web/src/pages/Dashboard.jsx:124-135` | Durable Jobs panel 已存在 | R3 应改为增强，而不是“新增” |
| `wiki/system/unattended-supervisor.md:9-12,39-40` | 文档仍残留 `.omc/` runtime 路径 | R1 应提前到 A0，避免误导执行 |

---

## 三、调整后的短期执行线

### A0: Plan/doc sync

目标：先修正执行基线，避免后续实现按过期文档推进。

变更范围：

- 更新或替代原统合计划，明确本文件为执行基线。
- 给 `2026-05-13-flow-unified-master-plan.md` 加 superseded 标记（文件头加醒目警告，或移至 `docs/superpowers/plans/archive/`）。
- 修正 `wiki/system/unattended-supervisor.md` 中 `.omc/events`、`.omc/leases`、`.omc/worktrees` 为 `flow-task/events`、`flow-task/leases`、`flow-task/worktrees`（涉及 line 9-12、line 39-40）。
- 修正 roadmap 中 “UI Durable Jobs panel 新增” 为 “Durable Jobs panel 增强”。
- 明确 `bridges/init-project.sh` 中 `.omc/wiki/flow` symlink 是项目集成链接（project integration symlink），不是 runtime state。Flow live runtime 不读写 `.omc/` 指的是不写 events/leases/state/worktrees 等运行时数据。验收标准中的 “Flow live runtime does not read or write `.omc/`” 应精确为 “Flow live runtime 不读写 `.omc/events`、`.omc/leases`、`.omc/state`、`.omc/worktrees`；`.omc/wiki/flow` 是 init 创建的项目集成 symlink，不属于 runtime state”。

验收：

- `rg -n "\\.omc/(events|leases|worktrees)" wiki docs README.md` 只剩历史迁移说明或明确标注为 legacy。
- `node --test tests/*.test.mjs` 通过。

附加检查：

- 审计 `profiles/` 目录现有内容（`profiles/claude/`、`profiles/codex/`），记录现有 soul.md 中是否有硬编码权限指令，避免 A7 profile loader 与现有内容冲突。

风险：

- 文档先改不影响 runtime，但会改变后续执行口径。

---

### A1: Event-backed projection and compatibility state retirement

目标：把 UI/API/CLI 读路径迁到 event-store materialized job，最后再删除兼容 state。

#### A1.1 新增投影层

新增 `server/services/job-projection.js`，提供：

- `jobToPipelineState(job)`：把 materialized job 转为旧 UI 可消费的 `pipelineState` 形状。
- `projectPipelineState(flowRoot, project)`：从 `listJobs()` 找该项目最新 running/non-terminal job，必要时退回最近 job。
- `listProjectPipelineStates(flowRoot)`：供 projects list 一次性使用，避免每个项目重复全量扫描。

保留字段兼容：

```js
{
  project,
  task,
  jobId,
  phase,
  status,
  retryCount,
  maxRetries,
  started,
  updated
}
```

其中 `retryCount/maxRetries` 如果 event log 暂时没有，就返回 `null`，不要伪造。

#### A1.2 迁移读路径

修改：

- `server/routes/projects.js`：不再读 `flow-task/state/pipeline-*.json`，改用 projection。
- `flow status`：不再调用 `json-helper.mjs` 读 state，改用 `bridges/list-jobs.mjs` 或新增轻量 node helper 读取 projection。
- `web/src/pages/Dashboard.jsx`：保留 `pipelineState` 字段消费，但来源由 API/projection 提供。

#### A1.3 迁移更新通道

修改：

- `server/services/watcher.js`：`job:update` 触发后广播 job projection，或前端收到 `job:update` 后刷新 `/api/tasks/durable` 与 `/api/projects`。
- 删除 `flow-task/state` watcher 前，先保证 UI 在 pipeline run 中能刷新。

#### A1.4 删除兼容 state 写入

只有在 A1.1-A1.3 验收通过后，才删除：

- `bridges/json-helper.mjs`
- `common.sh` 中 `state_read/state_write/state_init`
- `run-pipeline.mjs` 中 `pipelineStateFile/readPipelineState/initPipelineState/writePipelineState`
- tests 中对 `flow-task/state/pipeline-*.json` 的正向依赖

验收：

- `! rg -n "pipeline-.*json|flow-task/state" server bridges flow web/src tests --glob '!worktree-manager.*'`
- `node --test tests/*.test.mjs`
- `bash tests/flow-jobs.test.sh`
- `bash tests/flow-bridges.test.sh`
- 手动或 fixture 验证：pipeline 执行中 Dashboard 能看到 job status/phase 更新。

#### A1.5 确认 Lease TTL 语义一致性

经核实，当前 TTL 设计没有 bug，只是语义需要文档化：

- `lease-manager.js:8` 的 `DEFAULT_LOCK_TTL_MS = 30,000ms` 是 **lock 目录 TTL**（mkdir atomic lock 的超时），不是 phase lease TTL。
- `job-runner.mjs:127` 和 `run-pipeline.mjs:147` 的 `FLOW_LEASE_TTL_MS`（默认 120,000ms）是 **phase lease TTL**（控制单次 phase 的租约时长）。
- 两个 TTL 控制不同机制，不需要统一。Lock TTL 控制的是"两个进程争抢同一个 lease 文件时的等待超时"，phase lease TTL 控制的是"lease 多久没续期视为 stale"。

变更：

- 在代码注释中明确两个 TTL 的语义区分。
- `lease-manager.js` 的 lock TTL 保留 `FLOW_LEASE_LOCK_TTL_MS` 作为覆盖入口。
- Phase lease TTL 保留 `FLOW_LEASE_TTL_MS` 作为覆盖入口。
- 无需更改默认值或统一配置源。

验收：

- `rg "TTL" bridges server` 的结果中，每个 TTL 变量都有注释说明其语义。
- `node --test tests/*.test.mjs` 通过。

#### A1.6 迁移期 double-write 保护

A1.1-A1.3 迁移窗口期间，pipeline 同时写 state file 和 event log。如果 projection 实现有 bug，UI 会显示错误数据。

变更：

- 新增环境变量 `FLOW_USE_PROJECTION=1`（默认关闭）。
- A1.1-A1.3 期间，`FLOW_USE_PROJECTION=1` 时读 projection，否则仍读 state file。
- A1.4 删除 state writer 时，`FLOW_USE_PROJECTION` 逻辑一并删除。
- UI 更新延迟指标：从 event 写入到 UI 显示更新 < 2s（手动或 fixture 验证）。

验收：

- 不设 `FLOW_USE_PROJECTION` 时行为与迁移前完全一致。
- 设 `FLOW_USE_PROJECTION=1` 后，Dashboard 能正确显示 pipeline 运行状态。

风险：

- 最大风险是 UI 从 push update 退化成 polling。允许短期 polling，但必须在验收中记录。
- `flow-task/state/` 仍可保留为迁移目录名，但不再由 live runtime 读写。

---

### A2: Control-plane event contract: cancel + redirect request/consume

目标：把 operator intent 和 runner terminal state 分开，避免 cancel/redirect 语义混乱。

#### Event contract

新增事件：

| Event | Class | 写入方 | 作用 |
|-------|-------|--------|------|
| `job_cancel_requested` | state/control | API/CLI/operator | 记录取消意图，不代表 runner 已停 |
| `job_cancelled` | state/terminal | runner/supervisor | runner 已停止或确认不会继续恢复 |
| `job_redirect_requested` | state/control | API/CLI/operator | 记录新指令，等待 runner 消费 |
| `job_redirect_consumed` | audit/control | runner | 记录某次 redirect 已注入到哪一 phase |

`materializeJob(events)` 新增字段：

```js
{
  cancelRequested: false,
  cancelReason: null,
  redirectContext: null,
  redirectReason: null,
  redirectEventId: null,
  consumedRedirectIds: []
}
```

规则：

- `job_cancel_requested` 不直接把 `status` 设为 `cancelled`，只设置 `cancelRequested=true`。
- `job_cancelled` 才是 terminal status，`status="cancelled"`。
- `job_redirect_requested` 设置 pending redirect。
- `job_redirect_consumed` 清掉对应 pending redirect，防止恢复后重复注入。

#### API/CLI

新增：

- `POST /api/tasks/:name/cancel { jobId, reason? }`
- `POST /api/tasks/:name/redirect { jobId, instructions, reason? }`
- `flow cancel <project> <jobId> [reason]`
- `flow redirect <project> <jobId> "<instructions>" [reason]`

验收：

- `tests/cancel-redirect.test.mjs` 覆盖 materialization、API validation、CLI helper。
- cancel request 后 `recoverJobs()` 不应继续调度已 cancel-requested 且无活跃 lease 的 job；应先写 `job_cancelled`。
- redirect request 被消费一次，恢复后不重复注入。

风险：

- 仅靠 event 不足以杀当前 child process；这由 A3 解决。

---

### A3: Runner/supervisor control-plane enforcement

目标：让 cancel/redirect 真正影响正在跑的 pipeline，而不只是影响下一次恢复。

变更：

- `bridges/run-pipeline.mjs`
  - 每个 phase 前调用 `getJob()` 检查 `cancelRequested`。
  - 每个 phase 后再次检查，防止刚结束 phase 后继续下一段。
  - 在 spawn child 时保留 child handle；如果本进程收到 cancel request，可终止 child process group。
  - redirect 只在 phase 边界注入；对于正在运行的 ACP session，记录为 pending，不尝试热插入。
- `bridges/job-runner.mjs`
  - phase start 前检查 cancel。
  - child exit 后如果 cancel requested，写 `job_cancelled` 而不是 `phase_failed`。
- `server/services/supervisor.js`
  - `TERMINAL_STATUSES` 加入 `cancelled`。
  - `recoverJobs()` 对 `cancelRequested` job 不恢复执行；写 terminal cancellation 或返回 operator-visible result。

推荐实现约束：

- MVP 做到”API 写 cancel request，runner 在 phase 边界停止”（phase-boundary cancel）。
- `server/services/executor.js` 已有 `registerTask(taskId, project, script, pid)` task registry，但这里的 `taskId` 是 API 层生成的（`tasks.js:65`：`${project}:${script}:${Date.now()}`），而 durable `jobId` 是 `run-pipeline.mjs:307` 内部通过 `createJob()` 创建的。两者之间没有绑定关系。
- **v1 路径（phase-boundary only）**：cancel request 写入 event log，runner 在每个 phase 边界检查 `cancelRequested`。这是最小可行方案，不依赖 PID。
- **v2 路径（PID-based cancel）**：需要在 `run-pipeline.mjs` 创建 job 后，通过 IPC 或 event 把 `jobId` 传回父进程，让 `spawnBridge()` 能建立 `taskId <-> jobId` 绑定。然后在 `executor.js` 中增加 `cancelByJobId(jobId)` 方法。此路径不在 v1 实现范围内，但 A2 的 event contract 必须预留 `job_cancel_requested` 以支持 v2。
- 不要从 event log 猜 PID。

验收：

- 正在 phase 间的 pipeline 收到 cancel 后，不进入下一 phase。
- cancel 后 supervisor 不恢复该 job。
- redirect 在下一 phase prompt 中出现一次。
- `node --test tests/*.test.mjs` 通过。

风险：

- 长时间卡住且无输出的 ACP child 仍可能等到 idle timeout 才停。这个风险由 A4 的 activity/liveness 和 ACP idle timeout 配置共同缓解。

---

### A4: Activity/liveness events with real consumers

目标：只有存在明确 consumer 时才加 `phase_activity`，避免无用 event 膨胀。

新增 event：

| Event | Class | Consumer |
|-------|-------|----------|
| `phase_activity` | activity | supervisor stale 判断、UI lastActivity 显示、operator drill |

变更：

- `bridges/run-pipeline.mjs` / `job-runner.mjs` 监听 child stdout/stderr，有输出时节流写 `phase_activity`。
- `event-store.materializeJob()` 更新 `lastActivityAt`、`lastActivityMessage`。
- `supervisor.recoverJobs()` stale 判断优先参考 lease；当 lease 缺失或过期时，用 `lastActivityAt` 辅助判断，避免活跃进程输出但 lease 慢更新造成误恢复。
- Dashboard Durable Jobs panel 显示 `lastActivityAt`。

验收：

- 测试 materialization：`phase_activity` 不改变 `status`。
- 测试 supervisor：fresh activity 的 job 不被错误恢复；stale activity 的 job 可恢复。
- `grep "phase_activity" flow-task/events/*/*.jsonl` 只是辅助检查，不作为唯一验收。

风险：

- 高频输出会刷爆 event log。必须节流，例如每 30 秒最多一次，且 message 截断到 200 字符以内。

---

### A5: Per-tool ACP policy

目标：把现有 `FLOW_ACP_TERMINAL` 扩展为可按 ACP method/tool 控制的 policy，同时保持向后兼容。

环境变量：

```bash
# 方式一：扁平格式（推荐，shell 友好）
FLOW_ACP_DENY_TOOLS="terminal/create,fs/delete"
FLOW_ACP_ALLOW_TOOLS="fs/write_text_file"

# 方式二：JSON 文件（复杂策略时使用）
FLOW_ACP_TOOL_POLICY_FILE="./policy.json"
```

优先级：`FLOW_ACP_TOOL_POLICY_FILE` > `FLOW_ACP_DENY_TOOLS`/`FLOW_ACP_ALLOW_TOOLS` > 默认行为。

规则：

- 未配置时保持当前行为。
- `FLOW_ACP_TERMINAL=deny` 继续生效，并等价于 `terminal/create=deny` 的默认策略。
- policy value 初版只支持 `allow|deny`。
- JSON parse 失败时 fail closed，退出并给出清晰错误。

变更：

- `bridges/acp-client.mjs`
  - 新增 `toolPolicy` 解析。
  - `handleClientRequest()` 在 dispatch 前检查 method policy。
  - `permissionResponse()` 后续可使用 policy，但初版不要改变 request_permission 的语义，避免破坏 adapter 交互。
- `bridges/common.sh`
  - planner/verifier phase 默认 deny terminal。
  - builder phase 默认 allow terminal。

验收：

- `tests/acp-client.test.mjs` 覆盖 deny `terminal/create`、allow default、扁平格式解析、JSON 文件加载、invalid 输入 fail closed。
- 现有 `FLOW_ACP_TERMINAL` 测试继续通过。

风险：

- ACP adapter method 名称可能变化。初版 policy 以实际收到的 JSON-RPC method 为准，不做模糊匹配。

---

### A6: Workflow definition contract

目标：先抽象 workflow contract，再扩展 role/reviewer，避免 runner、supervisor、UI 各自硬编码。

新增：

- `server/services/workflow-definition.js`
- `server/services/role-bridge.js`

Workflow v1：

```js
standard: planner -> builder -> verifier
blocked: no agent launch, write job_blocked
```

注意：`simple: builder -> verifier` 不在 v1 范围内，原因是 `claude-execute.sh` 的 RTK prompt 依赖 plan artifact 构建上下文。`simple` 标为 accepted but blocked，直到 A7 profile loader 预留无 plan 场景的 prompt 模板后解除阻塞。验收中不要求测试 `simple`。

暂缓：

- `complex`
- parallel phase graph
- automatic classifier

变更：

- `run-pipeline.mjs` 支持 `--workflow standard|blocked`。
- `flow pipeline <project> "<task>" [max-retries] [timeout-min] --workflow standard` 保持兼容。
- `supervisor.nextPhaseFor()` 改为基于 workflow definition 计算下一 phase。
- `bridgeForPhase()` 改为通过 role bridge 映射。
- `event-store` 支持 `workflow_selected`，记录 explicit/default/blocked reason。
- UI `PipelineStatus` 不再只认 plan/execute/verify，至少能渲染 unknown/custom phase。

验收：

- omitted workflow 与 explicit `standard` 行为一致。
- `blocked` 写 `job_blocked` 或 `workflow_selected + job_blocked`，不启动 ACP child。
- supervisor 对 `standard/blocked` 都有测试。

风险：

- `simple` 会影响 handoff 文件模型，因为 execute 当前需要 plan id。`claude-execute.sh` 的 RTK prompt 依赖 plan artifact 构建上下文，没有 plan 时 prompt 质量会显著下降。MVP 先只支持 `standard|blocked`，把 `simple` 标成 accepted but blocked。A7 profile loader 中预留无 plan 场景的 prompt 模板，为后续 `simple` 解除阻塞做准备。

---

### A7: Profile loader v1

目标：只加载 runner 当前能消费的 profile 字段，不引入新依赖。

推荐 v1 contract：

```text
profiles/{role}/soul.md
profiles/{role}/config.json
```

说明：

- 原计划写 `config.yaml`，但当前项目没有 YAML parser，且工作协议要求不新增依赖。除非明确批准新依赖，否则 v1 用 `config.json`。
- 如果必须保留 YAML 文件名，只允许极小 YAML subset，并用本地 parser 覆盖测试；不支持 anchors、merge keys、复杂对象。

`config.json` 示例：

```json
{
  "permissions": {
    "write_paths": ["wiki/projects/*/inbox/*"],
    "deny_tools": ["terminal/create"]
  },
  "agent": {
    "command": "codex-acp",
    "args": []
  }
}
```

变更：

- 新增 `server/services/profile-loader.js`。
- `role-bridge.js` 读取 profile loader 输出，生成 bridge env/prompt policy。
- 不创建 `user.md`、`memory.md`、`skills/`、`variants/`。

验收：

- `tests/profile-loader.test.mjs`
- missing `soul.md` 报错清晰。
- missing `config.json` 使用安全默认值。
- 无新增 npm dependency。

风险：

- 与长期文档中 `config.yaml` 不一致。A0 需标注 v1 使用 JSON，YAML 属于 future decision。

---

### A8: Reviewer workflow

目标：在 workflow contract 稳定后加入 reviewer，不提前改 runner 大结构。

新增：

- `bridges/reviewer-review.sh`
- `profiles/reviewer/soul.md`

Workflow v2：

```text
complex: planner -> builder -> reviewer -> verifier
```

约束：

- reviewer 初版只读 builder deliverable、wiki context、计划文件、可选 diff artifact。
- reviewer 不写代码。
- reviewer 输出 `review-{id}.md` 或 `reviewer-verdict-{jobId}.md`，具体命名必须与 handoff schema 一致。

验收：

- `complex` workflow 跑通 fake ACP fixture。
- reviewer FAIL 时不直接进入 verifier；返回 builder fix 或 job blocked，规则必须明确。
- UI 能显示 reviewer phase。

风险：

- reviewer 与 verifier 职责可能重叠。初版 reviewer 看 maintainability/correctness，verifier 只做 acceptance criteria gate。

---

### A9: Diff-based verification

目标：让 verifier 能审查代码 diff，同时不破坏 verifier 禁 terminal 的安全边界。

关键调整：

- 不让 verifier 自己跑 `git diff`。
- runner 在 verifier phase 前生成 diff artifact。
- verifier 只读 diff artifact 和 handoff 文件。

新增 artifact：

```text
wiki/projects/{project}/outputs/diff-{deliverableId}.patch
```

或更推荐：

```text
flow-task/artifacts/{project}/{jobId}/diff-{phase}.patch
```

选择原则：

- 如果 diff 是机器生成、可能很大，放 `flow-task/artifacts/`。
- 如果 diff 需要人类交接阅读，可复制摘要到 wiki outputs。

变更：

- `run-pipeline.mjs` 在 verify 前确定 target project source path，生成 diff。
- `rtk_codex_verify` prompt 增加 diff artifact 路径。
- `acp-client` write allow 不因 diff verify 放宽。

验收：

- verifier phase 不创建 terminal。
- fake verifier 能读 diff artifact 并写 verdict。
- diff 缺失时 job blocked 或 verdict FAIL，不能静默 PASS。

风险：

- 当前 project source path 来自 `wiki/projects/{project}/project.json`，非 git 项目或 detached worktree 需要清晰 blocked reason。

---

## 四、中期路线调整

### R1: Operator documentation refresh

提前到 A0/A1 同步，后续中期只补 drill 手册。

### R2: Durable Jobs UI enhancement

原计划的“新增 panel”改为增强已有 panel：

- 显示 `lastActivityAt`
- 显示 `cancelRequested`
- 显示 pending redirect
- 支持从 job row 进入 job detail

### R3: E2E verification drill

保留，但顺序放到 A3/A4/A6 后。需要最小 E2E 框架：基于现有 `tests/fixtures/fake-acp-agent.mjs`，构建一个能跑完整 pipeline 并验证跨进程行为的 test harness。

```text
kill ACP child process -> supervisor resume
restart supervisor -> resume from event log
simulate missing provider env -> blocked
simulate stale lease -> recovery
simulate cancel request -> no further phase
simulate redirect request -> consumed once
simulate blocked workflow -> no agent launched
```

框架选型约束：

- 不引入新依赖。利用现有 `child_process.spawn` + fake ACP fixture。
- 每个 drill 场景封装为独立 shell 脚本，统一由 `tests/e2e/run-all.sh` 驱动。
- 失败时输出 event log 尾部用于诊断。

### R4: Event extension gate

除 A2/A4/A6 明确需要的 event 外，不增加新 event。每个 event 必须有：

- class: state/control/activity/audit
- materialization rule
- consumer
- regression test

### R5: Event log compaction/retention

当前 `materializeJob()` 是全量 replay。随着 event 增多，replay 会越来越慢。需要 snapshot-based compaction。

变更：

- 新增 `event-store.checkpointJob(flowRoot, project, jobId)`：在 job terminal 时写一个 checkpoint file，包含完整的 materialized state。
- `materializeJob()` 优先读 checkpoint，仅从 checkpoint 之后的 event 开始 replay。
- 非 terminal job 不写 checkpoint（保留全量 replay 的准确性）。
- `flow jobs cleanup --before <date>` 命令归档/删除已完成 job 的 event log 文件（保留 checkpoint）。

验收：

- 有 checkpoint 的 job，`materializeJob()` 耗时 < 5ms（与 event 数量无关）。
- 无 checkpoint 的 job 行为不变。

---

## 五、远期路线保留但降级

保留：

- Task terminology alias
- Advisory classifier
- Phase graph + parallel read-only
- Provider semaphores
- Profile richness
- Full role team

降级原则：

- `provider semaphores` 只在 workflow 真的支持并行后重新引入。
- `classifier` 只输出 advisory event，不决定 workflow。
- `profile richness` 只在 runner 有消费者时加文件。
- `parallel phase graph` 必须先有 merge lock 和 phase graph event。

---

## 六、实施顺序和依赖

```text
A0 doc sync + profiles audit + supersede old plan   0.5d
A1 event projection + state retire                   1.5d  (含 A1.5 TTL 注释、A1.6 feature flag)
A2 cancel/redirect event contract                    0.5d
A3 runner/supervisor enforcement                     1.0d
A4 phase activity consumers                          0.5d
--- checkpoint: A0-A4 控制面基础验收 ---
A5 per-tool ACP policy                               0.5d
A6 workflow definition contract                      1.0d
A7 profile loader v1                                 0.5d
A8 reviewer workflow                                 1.0d
A9 diff-based verification                           1.0d
R3 E2E drill                                         0.5d
R5 event log compaction                              0.5d
```

Dependency graph:

```text
A0 -> A1 -> A2 -> A3 -> A4
          -> A5 -> A6 -> A7 -> A8 -> A9
A3 + A4 + A6 -> R3
A1 -> R5
```

Do not start A8 before A6 passes.
Do not delete compatibility state before A1.1-A1.3 pass.
Do not implement realtime cancel kill before phase-boundary cancel is verified.

---

## 七、Acceptance criteria

Global acceptance:

- All existing tests pass: `node --test tests/*.test.mjs`.
- Bash integration passes: `bash tests/flow-jobs.test.sh`, `bash tests/flow-bridges.test.sh`, `bash tests/flow-variant-env.test.sh`.
- Syntax checks pass for `bridges/*.sh`, `tests/*.sh`, `bridges/*.mjs`, `tests/*.mjs`, `server/**/*.js`.
- No new npm dependency unless explicitly approved.
- Flow live runtime 不读写 `.omc/events`、`.omc/leases`、`.omc/state`、`.omc/worktrees`；`.omc/wiki/flow` 是 `flow init` 创建的项目集成 symlink，不属于 runtime state。
- No fake/mock fixture is edited merely to hide production behavior changes.

Feature acceptance:

| Feature | Acceptance |
|---------|------------|
| State retirement | UI/API/CLI status comes from event-backed job projection |
| Cancel | Requested cancel prevents later phases and supervisor recovery |
| Redirect | Redirect is consumed exactly once at phase boundary |
| Activity | Activity event updates `lastActivityAt` and influences stale recovery safely |
| Per-tool policy | Planner/verifier can deny terminal without blocking builder |
| Workflow | Standard remains unchanged; blocked workflow launches no agent |
| Profile loader | Loads only consumed fields; no dependency added |
| Reviewer | Complex workflow phase visible and tested with fake ACP |
| Diff verify | Verifier reads runner-generated diff without terminal access |

**注意**：`simple` workflow 不在 v1 验收范围内。

---

## 八、Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Removing compatibility state breaks UI/CLI | High | A1 staged migration with `FLOW_USE_PROJECTION` feature flag; delete writers only after readers move |
| Cancel does not stop active ACP child | High | v1: phase-boundary cancel（runner 在 phase 间检查 cancelRequested）；v2: 需先建立 jobId <-> taskId/PID 绑定，再利用 executor registry 发 SIGTERM |
| Redirect repeats after recovery | High | Add `job_redirect_consumed` event and materialization rule |
| Workflow diverges across runner/supervisor/UI | High | Introduce `workflow-definition.js` before reviewer/complex workflow |
| A1 迁移期 double-write 导致 UI 数据不一致 | High | `FLOW_USE_PROJECTION` feature flag 支持回退；迁移期两种路径都可验证 |
| `phase_activity` floods event log | Medium | 30s throttle and message truncation |
| Diff verification violates verifier no-terminal policy | Medium | Runner generates diff artifact; verifier only reads |
| YAML config adds dependency | Medium | Use `config.json` v1 or local restricted parser |
| Existing docs mislead operators | Medium | A0 doc sync before runtime changes |
| A7 profile loader 与现有 profiles/ 内容冲突 | Medium | A0 附加检查审计现有 soul.md；A7 预留 merge 策略 |
| `FLOW_ACP_TOOL_POLICY` JSON 环境变量维护性差 | Medium | A5 改用扁平格式 `FLOW_ACP_DENY_TOOLS` + 可选 JSON 文件 |
| `workflow-definition.js` 单点故障 | Medium | 100% 分支覆盖单元测试，每个 workflow 变体至少 2 个测试 |
| Lease TTL 不一致导致 supervisor 误判 | Low | 经核实 lock TTL 和 phase lease TTL 控制不同机制，无需统一，但需在代码中注释语义区分 |
| 老统合计划 `2026-05-13-flow-unified-master-plan.md` 已 superseded，需保持标记防误用 | Low | A0 已加 superseded 警告头；如后续执行者仍误引用需再提醒 |
| `wiki/system/dashboard.md` 有 replacement character 和测试项目残留 | Low | A0 doc sync 时一并清理 |
| Event log 无限增长导致 replay 变慢 | Medium | R5 snapshot-based compaction + retention |
| 工时估算偏乐观（6.5 天） | Low | 按 A0-A4 和 A5-A9 分两个 milestone 验收，中间设 checkpoint |

---

## 九、Rejected changes

Rejected: Delete `flow-task/state` immediately | current UI/API/CLI/tests still depend on it.

Rejected: Treat `job_cancel_requested` as terminal | request intent is not the same as runner shutdown.

Rejected: Hot-inject redirect into an active ACP session | current ACP bridge has no safe prompt mutation channel.

Rejected: Let verifier run `git diff` directly | conflicts with verifier terminal-deny boundary.

Rejected: Introduce YAML dependency for profile loader v1 | current workspace guidance says no new dependencies without explicit request.

Rejected: Add classifier before workflow telemetry | original v3 principle correctly delays automatic classification.

---

## 十、Execution handoff notes

Recommended execution lane:

1. Solo or `executor` for A0-A1 because the write set is tight and compatibility-sensitive.
2. `debugger` or `executor` for A2-A3 because control semantics and process lifecycle need tests.
3. `executor` for A5-A7.
4. `test-engineer` review before A8-A9 because workflow/diff verification risks are test-shape heavy.
5. **Checkpoint**：A0-A4 完成后暂停，运行全量测试 + 手动 E2E 验证，确认控制面基础稳固后再进入 A5-A9。

Suggested commit grouping:

1. `Align runtime docs with flow-task root, audit existing profiles`
2. `Serve project pipeline state from durable job projection`
3. `Add FLOW_USE_PROJECTION feature flag for migration safety`
4. `Add lease TTL semantics documentation`
5. `Retire compatibility pipeline state writers`
6. `Separate cancel and redirect control events`
7. `Enforce control events in runner with executor PID tracking`
8. `Track phase activity for recovery and UI`
9. `Apply per-tool ACP policy (flat format + optional JSON file)`
10. `Centralize workflow definitions`
11. `Load role profiles for workflow bridges`
12. `Add reviewer and diff verification workflows`
13. `Add event log compaction and retention`

Each commit should follow the Lore Commit Protocol in `AGENTS.md`.

