# Spec: 严格 Probe Runner — 让默认 checklist 自动构造可在 production 闭环

## 状态：部分实现（仅 diff-scope static probe 脚手架；production 闭环未达成）

> 已落地的脚手架（`core/workflow/probe-runner.ts`，`1a2af926`）：为 static
> checklist item 产确定性 observation（`queryId`=`static-diff-scope:<id>` +
> `matchCount` = 声明文件被改的命中计数），接入 `core/phases/verify.ts` 的
> evidence-ledger。probe-runner 已 stamp attemptId；static validator 已加严
> （`matchCount>0` 才 satisfied）。`tests/probe-runner.test.ts` 覆盖确定性逻辑。
>
> **本 spec 的核心目标尚未实现**——下面 6 层依赖链只完成了第 4–5 层的
> diff-scope 脚手架，关键的顶层和底层都没做：
>   - ❌ **LLM 分解 task 成带 allowedFiles 的结构化 item**（第 6 层，关键前提）。
>     `buildAcceptanceChecklist` 当前产 `allowedFiles: []`
>     (`acceptance-checklist.ts:236`)，无 LLM 分解 → 自动构造的 item 对 probe
>     runner 全是 `matchCount=0`。
>   - ❌ **static method 的语义严格证明**（codegraph 符号查询 / AST 模式匹配）。
>     当前 probe 是 `git diff` 文件名集合匹配（`static-diff-scope`），属粗粒度
>     「声明的文件确实被改」，非语义「改动满足 predicate」。
>   - ❌ **非 static method 的探针**（command/test/runtime_event/artifact_event/...）。
>     probe-runner 只 filter `static`，其余全跳过 (`probe-runner.ts:71`)。
>
> 后果：fail-closed 行为本身正确（`matchCount=0` 诚实失败），但默认启用的
> prepare 自动构造在真实 mutating job 上仍会在 completion-gate 卡
> `evidence_mismatch` —— **production 闭环尚未达成**。要闭环必须先做 LLM 分解。

## 顶层决策（已定）

- 默认启用 checklist 自动构造（不退回 opt-in）
- 证据来源：LLM 分解 checklist（构造智能）+ 确定性 probe runner（验证确定）
- 不做 grep expectedEvidence 弱证明；不做 hard gate 替换

## 完整依赖链（6 层，不可分割）

```
默认启用 checklist 自动构造
  └─ completion-gate 放行（evidence_mismatch 不再阻断）
      └─ evidence-ledger 有 result:"pass" 的 EV
          └─ probe observation 含 queryId+matchCount（validateStaticObservation）
              └─ probe runner 产合法 observation
                  └─ item 有可判定结构化断言（allowedFiles 非空 + 明确 predicate）
                      └─ LLM 分解 task 成结构化 item
```

**关键洞察**：LLM 分解（顶层）与 probe runner（底层）必须一起做。
probe runner 的严格性依赖 item 有 allowedFiles；allowedFiles 来自 LLM 分解。
分阶段做（先 probe runner 后 LLM 分解）不可行——probe runner 对空 allowedFiles
无从严格判定。

## 硬矛盾（已解决）

自动构造的自由文本 item（`requirement`=整段 task, `allowedFiles=[]`）无法被
确定性静态探针严格证明 → 必须由 LLM 在构造时分解成结构化、可判定的 item。
代价：checklist 构造失去「纯确定性」（用 LLM），但验证保持确定性。


## 背景：为什么需要这个

「checklist-first 验证」是 CodePatchbay 的核心不变量。2026-06-12 的 plan
(`docs/superpowers/plans/2026-06-12-checklist-first-task-verification.md`) 实现了
checklist 构造/冻结/事件索引/verify 契约，但**机制在生产路径上不可达**——
prepare 不自动构造 checklist。

2026-06-14 尝试「prepare 默认自动构造 checklist」(`8f788209`)，追到底后发现一个
**根本阻断**：默认启用会让所有真实 mutating job 在 completion-gate 卡
`evidence_mismatch`。这不是 bug，是证据模型的缺口。

## 根因（逐行核实）

默认构造 + 真实证据模型不兼容：

1. `buildAcceptanceChecklist` 自动构造的 item = `verificationMethod:"static"`，
   无 queryId/matchCount (`acceptance-checklist.ts:233`)
2. `buildEvidenceProbePlan` 从 item 生成 probe，observation 不含
   queryId/matchCount (`evidence-probes.ts:185-191`)
3. 真实 hard gate 产出 `{gate,file,ok}`，**无 checklistId** (`verify.ts:111`)
   → `buildEvidenceProbePlan:207` 跳过，不 upgrade probe
4. `buildEvidenceLedger` 对 probe observation 调 `validateStaticObservation` →
   无 queryId/matchCount → false → EV-001 `result:"fail"` (`verify.ts:209`)
5. verifier checklistVerdict 引用 EV-001 说 AC-001 pass →
   `evidenceMatchesChecklistItem` 因 result≠pass 返回 false →
   **evidence_mismatch** (`acceptance-checklist.ts:467-468`)
6. completion-gate 返回 `evidence_mismatch` → job **failed**

