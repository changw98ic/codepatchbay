# Spec: Redis 清退 + ProjectWorker 旧链路清理

> 状态：**DRAFT v2** | 作者：Linus-mode | 日期：2026-07-25
> v2 更新：根据 Codex 审查意见修正 4 个严重问题 + 8 个改进建议

## 1. 背景与动机

### 1.1 当前问题

1. **Redis 增加了部署复杂度**：项目定位是"纯 Node.js CLI 工具，仅依赖 chokidar"，但 Redis 后端引入了外部服务依赖
2. **双后端维护成本高**：AssignmentStore/WorkerStore/leader-lock 都需要维护 local + Redis 两套实现
3. **旧 ProjectWorker 链路造成混淆**：新旧两套执行模型并存，状态源、租约语义、失败处理方式不同
4. **迁移代码是技术债务**：hub-redis-migration.ts (2286行) 是一次性迁移工具，不应长期保留

### 1.2 目标

- **清退 Redis**：移除所有 Redis 相关代码，统一使用本地文件系统后端
- **清理旧链路**：删除 ProjectWorker + run-pipeline，统一使用 HubOrchestrator → ManagedWorker 链路
- **简化架构**：回归"纯 Node.js CLI，仅依赖 chokidar"的定位

## 2. 影响范围分析

### 2.1 Redis 代码清单

| 文件 | 行数 | 用途 | 删除/修改 |
|------|------|------|-----------|
| `shared/hub-state-redis.ts` | 2664 | Redis 状态后端核心 | **删除** |
| `server/services/hub/hub-redis-migration.ts` | 2286 | Local → Redis 迁移 | **删除** |
| `server/services/hub/hub-redis-retention.ts` | 216 | Redis 数据保留策略 | **删除** |
| `server/services/audit/hub-access-audit-redis-export.ts` | ? | Redis 审计导出 | **删除** |
| `shared/hub-leader-fence.ts` | 12 | Redis leader fence 类型封装 | **重构**（当前全部依赖 Redis 类型） |
| `scripts/verify-enterprise-gate.ts` | ? | 企业门禁验证 | **删除或修改** |
| **总计** | **~5200+** | | |

### 2.2 Redis 消费者（需要修改）

| 文件 | 使用方式 | 修改内容 |
|------|----------|----------|
| `server/index.ts` | `openHubRedisStateBackend()` | 移除 Redis 初始化，只用 local |
| `server/services/readiness-checks.ts` | Redis 健康检查 | 移除 Redis 检查项 |
| `server/services/infra.ts` | Redis 配置读取 | 移除 Redis 配置 |
| `server/services/phase-runner.ts` | 传递 `CPB_HUB_STATE_REDIS_CONFIG_FILE` | 移除环境变量传递 |
| `server/services/event/event-store.ts` | Redis 后端选择 | 移除 Redis 分支 |
| `server/services/hub/hub-queue.ts` | Redis 后端选择 | 移除 Redis 分支 |
| `server/services/hub/hub-registry.ts` | Redis 配置传递 | 移除 Redis 配置 |
| `server/services/hub/hub-backup.ts` | Redis 备份逻辑 | 移除 Redis 备份 |
| `server/services/job/job-store.ts` | `redisJobBackend()` + Redis projection | **移除 Redis 后端分支** |
| `server/services/audit/hub-access-audit.ts` | `captureRedisAudit()` + `verifyRedisAudit()` | **移除 Redis 审计函数** |
| `server/orchestrator/leader-lock.ts` | Redis leader fence (36处引用) | 改用纯本地实现 |
| `server/orchestrator/worker-supervisor.ts` | Redis 配置传递 | 移除 Redis 配置 |
| `shared/orchestrator/assignment-store.ts` | 双后端 (local + Redis) | **移除 Redis 后端，只保留 local** |
| `shared/orchestrator/worker-store.ts` | 双后端 (local + Redis) | **移除 Redis 后端，只保留 local** |
| `shared/hub-leader-fence.ts` | Redis leader fence 类型封装 | **重构：定义 LocalLeaderFence 类型，更新 4 个消费者** |
| `cli/commands/hub.ts` | Redis 迁移命令 | **删除 migrate-to-redis, recover-redis-migration, redis-retention 命令** |
| `runtime/worker/managed-worker.ts` | 删除 Redis 环境变量 | 保持（清理子进程环境） |
| `scripts/e2e-npm-pack.ts` | Redis 环境变量检查 | **移除 CPB_HUB_STATE_REDIS_CONFIG_FILE 检查** |

