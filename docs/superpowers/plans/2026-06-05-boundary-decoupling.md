# 边界解耦实施计划

> 面向后续 agent：本计划按“先测试锁边界，再迁移依赖入口，最后全量验证”的顺序执行。继续修改时必须保持文档和新增测试为中文语境。

## 目标

完整拆掉当前最危险的跨层耦合，让核心引擎、服务端、运行时 worker、CLI 与桥接层之间有明确依赖方向。

## 架构策略

先用静态边界测试锁住禁止方向，再将具体依赖迁到 canonical 服务级实现中；早期 CLI bridge 与薄入口方案已废弃：

- `core/` 不再直接或懒加载 `server/`。
- `runtime/` 删除旧 ACP/runtime 服务入口，使用明确的 canonical runtime 可执行入口。
- `cli/` 不再通过 CLI bridge，直接导入 canonical `server/services/` 与 `server/orchestrator/`。
- `server/` 不再导入 `runtime/`；ACP client core 的服务级实现迁入 `server/services/`。

## 任务 1：拆除 `core -> server` 反向依赖

涉及文件：

- 新增：`tests/core-boundary.test.mjs`
- 修改：`core/engine/run-job.js`
- 修改：`bridges/engine-bridge.js`
- 修改：`tests/engine-provider-event.test.mjs`

完成状态：

- [x] 写静态边界测试，禁止 `core/` 指向 `server/`、`runtime/`、`cli/`、`bridges/`。
- [x] 确认红灯来自 `core/engine/run-job.js` 的 provider/quota 懒加载。
- [x] 在 `runJob(ctx)` 中引入 `ctx.providerServices` 注入点。
- [x] 在 `server/services/engine-runner.js` 注入 provider quota、provider adapters、quota delegate client；`bridges/engine-bridge.js` 只保留 runtime-facing 边界入口。
- [x] provider fallback、usage、delegate failure 回归测试通过。

## 任务 2：拆除 `runtime -> server` 直接依赖

涉及文件：

- 新增：`tests/runtime-boundary.test.mjs`
- 修改：`runtime/worker/managed-worker.js`
- 修改：`runtime/evolve/multi-evolve.js`
- 新增：`bridges/runtime-event-services.js`
- 新增：`bridges/runtime-migration-services.js`
- 修改：`runtime/worker/managed-worker.js`
- 修改：`runtime/evolve/multi-evolve.js`
- 删除：runtime 旧 ACP pool 入口
- 修改：`runtime/migrate-runtime-root.js`
- 修改：`runtime/record-ui-escalation.js`

完成状态：

- [x] 写静态边界测试，禁止旧 runtime ACP 入口和兼容 re-export 回归。
- [x] 将服务端启动托管 worker 的路径切到 `runtime/worker/managed-worker.js`。
- [x] 将 multi-evolve 入口切到 `runtime/evolve/multi-evolve.js`。
- [x] 删除早期 bridge facade 与薄入口方案。
- [x] managed worker 回归测试通过。

## 任务 3：拆除 `cli -> server` 直接依赖

涉及文件：

- 新增：`tests/cli-boundary.test.mjs`
- 修改：`cli/commands/*`

完成状态：

- [x] 写静态边界测试，禁止 `cli/` 重新导入或动态拼接 `bridges/`。
- [x] 将 CLI 命令中的静态和动态旧 bridge 路径机械替换为 canonical `server/` 路径。
- [x] CLI 文件语法检查通过。

## 任务 4：拆除 `server -> runtime` 反向依赖

涉及文件：

- 新增：`tests/server-boundary.test.mjs`
- 新增：`server/services/acp-client-core.mjs`
- 新增：`server/services/delete-guard.js`
- 新增：`server/services/apply-variant.js`
- 修改：`server/services/acp-pool.js`
- 删除：runtime 旧 ACP / guard / variant 入口

完成状态：

- [x] 写静态边界测试，禁止 `server/` 导入 `runtime/`。
- [x] 将 ACP client core、delete guard、variant overlay 的服务级实现迁入 `server/services/`。
- [x] 删除 runtime 旧入口；当前不保留兼容 re-export 或小型 CLI wrapper。
- [x] ACP client 与 ACP pool 相关测试通过。

## 任务 5：文档与全量验证

涉及文件：

- 修改：`docs/architecture/runtime-boundaries.md`
- 保留：`docs/architecture/unit-flowcharts.md`

完成状态：

- [x] 更新边界文档中的层级、允许方向、已拆除项。
- [x] 运行 `npm test`。
- [x] 运行最终静态扫描，确认禁止方向没有回潮。
