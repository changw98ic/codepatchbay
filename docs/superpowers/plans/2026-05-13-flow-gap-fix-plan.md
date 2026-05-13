# Flow 补足计划

> 基于 P0/P1 修复、Zed 对比、Cancel/Redirect 分析、fixed-role 计划审查后的落地计划。

## Context

基于以下分析，补足 Flow 的剩余缺口：
- 初始痛点分析（P0/P1 已修，P2 剩余）
- Zed 对比（权限系统、plan 追踪、diff 审批）
- Cancellation/Redirect 需求分析
- fixed-role-agents 计划的问题审查（状态一致性、event 类型兼容）

**已完成**：P0/P1 修复、run-pipeline.mjs、ACP 路径 enforce、API 测试、CI/CD、broadcast/prefix 修复
**本次计划**：补足剩余的功能缺口，从"能跑"到"可用"

---

## 第一阶段：收尾清理 + Cancel/Redirect（最高优先级）

### 1A: Phase 1 Cleanup（Task #10）

**文件**：
- `bridges/run-pipeline.sh` → 精简为 3 行 exec wrapper
- 删除 `bridges/json-helper.mjs`
- `bridges/common.sh` → 删除 `state_read`, `state_write`, `state_init`
- `server/routes/projects.js` → pipelineState 从 `listJobs()` 读取
- `server/services/watcher.js` → 停止监听 `.omc/state/`

### 1B: Cancellation

**新增 event type**：`job_cancelled`

**文件变更**：

`server/services/event-store.js` — materializeJob 新增：
```js
case "job_cancelled":
  state.status = "cancelled";
  state.leaseId = null;
  state.cancelledReason = event.reason ?? "user cancelled";
  break;
```

`server/services/job-store.js` — 新增 cancelJob：
```js
export async function cancelJob(flowRoot, project, jobId, { reason, ts } = {}) {
  // Release lease if active
  // Append job_cancelled event
}
```

`server/services/supervisor.js` — nextPhaseFor 和 recoverJobs 跳过 cancelled：
```js
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);
```

`bridges/run-pipeline.mjs` — phase 之间检查 cancel：
```js
const job = await getJob(flowRoot, project, jobId);
if (job.status === 'cancelled') {
  log('Job cancelled by user');
  await releaseLease(flowRoot, leaseId, { ownerToken });
  process.exit(0);
}
```

`server/routes/tasks.js` — 新增 API：
```
POST /api/tasks/:name/cancel  { jobId, reason? }
```

`flow` CLI — 新增命令：
```bash
flow cancel <project> <jobId>
```

### 1C: Redirect

**新增 event type**：`job_redirected`

**文件变更**：

`server/services/event-store.js` — materializeJob 新增：
```js
case "job_redirected":
  state.redirectContext = event.instructions;
  state.redirectReason = event.reason;
  // status 不变，仍然是 running
  break;
```

`bridges/run-pipeline.mjs` — phase 之间检查 redirect 并注入 prompt：
```js
const job = await getJob(flowRoot, project, jobId);
if (job.redirectContext) {
  redirectSection = `## Direction Change\nOriginal task: ${originalTask}\nNew direction: ${job.redirectContext}`;
  // 清除 redirectContext（写一个 redirect_consumed event）
}
```

`server/routes/tasks.js` — 新增 API：
```
POST /api/tasks/:name/redirect  { jobId, instructions, reason? }
```

`flow` CLI：
```bash
flow redirect <project> <jobId> "<new instructions>"
```

**测试**：
- `tests/cancel-redirect.test.mjs`
- 测试 cancel：appendEvent → getJob status=cancelled → supervisor 不恢复
- 测试 redirect：appendEvent → getJob 有 redirectContext → pipeline 注入新 prompt
- 测试 cancel + supervisor：cancelled job 不出现在 recoverJobs 结果中

---

## 第二阶段：权限系统对齐 Zed

### 2A: Per-Tool Permission Patterns

当前：`FLOW_ACP_PERMISSION=allow|reject`，全局开关。
目标：per-tool pattern 精细控制。

**文件**：`bridges/acp-client.mjs`

**新增环境变量**：
```
FLOW_ACP_TOOL_POLICY=<json>
```

格式：
```json
{
  "fs/write_text_file": "allow",
  "terminal/create": "confirm",
  "terminal/kill": "deny"
}
```

**permissionResponse 方法改造**：
```js
permissionResponse(params) {
  const toolName = params?.toolName;  // ACP 传递的 tool name
  const policy = this.toolPolicy[toolName] || this.defaultPolicy;
  // policy: 'allow' | 'deny'
  // 'confirm' 在无人值守模式下等于 'allow'（没有人类确认）
  const wantsReject = policy === 'deny';
  // ... 选择匹配的 option
}
```

**bridge 脚本设置**：
- `rtk_codex_plan` → `FLOW_ACP_TOOL_POLICY='{"terminal/create":"deny"}'`
- `rtk_codex_verify` → `FLOW_ACP_TOOL_POLICY='{"terminal/create":"deny"}'`
- `rtk_claude_execute` → 不设（默认 allow）

### 2B: Phase Activity Event

**新增 event type**：`phase_activity`

Pipeline runner 在 spawn bridge 脚本时，监听 stdout 每行输出，定期（每 30s）写 activity event：

```js
// 在 run-pipeline.mjs 的 spawnBridge 中
let lastActivity = Date.now();
child.stdout.on('data', (chunk) => {
  lastActivity = Date.now();
});
const activityInterval = setInterval(() => {
  if (Date.now() - lastActivity > 30000) {
    appendEvent(flowRoot, project, jobId, {
      type: 'phase_activity',
      jobId, phase, note: 'stdout idle 30s', ts: new Date().toISOString()
    });
  }
}, 30000);
```

materializeJob 处理：
```js
case "phase_activity":
  state.lastActivityAt = event.ts;
  state.status = state.status || "running"; // 不改变 status
  break;
