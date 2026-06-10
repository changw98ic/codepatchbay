# DW 对抗性代码审计报告

## 审计范围
13 个文件

## 发现的问题

### 1. [CRITICAL] run-job.js:20 + run-job.js:1235 — completion gate 被导入但从未执行

**问题**: `evaluateCompletionGate`、`parseVerdict`、`completionGateEvent` 从 `completion-gate.js` 导入（第 20 行），但在整个 `runJob()` 函数中从未被调用。第 1235 行直接调用 `completeJob(cpbRoot, project, jobId)` 而不经过任何 gate 评估。这意味着 completion gate 系统完全是一个死代码路径 — 任何 job（包括 mutating durable job）都可以直接到达 `completed` 状态，只要所有 phase 通过，无需通过 verification gate。

这是整个 DW Strict Completion 的核心安全机制。没有这层 gate，以下保护全部失效：
- mutating job 必须有 verify phase
- verify 必须实际运行并完成
- verdict artifact 必须可解析
- verdict 状态必须是 PASS
- adversarial verify 在 risk map 要求时必须通过

**修复建议**: 在 `runJob()` 中 phase 循环完成后、调用 `completeJob()` 之前，插入 completion gate 评估：

```js
// 5. Evaluate completion gates before completing
const gateResult = evaluateCompletionGate({
  job: { ...job, workflow, planMode, completedPhases: phases.filter((p) => /* passed */) },
  workflowDag,
  riskMap,
  dynamicAgentPlan,
  parsedVerdict: /* extract from verify artifact */,
  parsedAdversarialVerdict: /* extract from adversarial artifact */,
});

await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, gateResult));

if (gateResult.outcome !== "complete") {
  await failJob(cpbRoot, project, jobId, {
    reason: gateResult.reason,
    code: "completion_gate_failed",
    phase: "completion_gate",
    cause: gateResult,
  });
  return { status: "failed", jobId, exitCode: 1, failure: { kind: "completion_gate_failed", ... } };
}
```

### 2. [CRITICAL] workflow-runner.js:9 vs phase-policy.js:15 — light planMode 对 verify 的处理矛盾

**问题**: `workflow-runner.js` 的 `phasesForPlanMode` 在 `light` 模式下移除 `plan` 和 `review`（第 16 行），保留 `verify`。但实际代码在第 9 行是：
```js
return phases.filter((phase) => phase !== "review" && phase !== "verify");
```
这会在 `light` 模式下移除 `verify` phase。`run-job.js` 第 376 行调用的是 `resolvePhases`（来自 `workflow-runner.js`），所以 light 模式的 job 会跳过 verify。

同时，`completion-gate.js` 的 `isMutatingJob` 在 `light` 模式下返回 `true`（因为 `light` 不在 `parent`/`none` 豁免列表中），所以 gate 会要求 verify 存在。但由于 workflow-runner 在 light 模式下移除了 verify，gate 必然失败。

这两个模块对 `light` 的语义定义互相矛盾：
- `workflow-runner.js`: light = 全流程减去 plan、review、**verify**
- `phase-policy.js`: light = 全流程减去 plan、review（保留 verify）

**修复建议**: `workflow-runner.js:9` 应改为与 `phase-policy.js:15` 一致：
```js
return { phases: phases.filter((p) => p !== "plan" && p !== "review") };
```

### 3. [HIGH] phase-policy.js:61-72 + dag-builder.js:111-121 — 验证函数从未被任何代码调用

**问题**: `validatePhasePolicy()`（phase-policy.js:61）和 `validateDagForMutatingJob()`（dag-builder.js:111）都是 exported 函数，但在整个代码库中没有任何文件导入或调用它们（通过全局搜索确认）。`dw-status.js` 只检查 `resolveSemanticPhases` 是否 exported，不检查 `validatePhasePolicy`。

这意味着即使 light 模式的 phase 列表缺少 verify phase，也没有任何运行时检查会拒绝该 DAG。

**修复建议**: 在 `runJob()` 中 DAG 构建后、phase 执行前，调用这些验证函数。若验证失败应 block job 而非静默继续。

### 4. [HIGH] phase-policy.js — 死代码模块：没有任何运行时消费者

**问题**: `resolveSemanticPhases()` 和 `validatePhasePolicy()` 被 exported 但全代码库中唯一引用 `phase-policy.js` 的地方是 `dw-status.js` 的存活性检查。`run-job.js` 使用的是 `workflow-runner.js` 的 `resolvePhases()`，而非 `phase-policy.js` 的 `resolveSemanticPhases()`。这两个函数对 `light` 模式的处理逻辑不同（见问题 2），说明 `phase-policy.js` 可能是后来为 DW spec 编写但未集成的模块。

