# CodePatchbay 架构与性能独立评估 — 2026-07-23

> 独立评估，非 agent 推测。架构结论经 codegraph + 真实代码逐行核对；性能结论基于实测 benchmark。与 `docs/product/cpb-perf-arch-debt-2026-07-23.md` 并列。

## 修订记录

**v3 — 2026-07-23（复审纠 7 处事实错误）**
1. **P1-b 从"拒绝"改为"未覆盖"**：bench 脚本不写 checkpoint（`scripts/bench-reconciler-perf.ts` 只 createJob+append+readJobProjection），checkpoint 仅对 terminal job 写（`event-store.ts` checkpointJob `if(!TERMINAL_STATUSES) return null`）。所测 readJobProjection 走无 checkpoint 快路（`event-store.ts:2061`），**未走** P1-b 担心的 checkpoint 全量 replay 校验路径（2069-2087）。不能据此拒绝也不能确认 P1-b。
2. **事件数修正**：createJob 追加 `job_created`（`job-store.ts:634`）+ DAG(1) + N = **N+2**；脚本 `eventCount: N+1` 少算 1。表中 1001/5001 实为 1002/5002。
3. **性能范围收窄**：reconcileAssignments ≠ 完整 `hub.tick()`（后者还含 scheduler.nextCandidates+dispatch，`hub-orchestrator.ts:315-324+`）；TICK_MS=2000 是每轮通过 `setTimeout` 安排下一轮的延迟（`hub-orchestrator.ts:22,270-283`），不是单轮强制 deadline。
4. **p99 → max**：5 runs 的 pct(0.99) 即最大值，无统计意义，表头改 max。
5. **taskId 竞态措辞纠正**：从 v2 的"不成立/已核销"改为"历史残留假设，当前代码未观察到触发路径但未穷尽；待当前实现复现，不列为 bug"。当前无 HTTP pipeline API（pipeline 是 CLI）。
6. **A3 耦合 import 数字标过时**：`runtime/` 当前**零** import server/（wiki "17 imports" 不成立）；run-pipeline.ts 不 import lease-manager。精确 import 图待重算。
7. **路径 typo**：脚本源是 `scripts/bench-reconciler-perf.ts`（非 .js）。

**v2 — 2026-07-23**：撤回 v1 的 taskId/jobId A1（引自未核对的 2026-05-24 wiki）；性能结论全局→局部。

---

## 一句话结论（范围限定）

**在本地 FS、warm cache、assigned 状态热路径、N≤200 范围内未发现瓶颈。** 全局性能结论仍需 checkpoint、Redis、running/stale-progress、完整 hub tick 的 benchmark 支撑——当前 bench 未覆盖。架构债集中在可维护性（ctx 上帝对象、文件膨胀）与跨层耦合，不在吞吐。

## 评估方法（含 bench 限制）

- codegraph（36740 nodes / 97269 edges）定位符号与调用链，`Read` 补具体行。
- 实测：`scripts/bench-reconciler-perf.ts`（ORICO 外接 APFS / Node v24.4.1），产物 `docs/product/evidence/perf-baseline-2026-07-23.json`。

**bench 统计强度与覆盖限制（必须声明）：**
- **runs=5**：p99/max 仅 5 样本，置信区间极宽。仅适合量级判断，不可做回归门禁（门禁需 ≥30 runs）。
- **覆盖**：2 函数 / 1 backend（本地 FS，非 Redis）/ 1 状态（assigned，未触 running 探针）/ warm OS page cache。
- **readJobProjection 测的是无 checkpoint 快路**（脚本不写 checkpoint）——不代表有 checkpoint 时的全量 replay 校验成本。
- **reconcileAssignments ≠ 完整 hub tick**（未含 scheduler/dispatch）。

---

## 一、性能：所测范围内未发现瓶颈（局部，且路径受限）

### 实测数据（本地 FS，5 runs，事件数已按 N+2 修正）

| 指标 | 规模（实际事件数） | 实测 mean / max | 参照 | 备注 |
|---|---|---|---|---|
| `reconcileAssignments`（tick 的 reconcile 段，非完整 tick） | N=100 | 72ms / 79ms | tick 周期 2000ms | 周期非 deadline |
| 同上 | N=200 | 159ms / 162ms | 同上 | |
| `readJobProjection`（**无 checkpoint 快路**） | 1002 events | 2.6ms / 4ms | P1-b 目标 <10ms | **未测 checkpoint 路径** |
| 同上 | 5002 events | 8.1ms / 9ms | | **未测 checkpoint 路径** |

> JSON 的 `eventCount` 字段标 N+1（脚本少算 job_created），实际 N+2，上表已修正；JSON 中的 `p99Ms` 也只是 5 次样本的最大值，字段名暂未同步。时间值不受标签影响。

