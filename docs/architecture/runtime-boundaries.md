# 运行时边界契约

## 分层

- `core/`：纯策略、解析、状态机与领域契约。不得导入 `server/`、`bridges/`、`cli/` 或 `runtime/`。
- `server/services/`：持久化状态、注册表、HTTP/Hub 编排服务、ACP 池与服务级运行时能力。
- `bridges/`：runtime-facing 跨层装配层，只保留 `engine-bridge.ts` 与 `runtime-services.ts` 这类明确边界入口；不放测试工具、运维 harness 或兼容 re-export。
- `cli/`：命令路由和命令参数/输出适配。命令文件直接调用 canonical `server/services/` 或 `server/orchestrator/` 能力，不再经过已删除的 CLI bridge。
- `runtime/`：长期 worker 与运行时脚本（worker/evolve/git/mcp）。运行时文件使用 canonical `runtime/` 入口，不得导入 `server/`，也不得新增旧路径兼容入口。
- `shared/`：无 HTTP / CLI / runtime 副作用的共享基础设施，例如文件工具、日志、worker store、assignment store。

## 允许方向

- `bridges/` 可以导入 `server/`、`core/`、`runtime/`，但只用于 runtime 边界装配和明确入口。
- `server/` 可以导入 `core/`，不得导入 `runtime/` 实现模块；允许为 child process 启动拼接 canonical runtime 可执行入口。
- `runtime/` 可以导入 `core/`、`shared/`、`bridges/engine-bridge.ts`、`bridges/runtime-services.ts`；不得直接导入 `server/`。
- `cli/` 可以导入 `core/`、`server/services/` 与 `server/orchestrator/`；不得恢复已删除的 CLI bridge，也不得直接拼接 `bridges/` 或 `runtime/` 入口。
- `core/` 可以依赖自身子目录、`shared/` 和标准库/外部包，不得反向穿透其他实现层。
- `shared/` 只能依赖自身子目录和标准库/外部包；不得反向导入 `core/` 或任一实现层。

## 当前已锁定的边界测试

- `tests/core-boundary.test.ts`：禁止 `core/` 导入 `server/`、`runtime/`、`cli/`、`bridges/`。
- `tests/shared-boundary.test.ts`：禁止 `shared/` 反向导入 `core/` 或任一实现层，也禁止动态拼接这些层的路径。
- `tests/server-boundary.test.ts`：禁止 `server/` 导入 `runtime/` 实现。
- `tests/runtime-boundary.test.ts`：禁止 runtime 直接导入 `server/`，并禁止已删除的 runtime ACP / guard / variant 入口和兼容 re-export 壳回归。
- `tests/runtime-boundary.test.ts`：锁定 `bridges/` 精确只包含 runtime 边界适配器，防止工具脚本回流。
- `tests/cli-boundary.test.ts`：禁止 `cli/` 重新导入或动态拼接 `bridges/`、`runtime/`。

## Core 执行端口

- `core/engine/run-job-ports.ts` 是核心 job 状态机所需基础设施能力的契约源。核心只依赖这些端口，不感知端口由本地文件、Redis、worker broker 还是独立进程实现。
- `RunJobContext` 不带开放索引签名；prepare、assurance、checklist、execute、lifecycle helper 只通过 `Pick<RunJobState, ...>` 与 `Pick<RunJobPorts, ...>` 声明实际依赖。新增 helper 依赖必须进入对应 Pick，不能依靠对象扩展字段隐式穿透。
- checklist 分解接收本次 `createJob` 物化的 `jobId`，不得从调用方预填的旧 context 值推断当前 job。
- provider pool/services/usage payload 和 process hook 都由 core-owned contract 定义；provider service callbacks 直接消费这些 payload，而不是回退到 `LooseRecord`。artifact-index 的 broker 传输 envelope 属于 `shared/`，core port 从该共享 DTO 派生自己的能力契约，避免 `shared -> core` 反向依赖。server adapter 实现这些 contract，core helper 不再各自声明宽类型或重复结构。
- `server/services/engine-runner.ts` 是生产端口的 composition root，负责本地/worker broker 选择、project runtime root 约束、provider 服务装配和事件持久化策略。
- `bridges/engine-bridge.ts` 直接指向 `server/services/engine-runner.ts`；runtime worker 只能通过这个 bridge 进入该装配路径，不得自行拼装或直接导入 server 服务。
- setup、provider variant 与 executor-root 能力分别由 `server/services/setup-events.ts`、`server/services/apply-variant.ts`、`server/services/executor-root.ts` 提供；禁止重新建立跨领域聚合服务入口。
- `runJob` 新增副作用前，必须先定义 core-owned port，再在 server composition root 完成装配；不得新增第二套 runtime 装配路径。

