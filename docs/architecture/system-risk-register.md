# CodePatchBay 架构风险清单

本文记录系统按维度拆解后发现的结构性问题。优先级含义：

- `P0`：当前会造成数据损坏、安全事故或主链路不可用。
- `P1`：合并或发布前应处理，否则容易造成运行时故障、发布缺陷或明显不可恢复状态。
- `P2`：功能可用但能力薄弱、可观测性不足、未来演进容易踩坑。
- `P3`：文档、体验、校验覆盖或维护性问题。

## 架构决策：不做兼容

用户明确要求：后续拆分以“硬切”为准，不做兼容。

- 不保留旧路径兼容入口。
- 不新增兼容 re-export。
- 不维护同一能力的新旧双轨调用。
- 迁移完成后，旧入口应删除或改为明确失败，而不是继续透传。
- 风险条目里的“兼容入口”不应按“修补兼容”处理，应按“删除旧入口、收敛到唯一入口”处理。

## RISK-001：常驻调度 / ACP 控制面能力偏 MVP

- 优先级：`P2`
- 状态：已记录，待设计升级
- 相关维度：编排与调度、ACP 与 provider 配额、恢复与观测
- 相关文件：
  - `server/orchestrator/scheduler.js`
  - `server/orchestrator/hub-orchestrator.js`
  - `server/orchestrator/worker-supervisor.js`
  - `server/services/acp-pool.js`
  - `server/services/provider-quota.js`
  - `core/engine/run-job.js`

### 现象

当前常驻调度更像“可靠的文件队列 dispatcher”，而不是“统一资源控制面”：

- 调度主决策主要是 `priority + createdAt + 项目并发限制`。
- Worker 生命周期、队列状态、ACP 池、provider quota 和 agent 健康之间没有统一打分模型。
- 失败、耗时、provider 限流、agent 成功率等反馈没有系统性反哺下一轮调度。
- P0/P1 任务缺少抢占、快速通道、截止时间和依赖关系表达。
- ACP 池负责 provider 连接与 quota，但没有和队列调度形成完整 backpressure 闭环。

### 影响

- 短期：系统能跑，但面对高并发、多 provider、长任务、失败重试时调度行为偏机械。
- 中期：任务优先级、provider 限流和 worker 容量之间容易互相打架。
- 长期：如果要做“常驻智能调度”或“多项目自治执行”，需要补统一控制面，否则调度能力会成为瓶颈。

### 建议方向

- 建立 `RuntimeControlPlane` 或等价服务，统一汇总 queue、assignments、workers、ACP pool、provider quota、agent health。
- 调度器从“取下一个 pending”升级为“候选打分 + backpressure + 资源预测”。
- 将失败率、阶段耗时、provider 限流、worker 健康写入可查询指标。
- 给项目、worker、provider 三层都建立 capacity 和 backpressure。
- 为 P0/P1 引入明确的快速通道、抢占或并发保留策略。

## RISK-002：Executor root / release 校验只看薄入口，传递依赖校验不足

- 优先级：`P1`
- 状态：已修复
- 相关维度：安装与发布、Worker 执行、运行根
- 相关文件：
  - `server/services/executor-root.js`
  - `runtime/worker/managed-worker.js`
  - `runtime/evolve/multi-evolve.js`
  - `server/services/acp-client-core.mjs`

### 证据

- `server/services/executor-root.js` 的 `REQUIRED_EXECUTOR_FILES` 已改为列出 canonical worker、multi-evolve、ACP client core、server service 与 orchestrator 文件。
- `runtime/worker/managed-worker.js` 与 `runtime/evolve/multi-evolve.js` 现在直接作为发布契约，不再依赖薄入口通过校验。

### 影响

残缺 executor root 可能通过 `assertExecutorRoot()`，但真正启动 worker 或 multi-evolve 时才因为缺传递依赖崩溃。这个问题在源码树不明显，在 release、安装包、手动指定 `CPB_EXECUTOR_ROOT` 时更危险。

### 建议方向

- 把关键传递依赖纳入 `REQUIRED_EXECUTOR_FILES`。
- 或改为入口自检：bridge 入口启动前验证其依赖链。
- release doctor 应覆盖 worker、multi-evolve、ACP one-shot CLI 的最小启动或 pack smoke。

## RISK-003：当前大拆分依赖未跟踪新增文件，存在提交/发布缺文件风险