**局部结论**：在 N≤200 的本次样本中，reconcile 耗时呈近似线性（N=200 为 159ms）；无 checkpoint 的 readJobProjection 在 5002 events 下 8.1ms。该结果不外推到更大规模，因为 assigned 分支仍存在队列扫描的 O(N²) 实现。**此前债务文档 P1-a 在此范围内被证伪**（N=200 远未接近 tick 周期）。

**不可推广**：
- P1-b（checkpoint 全量 replay 校验）**完全未测**——2.6/8.1ms 是无 checkpoint 快路，不能用来评估或拒绝 checkpoint 优化。
- Redis backend CAS 路径、running+probe 路径、完整 hub tick（含 dispatch）、冷启动——均未测。

### 据此修正原债务文档

- **P1-a（reconcile tick IO）→ 所测范围内非瓶颈**。完整 tick 未测。
- **P1-b（checkpoint 改 hash shortcut）→ 未覆盖，不裁决**。需补 terminal+checkpoint 的 bench 用例才能判断。原 v1/v2 的"拒绝"基于测错路径，撤回。
- **P0（建立基线）→ 已完成**（但基线本身有上述覆盖缺口）。

### bench 补强项（裁决 P1-b 与全局结论的前置）

1. **terminal job + checkpoint** 用例（测 P1-b 真实路径）。
2. Redis backend CAS 用例。
3. running + 新鲜 heartbeat + stale progress + error 级阈值的探针用例（heartbeat 过期会先走失败分支，无法覆盖 progress-delay probe）。
4. 完整 `hub.tick()`（含 scheduler/dispatch）用例。
5. ≥30 runs + 冷启动采样。

---

## 二、架构债（按 ROI 排序，均非吞吐问题）

### A1 — ctx 上帝对象（可维护性，P1，长期）

**证据**：`core/engine/run-job-ports.ts:101` —— `RunJobContext = RunJobState & RunJobPorts`。一个对象塞三类异质数据，当前有 9 个生产文件引用该上下文类型（不含 tests）；多个 extracted engine 模块共享/传递它，部分路径还会 mutate：

| 类别 | 字段 | 特征 |
|---|---|---|
| immutable config | `cpbRoot`/`project`/`task`/`hubRoot` | 全程不变 |
| dynamic JSON boundary | `managedWorktree`/`scope` | 已标 `retain:`，对外不透明 |
| engine bookkeeping | `_jobId`/`_attemptId`/`_currentPhase`（run-job-ports.ts:96-98） | 带下划线的可变状态 |

`_jobId` 这类突变挂在共享 ctx 上，不是已复现的功能 bug，但构成测试隔离和并发推理的潜在维护风险。分域方向正确（config / boundary / bookkeeping 三 holder）。**风险中**：碰 strict-engine gate，须拆多个小 slice，不紧急。

### A2 — 文件粒度失控（可读性，P2，低风险易落地）

**实测行数**：

| 文件 | 行数 |
|---|---|
| `scripts/build-output.mjs` | 2097 |
| `core/engine/run-job-execute-dag.ts` | 1952 |
| `core/artifacts/artifact-store.ts` | 1595 |
| `core/agents/session-cache.ts` | 1370 |
| `runDagNode`（单函数） | 216 |

计划（尚未落地）：新增 `scripts/size-guard.ts`（mirror type-debt-guard，file >800 / function >150 行告警 + allowlist baseline）。**低风险**。当前约 ~109 个 offender 是待正式扫描复核的估算，之后再一次性 seed baseline。

**commit-size gate 上线说明**：`verify-commit-size` 只检查当前 `HEAD`，而 `verify:stabilization`/CI 会执行该 gate，不扫描历史 checkpoint。当前 `b952c61a` 若仍是 HEAD，会因 171171 changed lines、321 files 且没有 explanatory body 而失败；不可改写该历史提交时，应由新的 tip 提交承接，或在该提交作为 tip 的运行中显式设置带理由的 `CPB_COMMIT_SIZE_OVERRIDE`。新 tip 通过不等于历史 checkpoint 已被审查。

### A3 — bridges/cli/runtime → server 无稳定接口（耦合，P2，数字待重算）

**方向成立，但 import 数字过时**。`.omc/wiki/architecture-residual-defects-2026-05-24.md` Residual 2 的 "bridges→server 32 / cli→server 36 / runtime→server 17" 为 2026-05-24 计数，**当前已部分失效**：

- `runtime/` 当前**零** import `server/`（grep 证实）→ "runtime→server 17" 不成立。
- `bridges/run-pipeline.ts` 实际依赖的 server 服务：`event-store`、`hub-registry`、`runtime.js`、`job-store`、`workflow-definition`、`phase-runner`、`dispatch`、`executor-root`（run-pipeline.ts:16-43）——**无 lease-manager**。

**核心判断仍成立**：bridges 直连 server 内部服务，无 API 稳定契约；变更这些 server 内部服务接口时，可能影响直接消费它们的 bridges。但精确 import 图须重算后才能进 PR。解法：抽 `core/services/` 稳定接口层。2–3 周，与稳定化冻结冲突，**记录在案，冻结期后执行**。

