# Flow 统合计划

> **⚠️ SUPERSEDED — 本文档已被 [`2026-05-13-flow-unified-master-plan-adjusted.md`](./2026-05-13-flow-unified-master-plan-adjusted.md) 替代。**
>
> 调整版修正了短期执行顺序、遗漏触点和验收口径。本文档中的 `config.yaml`、`simple: builder -> verifier`、
> `job_cancelled`/`job_redirected` 等旧方向不再适用。仅保留作为历史参考。

> 合并 5 份独立计划为一份，消除矛盾，标注已完成项，明确剩余工作和长期路线。
> 生成时间：2026-05-13

## 计划来源

| 原始文件 | 内容 | 统合处理 |
|---------|------|---------|
| `24h-unattended-supervisor.md` | 12 步详细实现（event/lease/job/supervisor/runner） | 大部分已实现，标记完成项 |
| `flow-task-runtime-v2.md` | 并行 task-store + 新命名空间 | **否决**（v3 证明双系统不可行） |
| `flow-task-runtime-v3.md` | 单系统演进 + .omc/ → flow-task/ 迁移 | Phase 0-5 已完成，Phase 6-8 纳入路线 |
| `24h-unattended-fixed-role-agents.md` | 10 阶段固定角色长期愿景 | 有 4 致命 + 4 严重问题，修正后纳入远期 |
| `flow-gap-fix-plan.md` | 4 阶段即时修复 | 作为短期执行线，纳入本文 |

---

## 命名空间约定（所有计划统一）

```
.omc/         → oh-my-claudecode 所有，Flow 不写
.omx/         → oh-my-codex 所有，Flow 不写
flow-task/    → Flow 运行时数据（events/leases/state/worktrees/）
wiki/         → 人类可读的项目记忆和交接文件
profiles/     → Agent 角色定义（soul.md + config.yaml）
```

---

## 一、已完成工作（5 个 Git Commits）

### Commit `aa93f93` — Initial Commit
- 87 files, 14289 lines，整个项目骨架

### Commit `d9a9b66` — P0/P1 修复
- 双状态模型统一（event-store + job-store）
- Provider semaphore 泄漏修复
- Supervisor 空转 → 实际恢复（recoverAndRun）
- WebSocket broadcast 提取（ws-broadcast.js）
- 路由双前缀 /api/api/ 修复

### Commit `7769de9` — Phase 1-3
- run-pipeline.mjs 创建（15KB 统一 pipeline runner）
- run-pipeline.sh → 薄 wrapper（785B）
- ACP 路径白名单 + handoff 校验 + terminal policy
- API 路由测试（routes-projects 21 tests, routes-tasks 19 tests）
- Supervisor 恢复测试 + provider semaphore stale 清理测试
- GitHub Actions CI（.github/workflows/test.yml）

### Commit `646311f` — Phase 4-5（Runtime Root 迁移）
- .omc/ → flow-task/ 全量迁移
- runtime-root.js 新增
- migrate-runtime-root.mjs 新增
- provider-semaphore.js + test 删除（dead code）
- no-omc-writes guard tests 新增
- 所有测试路径更新

### Commit `08c5d7a` — chore
- gitignore web artifacts
- 补充 verdict/index 文件

### 当前测试状态
- **54 tests, 0 failures**, 工作区干净

---

## 二、短期执行线（从"能跑"到"可用"）

> 来源：gap-fix plan，修正后纳入统合

### M1: Phase 1A 剩余清理

**前置**：run-pipeline.sh wrapper 已完成（7769de9）

| 子项 | 文件 | 动作 |
|------|------|------|
| 删除 json-helper.mjs | `bridges/json-helper.mjs` | DELETE |
| 清理 common.sh | `bridges/common.sh` | 移除 `state_read`, `state_write`, `state_init` |
| pipelineState 数据源 | `server/routes/projects.js` | 从 `listJobs()` 读取，不再读 `flow-task/state/pipeline-*.json` |
| watcher 停监听 state | `server/services/watcher.js` | 移除 `flow-task/state/` 的 watch（只保留 events + wiki） |

**验证**：
```bash
test ! -f bridges/json-helper.mjs && echo "deleted"
! grep -q "state_read\|state_write\|state_init" bridges/common.sh && echo "cleaned"
! grep -q "pipeline-.*json" server/routes/projects.js && echo "projects.js clean"
node --test tests/*.test.mjs  # 54 pass
```

### M2: Cancellation

**新增 event**：`job_cancelled`

