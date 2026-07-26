export const meta = {
  name: 'redis-cleanup-fix',
  description: '修复 Redis 清退残留的 30 个编译错误',
  phases: [
    { title: '修复编译错误', detail: '清理 hub-backup.ts、cli/commands/hub.ts、assignment-store.ts、worker-store.ts' },
    { title: '验证', detail: 'typecheck + 测试' },
  ],
};

phase('修复编译错误')

// 1. 修复 assignment-store.ts 和 worker-store.ts 的 import 残留
const fixStoreImports = await agent(
  `修复 /Volumes/ORICO/flow 中的 import 残留：

1. shared/orchestrator/assignment-store.ts - 移除对 hub-state-redis.js 的 import
2. shared/orchestrator/worker-store.ts - 移除对 hub-state-redis.js 的 import

这两个文件的 Redis 后端分支已经在之前的 workflow 中分析过，现在需要：
- 移除 import 语句
- 移除任何对 openPinnedHubRedisStateBackend、HubRedisStateBackend 的使用
- 移除 _backend() 方法和 _redisBackend 字段
- 移除所有 if (backend) { ... Redis path ... } 分支，只保留 local 路径
- 移除 Redis 相关的 helper 方法
- 简化类型定义，移除 "redis" 变体

注意：assignment-store.ts 有 97389 行，worker-store.ts 有 99273 行，需要仔细处理。

运行 npm run typecheck 验证修复。

输出：修改的关键代码段和 typecheck 结果`,
  { label: 'fix-store-imports', phase: '修复编译错误', model: 'opus' }
)

// 2. 修复 cli/commands/hub.ts
const fixCliHub = await agent(
  `修复 /Volumes/ORICO/flow/cli/commands/hub.ts：

当前有 9 个编译错误，因为引用了已删除的模块：
- hub-redis-migration.js
- hub-redis-retention.js
- hub-state-redis.js
- hub-access-audit-redis-export.js

需要：
1. 删除 migrate-to-redis 命令分支
2. 删除 recover-redis-migration 命令分支
3. 删除 redis-retention 命令分支
4. 移除对 verifyRedisHubAccessAudit 的引用
5. 移除对 openHubRedisStateBackend 的引用
6. 清理相关的环境变量检查

运行 npm run typecheck 验证修复。

输出：删除/修改的代码段`,
  { label: 'fix-cli-hub', phase: '修复编译错误', model: 'sonnet' }
)

// 3. 修复 hub-backup.ts（重灾区）
const fixHubBackup = await agent(
  `修复 /Volumes/ORICO/flow/server/services/hub/hub-backup.ts：

这是重灾区，有 261 个 Redis 引用和 18 个编译错误。

需要移除的类型和函数：
- HubRedisStateBackend
- RedisLogicalSnapshot
- HubBackupRedisSnapshot
- openPinnedHubRedisStateBackend
- RedisRestoreCommitEvidence
- 所有 Redis 相关的备份/恢复逻辑

策略：
1. 先读取文件，理解整体结构
2. 识别所有 Redis 相关的代码块
3. 移除 Redis 备份/恢复逻辑，只保留本地文件系统备份
4. 简化类型定义
5. 移除 Redis 相关的函数和方法

注意：这个文件处理 hub 备份/恢复，需要保留本地文件系统的备份功能。

运行 npm run typecheck 验证修复。

输出：修改的关键代码段`,
  { label: 'fix-hub-backup', phase: '修复编译错误', model: 'opus' }
)

// 4. 清理其他零散文件
const fixOtherFiles = await agent(
  `清理 /Volumes/ORICO/flow 中的其他 Redis 残留：

1. server/services/event/event-types.ts - 移除 "redis" 类型变体
2. core/workflow/probe-runner.ts - 移除注释/字符串中的 Redis 引用
3. shared/types/leader-fence.ts - 检查是否有 Redis 引用
4. scripts/verify-enterprise-gate.ts - 移除 Redis 引用
5. scripts/verify-stabilization.ts - 移除 Redis 引用
6. scripts/run-node-tests.ts - 移除 Redis 引用

运行 npm run typecheck 验证修复。

输出：每个文件的修改`,
  { label: 'fix-other-files', phase: '修复编译错误', model: 'sonnet' }
)

phase('验证')

const verification = await agent(
  `验证 /Volumes/ORICO/flow 的 Redis 清退完成：

1. 类型检查：
   - npm run typecheck

2. 代码检查：
   - grep -r "redis\\|Redis" --include="*.ts" | wc -l（应该接近 0）
   - grep -r "hub-state-redis\\|hub-redis-migration\\|hub-redis-retention" --include="*.ts" | wc -l（应该为 0）

3. 测试：
   - npm test

4. 功能验证：
   - cpb hub status

输出：每个验证的结果`,
  { label: 'verification', phase: '验证', model: 'sonnet' }
)
