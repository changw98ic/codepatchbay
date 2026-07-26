export const meta = {
  name: 'redis-retirement-and-projectworker-cleanup',
  description: '清退 Redis + 清理旧 ProjectWorker 执行链路',
  phases: [
    { title: 'Phase 1: 本地存储加固', detail: '验证现有实现、定义 LocalLeaderFence 类型、重构 hub-leader-fence.ts' },
    { title: 'Phase 2: Redis 清退', detail: '重构 leader-lock、修改 AssignmentStore/WorkerStore、清理消费者' },
    { title: 'Phase 3: ProjectWorker 清理', detail: '删除旧执行链路、清理 CLI 入口和测试' },
    { title: 'Phase 4: 文档更新', detail: '更新 CLAUDE.md、README.md、AGENTS.md' },
    { title: 'Phase 5: 验证', detail: '全量测试、类型检查、端到端验证' },
  ],
};

// Phase 1: 本地存储加固
phase('Phase 1: 本地存储加固')

// 1.1 验证现有本地存储实现
const localStoreAudit = await agent(
  `审计 /Volumes/ORICO/flow 项目中的本地存储实现，确认原子性保证：

1. 读取 shared/fs-utils.ts，找到 writeJsonAtomic (第325行) 和 writeJsonOnce (第407行)
2. 分析它们的实现：是否使用 write + fsync + rename 模式？
3. 读取 shared/orchestrator/assignment-store.ts，找到 completeAttemptAndAckInbox() 方法
4. 分析这个方法的两步写入是否可以合并为单次原子操作
5. 如果现有实现不足，提出改进方案

输出格式：
- 现有实现评估：✅ 充分 / ⚠️ 需要改进 / ❌ 不足
- 具体问题描述
- 改进建议（如果需要）`,
  { label: 'audit-local-store', phase: 'Phase 1: 本地存储加固', model: 'sonnet' }
)

// 1.2 定义 LocalLeaderFence 类型
const localFenceType = await agent(
  `在 /Volumes/ORICO/flow 项目中定义 LocalLeaderFence 类型：

1. 读取 shared/hub-leader-fence.ts，了解当前 RedisLeaderFence 的使用方式
2. 读取 shared/hub-state-redis.ts 第 804 行，找到 RedisLeaderFence 类型定义
3. 创建新文件 shared/types/leader-fence.ts，定义 LocalLeaderFence 类型：

\`\`\`typescript
export type LocalLeaderFence = {
  hubId: string;
  lockToken: string;
  epoch: number;
  processIdentity: ProcessIdentity; // { pid, birthId, incarnation }
};
\`\`\`

4. 确保类型兼容现有的使用场景

输出：创建的文件路径和类型定义`,
  { label: 'define-local-fence-type', phase: 'Phase 1: 本地存储加固', model: 'sonnet' }
)

// 1.3 重构 hub-leader-fence.ts
const hubLeaderFenceRefactor = await agent(
  `重构 /Volumes/ORICO/flow/shared/hub-leader-fence.ts：

当前状态：全部 12 行代码都依赖 Redis 类型
\`\`\`typescript
import type { RedisLeaderFence } from "./hub-state-redis.js";
const processFences = new Map<string, RedisLeaderFence>();
\`\`\`

目标：
1. 移除对 hub-state-redis.js 的导入
2. 使用新定义的 LocalLeaderFence 类型（从 shared/types/leader-fence.ts 导入）
3. 保持相同的 API 和语义
4. 确保 4 个消费者文件（leader-lock.ts、hub-queue.ts、assignment-store.ts、worker-store.ts）不需要修改

注意：这是一个类型重构，不需要改变运行时行为。

输出：修改后的文件内容`,
  { label: 'refactor-hub-leader-fence', phase: 'Phase 1: 本地存储加固', model: 'sonnet' }
)

// 1.4 补充本地存储测试
const localStorageTests = await agent(
  `为 /Volumes/ORICO/flow 项目补充本地存储测试：

1. 创建 tests/local-store-atomicity.test.ts
2. 测试场景：
   - writeJsonAtomic 在进程崩溃时的原子性
   - completeAttemptAndAckInbox() 的两步写入行为
   - 多进程并发写入同一 assignment

3. 创建 tests/leader-lock-local.test.ts
4. 测试场景：
   - 本地文件锁的获取和释放
   - 多进程并发 leader 竞争（两个进程同时尝试获取锁，只有一个成功）
   - leader 进程 SIGKILL 后锁回收

使用 Node.js 内置 test runner。

输出：创建的测试文件路径`,
  { label: 'local-storage-tests', phase: 'Phase 1: 本地存储加固', model: 'sonnet' }
)

