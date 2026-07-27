# CPB 产品入口与执行内核可行性计划 — 2026-07-27

> 状态：部分实施；工程验收通过；发布验收阻塞（2026-07-27）。
>
> 本计划针对两个已确认的问题：普通用户无法从产品入口理解 CPB；执行内核已经架构正确但维护复杂度过高。计划经过 10 轮独立方案审查和 10 轮独立计划审查后修订。当前分支已经落地产品薄入口、TaskView、幂等契约和部分执行链 seam，但尚未满足 live release evidence、运行态和跨项目隔离的发布条件。

## 一、结论

方向可行，但不能把产品入口、Hub 自动启动、TaskView、RunJobContext、DAG 执行器和 worker 恢复模型放进一次大重构。

建议分成两条可独立发布的路线：

1. 先增加面向普通用户的薄入口，复用现有 queue、worker、job、event、completion gate 和 finalizer。
2. 产品入口稳定后，再以 characterization test 和 golden trace 保护为前提，拆分核心执行链。

全程冻结以下范围：

- 不新增 Provider 类型；
- 不新增 Agent 类型；
- 不新增 workflow 类别；
- 不建设通用调度器；
- 不替换现有 queue、assignment、job、attempt 身份模型；
- 不改变原始事件和 SSE 契约；
- 不默认执行 live PR 或其他外部副作用。

## 二、当前事实与约束

当前 CLI 已有 `run`、`pipeline`、`hub`、`status` 等内部导向命令，但没有面向普通用户的“帮我修这个问题”入口。

现有执行路径已经包含：

```text
queue
→ assignment / attempt
→ managed worker
→ RunJob
→ workflow DAG
→ verification / completion gate
→ finalizer / terminal result
```

当前主要维护风险集中在：

- `runDagNode` 同时承担路由、预检、执行、fallback、重试、scope guard、结果收敛和失败落盘；
- `RunJobContext` 混合 immutable 配置、动态边界和可变 bookkeeping；
- managed worker 同时处理 claim、lease、worktree、ACP、结果发布和恢复；
- 事件、证据和终态写入顺序构成实际恢复协议。

因此，拆分目标是降低职责耦合，不是改变执行语义或增加调度能力。

## 三、公共产品契约（提案）

### 3.1 用户入口

拟增加：

```text
cpb fix "修复登录后页面空白"
cpb task <task-id>
cpb fix "修复登录后页面空白" --follow
```

其中：

- `fix` 是普通用户入口；
- `task` 是公开的只读任务查询入口；
- `--follow` 是可选的终态跟随模式；
- `run`、`pipeline` 和高级参数继续保留兼容，不改变其现有行为。

`fix` 只做请求解析、readiness、enqueue 和公共结果输出，实际执行仍走现有 pipeline/queue/worker 路径。

### 3.2 TaskView v1

TaskView 是只读投影，不是新的状态存储：

```text
schemaVersion
taskId
state
summary
progress
checks
changedFiles
nextAction
createdAt
updatedAt
```

建议状态：

```text
accepted
queued
running
verifying
succeeded
needs_input
blocked
failed
canceled
```

`needs_setup`、`invalid_request` 和 `runtime_unavailable` 属于提交前失败，不产生任务，不进入 queue。

TaskView 默认不得暴露：

```text
jobId
attemptId
provider
agent
lease
session
PID
prompt
环境变量
绝对运行时路径
```

`taskId` 建议直接使用现有 queue entry id 作为不透明标识，不新建 task→job 双注册表。TaskView 从 queue entry、job/assignment/attempt、事件、completion gate 和 finalizer receipt 派生。

### 3.3 幂等语义

- 保留现有活跃 pending 请求的去重行为；
- 增加可选的 `--idempotency-key`；
- key 的作用域为 project；
- 只对活跃任务去重；
- 终态任务不会永久占用相同 key；
- 对外不写入明文 key，只保留哈希或不可逆引用；
- 幂等冲突和普通重复提交都必须有测试覆盖。

### 3.4 Exit code

实现前冻结稳定 exit-code 表。建议语义如下：