| 文件 | 变更 |
|------|------|
| `server/services/event-store.js` | materializeJob 新增 `job_cancelled` case |
| `server/services/job-store.js` | 新增 `cancelJob()` |
| `server/services/supervisor.js` | `TERMINAL_STATUSES` 加入 `"cancelled"` |
| `bridges/run-pipeline.mjs` | phase 间检查 cancel，若 cancelled 则 releaseLease + exit 0 |
| `server/routes/tasks.js` | `POST /api/tasks/:name/cancel { jobId, reason? }` |
| `flow` CLI | `flow cancel <project> <jobId>` |

**验证**：`tests/cancel-redirect.test.mjs`

### M3: Redirect

**新增 event**：`job_redirected`

| 文件 | 变更 |
|------|------|
| `server/services/event-store.js` | materializeJob 新增 `job_redirected` case |
| `bridges/run-pipeline.mjs` | phase 间检查 redirectContext，注入新 prompt 段 |
| `server/routes/tasks.js` | `POST /api/tasks/:name/redirect { jobId, instructions, reason? }` |
| `flow` CLI | `flow redirect <project> <jobId> "<instructions>"` |

**验证**：同 M2 测试文件

### M4: Per-Tool Permission

**文件**：`bridges/acp-client.mjs`

- 新增 `FLOW_ACP_TOOL_POLICY` JSON 环境变量
- `permissionResponse()` 按 tool name 查 policy
- bridge 脚本按角色设不同 policy（plan/verify 禁 terminal）

**验证**：
```bash
FLOW_ACP_TOOL_POLICY='{"terminal/create":"deny"}' node bridges/acp-client.mjs --agent codex
```

### M5: Phase Activity Event

**新增 event**：`phase_activity`（activity class，不改变 status）

| 文件 | 变更 |
|------|------|
| `bridges/run-pipeline.mjs` | spawnBridge 监听 stdout，30s idle 写 activity event |
| `server/services/event-store.js` | materializeJob 更新 `lastActivityAt` |
| `server/services/supervisor.js` | lease stale 判断结合 lastActivityAt |

**验证**：
```bash
grep "phase_activity" flow-task/events/*/*.jsonl
```

### M6: Profile Loader

**新建**：`server/services/profile-loader.js`

- 读取 `profiles/{role}/soul.md` + `config.yaml`
- 不做 user.md / memory.md / skills/ / variants/（v3 原则：runner 没有消费者就不加）

**config.yaml 格式**：
```yaml
permissions:
  write_paths:
    - "wiki/projects/*/inbox/*"
  deny_tools:
    - "terminal/create"
agent:
  command: "codex-acp"
  args: []
```

**验证**：`tests/profile-loader.test.mjs`

### M7: Role-Bridge Mapping + Workflow Selection

**新建**：`server/services/role-bridge.js`

```js
const ROLE_BRIDGE_MAP = {
  planner: { script: 'codex-plan.sh', profile: 'planner' },
  builder: { script: 'claude-execute.sh', profile: 'builder' },
  verifier: { script: 'codex-verify.sh', profile: 'verifier' },
};
```

run-pipeline.mjs 支持 `--workflow` 参数：
- `standard`（默认）: planner → builder → verifier
- `simple`: builder → verifier
- `complex`: planner → builder → reviewer → verifier（M9+ 启用）

> 来源：v3 Phase 6 — Explicit Workflow Input

**验证**：
```bash
./flow pipeline test-project "Add unit tests" --workflow standard
```

### M8: Reviewer Bridge

**新建**：
- `bridges/reviewer-review.sh`
- `profiles/reviewer/soul.md`

ACP agent 读取 builder deliverable + git diff → 输出 review verdict

### M9: Diff-based Verification

verifier 新增 diff 模式：读取 `git diff`（worktree vs base）→ 逐文件审查 → per-file verdict + 总体 PASS/FAIL

---

## 三、中期路线（从"可用"到"健壮"）

> 来源：v3 Post-MVP Roadmap + supervisor plan 剩余项

### R1: Operator Documentation

- `wiki/system/unattended-supervisor.md` — 运维手册
- README 更新 24h 无人值守说明
- `flow wiki lint` 补充新文档

> 来源：supervisor plan Task 11

### R2: Workflow Selected Event

**新增 event**：`workflow_selected`（state class）

显式记录 workflow 选择原因，便于审计。

> 来源：v3 Phase 7 — Event Extension Gate

### R3: UI Durable Jobs 显示

- `web/src/` 新增 Durable Jobs panel
- WebSocket 接收 `job:update` 事件刷新
- 显示 jobId / project / status / phase / lastActivity

> 来源：supervisor plan Task 10

### R4: E2E 验证 Drill

手动演练：
```
kill ACP child process → supervisor 恢复
restart supervisor → resume from event log
simulate missing provider env → blocked
simulate stale lease → recovery
simulate cancel → pipeline 退出不恢复
simulate redirect → pipeline 注入新 prompt
```