## 进程终止与本地锁所有权

- 任何直接 root 终止路径都必须在 `spawn` 后立即捕获 canonical exact `ProcessIdentity`，并在整个生命周期复用该身份。`core/runtime/process-tree.ts#killTree` 对非零 PID 强制要求 `expectedRootIdentity`；缺失、粗粒度、非 canonical、PID 不匹配或 successor identity 都在任何终止信号前失败关闭。descendant 只有在 root incarnation 仍匹配且 PID/PPID membership 再验证后才能派生为终止目标。
- 禁止通过命令行路径、进程名、当前 PID 探测或首次捕获失败后的二次捕获来“重新认领”进程。因而生产脚本不得用 `pkill` / `killall` 补偿未验证清理；ACP residual 与 worker cleanup 只能使用调用方已持有的启动时身份。没有身份的已启动 child 必须留下 `cleanupVerified: false` / recovery evidence，不能假标为已退出。
- 进程树清理必须等待身份绑定的 root/descendant teardown 与 close proof 完成。PID/PGID 只能作为已验证 identity 的寻址字段；单独的数字 PID、路径匹配或 TTL 不构成终止权限。
- 本地 directory lock owner 必须持有 exact `ProcessIdentity` 与随机 owner token。legacy 或缺身份 owner 的普通自动恢复失败关闭，不允许退回 PID-only stale reclaim。owner/metadata 使用 `O_NOFOLLOW`、分块 byte bound 和 pre/fd/post generation 检查；quarantine 恢复使用 `mkdir` reservation 与逐项 no-clobber restore，rename/remove 后必须 fsync 受影响父目录并显式传播 committed durability ambiguity。

## Workflow DAG 执行契约

- `workflow_dag_materialized` 的执行模式是 `bounded_dependency_parallel`。这表示调度器按依赖图推进 ready nodes，并受 `maxConcurrentNodes` 上限约束；不表示所有 phase 都可并发。
- 只有 canonical `review` phase 可进入并发候选集。`plan`、`execute`、`verify`、`adversarial_verify`、custom node、side-effecting node、`parallelSafe: false` node，以及 resume 已完成 node 都必须 exclusive 执行。
- `execute`/remediate 类节点保持 exclusive，因为它们拥有候选 artifact、checklist state 和修复循环。`verify`/`adversarial_verify` 保持 exclusive，因为它们拥有 completion gate、repair retry 和失败归因。
- 并发候选节点的 `conflictKey` / `conflictKeys` 使用稳定前缀串行策略：同一 ready wave 中遇到冲突 key 后，不再启动后续冲突节点；后续 wave 在前置节点提交后再继续。
- 并发节点的 durable effects 必须先缓冲，再按稳定拓扑节点顺序提交。实际 provider 完成顺序不能决定 `dag_node_started` / `dag_node_completed` 的持久化顺序，也不能污染 artifact index。
- 取消和失败必须向未执行或依赖不可满足的下游节点传播为 `dag_node_cancelled`。并发 wave 观察到首个 terminal failure、抛异常或外部 `AbortSignal` 时必须立即封闭各节点 effect buffer、向 sibling 传播取消并返回，不能等待不协作或挂起的 sibling。此时只提交 start-only durable effects，不能把已取消节点的 phase completion 写入 durable 状态。
- 并发 `review` artifact 使用两阶段提交：phase 可在内存中读取预留内容完成 poisoned-session 等校验，但文件仅在整个成功 wave 按稳定拓扑序提交时落地；失败、取消及晚到 sibling 结果必须释放预留，不能留下可索引或孤立的 review 文件。
- provider 容量由两层共同限制：DAG 调度层按 `maxConcurrentNodes` / provider capacity 选择 ready nodes，ACP pool/provider leases 再约束实际 agent 连接数。CLI 或状态面展示 provider limit 时必须读取 pool 的有效 provider limit，而不是只显示默认值。

## Claude CLI phase 权限线