| 模式 | 结果 | 语义 |
|---|---|---|
| 默认 `fix` | 0 | 请求已通过 readiness 并成功进入 queue |
| 默认 `fix` | 非 0 | 请求无效、未初始化或 runtime 不可用 |
| `--follow` | 0 | 任务完成且证据驱动的验证通过 |
| `--follow` | 非 0 | 失败、取消、阻塞、需要输入或超时 |

CLI 默认输出应先给用户可执行的下一步，而不是输出 Hub、Worker、ACP、Provider handoff、Evidence、lease 等内部术语。

## 四、实施阶段

### 阶段 0：契约冻结与基线

目标：在改代码前记录当前行为。

工作项：

1. 冻结 TaskView v1、状态、错误类别、exit code 和幂等语义。
2. 增加 `run/pipeline` 的事件序列 golden trace。
3. 记录 `runDagNode`、DAG 并行 wave、resume/retry 和 worker finalizer 的当前行为。
4. 记录关键模块依赖、状态查询耗时和现有 release gate 结果。
5. 明确哪些字段只能留在 debug/raw stream，哪些字段可进入公共投影。

退出条件：

- 契约测试先失败于缺失实现，而不是测试本身不稳定；
- 旧入口的 trace 可以在重构后逐事件比较；
- 没有把当前未执行的验证写成“已通过”。

### 阶段 1：产品薄入口

建议新增的代码边界：

- `cli/commands/fix.ts`：参数、readiness、enqueue 和用户输出；
- `cli/commands/task.ts`：TaskView 查询；
- `server/services/task/task-view.ts`：只读投影；
- 复用现有 queue、job、assignment、event 和 gate 服务，不复制状态机。

readiness 顺序固定为：

```text
resolve project
→ validate runtime root
→ validate agent executable/config
→ connect to existing Hub or safely start local Hub
→ enqueue
```

任一步失败都不得写 queue。

安全启动 Hub 只允许在以下条件同时满足时发生：

- 当前是明确的本地控制平面；
- 没有远程或不明 Hub 配置；
- 能取得现有 leader/process identity 证明；
- 启动行为不会绕过既有锁、认证或进程边界。

未初始化项目只返回明确的 `cpb init` 下一步，不隐式注册项目。远程或不明控制平面只连接，不自动拉起。

退出条件：

- 陌生用户能用一条 `cpb fix` 命令提交请求；
- readiness 失败不会产生孤儿 queue entry；
- `cpb task` 能在 queue 已创建但 job 尚未出现时显示合理状态；
- 默认输出不需要用户理解内部架构名词；
- 旧 `run/pipeline` 行为无变化。

### 阶段 2：TaskView 与证据驱动结果

TaskView 的状态映射必须来自现有权威数据：

```text
queue entry
→ job / assignment / attempt
→ event projection
→ completion gate
→ finalizer receipt
```

不得把 `job.status=completed` 直接翻译成“已修好”。公共结果至少分开表达：

```text
completed
verified
deliveryReady
```

只有以下条件同时满足时才显示“验证通过”：

- completion gate 为 complete；
- verify verdict 为 PASS；
- candidate identity 校验通过；
- clean replay 通过；
- 没有缺失、过期、污染或不匹配的证据。

默认只展示 dry-run/下一步，不自动执行 live PR 或其他外部副作用。

### 阶段 3：RunJobContext 分域

此阶段只做数据边界拆分，不改变执行流程。

建议分为：

```text
RunJobConfig       immutable 配置
RunJobBookkeeping  job、attempt、current phase 等可变状态
RunJobPorts        外部副作用端口
RunJobContext      兼容 adapter，逐步退场
```

第一步先消除对 `ctx._currentPhase` 等共享可变字段的直接写入，改由 bookkeeping holder 负责；不做一次性全量重命名。

退出条件：

- strict engine typecheck 通过；
- 旧调用方仍可编译；
- event trace 无变化；
- cancellation、resume、retry 和 failure path 无行为差异。

### 阶段 4：DAG 节点执行链拆分

`runDagNode` 暂时保留为 coordinator，按以下顺序提取：

1. node decision：节点身份、resume、路由决策等纯逻辑；
2. node attempt runner：预检、ACP/provider handoff、fallback 和 retry；
3. node outcome finalizer：scope guard、artifact、phase result、事件和失败落盘；
4. 失败处理继续复用现有 terminal/failure helper。