### 历史残留假设 — taskId/jobId 双注册表竞态（原 v1 的 A1，不列为 bug）

**状态：待当前实现复现，不是已确认 bug。**

`.omc/wiki/architecture-residual-defects-2026-05-24.md` Residual 3 描述的 "API 返回 `{accepted,taskId,pid}` 在 job 前 / executor.js 按 taskId 追踪 / 双注册表 / 取消 404 竞态"，在当前代码**未观察到触发路径**：

- `executor.js`/`supervisor.js` 不在当前树；当前 HTTP server **无 pipeline API**（pipeline 是 CLI：`cpb pipeline` → `bridges/run-pipeline.ts`）。
- `bridges/run-pipeline.ts:661` 先 `createJob()` 建 durable job，再用 jobId 跑。
- `cpb cancel/redirect/retry` 直接收 jobId 作参数（`cli/commands/cancel-redirect.ts:33,46`、`cli/commands/retry.ts:17`），无 taskId→jobId 转换。
- taskId 在 orchestrator 层仅作 metadata 透传字段（`hub-orchestrator.ts:90,117`），非进程追踪键。

**但**：未穷尽所有路径（review 子系统 `review-dispatch.ts:1614,1718,1764` 的 `queueEntryId || jobId` 别名、未来引入的进程追踪）。故标"历史残留假设，待复现"，**不**断言已消除，也**不**列为 P1 bug。若需定论，做一次独立的身份语义审计。

---

## 三、reconciler 冗余（真实，确认存在）

**已确认**（`server/orchestrator/reconciler.ts`）：

1. **`getActiveAttempt` 无进程内缓存**（assignment-store.ts:1669-1683）：每次 = 读 `state.json` + `attempt.json`。
2. **冗余重读**：`running` 分支（reconciler.ts:1310）已拿 `attempt`，但 `_readAttemptResult`(:2044) 又读一次；`scheduled/assigned` 分支（:1234/:1251）传入 attempt 后，`_readAccepted`(:2028) 的 ENOENT fallback 仍再读一次。
3. **O(N²) 队列扫描**：reconciler.ts:1250-1273（assigned 分支内）每个 assignment 都 `listQueue({status:"in_progress"})` 全量重扫。**这是该分支中已确认的非线性项**。

**在当前 benchmark 覆盖规模内属于 cosmetic**（N=200 reconcile 段 159ms）。唯一值得顺手修：O(N²) listQueue → 循环外建 map、循环内查表，约三行。低优先 cleanup。

---

## 四、可执行建议（按优先级）

| # | 动作 | 理由 | 风险 |
|---|---|---|---|
| 1 | **性能优化全部暂缓**，P1-a 标"所测范围非瓶颈"，P1-b 标"未覆盖" | 实测范围内无瓶颈，P1-b 路径未测 | 无 |
| 2 | **补 checkpoint/Redis/probe/完整 tick bench + ≥30 runs** | 裁决 P1-b 与全局结论的前置 | 低 |
| 3 | **落地 A2 size-guard**（seed baseline） | 防文件膨胀 | 低 |
| 4 | **顺手修 O(N²) listQueue** | 不线性，定时炸弹 | 低 |
| 5 | **A3 import 图重算** | 当前数字过时，进 PR 前须刷新 | 低 |
| 6 | A1 ctx 分域 / A3 接口层抽取 | 长期可维护性 | 中-高，拆 slice |

**撤回项**：原 v1 的"修 taskId/jobId 双注册表"降为"历史假设，待复现"，不做。

---

## 五、待 owner 决策

1. **bench 补强 + 进 CI**：补到 ≥30 runs + checkpoint/Redis/probe/完整 tick 后，是否接防退化门禁？
2. **P1-b 复测**：是否补 terminal+checkpoint 用例，用数据裁决 checkpoint 优化？（当前无数据，既不拒绝也不采纳。）
3. **A3 接口层抽取**：冻结期后是否启动 `core/services/` 抽取（2-3 周）？
4. **taskId 身份语义审计**：是否做独立复核（review 子系统 `queueEntryId || jobId` 并发歧义）？非紧急。

---

## 六、自我纠正说明

本报告经三轮自纠。v1 存"引用未核对旧 wiki"与"全局性能结论超覆盖"两处越界；v2 纠正但残留 7 处事实错误（P1-b 测错路径、事件数差 1、p99 误称、taskId 过度断言、A3 import 数字过时、路径 typo，以及调度/上下文/reconciler 的表述不精确），v3 依据当前代码逐条改正。

**教训**：架构/性能结论必须以当前代码为唯一证据源；bench 须明确标注所测的具体路径与统计强度；跨日期 wiki 仅作线索不作结论；引用行号与文件名必须核对原文。