- Claude-compatible agent 的权限线由 `core/agents/agent-runner.ts` 先写入 phase-aware env，再由 `server/services/acp/acp-pool.ts` 翻译成 Claude CLI `--settings`、`--tools`、`--permission-mode dontAsk`、禁用 MCP / slash command 的运行时约束。persistent client key 包含 `launchPermissionLane`，不得复用另一条权限线上的 Claude 进程。
- `plan` 是静态 evidence-only 线。Claude CLI planning 默认只有结构化输出；首轮受限 repository discovery 也只暴露 `Read` / `Glob` / `Grep`，不得使用 `Bash`、编辑工具、Web 工具或 worktree 写入。`core/engine/phase-retry.ts` 对 plan 的 retry 文案也明确禁止测试、`python -c`、heredoc probe 和临时诊断命令。
- `execute` 与 `remediate` 是 mutating 线。`core/agents/agent-runner.ts` 只把 mutating phase 视为可写，并为 Claude-compatible executor 额外加入 `${dataRoot}/phase-io/<phase>/*`，用于写结构化 phase handoff；源码写入仍发生在当前 `executionCwd`。`server/services/acp/acp-pool.ts` 的 native execution settings 暴露 `Read` / `Edit` / `Write` / `Glob` / `Grep`，只在 source boundary sandbox 可用时暴露 `Bash`。
- `verify` 与 `review` 是 validation 线。`verify` 可在 phase-owned output root 写 verdict，`review` 走 replay-style deny list；二者都不得用 direct edit 工具改候选源码。validation 命令的允许范围来自 `server/services/permission-matrix.ts` 的 verifier/reviewer execute policy，禁止破坏性 git、publish/deploy、远程脚本 pipe 等命令。
- disposable verification replay 是独立可写 replay 线。`core/phases/verify.ts` 先通过 `materializeCandidateVerificationReplay` 创建临时 worktree 并把 verifier cwd 切过去，再加入 `CPB_VERIFIER_REPLAY_WORKSPACE_WRITE` / `CPB_CODEX_VERIFIER_WORKSPACE_WRITE`。该线允许测试或构建在 replay worktree 产生输出，但 `Edit` / `Write` / `MultiEdit` 仍被 Claude deny；返回后重新校验 candidate identity，`tests/verification-infrastructure.test.ts` 锁定“构建输出不改变候选、源码 mutation 会改变 replay identity、canonical candidate 不被 replay mutation 改写”。
- `adversarial_verify` 是 evidence-only 线。`core/phases/adversarial_verify.ts` 在启动 agent 前把候选 diff、普通 verify verdict、evidence ledger、checklist verdict 和 acceptance checklist 写入 `${dataRoot}/phase-io/adversarial_verify/*-frozen-evidence-<sha>.json`，prompt 声明该 frozen snapshot 是权威来源；Claude 运行时走 strict read-only settings，只暴露 `Read` / `Glob` / `Grep`，不暴露 `Bash` 或 worktree 写入。
- phase-owned 写根只允许 phase 输出、隔离 temp、agent home/config/cache 这类运行时位置，不是候选源码豁免。`core/agents/agent-runner.ts` 把 read-only phase 的 `CPB_ACP_WRITE_ALLOW` / `CPB_AGENT_SANDBOX_ALLOW_WRITE` 收窄到 `${dataRoot}/phase-io/<phase>/*` 或 `__cpb_no_worktree_writes__`，`server/services/acp/acp-pool.ts` 对 strict read-only phase 再把 path guard 写根收窄到该 phase output root。
- direct provider 调用不得绕过 phase/role 元数据。coding-task phase 通过 `runAgent` 进入 pool，并显式传 `phase`、`role`、`jobId`、`dataRoot`、`scope` 与 audit context；`tests/phase-budget-policy.test.ts` 对生产 `.execute()` call site 建 allowlist。direct triage 调用 `server/services/issue-triage.ts` 使用 `{ phase: "issue_triage", role: "triager", controlPlane: true }`；live provider preflight/scan 路径 `scripts/queue-swebench-batch.ts` 使用 route 的 `phase` / `role`、`poolScope: "provider_live_preflight"` 和 `controlPlane: true`。新增 direct scan/triage 例外必须携带等价 metadata，不能作为匿名 provider 调用进入共享池。

## 动态线协议