### 2.3 Redis 测试文件（需要删除或修改）

| 文件 | 操作 |
|------|------|
| `tests/*redis*.test.ts` | **删除** |
| `tests/*migration*.test.ts` | **删除** |
| 其他测试中的 Redis 分支 | **删除 Redis 分支** |

### 2.4 ProjectWorker 代码清单

| 文件 | 行数 | 用途 | 操作 |
|------|------|------|------|
| `bridges/project-worker.ts` | 919 | 旧 worker 实现 | **删除** |
| `bridges/run-pipeline.ts` | 1187 | 旧 pipeline 执行 | **删除** |
| **总计** | **2106** | | |

### 2.5 ProjectWorker 消费者

| 文件 | 使用方式 | 操作 |
|------|----------|------|
| `cli/commands/*.ts` | 可能调用 ProjectWorker | **检查并移除** |
| `tests/project-worker.test.ts` | 测试 | **删除** |
| `tests/fixtures/` | 测试夹具 | **检查并清理** |

### 2.6 依赖图

```
Redis 清退影响链：
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Commands                             │
│  (hub.ts: migrate-to-redis, recover-redis-migration, etc.)     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Server Services                            │
│  (index.ts, infra.ts, phase-runner.ts, event-store.ts, etc.)   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Orchestrator Layer                             │
│  (leader-lock.ts, assignment-store.ts, worker-store.ts)         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Redis Core (删除)                             │
│  (hub-state-redis.ts, hub-redis-migration.ts, etc.)             │
└─────────────────────────────────────────────────────────────────┘


ProjectWorker 清理影响链：
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Commands                             │
│  (可能的 worker 启动命令)                                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Old Execution Path (删除)                      │
│  (project-worker.ts → run-pipeline.ts → 直接更新 queue)          │
└─────────────────────────────────────────────────────────────────┘


新执行链路（保留）：
┌─────────────────────────────────────────────────────────────────┐
│                     HubOrchestrator                              │
│  (hub-orchestrator.ts - 主调度循环)                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐  ┌───────────────────┐  ┌───────────────────┐
│  LeaderLock   │  │  AssignmentStore  │  │   WorkerStore     │
│  (本地实现)    │  │  (仅 local 后端)  │  │  (仅 local 后端)  │
└───────────────┘  └───────────────────┘  └───────────────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ManagedWorker                                │
│  (scheduler → worker-supervisor → reconciler → failure-router)  │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 清理方案

### 3.1 Phase 1: Redis 清退（优先级：高）

#### 3.1.1 删除 Redis 核心文件

```bash
# 删除 Redis 核心实现
rm shared/hub-state-redis.ts
rm server/services/hub/hub-redis-migration.ts
rm server/services/hub/hub-redis-retention.ts
rm server/services/audit/hub-access-audit-redis-export.ts

