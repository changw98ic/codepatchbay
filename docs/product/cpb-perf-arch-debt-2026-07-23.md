# CodePatchBay 性能与架构债务清理规范 — 2026-07-23

> 补充 `cpb-stabilization-baseline-2026-06-22.md`：稳定化周期已清偿执行内核瘦身（`run-job.ts` 2384→203 行、type-debt 归零、strict-engine 全覆盖、durable 恢复单一权威）。本规范聚焦其未系统覆盖的**性能维度**与残留**架构债务**，作为后续 PR 的依据。

## 评估方法

evidence-based 独立评估（非 agent 推测）。架构结论经 codegraph + 真实代码核对；性能结论区分代码路径推测与实测基线。实测基线见 `docs/product/evidence/perf-baseline-2026-07-23.json` 及[独立评估](./cpb-arch-perf-assessment-2026-07-23.md)。**未覆盖路径的判断一律保留"推测"标记**。

## 现状判断

架构合理，偏"正确性奢侈"——为 durability / 审计 / 防 split-brain 付了实在的复杂度与潜在性能成本。恢复模型正确（dagResume 是 event log 单一权威，split-brain 已证伪）。当前 benchmark 覆盖范围内未发现 reconcile 瓶颈；剩余性能判断仍集中在 checkpoint、Redis、running/probe、完整 hub tick 等未覆盖路径，架构债务则集中在**可维护性与文件粒度失控**。

## 目标

1. 建立并补齐**实测性能基线**（局部基线已建立，覆盖仍有缺口）。
2. 清偿已知架构债务（不新增能力，尊重稳定化冻结）。
3. 流程防退化（commit-size gate 已落地）。

## 非目标（YAGNI / 冻结）

- 不新增 agent 类型 / workflow 类别 / scheduler 特性 / provider 集成（README:15-25 冻结红线）。
- 不做无 bug 的镀金 defense——已实证：`#prepareSession` 的 sessions 路径 defense 在 persistent 模式是 dead code（persistent reuse 走 `#getPersistentClient` L5117-5118）。镀金项必须先证明触发路径真实存在。
- 不重写已正确的恢复模型（event log 单一权威 / checkpoint terminal-only 是设计而非缺陷）。

## 改善项

### P0 — 建立性能基线（benchmark）【局部基线已完成，覆盖待补】

**原问题**：P1 判断最初主要基于代码路径分析，缺少数据。`#1 reconciler tick IO` 曾是推测瓶颈。

**已完成**：`scripts/bench-reconciler-perf.ts` 构造临时 hub 并产出 `docs/product/evidence/perf-baseline-2026-07-23.json`，覆盖：
- 本地 FS、warm cache、assigned 状态热路径下的 `reconcileAssignments()`；N=100 mean/max 为 72/79ms，N=200 为 159/162ms。
- 无 checkpoint 快路的 `readJobProjection`；1002/5002 实际事件分别约 2.6/8.1ms。

**实测修正**：上述范围内未发现 P1-a 瓶颈；`reconcileAssignments()` 不是完整 `hub.tick()`，`TICK_MS=2000` 是 `setTimeout` 安排下一轮的延迟而非单轮 deadline。benchmark 仅 5 runs，JSON 的 `p99Ms` 实际是最大值，脚本的 `eventCount` 少计 `job_created`（实际为 N+2）。

**尚未覆盖**：checkpoint 路径、Redis backend CAS、running/stale-progress probe、完整 `hub.tick()`（scheduler/dispatch）、冷启动及 ≥30 runs。P1-b 的性能影响因此不裁决。

**验收**：当前局部基线 JSON 落库；补齐上述路径后，再决定是否启动 P1 优化。

**风险**：低（只读测，不碰生产码）。

---

### P1-a — reconciler tick IO 密度【局部实测非瓶颈，完整 tick 待测】

**原问题假设**：每 2s tick × N assignments × (`getActiveAttempt` + `_readAccepted` + `_readAttemptResult` + `_readHeartbeat` ≈ 4 次文件 IO)。ORICO 外接 APFS 随机 IO ms 级，N=100 时 ~400 IO/tick 可能逼近 2s 预算。

**证据**：reconciler.ts:1225 reconcileAssignments → getActiveAttempt（caller 确认，**非** getJob，故不走 readJobProjection）。

**实测修正**：在本地 FS、warm cache、assigned 状态、N≤200 的 benchmark 中，N=100 reconcile 段为 72ms mean、79ms max；N=200 为 159ms mean、162ms max，远未接近 2s tick 周期。因此 P1-a 在该范围内标为**非瓶颈**，完整 tick 和其他 backend 仍未测，不能外推全局。

**方案**（仅在补齐路径并确认退化后再定，三选一或组合）：
- assignment 状态内存缓存 + 脏标记，减少 tick 全量文件扫。
- 批量 readdir 替代 per-assignment stat。
- tick 频率自适应（负载低时拉长间隔）。

**验收**：补齐完整 tick benchmark 后，N=100 时 max < 1s（2s 预算的 50%）。

**风险**：中（碰 reconciler 恢复路径，needsHumanReview）。

---

### P1-b — readJobProjection checkpoint 改真 shortcut【当前 benchmark 未覆盖，不裁决】

**代码事实/风险假设**：即使有 checkpoint，`readJobProjection` 仍跑 `materializeJob(events)` 全量做 `CHECKPOINT_REPLAY_MISMATCH` 交叉校验（event-store.ts:2074 `fullyMaterialized`）。checkpoint 当前是**正确性校验，不是性能 shortcut**；长 job 可能产生 O(n) per getJob 成本。

