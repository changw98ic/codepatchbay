export const meta = {
  name: 'fix-preexisting-test-failures',
  description: '修复 5 个预存集成测试失败',
  phases: [
    { title: '修复进程身份捕获', detail: '修复 macOS 短命进程 identity 捕获失败' },
    { title: '修复 finalizer fixture', detail: '修复 finalizeResult 缺少顶层 commit/tree 字段' },
    { title: '验证', detail: '运行所有失败测试' },
  ],
};

phase('修复进程身份捕获')

// 1. 修复 captureSpawnProcessIdentity 对短命进程的处理
const fixProcessIdentity = await agent(
  `修复 /Volumes/ORICO/flow/shared/primitives/process-tree.ts 中的进程身份捕获问题。

问题：macOS 上 captureDarwinProcPidInfoIdentity 对短命进程（如 \`node -e "process.stdout.write('ok')"\` 或 \`#!/bin/bash\\nexit 0\`）失败。进程在身份捕获完成前退出，captureSpawnProcessIdentity 重试 3 次后返回 null。

当前行为（process-tree.ts:111-132）：
- captureSpawnProcessIdentity 在 child.exitCode !== null 时直接返回 null
- 调用方 captureSpawnedProcessIdentity 在 strict: true 时抛出 PROCESS_IDENTITY_UNAVAILABLE

commit ae082012 修复了 teardown 路径（isProcessIdentityAlive、waitForVerifiedCleanup、killTree 容忍 identity 不可用），但未修复 spawn 路径。

修复方案：
1. 在 captureSpawnProcessIdentity 中，当子进程已退出但 identity 未捕获时，使用 fallback identity（基于 pid + exit 时间戳）
2. 或者在 captureSpawnedProcessIdentity 中，当 identity 捕获失败且子进程已退出时，使用退化的 "exited" identity 而不是抛错
3. 确保 strict 模式下，对于已退出的短命进程，使用 pid-only identity（birthIdPrecision: "coarse"）而不是失败

参考 ae082012 commit 的 teardown 修复模式。

运行测试验证：
- node dist-tests/scripts/run-node-tests.js tests/integration/acp-test-agent.test.ts 2>&1 | grep "✖ ACP terminal"

输出：修改的代码和测试结果`,
  { label: 'fix-process-identity', phase: '修复进程身份捕获', model: 'opus' }
)

phase('修复 finalizer fixture')

// 2. 修复 managed-worker 测试的 finalizeResult fixture
const fixFinalizerFixture = await agent(
  `修复 /Volumes/ORICO/flow/tests/integration/managed-worker.test.ts 中的 finalizeResult fixture。

问题：verifyFinalizerCandidateCommit (finalizer-candidate.ts:123) 期望 finalizeResult 顶层有 commit 和 tree 字段，但测试 fixture (managed-worker.test.ts:164-195) 的 finalizeResult 将这些信息放在了 remoteIntent 子对象中。

当前 fixture 结构：
\`\`\`typescript
finalizeResult: {
  ok: false,
  status: "blocked",
  mode: "remote",
  jobId: "job-finalizer-a2",
  committed: false,
  remoteIntent,  // commit/tree 在这里
  reconciliation: {...},
  safeContinuation: {...},
}
\`\`\`

需要添加顶层 commit 和 tree 字段：
\`\`\`typescript
finalizeResult: {
  ...当前字段,
  commit: candidateHead,  // 添加
  tree: candidateTree,    // 添加
}
\`\`\`

运行测试验证：
- node dist-tests/scripts/run-node-tests.js tests/integration/managed-worker.test.ts 2>&1 | grep "✖ managed worker"

输出：修改的代码和测试结果`,
  { label: 'fix-finalizer-fixture', phase: '修复 finalizer fixture', model: 'sonnet' }
)

phase('验证')

const verification = await agent(
  `验证 /Volumes/ORICO/flow 的所有修复：

运行以下测试：

1. node dist-tests/scripts/run-node-tests.js tests/integration/acp-test-agent.test.ts 2>&1 | grep -E "^(✔|✖|ℹ)" | tail -10
2. node dist-tests/scripts/run-node-tests.js tests/integration/managed-worker.test.ts 2>&1 | grep -E "^(✔|✖|ℹ)" | tail -10
3. node dist-tests/scripts/run-node-tests.js tests/integration/phase-runner-authority.test.ts 2>&1 | grep -E "^(✔|✖|ℹ)" | tail -10

输出：每个测试的结果`,
  { label: 'verification', phase: '验证', model: 'sonnet' }
)