```

**Supervisor 改造**：lease 判断结合 lastActivityAt。如果 lease stale 但 lastActivityAt 在 TTL 内，不标记为 recoverable（agent 还在干活，只是 lease 续期可能有延迟）。

---

## 第三阶段：Minimal Role System Foundation

不是完整的 fixed-role 计划（那个计划有致命问题需要先修），而是最小可用的 profile 机制。

### 3A: Profile Loader

**新建**：`server/services/profile-loader.js`

```js
export async function loadProfile(flowRoot, role) {
  const dir = path.join(flowRoot, 'profiles', role);
  const soul = await readFile(path.join(dir, 'soul.md'), 'utf8').catch(() => '');
  const config = await readYaml(path.join(dir, 'config.yaml')).catch(() => ({}));
  return { role, soul, config };
}
```

只支持 `soul.md` + `config.yaml`。不做 `user.md`, `memory.md`, `skills/`, `variants/`。

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

### 3B: Role to Bridge Mapping

**新建**：`server/services/role-bridge.js`

```js
const ROLE_BRIDGE_MAP = {
  planner: { script: 'codex-plan.sh', profile: 'planner' },
  builder: { script: 'claude-execute.sh', profile: 'builder' },
  verifier: { script: 'codex-verify.sh', profile: 'verifier' },
};
```

run-pipeline.mjs 支持通过 `--workflow` 参数选择 phase 组合：
- `standard`（默认）: planner → builder → verifier
- `simple`: builder → verifier
- `complex`: planner → builder → reviewer → verifier

这是 Phase 5 的最小版本，为后续扩展留接口。

---

## 第四阶段：Reviewer 角色 + Diff 审批

### 4A: 新增 reviewer bridge

**新建**：`bridges/reviewer-review.sh`
- ACP agent 读取 builder 的 deliverable
- 对比 builder worktree 的 git diff
- 输出 review verdict（同 verdict 格式）

### 4B: Diff-based Verification

当前 verify 只看 deliverable 文件。新增 diff 模式：
- verifier 读取 `git diff`（worktree vs base）
- 逐文件审查变更
- 输出 per-file verdict + 总体 PASS/FAIL

---

## 文件变更汇总

| Phase | 新建文件 | 修改文件 | 删除文件 |
|-------|----------|----------|----------|
| 1A | - | run-pipeline.sh, common.sh, projects.js, watcher.js | json-helper.mjs |
| 1B | tests/cancel-redirect.test.mjs | event-store.js, job-store.js, supervisor.js, run-pipeline.mjs, tasks.js | - |
| 1C | (同上) | (同上) | - |
| 2A | - | acp-client.mjs, common.sh | - |
| 2B | - | run-pipeline.mjs, event-store.js, supervisor.js | - |
| 3A | server/services/profile-loader.js | - | - |
| 3B | server/services/role-bridge.js | run-pipeline.mjs | - |
| 4A | bridges/reviewer-review.sh, profiles/reviewer/soul.md | - | - |
| 4B | - | codex-verify.sh (or run-pipeline.mjs) | - |

## 实施顺序

```
1A cleanup       ██  0.5 天  → 清理技术债
1B cancel         ██  1 天    → 核心操作安全
1C redirect       ██  1 天    → 方向调整能力
2A per-tool perm  ██  1 天    → 权限精细控制
2B activity       █  0.5 天   → 活跃度追踪
3A profile loader █  0.5 天   → 角色基础
3B role mapping   █  0.5 天   → workflow 扩展
4A reviewer       ██  1 天    → 代码审查
4B diff verify    ██  1 天    → 精确验证
```

## 验证计划

### 1A 验证
```bash
# run-pipeline.sh 只是 wrapper
bash bridges/run-pipeline.sh --help  # 应该显示 run-pipeline.mjs 的帮助
# json-helper.mjs 不存在
test ! -f bridges/json-helper.mjs && echo "deleted"
# 旧 .omc/state/ 不再被读取
grep -r "pipeline-.*json" server/ bridges/ --include="*.js" --include="*.mjs"  # 应该只在 watcher 的旧 watch 路径
```

### 1B/1C 验证
```bash
node --test tests/cancel-redirect.test.mjs  # 全部通过
# 手动测试：启动 pipeline → 另一个终端 flow cancel → 确认 pipeline 退出且不恢复
```

### 2A 验证
```bash
# plan phase 尝试创建 terminal → deny
FLOW_ACP_TOOL_POLICY='{"terminal/create":"deny"}' node bridges/acp-client.mjs --agent codex
```

### 2B 验证
```bash
# 长时间任务产生 phase_activity 事件
grep "phase_activity" .omc/events/*/*.jsonl
```

### 3A/3B 验证
```bash
node --test tests/profile-loader.test.mjs
./flow pipeline test-project "Add unit tests" --workflow standard
```

### 4A 验证
```bash
./flow review test-project <deliverable-id>
```
