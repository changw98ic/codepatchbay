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
- `core/` 只能依赖自身子目录和标准库/外部包，不得反向穿透其他层。

## 当前已锁定的边界测试

- `tests/core-boundary.test.ts`：禁止 `core/` 导入 `server/`、`runtime/`、`cli/`、`bridges/`。
- `tests/server-boundary.test.ts`：禁止 `server/` 导入 `runtime/` 实现。
- `tests/runtime-boundary.test.ts`：禁止 runtime 直接导入 `server/`，并禁止已删除的 runtime ACP / guard / variant 入口和兼容 re-export 壳回归。
- `tests/runtime-boundary.test.ts`：锁定 `bridges/` 精确只包含 runtime 边界适配器，防止工具脚本回流。
- `tests/cli-boundary.test.ts`：禁止 `cli/` 重新导入或动态拼接 `bridges/`、`runtime/`。

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
- `bridges/engine-bridge.ts` 是 runtime-facing 边界入口，runtime 通过它调用 server-owned engine runner。
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