- 优先级：`P1`
- 状态：待提交前处理（代码已验证，提交时必须纳入索引）
- 相关维度：安装与发布、分层边界、交付流程
- 相关文件：
  - `server/services/acp-pool.js`
  - `server/services/acp-client-core.mjs`
  - `server/orchestrator/worker-supervisor.js`
  - 已删除旧入口：`bridges/acp-client.mjs`、`bridges/multi-evolve.mjs`、`runtime/acp-client-core.mjs`
  - `tests/*boundary.test.mjs`

### 证据

当前代码已经依赖以下新增文件，且 `git status --short` 显示它们仍未跟踪；提交时必须显式纳入：

- `server/services/acp-client-core.mjs`
- `server/services/apply-variant.js`
- `server/services/delete-guard.js`
- `server/services/control-plane-snapshot.js`
- `server/services/queue-rules.js`
- `server/services/review-dispatch.js`
- `server/services/browser-agent-acp.mjs`
- `server/services/dual-research.mjs`
- `server/services/evolve-multi-cli.js`
- `server/services/local-smoke.mjs`
- `server/services/review-dispatch-runner.mjs`
- `bridges/runtime-services.js`
- `runtime/worker/assignment-finalizer.js`
- `runtime/worker/worktree-manager.js`
- `shared/fs-utils.js`
- `shared/logger.js`
- `shared/orchestrator/assignment-store.js`
- `shared/orchestrator/worker-store.js`
- `tests/core-boundary.test.mjs`
- `tests/runtime-boundary.test.mjs`
- `tests/server-boundary.test.mjs`
- `tests/cli-boundary.test.mjs`
- `tests/release-pack-smoke.test.mjs`
- `docs/architecture/system-risk-register.md`

### 影响

源码树能跑不代表提交后或发布后能跑。如果新增文件没有被 `git add`，后续 commit / PR / npm pack / release install 可能得到缺文件版本。旧入口删除也必须一并 stage，否则会出现源码硬切完成但提交仍保留旧入口的假象。

### 建议方向

- 提交前用 `git status --short` 专门确认新增 server service、runtime helper、boundary tests、docs 和旧入口删除都被纳入。
- 发布验证加入 `npm pack --dry-run --json` 内容检查。

## RISK-004：队列 claim / stale recovery 存在双路径语义不一致

- 优先级：`P2`
- 状态：已修复
- 相关维度：队列、编排与调度、恢复与观测
- 相关文件：
  - `server/orchestrator/scheduler.js`
  - `server/services/hub-queue.js`
  - `server/routes/hub.js`

### 证据

- `server/services/queue-rules.js` 已成为 assignment-aware recovery 的单一规则入口。
- `server/services/hub-queue.js` 和 `server/orchestrator/scheduler.js` 都通过该规则判断 stale claim。
- 队列/编排测试覆盖了 stale in-progress recovery 与 active assignment 保护。

### 影响

旧风险已处理：claim 和 scheduler 不再维护两套互相冲突的 stale recovery 语义。

### 建议方向

- 保持 `queue-rules.js` 为唯一恢复规则入口。
- 修改 queue claim 语义前必须同步更新 `tests/queue-orchestrator.test.mjs`。

## RISK-005：providerServices 注入契约过脆，部分覆盖会关闭默认服务

- 优先级：`P2`
- 状态：已记录，未纳入本轮硬切
- 相关维度：核心引擎、ACP 与 provider 配额、分层边界
- 相关文件：
  - `server/services/engine-runner.js`
  - `core/engine/run-job.js`
  - `tests/engine-provider-event.test.mjs`

### 证据

- `server/services/engine-runner.js` 使用 `opts.providerServices !== undefined` 判断是否覆盖默认 provider services。
- 如果调用方只传部分函数，会完全替换 `buildServices()` 中的默认实现；`providerServices: undefined` 已按未传处理。
- `core/engine/run-job.js` 的 preflight、delegate mark unavailable、usage enqueue 都依赖该对象上的函数。

### 影响

调用方原本可能只想覆盖一个 provider service，但会无意间关掉 preflight、quota delegate 或 usage enqueue。中途 rate limit fallback 还可能因为缺少 `delegateMarkProviderUnavailable` 被转成 runtime failure。

### 建议方向

- `undefined` 按未传处理。
- 部分对象与默认 provider services 合并。
- 只有显式 `null` 表示禁用 provider services。
- 补 `providerServices: undefined` 和 partial override 测试。

## RISK-006：provider handoff 后 usage 记录可能丢失 fallback 语义