// Phase 2: Redis 清退
phase('Phase 2: Redis 清退')

// 2.1 重构 leader-lock
const leaderLockRefactor = await agent(
  `重构 /Volumes/ORICO/flow/server/orchestrator/leader-lock.ts：

当前状态：1960 行，36 处 Redis 引用

目标：
1. 移除所有 Redis 相关导入和代码
2. 使用 Phase 1 定义的 LocalLeaderFence 类型
3. 改用纯本地文件锁 + 进程身份验证
4. 保持相同的 API 和语义

关键修改点：
- 移除 openHubRedisStateBackend 调用
- 移除 Redis leader fence 实现
- 使用 shared/hub-leader-fence.ts 的本地实现

注意：这是高风险修改，需要充分测试。

输出：修改的关键代码段`,
  { label: 'refactor-leader-lock', phase: 'Phase 2: Redis 清退', model: 'opus' }
)

// 2.2 修改 AssignmentStore 和 WorkerStore
const storeRefactor = await agent(
  `修改 /Volumes/ORICO/flow 中的 AssignmentStore 和 WorkerStore：

文件：
- shared/orchestrator/assignment-store.ts (97389行)
- shared/orchestrator/worker-store.ts (99273行)

目标：
1. 移除 Redis 相关导入（openPinnedHubRedisStateBackend、HubRedisStateBackend）
2. 移除所有 Redis 后端分支代码
3. 只保留 local 文件系统实现
4. 移除 Redis 迁移检查逻辑
5. 确保 API 不变

关键修改：
- 移除 openPinnedHubRedisStateBackend 调用
- 移除 Redis 读写操作
- 移除 Redis 迁移检查

输出：需要修改的关键代码段`,
  { label: 'refactor-stores', phase: 'Phase 2: Redis 清退', model: 'opus' }
)

// 2.3 修改其他 Redis 消费者
const redisConsumersRefactor = await agent(
  `修改 /Volumes/ORICO/flow 中的 Redis 消费者（15+ 文件）：

需要修改的文件：
1. server/index.ts - 移除 Redis 初始化
2. server/services/job/job-store.ts - 移除 redisJobBackend()
3. server/services/audit/hub-access-audit.ts - 移除 Redis 审计函数
4. server/services/readiness-checks.ts - 移除 Redis 健康检查
5. server/services/infra.ts - 移除 Redis 配置
6. server/services/phase-runner.ts - 移除 CPB_HUB_STATE_REDIS_CONFIG_FILE 传递
7. server/services/event/event-store.ts - 移除 Redis 分支
8. server/services/hub/hub-queue.ts - 移除 Redis 分支
9. server/services/hub/hub-registry.ts - 移除 Redis 配置
10. server/services/hub/hub-backup.ts - 移除 Redis 备份
11. server/orchestrator/worker-supervisor.ts - 移除 Redis 配置
12. scripts/e2e-npm-pack.ts - 移除 Redis 环境变量检查

目标：移除所有 Redis 相关代码，只保留本地实现

输出：每个文件的关键修改`,
  { label: 'refactor-redis-consumers', phase: 'Phase 2: Redis 清退', model: 'opus' }
)

// 2.4 修改 CLI 命令
const cliCommandsRefactor = await agent(
  `修改 /Volumes/ORICO/flow/cli/commands/hub.ts：

删除命令：
- cpb hub migrate-to-redis
- cpb hub recover-redis-migration
- cpb hub redis-retention

保留命令：
- cpb hub status
- cpb hub start
- cpb hub stop
- cpb hub projects
- 其他非 Redis 命令

目标：移除所有 Redis 迁移和管理命令

输出：需要删除的代码段`,
  { label: 'refactor-cli-commands', phase: 'Phase 2: Redis 清退', model: 'sonnet' }
)

// 2.5 清理环境变量
const envVarsCleanup = await agent(
  `清理 /Volumes/ORICO/flow 中的 Redis 环境变量：

需要删除的环境变量：
- CPB_HUB_STATE_REDIS_CONFIG_FILE
- CPB_REDIS_ACL_CHECK_UNSUPPORTED
- CPB_REDIS_ACL_INSUFFICIENT

需要修改的文件（15+）：
1. server/services/readiness-checks.ts
2. server/services/infra.ts
3. server/services/phase-runner.ts
4. server/services/event/event-store.ts
5. server/services/hub/hub-queue.ts
6. server/services/hub/hub-registry.ts
7. server/orchestrator/worker-supervisor.ts
8. runtime/worker/managed-worker.ts
9. scripts/e2e-npm-pack.ts
10. 其他文件...

目标：移除所有 Redis 环境变量的使用和传递

输出：每个文件的修改`,
  { label: 'cleanup-env-vars', phase: 'Phase 2: Redis 清退', model: 'sonnet' }
)

