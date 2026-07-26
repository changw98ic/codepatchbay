export const meta = {
  name: 'fix-test-redis-refs',
  description: '修复测试文件中残留的 19 个 Redis 编译错误',
  phases: [
    { title: '修复测试文件', detail: '清理 8 个测试文件中的 Redis hooks/types 引用' },
    { title: '验证', detail: 'typecheck + 测试' },
  ],
};

phase('修复测试文件')

// 修复所有测试文件中的 Redis 残留引用
const fixTestFiles = await agent(
  `修复 /Volumes/ORICO/flow 中 8 个测试文件的 Redis 残留引用：

错误列表：
1. tests/bridge-teardown.test.ts (2 errors) - 引用已删除的 bridges/project-worker.js 和 run-pipeline.js
2. tests/event-store-durability.test.ts (2 errors) - 引用不存在的 'openRedisEventBackend'
3. tests/event-stream-identity.test.ts (2 errors) - 同上
4. tests/hub-registry-receipt.test.ts (2 errors) - 引用不存在的 'registryBackend'
5. tests/integration/verifier-independence.test.ts (1 error) - 引用已删除的 bridges/run-pipeline.js
6. tests/lease-lock-incarnation.test.ts (8 errors) - 引用不存在的 'redisLeaseBackend'
7. tests/pipeline-wire-contract.test.ts (1 error) - 引用已删除的 bridges/run-pipeline.js
8. tests/worker-store-lifecycle.test.ts (1 error) - 引用不存在的 '_redisBackend'

策略：
- 对于引用已删除模块的测试（bridge-teardown、verifier-independence、pipeline-wire-contract）：删除整个测试文件
- 对于引用不存在 hooks 的测试：移除相关 test blocks 或 test hooks 配置

运行 npm run typecheck 验证修复。

输出：修改的文件和 typecheck 结果`,
  { label: 'fix-test-files', phase: '修复测试文件', model: 'sonnet' }
)

phase('验证')

const verification = await agent(
  `验证 /Volumes/ORICO/flow 的 Redis 清退完成：

1. 类型检查：
   - npm run typecheck（应该 0 错误）

2. 代码检查：
   - grep -r "redis\\|Redis" --include="*.ts" tests/ | wc -l

3. 测试：
   - npm test

输出：验证结果`,
  { label: 'verification', phase: '验证', model: 'sonnet' }
)