**证据**：event-store.ts:2051-2082。caller 是 job-store 内部（createJob/completePhase/retryJob/completeJob）+ auto-finalizer，频率 = job 状态转换率（非 tick 高频，但单次 O(n)）。

**实测边界/当前裁决**：现有 bench 不写 checkpoint，`readJobProjection` 走无 checkpoint 快路；因此不能用 2.6/8.1ms 的数据确认或拒绝 P1-b。

**方案**：checkpoint 增量 replay suffix + 用 checkpoint.state 的紧凑 hash（非全量 materialize）做等价校验。

**trade-off**：削弱 `CHECKPOINT_REPLAY_MISMATCH` 防护强度（split-brain 的安全网）。必须用等强度 hash 校验替代，不能裸跳。

**验收**：1000-event job 的 readJobProjection < 10ms；hash 校验失败仍 throw。

**风险**：高（碰恢复正确性）。**需 owner 批准**是否接受校验形态变化。

---

### P2 — artifact-store 同步 stat → 异步

**问题**：`lstatSync`/`readdirSync`/`rmdirSync`/`unlinkSync`（artifact-store.ts:3, 1133, 1214, 1228, 1246）阻塞 event loop，verify/probe 密集时影响并发。

**方案**：改 `fs.promises` 异步等价。

**验收**：verify phase probe 期间 event loop 不出现 ms 级阻塞（benchmark 验证）。

**风险**：低-中（IO 改 async，逻辑等价）。

---

### P3 — ctx 上帝对象分域

**问题**：`RunJobState` 25 字段 + `_jobId`/`_currentPhase`/`_attemptId` 突变挂在共享 ctx；当前有 9 个生产文件引用该上下文类型（不含 tests），多个 extracted 模块共享/传递一个部分可变对象（run-job-ports.ts:71-101）。

**方案**：分域——immutable config（cpbRoot/project/ports）/ dynamic-JSON boundary（managedWorktree/scope，已有 `retain:` 注释，不动）/ engine bookkeeping（`_jobId` 等，收进独立 holder）。

**验收**：extracted 模块不再直接 mutate ctx 的 bookkeeping 字段；strict-engine + type-debt 保持零。

**风险**：中（大改，碰 strict-engine gate，需分多个小 slice）。

---

### P4 — 文件粒度守卫【待实现】

**问题**：反复产出超大单文件（`run-job-execute-dag.ts` 1952、`runDagNode` 216 行、`artifact-store.ts` 1595、`session-cache.ts` 1370、`scripts/build-output.mjs` 2097）。

**方案（未落地）**：新增 `scripts/size-guard.ts`（mirror type-debt-guard，file >800 / function >150 行，allowlist baseline）。

**验收**：CI fail on new offenders beyond allowlist。

**风险**：低。当前约 ~109 个 offender 是待正式扫描复核的估算，不能当作已落地 baseline。

## 已落地（本会话 2026-07-23，作为基线）

| 项 | 文件 | 状态 |
|---|---|---|
| commit-size gate（C1+C3 合并：>1000 行/30 文件须带 body）| `scripts/verify-commit-size.ts` + 接线 | ✅ 12 测试 |
| split-brain 锁定测试（非终态 job dagResume 从 event log 重建）| `tests/dag-resume-midflight-authority.test.ts` | ✅ 2 测试 |
| ctx audit "unknown" guard（不写 unknown jobId 进 event log）| `core/engine/run-job-lifecycle.ts` | ✅ 3 测试 |
| worker-restart orphaned attempt 堵漏（dual-path claimedBy 校验）| `server/orchestrator/reconciler.ts` | ✅ +2 测试 |
| conversation-key persistent defense（L5118 providerKey 校验）| `server/services/acp/acp-pool.ts` | ✅ 2 测试 |

全部过 typecheck / strict-engine / type-debt / patch-integrity / 各自测试套件。

## 性能验收（所有 P1+ 改动）

- 改动前后跑覆盖相同路径的 benchmark，对比 `perf-baseline-2026-07-23.json`，退化 >10% 即 fail；当前 5 runs 的 `p99Ms` 按 max 解读。
- 不引入新同步 IO 到热路径。

## 流程约束

- `commit-size gate` 已在 `stabilizationChecks`（verify-stabilization.ts），CI 的 `npm run verify:stabilization` 会执行它。实现只检查当前 `HEAD` 的 `git show --numstat`，不扫描历史提交；因此当前 `b952c61a` 若仍是 HEAD，会因 171171 changed lines / 321 files / 无 body 失败。该 checkpoint 提交不可改写时，应由新的 tip 提交承接，或在该提交作为 tip 的 CI/本地运行中显式设置带理由的 `CPB_COMMIT_SIZE_OVERRIDE`；不能把新 tip 通过误认为历史 checkpoint 已被门禁审查。
- 触及发布门禁的 PR 必跑 `verify:release-gate`，PR 说明是否触及门禁。
- 新 defense / 新优化必须配套测试证明触发路径真实（吸取 conversation-key sessions-路径 dead code 教训）。

## 待 owner 决策

1. **P1-b**：是否补 terminal+checkpoint、Redis、running/probe、完整 tick benchmark（并提高到 ≥30 runs），再决定是否接受 readJobProjection 校验形态变化？这是正确性 vs 性能的真实 trade-off。
2. **P1-a**：在补齐完整 tick 与 backend 覆盖后，若仍有退化，是否启动 reconciler IO 优化？当前局部实测不支持立即优化。