必须保留的执行不变量：

- 当前仅允许安全候选 review 节点并行；
- 尊重 conflict keys；
- stable ready order 不变；
- buffered effects 按既有顺序回放；
- 取消时不提交未完成副作用；
- 失败正确传播到依赖节点；
- resume 节点不能重复执行；
- verification repair loop 行为不变。

此阶段禁止顺便建设新的 scheduler、parallel workflow 或 provider fallback 类型。

### 阶段 5：Worker 生命周期 seam

只提取边界，不重写恢复模型：

- execution lease renewal/loss；
- attempt、worker、inbox identity re-check；
- worktree cleanup/retention proof；
- terminal result 单次发布；
- terminal sync 失败时保留 claim；
- cancellation、lease loss 和进程退出后的恢复。

cleanup proof generator 是现有 evidence contract。第一版保持原字符串不变；若未来必须变更，必须同步更新生成器、验证器、脚本、文档和 fixtures，并提供迁移说明。

## 五、测试与发布门槛

### 5.1 契约测试

新增或补充：

- `fix` 参数、帮助和 exit-code 测试；
- readiness 各失败分支测试；
- “readiness 失败不得 enqueue”测试；
- TaskView queue-only、job-linked、terminal、blocked 投影测试；
- idempotency active reuse 和 terminal re-submit 测试；
- 默认输出字段白名单与敏感字段排除测试；
- `--follow` 超时、SIGINT 和终态退出测试。

### 5.2 执行链回归

- node decision 纯逻辑测试；
- retry/fallback/scope guard 测试；
- DAG stable ready、conflict batch 和 buffered replay 测试；
- cancellation/failure propagation/resume 测试；
- worker lease loss、cleanup proof、单次 result publish 测试；
- 旧 `run/pipeline` golden trace 对比。

### 5.3 真实链路验收

工程测试通过不等于产品验收通过。还需要：

- 隔离 npm pack 和安装后 CLI smoke；
- 至少一条真实端到端修复链路；
- 现有 product-gate 所要求的真实维护者或 benchmark 证据；
- release readiness 报告；
- 无 fake fixture 冒充真实产品证据。

## 六、Go / No-Go 条件

### 产品阶段可以继续的条件

- 陌生用户能从 `cpb fix` 完成提交；
- 未初始化、Hub 不可用、agent 不可用时错误明确且不造任务；
- TaskView 不泄露内部运行时信息；
- 重复提交不会产生错误的永久去重；
- 旧入口和旧事件契约无回归。

### 内核拆分可以继续的条件

- event trace 与基线一致；
- completion gate、证据和 finalizer 语义一致；
- lease、cleanup、attempt ownership 和恢复测试通过；
- strict engine/type-debt/release gates 通过；
- 依赖方向更清晰，而不是新增一层同样复杂的 facade。

任一条件不满足，停止当前拆分并回滚当前独立提交，不继续增加抽象。

## 七、回滚与兼容策略

按以下独立提交实施：

1. 契约和 characterization tests；
2. `fix` facade；
3. TaskView；
4. RunJobContext adapter；
5. node decision/attempt/finalizer extraction；
6. worker lifecycle seam。

每个提交都保留旧模块入口和旧 `run/pipeline` 路径。产品 facade 可以独立回滚，不要求回滚执行内核；执行内核拆分失败时不影响已经发布的 `fix` 入口。

不做 queue schema、job event schema 或 task identity schema 的大迁移。

## 八、10轮审查修订记录

### 方案审查

1. 范围审查：拆成产品薄切片和内核拆分两条发布线。
2. 契约审查：冻结 TaskView v1，避免内部字段透传。
3. readiness 审查：所有检查先于 enqueue，失败不产生孤儿任务。
4. 执行事务审查：保留 `runDagNode` coordinator，分步提取副作用。
5. 并发恢复审查：保持受限并行、取消、恢复和 worker finalizer 不变量。
6. 完成态审查：区分 completed、verified 和 deliveryReady。
7. 测试审查：区分工程回归、隔离安装和真实产品证据。
8. 安全审查：限制 Hub 自动启动、输出字段、follow 超时和幂等 key。
9. 迁移审查：保留旧入口、事件、proof generator 和可回滚提交。
10. 衡量审查：以行为 trace、依赖方向和不变量判断复杂度是否下降。