// 2.6 删除 Redis 核心文件
const deleteRedisCore = await agent(
  `删除 /Volumes/ORICO/flow 中的 Redis 核心文件：

要删除的文件：
1. shared/hub-state-redis.ts (2664行)
2. server/services/hub/hub-redis-migration.ts (2286行)
3. server/services/hub/hub-redis-retention.ts (216行)
4. server/services/audit/hub-access-audit-redis-export.ts

要删除的测试文件：
1. tests/*redis*.test.ts
2. tests/*migration*.test.ts

执行删除命令，然后运行 npm run typecheck 验证编译。

输出：删除的文件列表和 typecheck 结果`,
  { label: 'delete-redis-core', phase: 'Phase 2: Redis 清退', model: 'sonnet' }
)

// Phase 3: ProjectWorker 清理
phase('Phase 3: ProjectWorker 清理')

// 3.1 检查 ProjectWorker 消费者
const projectWorkerConsumers = await agent(
  `检查 /Volumes/ORICO/flow 中的 ProjectWorker 消费者：

1. 读取 server/services/hub/hub-registry.ts，找到 summarizeProjectWorkers 函数（第1955行）
2. 分析这个函数是否依赖 bridges/project-worker.ts 的类型或数据结构
3. 检查 cli/commands/*.ts 是否有对 ProjectWorker 的调用
4. 检查其他可能的隐藏依赖

输出：
- 完整的 ProjectWorker 消费者列表
- 每个消费者的修改建议`,
  { label: 'check-projectworker-consumers', phase: 'Phase 3: ProjectWorker 清理', model: 'sonnet' }
)

// 3.2 删除旧执行链路
const deleteOldExecutionPath = await agent(
  `删除 /Volumes/ORICO/flow 中的旧执行链路：

要删除的文件：
1. bridges/project-worker.ts (919行)
2. bridges/run-pipeline.ts (1187行)

要删除的测试文件：
1. tests/project-worker.test.ts
2. tests/*run-pipeline*.test.ts

要删除的夹具：
1. tests/fixtures/*project-worker*
2. tests/fixtures/*run-pipeline*

执行删除命令，然后运行 npm run typecheck 验证编译。

输出：删除的文件列表和 typecheck 结果`,
  { label: 'delete-old-execution-path', phase: 'Phase 3: ProjectWorker 清理', model: 'sonnet' }
)

// Phase 4: 文档更新
phase('Phase 4: 文档更新')

const docsUpdate = await agent(
  `更新 /Volumes/ORICO/flow 中的文档：

1. CLAUDE.md：
   - 移除 Redis 相关说明
   - 移除双后端架构描述
   - 移除迁移命令文档
   - 更新架构图，移除 Redis 层

2. README.md：
   - 移除 Redis 配置说明
   - 移除 Redis 部署指南
   - 移除迁移文档

3. AGENTS.md：
   - 移除 Fastify/Vite/React 描述
   - 更新架构描述为 Node 原生 http + SSE

4. package.json：
   - 检查并移除 Redis 相关依赖（如果有）
   - 移除 Redis 相关 scripts

输出：每个文件的关键修改`,
  { label: 'update-docs', phase: 'Phase 4: 文档更新', model: 'sonnet' }
)

// Phase 5: 验证
phase('Phase 5: 验证')

const verification = await agent(
  `验证 /Volumes/ORICO/flow 的 Redis 清退和 ProjectWorker 清理：

运行以下验证：

1. 代码检查：
   - grep -r "redis\\|Redis" --include="*.ts" | wc -l（应该返回 0，除了注释）
   - grep -r "ProjectWorker\\|run-pipeline" --include="*.ts" | wc -l（应该返回 0）

2. 类型检查：
   - npm run typecheck

3. 测试：
   - npm test

4. 功能验证：
   - cpb hub status（应该正常工作）
   - cpb pipeline（如果可行）

输出：每个验证的结果`,
  { label: 'verification', phase: 'Phase 5: 验证', model: 'sonnet' }
)