**佐证**：`checklist-verifier-gate.test.ts:289-295` 注释明确：「真实 hard gate
checks 无 checklistId，不能 prove checklist item」。该套件的 pass 测试不断言
`result.status==="completed"`，只验证 verify phase artifact 形状。

## 缺的是什么：严格 Probe Runner

verify phase 需要为每个 checklist item（按 verificationMethod）执行**确定性、
语义有效**的探针，产出合法 observation（queryId+matchCount 等），upgrade 到
evidence probe，让 EV result:"pass"，completion-gate 才能放行。

### 设计约束（用户明确要求）

- ✅ **确定性静态探针**：可重放，不依赖 agent 合规产出
- ✅ **严格 probe runner**：独立的探针执行子系统，**不是 hard gate 替换**
- ✅ **不是弱证明**：禁止 `grep expectedEvidence` 这种关键词匹配
- ❌ 不是 hard gate 替换（hard gate 保留，做语法/测试门）
- ❌ 不是 agent 产 observation（agent 不可靠）

### 待设计的问题（spec 阶段需回答）

1. **static method 的严格证明语义**：什么查询能证明一个 static checklist item
   被满足？（候选：codegraph 符号查询、AST 模式匹配、diff 语义分析）——grep
   关键词被否决，需定义真正的语义查询
2. **probe runner 接口**：输入（checklist item + cwd + verificationMethod）、
   输出（observation：queryId+matchCount+method 字段）、与
   `buildEvidenceProbePlan` 的集成点
3. **各 verificationMethod 的探针定义**：static/command/test/runtime_event/
   artifact_event/... 每种的严格探针长什么样
4. **queryId 命名空间**：确定性、可审计、防伪造
5. **失败语义**：探针查不到证据 → EV result:"fail" → completion-gate
   evidence_mismatch（fail-closed，正确）；探针执行异常 → ？

### 改动面预估

- 新增 `core/workflow/probe-runner.ts`（或类似）：探针执行子系统
- `core/phases/verify.ts`：在 `buildEvidenceProbePlan` 前注入 probe runner
  产出的 observations（取代/补充 hard gate checks 的 upgrade 路径）
- 可能涉及 `evidence-probes.ts`：probe observation 的来源从「hard gate checks」
  扩展到「probe runner + hard gate checks」
- 测试：通用 fake 测试需注入 probe runner mock（产合法 static observation）

## 与已撤销改动 (`8f788209`) 的关系

`8f788209` 的三部分处置：
- **prepare 自动构造**：方向正确，但**依赖 probe runner 才能在 production 闭环**。
  本 spec 实现后才能默认启用
- **verify.ts fail 修复**（checklistVerdict.status=fail → VERIFICATION_FAILED）：
  独立正确，可单独保留
- **fail-closed（裸 runJob 无 getArtifactIndex → block）**：方向正确，但与默认
  启用绑定，应与 probe runner 一起落地

## 建议执行顺序

1. 本 spec 审核 → 定义 static method 的严格证明语义（最关键的设计决策）
2. 实现 probe runner + verify phase 集成
3. 默认启用 prepare 自动构造 + fail-closed（此时 production 能闭环）
4. 通用测试 fake 注入 probe runner mock

## 关键文件

- `core/phases/verify.ts` — verify phase（hard gate / evidence ledger / probe plan）
- `core/workflow/evidence-probes.ts` — `buildEvidenceProbePlan` /
  `validateEvidenceObservation` / `validateStaticObservation`
- `core/workflow/acceptance-checklist.ts` — `buildAcceptanceChecklist` /
  `evaluateChecklistCompletion` / `evidenceMatchesChecklistItem`
- `core/engine/run-job.ts` — `freezeChecklistAndMaterializeDag` / completion-gate 调用
- `core/workflow/probe-runner.ts` — **已实现**（`1a2af926`），确定性 static probe

## 端到端验证踩过的 infra 门（真实 ACP 环境）

裸 `runJob` / `runJobWithServices` 跑真实 codex 时，prepare 之前的前置门
依次挡路（与 checklist 代码无关）：

1. **codegraph 索引**（`checkCodeGraphReady`）：项目要有 `.codegraph/codegraph.db`
2. **Project Capability Map**（`requireCapabilityMap`）：`project.json` 要有
   `projectCapabilityMap` 且 `confidence === "high"`。flow 项目当前缺这个
   （只有 concurrency + agents），用 `runJobWithServices` 跑会被这扇门 block
3. **agent HOME 隔离**（`isolation.ts:resolveAgentHomeRoot`）：spawn 子进程需要
   `CPB_PROJECT_RUNTIME_ROOT`，`runJobWithServices` 自动设；裸 `runJob` 要手传
4. **hub daemon**：`cpb pipeline` 异步入队，要 hub worker 消费；`cpb hub start`
   的 CLI 路由把 `hub` 误当 project（`cli/cpb.ts:164` PROJECT_COMMANDS 含 "hub"）

**已验证可行的端到端驱动方式**：`buildServices` 拿真实 pool + production spawn env，
stub `prepareTask` 绕过 codegraph/capability 门，直接 `runJob`。真实 codex 可用
（gpt-5.5，`agents test` 报 degraded 是 `codex auth status` 子命令过时的误报）。