# 删除 Redis 相关测试
rm tests/*redis*.test.ts
rm tests/*migration*.test.ts

# 删除企业门禁脚本（如果仅用于 Redis）
rm scripts/verify-enterprise-gate.ts
```

#### 3.1.2 修改 AssignmentStore（关键）

**文件**: `shared/orchestrator/assignment-store.ts`

**当前状态**: 支持双后端 (local + Redis)，通过 `openPinnedHubRedisStateBackend()` 动态选择

**修改内容**:
1. 移除 Redis 相关导入
2. 移除 `openPinnedHubRedisStateBackend` 调用
3. 移除所有 Redis 后端分支代码
4. 只保留 local 文件系统实现
5. 移除 Redis 迁移检查逻辑

**关键代码位置**:
- 第 10 行: `import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../hub-state-redis.js";`
- 第 ~200 行: Redis 后端初始化逻辑
- 第 ~500 行: Redis 读写操作

#### 3.1.3 修改 WorkerStore

**文件**: `shared/orchestrator/worker-store.ts`

**修改内容**: 同 AssignmentStore，移除 Redis 后端，只保留 local

#### 3.1.4 修改 leader-lock

**文件**: `server/orchestrator/leader-lock.ts` (1960 行)

**当前状态**: 依赖 Redis (36处引用)

**修改内容**:
1. 移除 Redis leader fence 实现
2. 改用纯本地文件锁 + 进程身份验证
3. 参考现有的 `shared/hub-leader-fence.ts` 中的本地实现

**风险**: 这是最复杂的修改，leader-lock 是调度核心

#### 3.1.5 修改 Server 入口

**文件**: `server/index.ts`

**修改内容**:
1. 移除 `openHubRedisStateBackend` 导入和调用
2. 移除 `recoverHubRedisMigration` 调用
3. 只使用本地状态后端

#### 3.1.6 修改 CLI 命令

**文件**: `cli/commands/hub.ts`

**删除命令**:
- `cpb hub migrate-to-redis`
- `cpb hub recover-redis-migration`
- `cpb hub redis-retention`

**保留命令**:
- `cpb hub status`
- `cpb hub start`
- `cpb hub stop`
- `cpb hub projects`
- 其他非 Redis 命令

#### 3.1.7 清理环境变量

**删除环境变量**:
- `CPB_HUB_STATE_REDIS_CONFIG_FILE`
- `CPB_REDIS_ACL_CHECK_UNSUPPORTED`
- `CPB_REDIS_ACL_INSUFFICIENT`

**需要修改的文件** (15+):
- `server/services/readiness-checks.ts`
- `server/services/infra.ts`
- `server/services/phase-runner.ts`
- `server/services/event/event-store.ts`
- `server/services/hub/hub-queue.ts`
- `server/services/hub/hub-registry.ts`
- `server/orchestrator/worker-supervisor.ts`
- `runtime/worker/managed-worker.ts`
- 等

### 3.2 Phase 2: ProjectWorker 清理（优先级：中）

#### 3.2.1 删除旧执行链路

```bash
# 删除 ProjectWorker 实现
rm bridges/project-worker.ts
rm bridges/run-pipeline.ts

# 删除相关测试
rm tests/project-worker.test.ts
rm tests/*run-pipeline*.test.ts

# 删除相关夹具
rm tests/fixtures/*project-worker*
rm tests/fixtures/*run-pipeline*
```

#### 3.2.2 清理 CLI 入口

**检查并修改**:
- `cli/commands/*.ts` - 移除对 ProjectWorker 的调用
- 确保所有 worker 启动都通过 HubOrchestrator → ManagedWorker

#### 3.2.3 清理 Bridge 文件

**检查**:
- `bridges/` 目录下的其他文件是否依赖 project-worker.ts
- 移除相关导入和调用

### 3.3 Phase 3: 文档和配置更新

#### 3.3.1 更新 CLAUDE.md

**移除**:
- Redis 相关说明
- 双后端架构描述
- 迁移命令文档

**更新**:
- 架构图：移除 Redis 层
- 技术栈：确认"纯 Node.js，仅依赖 chokidar"
- 核心数据流：移除 Redis 相关路径

#### 3.3.2 更新 README.md

**移除**:
- Redis 配置说明
- Redis 部署指南
- 迁移文档

#### 3.3.3 更新 AGENTS.md

**修正**:
- 移除 Fastify/Vite/React 描述（当前是 Node 原生 http + SSE）
- 更新架构描述

#### 3.3.4 更新 package.json

**检查**:
- 移除 Redis 相关依赖（如果有）
- 移除 Redis 相关 scripts

## 4. 本地存储加固

清退 Redis 后，需要加固本地存储的原子性。

### 4.1 Assignment 原子性

**当前问题**: `completeAttemptAndAckInbox()` 返回 `inboxAcked: false`

**现状评估**: `shared/fs-utils.ts` 已有 `writeJsonAtomic` (第325行) 和 `writeJsonOnce` (第407行)，`worker-store.ts` 已在使用。当前实现使用 write + fsync + rename 模式，基本满足需求。

**需要验证**:
- [ ] 确认 `writeJsonAtomic` 在进程崩溃时的原子性保证
- [ ] 验证 `completeAttemptAndAckInbox()` 的两步写入是否可以合并为单次原子操作
- [ ] 如果无法合并，使用 write-ahead log 模式记录中间状态

**改进方案** (如果现有实现不足):
```typescript
// 改进实现（原子）
const tmpPath = `${assignmentPath}.tmp.${Date.now()}`;
await writeJsonAtomic(tmpPath, { state, inboxAck: true });
await rename(tmpPath, assignmentPath); // 原子操作
```

### 4.2 Leader Lock 本地实现

**当前**: 依赖 Redis 实现 leader fence

**改为**: 文件锁 + 进程身份验证

**类型迁移步骤**:
1. 定义 `LocalLeaderFence` 类型（替代 `RedisLeaderFence`）
2. 更新 `shared/hub-leader-fence.ts`：移除 Redis 类型依赖，使用本地实现
3. 更新 4 个消费者文件：
   - `server/orchestrator/leader-lock.ts`
   - `server/services/hub/hub-queue.ts`
   - `shared/orchestrator/assignment-store.ts`
   - `shared/orchestrator/worker-store.ts`

```typescript
// 新的本地 fence 类型
export type LocalLeaderFence = {
  hubId: string;
  lockToken: string;
  epoch: number;
  processIdentity: ProcessIdentity; // { pid, birthId, incarnation }
};
```

### 4.3 进程崩溃恢复

**需要测试的场景**:
1. Assignment 写入后进程崩溃 → reconciler 重置
2. Inbox 写入后进程未返回 → inbox timeout + 重试
3. Worker 崩溃 → worker health 标记 + 强制清理

## 5. 测试策略

### 5.1 删除的测试

- 所有 Redis 相关测试
- 所有迁移相关测试
- ProjectWorker 测试
- run-pipeline 测试

### 5.2 新增/修改的测试

1. **本地存储原子性测试**
   - 测试 write-ahead + rename 模式
   - 测试进程崩溃后恢复

2. **Leader Lock 本地实现测试**
   - 测试文件锁 + 进程身份验证
   - 测试 leader 选举和 fence
   - **多进程并发 leader 竞争测试**：两个进程同时尝试获取锁，只有一个成功
   - **leader 进程 SIGKILL 后锁回收测试**：异常退出后锁能被回收

3. **故障注入测试**
   - Assignment 写入点前后崩溃
   - Inbox 写入点前后崩溃
   - Worker 清理失败场景

### 5.3 集成测试

- 端到端 pipeline 测试（不依赖 Redis）
- 多 worker 并发测试（使用本地锁）
- 崩溃恢复测试

## 6. 风险评估

### 6.1 高风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| leader-lock 重构引入 bug | 调度混乱、重复执行 | 充分测试，保留 git 历史以便回滚 |
| 本地存储原子性不足 | 任务丢失或重复 | Phase 1 先加固本地存储，再删除 Redis |

### 6.2 中风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 遗漏 Redis 引用 | 运行时报错 | 全面搜索 + 类型检查 |
| 企业用户依赖 Redis | 功能丢失 | 明确文档说明，提供迁移指南 |

### 6.3 低风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 测试覆盖不足 | 回归问题 | 补充测试后再删除代码 |
| 文档更新不及时 | 用户困惑 | 同步更新所有文档 |

## 7. 执行计划

### 7.1 Phase 1: 本地存储加固（2-3天）⚠️ 必须在删除 Redis 之前完成

- [ ] **1.1 验证现有本地存储实现**
  - 审计 `writeJsonAtomic` 的原子性保证
  - 验证 `completeAttemptAndAckInbox()` 是否可以合并为单次原子操作
  - 如果不足，实现 write-ahead + rename 改进

- [ ] **1.2 定义 LocalLeaderFence 类型**
  - 创建 `shared/types/leader-fence.ts`
  - 定义 `LocalLeaderFence` 接口（替代 `RedisLeaderFence`）

- [ ] **1.3 重构 hub-leader-fence.ts**
  - 移除 Redis 类型依赖
  - 使用本地文件锁 + 进程身份验证
  - 更新 4 个消费者文件的类型签名

- [ ] **1.4 补充本地存储测试**
  - 原子性测试
  - 多进程并发 leader 竞争测试
  - leader 进程 SIGKILL 后锁回收测试

- [ ] **1.5 运行全量测试，确认 baseline**

### 7.2 Phase 2: Redis 清退（2-3天）

- [ ] **2.1 重构 leader-lock（改用本地实现）**
  - 移除 Redis leader fence 实现（36处引用）
  - 使用 Phase 1 实现的 LocalLeaderFence
  - 运行 leader-lock 专项测试

- [ ] **2.2 修改 AssignmentStore 和 WorkerStore**
  - 移除 Redis 后端分支
  - 只保留 local 文件系统实现
  - 移除 Redis 迁移检查逻辑

- [ ] **2.3 修改其他 Redis 消费者** (15+ 文件)
  - `server/index.ts` - 移除 Redis 初始化
  - `server/services/job/job-store.ts` - 移除 `redisJobBackend()`
  - `server/services/audit/hub-access-audit.ts` - 移除 Redis 审计函数
  - `server/services/readiness-checks.ts` - 移除 Redis 健康检查
  - 其他文件...

- [ ] **2.4 修改 CLI 命令**
  - 删除 `cpb hub migrate-to-redis`
  - 删除 `cpb hub recover-redis-migration`
  - 删除 `cpb hub redis-retention`

- [ ] **2.5 清理环境变量**
  - 移除 `CPB_HUB_STATE_REDIS_CONFIG_FILE` (15+ 文件)
  - 移除 `CPB_REDIS_ACL_*` 常量
  - 包括 `scripts/e2e-npm-pack.ts`

- [ ] **2.6 删除 Redis 核心文件**
  - `shared/hub-state-redis.ts` (2664行)
  - `server/services/hub/hub-redis-migration.ts` (2286行)
  - `server/services/hub/hub-redis-retention.ts` (216行)
  - `server/services/audit/hub-access-audit-redis-export.ts`

- [ ] **2.7 删除 Redis 测试文件**
  - `tests/*redis*.test.ts`
  - `tests/*migration*.test.ts`

- [ ] **2.8 运行测试，修复编译错误**

### 7.3 Phase 3: ProjectWorker 清理（1天）

- [ ] **3.1 检查 ProjectWorker 消费者**
  - `server/services/hub/hub-registry.ts` 的 `summarizeProjectWorkers` 函数
  - `cli/commands/*.ts` 的调用
  - 确认无其他隐藏依赖

- [ ] **3.2 删除旧执行链路**
  - `bridges/project-worker.ts` (919行)
  - `bridges/run-pipeline.ts` (1187行)

- [ ] **3.3 清理测试和夹具**
  - `tests/project-worker.test.ts`
  - `tests/*run-pipeline*.test.ts`
  - `tests/fixtures/*project-worker*`
  - `tests/fixtures/*run-pipeline*`

- [ ] **3.4 运行测试，修复问题**

### 7.4 Phase 4: 文档更新（0.5天）

- [ ] 更新 CLAUDE.md - 移除 Redis 描述
- [ ] 更新 README.md - 移除 Redis 配置说明
- [ ] 更新 AGENTS.md - 修正架构描述
- [ ] 更新 package.json - 移除 Redis 相关 scripts

### 7.5 Phase 5: 验证（1天）

- [ ] 全量测试通过
- [ ] 类型检查通过：`npm run typecheck`
- [ ] 端到端测试通过：`cpb pipeline` 正常工作
- [ ] 文档审查
- [ ] 代码审查：`grep -r "redis\|Redis" --include="*.ts"` 返回 0

## 8. 验收标准

### 8.1 代码层面

- [ ] `grep -r "redis\|Redis" --include="*.ts"` 返回 0 结果（除了注释）
- [ ] `grep -r "ProjectWorker\|run-pipeline" --include="*.ts"` 返回 0 结果
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿

### 8.2 功能层面

- [ ] `cpb hub status` 正常工作
- [ ] `cpb hub start/stop` 正常工作
- [ ] `cpb pipeline` 端到端正常工作
- [ ] 多 worker 并发正常工作
- [ ] 崩溃恢复正常工作

### 8.3 文档层面

- [ ] CLAUDE.md 无 Redis 描述
- [ ] README.md 无 Redis 配置说明
- [ ] AGENTS.md 架构描述准确
- [ ] 无遗留的 Redis/ProjectWorker 文档

## 9. 回滚方案

### 9.1 Git 回滚

```bash
# 如果出现问题，回滚到清理前的 commit
git revert <cleanup-commit-hash>
```

### 9.2 分阶段回滚

- Phase 2 出问题 → 回滚 Phase 2，保留 Phase 1
- Phase 3 出问题 → 回滚 Phase 3，保留 Phase 1+2

### 9.3 Leader Lock Feature Flag（高风险变更的安全网）

为 leader-lock 重构增加临时 feature flag，允许快速切换：

```typescript
// 环境变量控制
const LEADER_LOCK_BACKEND = process.env.CPB_LEADER_LOCK_BACKEND || 'local';

// 代码中根据 flag 选择实现
if (LEADER_LOCK_BACKEND === 'redis') {
  // 使用 Redis 实现（过渡期保留）
} else {
  // 使用本地文件锁实现（新实现）
}
```

**使用时机**:
- 如果本地 leader-lock 实现出问题，可以快速切换回 Redis
- 过渡期（1-2周）后，确认稳定后移除 flag 和 Redis 代码

**注意**: 这个 flag 只在 Phase 2 过渡期使用，最终目标是完全移除 Redis

### 9.4 紧急修复

- 保留 Redis 核心代码的 git 历史
- 可以随时从历史中恢复特定文件
- 保留 `CPB_HUB_STATE_REDIS_CONFIG_FILE` 环境变量的解析（只读兼容）

## 10. 附录

### 10.1 关键文件路径

**Redis 核心文件（删除）**:
- `shared/hub-state-redis.ts` (2664行)
- `server/services/hub/hub-redis-migration.ts` (2286行)
- `server/services/hub/hub-redis-retention.ts` (216行)
- `server/services/audit/hub-access-audit-redis-export.ts`

**Redis 消费者（修改）**:
- `shared/hub-leader-fence.ts` (12行 - 隐藏的 Redis 类型依赖，需重构)
- `server/services/job/job-store.ts` (14处 Redis 引用)
- `server/services/audit/hub-access-audit.ts` (Redis 审计函数)
- `scripts/e2e-npm-pack.ts` (Redis 环境变量检查)

**ProjectWorker 相关（删除）**:
- `bridges/project-worker.ts` (919行)
- `bridges/run-pipeline.ts` (1187行)

**ProjectWorker 消费者（检查）**:
- `server/services/hub/hub-registry.ts` (`summarizeProjectWorkers` 函数)

**新执行链路（保留）**:
- `server/orchestrator/hub-orchestrator.ts`
- `server/orchestrator/leader-lock.ts` (1960行，36处 Redis 引用)
- `server/orchestrator/scheduler.ts`
- `server/orchestrator/worker-supervisor.ts`
- `server/orchestrator/reconciler.ts`
- `server/orchestrator/failure-router.ts`
- `shared/orchestrator/assignment-store.ts` (97389行，双后端)
- `shared/orchestrator/worker-store.ts` (99273行，双后端)

**本地存储（保留）**:
- `shared/fs-utils.ts` (`writeJsonAtomic` 第325行，`writeJsonOnce` 第407行)

### 10.2 环境变量清单

**删除**:
- `CPB_HUB_STATE_REDIS_CONFIG_FILE`
- `CPB_REDIS_ACL_CHECK_UNSUPPORTED`
- `CPB_REDIS_ACL_INSUFFICIENT`

**保留**:
- `CPB_ROOT`
- `CPB_EXECUTOR_ROOT`
- `CPB_HUB_ROOT`
- 其他非 Redis 环境变量

### 10.3 CLI 命令变更

**删除**:
- `cpb hub migrate-to-redis`
- `cpb hub recover-redis-migration`
- `cpb hub redis-retention`

**保留**:
- `cpb hub status`
- `cpb hub start`
- `cpb hub stop`
- `cpb hub projects`
- 其他非 Redis 命令

---

## 11. Codex 审查反馈（v2 更新）

### 🔴 严重问题（已修复）

| # | 问题 | 修复 |
|---|------|------|
| 1 | `leader-lock.ts` 行数声明失实（68752→实际1960） | 已修正为 1960 行，Redis 引用 36 处 |
| 2 | `hub-leader-fence.ts` 是隐藏的 Redis 类型依赖 | 已加入代码清单，明确需要重构 |
| 3 | `job-store.ts` 有 14 处 Redis 引用被遗漏 | 已加入 Redis 消费者清单 |
| 4 | 执行顺序倒置（应先加固本地存储再删除 Redis） | 已调整：Phase 1 改为"本地存储加固" |

### 🟡 建议改进（已修复）

| # | 问题 | 修复 |
|---|------|------|
| 5 | `hub-access-audit.ts` 主文件有 Redis 依赖 | 已加入 Redis 消费者清单 |
| 6 | `scripts/e2e-npm-pack.ts` 引用 Redis 环境变量 | 已加入环境变量清理清单 |
| 7 | 本地后端实现文件未指明 | 已在附录中明确 `shared/fs-utils.ts` 的位置 |
| 8 | write-ahead + rename 与现有实现重复 | 已在 4.1 中说明现状评估和验证步骤 |
| 9 | `hub-registry.ts` 的 `summarizeProjectWorkers` 函数 | 已加入 ProjectWorker 消费者检查清单 |
| 10 | 缺少 `RedisLeaderFence` 类型迁移步骤 | 已在 4.2 中增加详细类型迁移步骤 |
| 11 | 测试策略缺少 leader-lock 并发竞争场景 | 已在 5.2 中增加并发竞争和 SIGKILL 测试 |
| 12 | 回滚方案过于粗糙 | 已在 9.3 增加 leader-lock feature flag 方案 |

### 🟢 确认正确（无需修改）

- 背景分析准确描述了问题
- 影响范围分析的依赖图清晰
- Phase 分离（Redis 清退 vs ProjectWorker 清理）正确
- 验收标准的 `grep` 检查和功能测试覆盖合理
- `package.json` 已经没有 Redis npm 依赖
- `run-pipeline.ts` 的唯一非测试消费者是 `project-worker.ts`

---

**下一步**: 审查此 spec v2，确认无遗漏后开始执行。
