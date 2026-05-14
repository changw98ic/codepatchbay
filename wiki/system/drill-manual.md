# Operator Drill Manual

Recovery 场景测试手册，供 operator 验证 supervisor 和 job 系统的可靠性。

## 前提

```bash
cd /path/to/codepatchbay
node --test tests/e2e-pipeline-drill.test.mjs   # R3 E2E drill (7 场景)
```

## Drill 场景

### 1. Stale Lease Recovery

Supervisor 检测 stale lease 并恢复 job。

**触发条件**: phase 执行进程崩溃或失联，lease TTL 过期。

**验证**: `recoverJobs()` 返回该 job，supervisor 重新 acquire lease 并执行。

**对应测试**: `stale lease triggers supervisor recovery`

### 2. Cancel 终止

Cancel request 在 phase boundary 生效，后续 phase 不再执行。

**触发条件**: operator 发出 `requestCancelJob`。

**验证**: `nextPhaseFor()` 返回空，`recoverJobs()` 不恢复该 job，状态变为 `cancelled`。

**对应测试**: `cancel request stops further phases`

### 3. Redirect 单次消费

Redirect request 在下一个 phase boundary 被消费一次，之后清除。

**触发条件**: operator 发出 `requestRedirectJob`。

**验证**: 消费后 `redirectContext` 清空，`consumedRedirectIds` 包含已消费 ID。

**对应测试**: `redirect request is consumed once at phase boundary`

### 4. Blocked Workflow

Blocked workflow 不启动任何 agent 进程。

**触发条件**: 创建 job 时指定 `workflow: 'blocked'`。

**验证**: `nextPhaseFor()` 返回空，状态为 `blocked`，无 phase 执行。

**对应测试**: `blocked workflow creates no agent processes`

### 5. Job-Runner Event 写入

Job-runner 执行 phase 后正确写入 `phase_started` 和 `phase_completed` 事件。

**验证**: 事件文件存在，job 状态更新。

**对应测试**: `job-runner executes a phase and writes events`

### 6. 崩溃恢复

Supervisor 从 event log 恢复 job，无需外部状态。

**触发条件**: supervisor 进程重启，job 的 lease 已过期。

**验证**: `recoverAndRun()` 找到 job 并恢复到正确 phase。

**对应测试**: `supervisor recovers job from event log after simulated crash`

### 7. 已完成 Job 不恢复

Terminal status 的 job 不会被 supervisor 拾取。

**验证**: `recoverJobs()` 返回空列表。

**对应测试**: `completed job is not recoverable`

## Event Extension Gate (R4)

所有 event type 必须满足四要素：

| 要素 | 说明 |
|------|------|
| class | `state` / `control` / `activity` / `audit` |
| materialization rule | `event-store.js` 的 `materializeJob()` 中有 case |
| consumer | 哪个模块消费此 event |
| regression test | `tests/` 下有对应测试 |

验证命令：

```bash
node --test tests/event-extension-gate.test.mjs
```

新增 event 前必须先在 `EVENT_REGISTRY` 中注册，否则 gate test 会失败。