- 优先级：`P2`
- 状态：已记录，未纳入本轮硬切
- 相关维度：ACP 与 provider 配额、状态与产物、观测
- 相关文件：
  - `core/engine/run-job.js`
  - `tests/engine-provider-event.test.mjs`

### 证据

- `core/engine/run-job.js:252-286` preflight handoff 只保存 `handoffReason`。
- `core/engine/run-job.js:706-712` usage fallback 的 `fromProviderKey` 来自 `failCause.providerKey`，成功结果下该字段可能为空。
- mid-run fallback 成功后，最终 `result` 已经是成功结果，失败原因可能不再存在于 `result.failure`。

### 影响

事件流能看到 `provider_handoff`，但 provider usage 统计可能丢掉“从哪个 provider 切到哪个 provider、为什么切”的语义。后续做 quota 诊断、provider 成功率和调度反馈时，指标会不可靠。

### 建议方向

- 在 handoff 发生时维护独立 `handoffState`。
- usage enqueue 直接使用 `handoffState.from/to/reason/count`。
- 增加 preflight fallback 与 mid-run fallback 成功后的 usage command 断言。

## RISK-007：multi-evolve worker 入口未统一

- 优先级：`P2`
- 状态：已修复
- 相关维度：运行时、Worker 执行、分层边界
- 相关文件：
  - `runtime/evolve/multi-evolve.js`
  - `runtime/worker/managed-worker.js`

### 证据

- `runtime/worker/managed-worker.js` 现在是唯一 canonical worker 执行入口。
- `runtime/evolve/multi-evolve.js` 和 `server/orchestrator/worker-supervisor.js` 都启动该入口。

### 影响

旧风险已处理：worker 不再通过薄入口绕转，multi-evolve 与 supervisor 已统一到 canonical worker。

### 建议方向

- 保持 `runtime/worker/managed-worker.js` 为唯一 worker 进程入口。
- 继续由 runtime/release smoke 测试防止旧薄入口回归。

## RISK-008：兼容入口残留，违反硬切原则

- 优先级：`P2`
- 状态：已修复
- 相关维度：运行时、兼容入口、安装发布
- 相关文件：
  - `server/services/acp-client-core.mjs`
  - `server/services/apply-variant.js`

### 证据

- `server/services/acp-client-core.mjs` 已承接 ACP one-shot CLI 入口。
- 旧 ACP bridge 入口和旧 runtime 服务入口已删除。
- `server/services/apply-variant.js` 是当前 canonical CLI/service 实现。

### 影响

旧兼容入口风险已处理：旧路径不再继续透传。当前剩余问题不是兼容路径，而是 `server/services/acp-client-core.mjs` 同时承担可复用服务函数和 direct-run CLI，模块职责仍偏厚。

### 建议方向

- 保持旧路径删除，不再新增 re-export 或兼容 shell。
- 后续可把 direct-run CLI 从 `server/services/acp-client-core.mjs` 拆到独立命令入口，让 service 文件只保留服务逻辑。
- 如发现旧路径引用，直接迁到 canonical path；不要补兼容透传。

## RISK-009：边界测试覆盖形态偏窄，动态穿层仍可能漏检

- 优先级：`P2`
- 状态：待加固
- 相关维度：分层边界、测试防线
- 相关文件：
  - `tests/core-boundary.test.mjs`
  - `tests/runtime-boundary.test.mjs`
  - `tests/cli-boundary.test.mjs`
  - `tests/server-boundary.test.mjs`

### 证据

- `tests/core-boundary.test.mjs:23-29` 只匹配 `from ...`、字面量 dynamic import 和 `await import("...")`，不匹配副作用导入 `import "../server/foo.js"`。
- `tests/runtime-boundary.test.mjs:22-27` 只匹配字面量 import，不覆盖 `path.join(..., "server", ...)`、`new URL(...)`、模板拼接。
- `tests/cli-boundary.test.mjs:44-49` 只匹配 `path.join(..., "server", "services")` 分段写法，不覆盖 `"server/services/..."` 合并字符串或 `new URL(...)`。
- `tests/server-boundary.test.mjs:44-49` 覆盖 `path.join/path.resolve(..., "runtime")`，但不覆盖 `new URL(...)` 和间接 bridge 到 runtime。

### 影响

当前测试能锁住主流静态 import，但对副作用 import、合并路径字符串、模板字符串、`new URL` 和 child process 可执行路径引用的覆盖不足。未来重构时可能重新引入穿层依赖而测试不红。