### 计划审查

计划随后从范围、公共 API、首次运行、执行事务、并发恢复、证据可信度、测试发布、安全隐私、迁移回滚、衡量和停止条件重新审查，所有发现均已回写到上文；实施后的验收结果见下一节。

## 九、实施验收记录 — 2026-07-27

### 9.1 已落地范围

- 本地源码入口已增加 `cpb fix` 和 `cpb task`，并保留 `run`、`pipeline` 等旧入口。
- TaskView 已使用公共字段投影，区分 `completed`、`verified` 和 `deliveryReady`，并覆盖幂等、退出码、敏感字段排除和字符化 trace 测试。
- `RunJobContext` bookkeeping、DAG node coordinator 和 worker assignment failure classification 已形成独立 seam；没有新增 Provider、Agent 或 workflow 类型。
- 本地源码版本为 `0.4.1`，`./cpb fix --help` 与 `./cpb task --help` 可用。

### 9.2 验收证据

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过 | Node 与 tests 类型检查通过 |
| `npm run typecheck:strict:engine` | 通过 | strict engine gate 通过 |
| `npm run typecheck:type-debt:engine` | 通过 | type-debt guard 通过 |
| 产品入口/TaskView/执行链目标测试 | 通过 | 178/178 |
| `npm run test:integration` | 通过 | 173/173 |
| `npm run verify:product-gate` | 通过 | 3 条 dry-run 记录 + 1 个 supplemental official score bundle |
| `npm run test:main` 批量执行 | 有条件通过 | 1397 个 fast、883/887 个 slow 通过；4 个并发资源争用失败，4 个隔离重跑均通过 |
| `npm run verify:release-gate` | 未通过 | patch integrity、live release evidence 未满足；并发批次另有 4 个隔离后通过的争用失败 |

### 9.3 当前发布阻塞项

1. `TaskView` 的项目匹配存在 task id-only fallback：当调用方传入错误的 `--project` 时，可能读到另一项目的同一任务视图。这违反项目边界，必须先删除 fallback 并补跨项目隔离回归测试。
2. 共享 Hub 当前为 `unsafe-state`：leader/process identity 无效；队列有 193 条记录、29 条 pending，且 85 个项目的 index/codegraph 不可用。当前没有 active mutating job，但不能据此宣称运行态健康。本次验收没有对共享运行态执行清理或强制启动。
3. `verify:release-gate` 缺少 `docs/product/cpb-live-release-validation.json`，尚未有可审计的真实端到端 `fix` 链路证据。本次只验证了 dry-run、合同测试和隔离集成测试。
4. 当前 PATH 中的全局 `cpb` 仍是 `0.3.12`，不包含 `fix/task`；只有仓库内 `./cpb` 使用 `0.4.1` 构建产物。需要完成 package 安装/发布后的隔离 smoke，不能把源码入口结果当作已发布 CLI 结果。
5. 计划文件本身仍未纳入 git patch，因而 `verify:patch-integrity` 会失败。提交或发布前必须有意地纳入该文档，或明确将其排除并记录原因。

当前 readiness 实现采取 fail-closed 策略：检查并连接现有 Hub，Hub 不可用时返回 `cpb hub start`，不会自动启动。安全自动启动仍属于后续产品决策，不应在本轮验收中假定已经完成。

### 9.4 验收结论

本分支可以作为“工程实现候选”继续迭代：核心契约、目标回归、集成测试和 product gate 已有证据。当前结论不是发布通过，而是“实现部分通过，发布阻塞”。在完成第 9.3 节的跨项目隔离修复、全局 CLI 安装验证、live evidence、patch integrity 和运行态治理前，不应对外承诺普通用户可以稳定执行真实修复。

## 十、当前状态

- 本文件同时记录可行性计划和 2026-07-27 的实施验收结果；第 9 节的阻塞项未清除前，不代表发布完成。
- 本计划未授权或包含 Provider、Agent、workflow 扩展。
- 真实 live release evidence、package 安装 smoke 和共享运行态修复需要单独完成并重新验收。