- `bridges/run-pipeline.ts` 与 `bridges/run-phase.ts` 在使用 project metadata 或 worktree-manager stdout 前执行具名 schema 校验；除明确的 `ENOENT` 外，损坏 JSON、错误字段类型和缺失必需字段一律失败关闭。
- `core/engine/run-phase.ts` 只接受安全 phase 标识符，按 canonical 具名导出或自定义 `run<Phase>` 导出加载适配器，并在结果进入 job 状态机前校验 `PhaseResult` 的 phase、status、artifact、failure、diagnostics 与时间戳。适配器模块仍通过单一受校验的动态 import 加载，避免把插件实现误并入 engine 静态依赖边界。
- `WorkerBrokerClient` 的原始 HTTP 调用是私有实现。公开方法必须同时校验 `{ ok: true, result }` envelope、operation-specific result shape 以及 project/job identity；测试只能注入 transport，不能绕过这些校验直接返回泛型结果。
- worker broker 的 `artifact_created` 事件必须同时包含非空 artifact 和 kind/artifactKind；artifact index 使用 `shared/orchestrator/artifact-index.ts` 的共享 DTO/guard，在 core 或 server 消费前拒绝损坏条目。
- provider quota、legacy rate-limit 与 usage JSONL 是持久化 wire contract。canonical 文件损坏不得回退到 legacy，legacy 仅在 canonical `ENOENT` 时读取；任何非法状态、时间戳、数字或 JSONL 行都必须带文件/行诊断失败关闭。
- parent-plan cache 的 project、cache key、plan id 和 merged plan id 都是路径边界标识符；读写前必须校验安全字符、请求身份一致性和时间戳，禁止通过 project 或 cache key 逃逸 project runtime root。

## 硬切原则

用户明确要求：后续拆分不做兼容。

- 不保留旧路径兼容入口。
- 不新增兼容 re-export。
- 不维护同一能力的新旧双轨调用。
- 迁移完成后，旧入口应删除或改为明确失败，而不是继续透传。
- 发现“为了兼容而存在”的壳层，应优先列为清理项。

## 迁移结果

- `core/engine/run-job.ts` 不再懒加载 `server/services/provider-*` 或 quota delegate，改由 `ctx.providerServices` 注入。
- `server/services/engine-runner.ts` 负责把 provider quota、provider adapter、quota delegate 注入核心引擎。
- `server/services/quota-delegate-client.ts` 的 delegate 输入从 core provider payload contract 派生；server 不再维护一份容易漂移的重复请求结构。
- `bridges/engine-bridge.ts` 是 runtime-facing 边界入口，runtime 通过它调用 server-owned engine runner。
- phase 执行的 primary、provider fallback 与普通 phase retry 路径都显式透传 `scope`、`signal`、`processHooks`、progress sink 与 conversation key；verify hard gate 因而始终收到同一取消信号与 child-process 注册能力。phase adapter 继续负责构造 agent 环境；不得把 composition root 的默认完整 `process.env` 整体下推，否则会改变 persistent ACP session 生命周期。
- `runtime/worker/managed-worker.ts` 是服务端启动托管 worker 的 canonical 可执行入口。
- `cli/commands/*` 直接调用 canonical `server/services/*` 与 `server/orchestrator/*`。
- ACP client core、delete guard、variant overlay 的服务级实现已迁入 `server/services/`；旧 runtime 入口已删除，不作为长期设计。
- `runtime/` 不再直接导入 `server/`。运行时需要的 server 协作者集中由 `bridges/runtime-services.ts` 注入，这是显式装配点，不是旧路径兼容入口。

## 新代码放置规则

- 新的纯逻辑放入 `core/`。
- 新的持久化状态读写放入 `server/services/`。
- 新的 runtime-facing 跨层装配才放入 `bridges/`（如 `engine-bridge.ts` / `runtime-services.ts`），不得新增兼容导出或薄转发入口；测试 provider、验证 harness、研究合并脚本放入 `server/services/`。
- 新的 CLI 参数解析和展示逻辑放入 `cli/commands/`，服务调用直接进入 canonical server 模块。
- 新的长期 worker 或运行时脚本放入 `runtime/`，不通过 re-export 做旧路径兼容。
- 新增 runtime 代码不得直接导入 server 服务；确需复用 server 协作者时，必须通过明确的跨层装配点注入，并同步补边界测试。

## Task Acceptance Boundary

Checklist-aware jobs treat the prepare-time `acceptance-checklist` artifact as
the frozen execution contract. Planner and executor summaries are audit context
only. Verifier pass requires itemized `checklist-verdict` entries backed by
fresh `evidence-ledger` refs. Completion gate must reject required failed or
unchecked items, missing evidence, stale evidence, unresolved scope violations,
and checklist verdict status that conflicts with item results.

Checklist artifacts must be event-visible and indexable. Diagnostics-only
artifact references are not sufficient for audit or completion.