### 建议方向

- 把 import 扫描升级到 AST 或统一字符串字面量归一化。
- 至少补副作用 import、`new URL`、合并路径字符串、模板字符串、child process path 的正则覆盖。
- 给扫描器本身加最小 fixture 测试。

## RISK-010：发布 E2E 脚本硬编码旧 tarball 版本

- 优先级：`P2`
- 状态：已修复
- 相关维度：安装与发布、验证流程
- 相关文件：
  - `scripts/e2e-npm-pack.mjs`
  - `package.json`

### 证据

- `scripts/e2e-npm-pack.mjs` 已从 `npm pack --json` 读取实际 tarball filename。
- `tests/release-pack-smoke.test.mjs` 覆盖 `npm pack --dry-run --json` 清单。

### 影响

旧风险已处理：发布验证不再依赖硬编码 tarball 文件名。

### 建议方向

- 保持 release smoke 对 pack 清单的覆盖。

## RISK-011：WorkerSupervisor 声明了重启上限但没有使用

- 优先级：`P2`
- 状态：已修复
- 相关维度：Worker 执行、恢复与观测、资源控制
- 相关文件：
  - `server/orchestrator/worker-supervisor.js`
  - `server/orchestrator/reconciler.js`
  - `server/orchestrator/failure-router.js`

### 证据

- `server/orchestrator/worker-supervisor.js` 已将 restart count 写入 worker registry 并执行 `MAX_RESTARTS` 上限。
- `tests/worker-supervisor.test.mjs` 覆盖超过 3 次后标记 exhausted，以及 deliberate stop 不重启。

### 影响

旧风险已处理：worker supervisor 层已有独立 restart cap。

### 建议方向

- 保持 worker restart cap 与 assignment retry budget 的测试覆盖。

## RISK-012：runtime 服务注入集中在跨层装配点，后续仍需模块化

- 优先级：`P2`
- 状态：已硬切直连，后续模块化
- 相关维度：运行时、分层边界、Worker 执行、ACP 与 provider 配额、状态与产物
- 相关文件：
  - `bridges/runtime-services.js`
  - `runtime/worker/managed-worker.js`
  - `runtime/worker/assignment-finalizer.js`
  - `runtime/evolve/multi-evolve.js`
  - `runtime/migrate-runtime-root.js`
  - `runtime/record-ui-escalation.js`
  - `shared/orchestrator/assignment-store.js`
  - `shared/orchestrator/worker-store.js`

### 证据

当前硬切已经删除旧入口与兼容壳，并切断 runtime 直接导入 server：

- `tests/runtime-boundary.test.mjs` 已禁止 runtime 文件直接导入 `server/`。
- `runtime/worker/managed-worker.js`、`runtime/evolve/multi-evolve.js`、`runtime/worker/assignment-finalizer.js` 等改为导入 `shared/` 和 `bridges/runtime-services.js`。
- `shared/orchestrator/assignment-store.js` 与 `shared/orchestrator/worker-store.js` 承接无副作用 store，避免 runtime 为了 assignment / worker 状态穿到 `server/orchestrator/`。
- `bridges/runtime-services.js` 集中注入 runtime 仍需调用的 server 协作者，例如 ACP pool、Hub queue、multi-evolve state/policy、event append、auto-finalizer 和 GitHub transport。

### 影响

runtime 已经不再直接穿到 server，但 `bridges/runtime-services.js` 仍是敏感装配点：它把状态、队列、ACP 池和自动收口能力一次性暴露给运行时。短期这比散落直连清晰，也满足“不做兼容”的硬切要求；中期如果要把观察、调度、worker 常驻能力交给子代理自治，这个集中注入点会成为下一轮模块化拆分对象。

### 建议方向

- 保持 `bridges/runtime-services.js` 不是兼容入口，不为旧路径提供 re-export。
- 把 worker 需要的最小状态 API 继续下沉到 `shared/` 或 runtime-local adapter，例如 heartbeat、assignment result、json atomic write。
- 把 ACP provider release / pool stop 变成显式进程协议或窄接口注入，减少 runtime 对 server control plane 的感知。
- 把 `multi-evolve` 的状态读写、queue sync、policy 访问拆成更窄的 service facade，再决定 facade 属于 server、shared 还是 runtime。
- 保持 `tests/runtime-boundary.test.mjs` 对 runtime→server 直接 import 的硬禁用；新增跨层能力必须先更新边界测试。