> 来源：supervisor plan Task 12

---

## 四、远期路线（从"健壮"到"智能"）

> 来源：fixed-role-agents plan，修正致命问题后纳入

### 原计划的致命问题（已识别）

1. **三重状态源**：event log + wiki YAML + profile state → 统一为单一 event log
2. **Event 类型不兼容**：task_created vs job_created → 保持 jobId，未来加 alias
3. **Wiki schema 违规**：机器状态不应写 wiki YAML → 保持 wiki 只做人类可读文件
4. **Coordinator 未定义**：自动分类在无 telemetry 时不可靠 → MVP 用显式 --workflow

### 修正后的长期阶段

#### L1: Task Terminology Alias

- `taskId` 作为 `jobId` 的用户面 alias
- `flow task run/list/show` 命令作为底层 job-store 的 alias
- 不引入第二套 runtime

> 来源：v3 Phase 8

#### L2: Advisory Classifier

- LLM 辅助分类 → 仅输出 `workflow_suggested` audit event
- 不决定 workflow，除非显式升级
- 需要 telemetry 数据支撑

> 来源：v3 Phase 7, fixed-role Phase 3

#### L3: Phase Graph + Parallel Read-only

- `workflow_planned` event 记录 phase graph
- researcher/reviewer/writer 可并行（只读 phase）
- builder fix loop 串行
- project merge lock 防并发集成

> 来源：fixed-role Phase 4/8

#### L4: Provider Semaphores（重新引入）

- 当多 agent 并行时，限制同一 provider 并发数
- 基于之前的 provider-semaphore.js 但重新设计（旧版已删）

> 来源：supervisor plan Task 9

#### L5: Profile Richness（按需）

- 只在 runner 有消费者时才加：
  - `user.md` — 用户偏好
  - `memory.md` — 角色长期记忆
  - `env.schema` — 必需环境变量名
  - `variants/` — provider/model overlay
- 不预先创建

> 来源：v3 Profile Plan, fixed-role Profile Contract

#### L6: Full Role Team

```
coordinator → researcher → planner → builder → reviewer → verifier → writer
```

每个角色有完整 profile + bridge + 权限约束。

> 来源：fixed-role Required Roles

---

## 五、原则（统合所有计划后）

1. **单一 event log**：`flow-task/events/` 是唯一可变状态源，cache 只为性能
2. **Namespace 隔离**：Flow 只写 `flow-task/`，不碰 `.omc/` `.omx/`
3. **Wiki 不存机器状态**：wiki 是人类可读的交接和记忆，不是状态库
4. **保持一个 runtime**：不建并行 task-store，演进现有 job-store
5. **Profile 按需生长**：runner 没有消费者就不加 profile 文件
6. **分类延迟到有数据**：显式 --workflow 优先，自动分类需要 telemetry
7. **命令兼容**：`flow pipeline` 保持稳定，新功能用新命令或新 flag

---

## 六、实施顺序总览

```
短期（M1-M9）—— 从"能跑"到"可用"
M1  cleanup        0.5天  ██████████░░░░░░░░░░ 40% done
M2  cancel         1天
M3  redirect       1天
M4  per-tool perm  1天
M5  activity       0.5天
M6  profile loader 0.5天
M7  workflow        0.5天
M8  reviewer       1天
M9  diff verify    1天

中期（R1-R4）—— 从"可用"到"健壮"
R1  docs
R2  workflow event
R3  UI jobs panel
R4  E2E drills

远期（L1-L6）—— 从"健壮"到"智能"
L1  task alias
L2  classifier
L3  phase graph + parallel
L4  provider semaphores
L5  profile richness
L6  full role team
```

---

## 七、文件变更汇总（短期 M1-M9）

| 阶段 | 新建 | 修改 | 删除 |
|------|------|------|------|
| M1 | - | common.sh, projects.js, watcher.js | json-helper.mjs |
| M2 | tests/cancel-redirect.test.mjs | event-store.js, job-store.js, supervisor.js, run-pipeline.mjs, tasks.js, flow | - |
| M3 | (同 M2) | (同 M2) | - |
| M4 | - | acp-client.mjs, common.sh | - |
| M5 | - | run-pipeline.mjs, event-store.js, supervisor.js | - |
| M6 | server/services/profile-loader.js, tests/profile-loader.test.mjs | - | - |
| M7 | server/services/role-bridge.js | run-pipeline.mjs | - |
| M8 | bridges/reviewer-review.sh, profiles/reviewer/soul.md | - | - |
| M9 | - | codex-verify.sh / run-pipeline.mjs | - |
