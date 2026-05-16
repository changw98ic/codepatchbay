# server/routes/review.js:stopReviewProcess/activeReviewProcesses — Declared but never populated or referenced anywhere else, so cancellation/cleanup paths are dead code and add maintenance overhead while obscuring intended review-process lifecycle behavior.

codex->claude  
Phase: plan

## Purpose
该计划聚焦于 `server/routes/review.js` 中 `activeReviewProcesses` 与 `stopReviewProcess` 的整理，目标是消除未被填充和引用的“伪生命周期”路径，降低维护负担并恢复清晰的 review 处理行为。

## Inputs
- `server/routes/review.js`
- `/Users/chengwen/dev/flow/wiki/projects/calc-test/context.md`
- `/Users/chengwen/dev/flow/wiki/projects/calc-test/decisions.md`
- `/Users/chengwen/dev/flow/profiles/codex/soul.md`
- `/Users/chengwen/dev/flow/wiki/system/handshake-protocol.md`
- `/Users/chengwen/dev/flow/templates/handoff/plan-to-execute.md`

## Step plan (5 steps, scope matched)

1. Establish authoritative lifecycle model for review route handling.
Acceptance criteria:
- 所有 review 相关成功、超时、异常、早退（若存在）路径在计划里被显式列出。
- 明确声明 `activeReviewProcesses` 与 `stopReviewProcess` 当前不承载任何必要行为，仅用于“意图说明但未实现”的清理路径。

2. Remove dead registry declarations and their no-op usage sites in `server/routes/review.js`.
Acceptance criteria:
- 代码中不再保留 `activeReviewProcesses` 的声明/初始化/导出。
- 代码中不再保留 `stopReviewProcess` 的定义或引用。
- 变更不会引入新的变量、依赖或导出项。

3. Validate actual cleanup behavior after removal.
Acceptance criteria:
- review 任务的终止/清理行为在现有代码中有明确的“请求内路径”（例如完成、错误、超时、finally）。
- 任一路由路径不再依赖外部进程映射或全局 registry 来执行清理。

4. Remove stale comments/notes that imply active cancellation registry.
Acceptance criteria:
- 所有暗示“可取消/可追踪进程注册”的注释被清理或改写为“基于请求生命周期处理”。
- 日后读者能从代码结构直接理解 review 生命周期，不需要追踪未使用的变量名。

5. Create implementation-ready safety checklist + rollback criteria for implementer.
Acceptance criteria:
- 形成可执行核对清单：搜索 `activeReviewProcesses` / `stopReviewProcess` 全局零引用。
- 形成回退条件：若有生产行为依赖，要求恢复原路径并补充最小注册与注销逻辑后再上线。

## Execution output expectations
- 单一补丁：移除死代码并同步注释与路径说明。
- 风险说明：如发现有隐含依赖，优先记录为“回退触发条件”而非临时兼容。
- 后续建议：在实现阶段补充一段轻量代码审查核查项，确保 review lifecycle 仍完整覆盖成功/失败/超时。