**修复建议**: 二选一：(a) 将 `workflow-runner.js` 的 phase 解析替换为 `phase-policy.js` 的版本，统一为一个权威来源；(b) 删除 `phase-policy.js`，将其语义合并回 `workflow-runner.js`。

### 5. [HIGH] run-job.js:1006-1043 — scope guard 仅做日志，不阻断 execution

**问题**: scope guard 在 execute phase 通过后检查文件变更是否在 `fix_scope` 内。但违规时仅记录事件和 progress（第 1033-1043 行），不设置 `result` 为失败。phase 结果保持 passed，job 继续执行并可以 complete。这是一个 advisory-only 的检查，不具约束力。

**修复建议**: 当 `!scopeResult.withinScope` 时，应将 `result` 替换为 `phaseFailed`，携带 `FailureKind.VERIFICATION_FAILED` 和 scope 违规详情，使该 phase 进入 retry 或 fail 路径。

### 6. [HIGH] run-job.js:1008-1009 — fix_scope 数据源不可达

**问题**: scope guard 查找 `fix_scope` 的路径是：
```js
phaseSourceContext?.retryContext?.fix_scope
|| phaseSourceContext?.retry?.fix_scope
```
但 `retryContext` 从未被任何代码写入 `phaseSourceContext`。`retry` 对象在 feedback retry 中被构造（第 949-953 行）时只包含 `failureKind`、`failureReason`、`previousOutput`、`attempt` 四个字段，不包含 `fix_scope`。

`fix_scope` 唯一的来源是 `adversarial_verify.js:119` 的 failure cause：
```js
fix_scope: verdict.fix_scope || verdict.fixScope || null
```
但这个 `fix_scope` 存在于 `result.failure.cause` 中，没有被提取到 `phaseSourceContext.retryContext` 或 `phaseSourceContext.retry` 中。数据流断裂。

**修复建议**: 在 adversarial_verify phase 失败后的 retry 路径中，从 failure cause 提取 `fix_scope` 写入 `phaseSourceContext.retryContext`。或在 scope guard 评估前从 `previousResults` 中 adversarial_verify 的 failure cause 提取。

### 7. [MEDIUM] completion-gate.js:9 — VERDICT_RE 只检查前 10 行，renderVerdictMarkdown 在第 3 行输出

**问题**: `parseVerdict` 只检查 `verdictText` 的前 10 行（第 20 行：`.slice(0, 10)`）。`renderVerdictMarkdown` 和 `renderAdversarialVerdictMarkdown` 都在第 3 行输出 `VERDICT:` 行。当前实现恰好兼容，但如果未来渲染函数在头部增加更多行（如增加 metadata header），可能超过 10 行窗口。

此外，`parseVerdict` 将 `PARTIAL` 映射为 `status: "fail"`（第 26 行），这在语义上可能令人困惑 — PARTIAL 不是 FAIL，但 gate 会将其视为失败。

**修复建议**: 当前实现可接受。建议添加注释标记 `renderVerdictMarkdown` 的 `VERDICT:` 行位置约定，或将窗口扩大到 20 行作为安全余量。

### 8. [MEDIUM] completion-gate.js:41-49 — isMutatingJob 不覆盖所有非 mutating 场景

**问题**: `isMutatingJob` 仅豁免 `parent`、`none`、`docs`、`readonly` workflow/planMode。如果有新的非 mutating workflow（如 `analysis`、`audit`、`research`）被添加，它们会被错误地标记为 mutating，要求通过 verify gate。返回 `true` 是 fail-closed（安全方向），但可能导致合法的只读 job 被阻塞。

**修复建议**: 考虑使用白名单（明确列出 mutating workflows）替代黑名单，或在 workflow 定义中添加 `mutating: boolean` 字段。

### 9. [MEDIUM] dw-acceptance.js:65-79 — checkDagNodesRan 依赖 job.workflowDag，但 job record 可能不存储 DAG

**问题**: `checkDagNodesRan` 从 `job?.workflowDag?.nodes` 读取 DAG phases（第 65-66 行）。但 `dw-acceptance.js` 的 `evaluateDwAcceptance` 接收的 `job` 参数是调用方传入的 job record，不一定是 `materializeJob` 的完整状态。如果传入的是原始 job record（来自 `createJob`），其上不会有 `workflowDag` 属性。DAG 只在 `workflow_dag_materialized` 事件后才通过 `materializeJob` 可用。

**修复建议**: 文档明确 `evaluateDwAcceptance` 的 `job` 参数必须是 `materializeJob` 的完整输出。或改为接收独立的 `workflowDag` 参数（已有此参数但 `checkDagNodesRan` 没用它）。

### 10. [MEDIUM] review-bundle.js:8 — parseVerdictEnvelope 导入自 core/workflow/verdict.js，与 completion-gate.js 的 parseVerdict 独立

**问题**: `review-bundle.js` 使用 `parseVerdictEnvelope`（从 `core/workflow/verdict.js`），`completion-gate.js` 使用自己的 `parseVerdict`。这两个函数做类似的事但实现不同。如果 `parseVerdictEnvelope` 的解析逻辑与 `parseVerdict` 不一致，review bundle 中显示的 verdict 状态可能与 completion gate 判断的状态不同。

**修复建议**: 统一为一个 verdict 解析函数，或明确文档说明两者的用途差异。

### 11. [MEDIUM] verify.js:411-428 — renderVerdictMarkdown 输出 verdict.status 的 UPPER，但 status 可能已是 lowercase

**问题**: `parseVerifierJson` 返回 `status: verdict`（即 "pass"/"fail"/"partial"，已经是 lowercase）。`renderVerdictMarkdown` 做了 `.toUpperCase()` 转换为 "PASS"/"FAIL"/"PARTIAL"。`parseVerdict` 的正则 `/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i` 用了 `i` flag 所以兼容。这个链路是正确的。

但 `verdict.reason` 和 `verdict.details` 可能为空字符串（来自 `result.data.reason || ""`）。markdown 渲染会显示空行或 "N/A"，不影响功能但影响可读性。

**修复建议**: 低优先级，当前行为可接受。

### 12. [LOW] dag-builder.js:21-76 — buildWorkflowDag 对重复 phase 的处理

**问题**: 当同一个 phase 出现多次时（理论上不应该，但如果 workflow 定义有误），`phaseBudget` 机制会为第二次出现创建新节点，id 附加 `_2` 后缀。但 `dagNodeCursorByPhase` 在 `run-job.js:384-478` 中按 phase 做 cursor 跟踪。如果 DAG 构建产生两个 verify 节点，run-job 会正确地按序消费它们，但 completion gate 只检查 `dagPhases.has("verify")`，不会检查是否所有 verify 节点都完成。

**修复建议**: 极端边界情况，低优先级。可在 completion gate 中增加对重复 phase 节点的检查。

### 13. [LOW] dw-status.js:121 — 冗余布尔操作

**问题**: 第 121 行：
```js
const dynamicPlanOk = dynamicAgentPlan.ok && dynamicAgentPlan.ok;
```
`&&` 自身是 idempotent 的，`x && x` 等价于 `x`。这是无意义的重复。

**修复建议**: 改为 `const dynamicPlanOk = dynamicAgentPlan.ok;`

## 已确认正确的关键路径

- **VERDICT 格式兼容性**: `renderVerdictMarkdown` 和 `renderAdversarialVerdictMarkdown` 都在第 3 行输出 `VERDICT: <STATUS>` 格式，`parseVerdict` 的正则 `/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i` 配合 `.slice(0, 10)` 可以正确匹配。status 从 lowercase 到 UPPERCASE 的转换链路一致。
- **adversarial_verify 插入**: `dag-builder.js` 的 `insertAdversarialVerify` 在 `verify` 之后正确插入 `adversarial_verify`，且仅当 `riskMap.adversarialRequired === true` 且 phase 列表中尚不存在时才插入（幂等）。
- **dynamic agent plan 生成与验证**: `generateDynamicAgentPlan` 在 high/critical risk 时正确标记 `verifier` 和 `adversarial_verifier` 为 required + independent。`validateDynamicAgentPlan` 在 run-job.js 第 430-461 行被正确调用，验证失败会 block job。
- **event-store materializeJob**: `completion_gate_evaluated` 在 `POST_TERMINAL_ALLOWED` 集合中（第 357 行），允许在 terminal job 上追加 gate 事件。
- **dw-acceptance 多维度检查**: 11 个 DoD 问题覆盖了 codegraph readiness、risk map、DAG nodes、agent plan、verify pass、adversarial pass、retry scope、benchmark、workflow enforcement。
- **scope-guard 模式匹配**: glob match 支持精确匹配、目录前缀匹配、`*`/`**` 通配符。正则转义覆盖了特殊字符。
- **event log terminal seal**: `appendEvent` 检查 job 是否已 terminal，拒绝非 `POST_TERMINAL_ALLOWED` 类型的事件追加，防止状态篡改。

## 总结

13 个问题：
- 2 个 CRITICAL（completion gate 未接入运行时、light 模式语义矛盾）
- 4 个 HIGH（验证函数从未调用、phase-policy 死代码模块、scope guard 不阻断、fix_scope 数据流断裂）
- 5 个 MEDIUM（VERDICT 窗口偏紧、isMutatingJob 覆盖不足、dw-acceptance job 参数假设、双 verdict 解析器、render 边界）
- 2 个 LOW（重复 phase DAG 节点、冗余布尔操作）
