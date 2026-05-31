# CPB 多 Agent 编排增强 Roadmap

> 基于 PilotDeck / AutoGen / LangGraph / CrewAI 等生态研究报告，结合 CPB v0.3.2 现状制定。
> 原则：**默认不改现有路径，每步可单独合并回滚，feature flag 控制所有新能力。**

## 现状评估

CPB 已有但未充分利用的资产：

| 资产 | 位置 | 状态 |
|---|---|---|
| 事件源 (JSONL append-only) | `server/services/event-store.js` | 成熟，939 行，支持 materialize/checkpoint/seal |
| Job 生命周期 | `server/services/job-store.js` | 成熟，含 routing/failure codes/recovery |
| 分布式 lease | `server/services/lease-manager.js` + `core/lease/` | 成熟，atomic lock + heartbeat |
| Agent 路由 | `core/agents/routing.js` | 基础可用，规则驱动，缺成本/复杂度感知 |
| 上下文分层 | `server/services/phase-context.js` + knowledge-* | 存在但无预算统计 |
| 可观测性 | `server/services/observability.js` + `observer.js` + `performance-tracker.js` | 有框架，缺 UI 暴露和 job timeline |
| ACP 持久进程池 | `bridges/acp-pool.mjs` + `runtime/acp-client.mjs` | 成熟，含 reuse/回收/429 处理 |
| Supervisor | `bridges/supervisor-loop.mjs` | 可用，支持 DAG recovery |
| 控制面 Web UI | `web/` (React 19 + Vite) | 存在，缺 timeline/route trace/memory 面板 |

**核心判断：CPB 的基础设施比研究报告描述的更成熟。真正缺的不是"更多 agent"，而是三层东西：可观测性 → 智能路由 → 决策记忆。**

---

## Phase 0: 可观测性底座 (0-6 周)

> 目标：让现有系统"跑完后看得见"。不改执行路径。

### 0.1 tool-loop-detector
- **文件**: 新增 `bridges/tool-loop-detector.mjs`
- **改动**: `bridges/acp-client.mjs` 注入可选 detector
- **行为**: 默认关闭，开启后只记录不拦截，连续 3 次相同指纹 (tool+args+cwd) 才告警
- **测试**: 单元测试 + ACP 客户端集成测试
- **状态**: 已有设计方案 (`docs/project-shortcomings-plan-plain.md`)，直接执行

### 0.2 context-budget
- **文件**: 新增 `server/services/context-budget.js`
- **改动**: 读取 `composePromptContext` 返回的 layers，输出每层字符数/占比/是否必保
- **行为**: 只统计不裁剪，不改默认返回结构
- **测试**: 单元测试覆盖空层/超长层/必保标记

### 0.3 job-run-report
- **文件**: 新增 `server/services/job-run-report.js` + `cli/commands/report.js`
- **改动**: 只读 `cpb-task/events/`，输出任务总数/状态分布/阶段失败/重试取消/最近异常
- **CLI**: `cpb report [project]`
- **测试**: 单元测试 + CLI 冒烟

### 0.4 job-timeline (新增)
- **文件**: 新增 `server/services/job-timeline.js`
- **改动**: 从 event-store materialize 结构提取 timeline 数据：phase 开始/结束时间、lease 持有者、tool 调用序列、routing decision、secret blocked、DAG 节点状态
- **API**: `GET /api/projects/:name/jobs/:id/timeline`
- **前端**: Dashboard 增加 Timeline 面板 (复用现有 React 组件)
- **测试**: API 测试 + 前端组件测试

### 0.5 route-trace (新增)
- **文件**: 修改 `server/services/job-store.js`，在 `resolveEffectiveRouting` 写入 route decision 事件
- **事件类型**: `route_decision` (含 chosen agent/model, reason, fallback chain, category)
- **前端**: Timeline 面板中展示路由选择
- **测试**: 验证事件写入和前端渲染

**验收**: `cpb report` 输出统计；Web UI 可查看单个 job 的完整 timeline + route trace；现有 smoke 和 CI 不退化。

---

## Phase 1: WorkPack — 项目级上下文容器 (4-10 周)

> 目标：把散落的 job/工件/约束/路由痕迹归到项目级容器，为记忆和路由打基础。

### 1.1 WorkPack 定义
- **文件**: 新增 `core/workpack/schema.js`
- **结构**:
  ```
  cpb-task/packs/{project}/
    meta.json          # project name, created, updated
    constraints.md     # 项目硬约束 (从 handoff/job 中提取)
    routing-history.jsonl  # 历史路由决策 + 结果
    artifacts/         # 指向 cpb-task/events/ 中产物的索引
    worktree-map.json  # job → worktree 映射
  ```
- **行为**: 只在 job 完成/失败时追加，不改执行时逻辑
- **测试**: schema 验证 + 读写测试

### 1.2 WorkPack Builder
- **文件**: 新增 `server/services/workpack-builder.js`
- **改动**: 监听 event-store 的 terminal 事件，自动提取约束/路由/产物到 WorkPack
- **测试**: 模拟 job 完成事件，验证 WorkPack 内容

### 1.3 CLI: `cpb pack`
- **文件**: 新增 `cli/commands/pack.js`
- **命令**: `cpb pack show <project>` / `cpb pack export <project>`
- **测试**: CLI 冒烟

**验收**: job 完成后自动生成/更新 WorkPack；`cpb pack show` 可查看项目约束和路由历史；不改执行路径。

---

## Phase 2: 智能路由 (8-16 周)

> 目标：从"规则驱动"升级到"规则 + 任务画像 + 成本感知"路由。

### 2.1 任务画像器
- **文件**: 新增 `core/agents/task-profiler.js`
- **输入**: 任务描述、变更文件数、受影响目录、历史验证失败率、项目 WorkPack
- **输出**: `{ complexity: 1-5, category, sensitivity, estimatedTokens }`
- **测试**: 各类任务描述的画像准确性

### 2.2 Route Judge
- **文件**: 新增 `core/agents/route-judge.js`
- **逻辑**:
  - 复杂度 1-2 → haiku/轻量 agent
  - 复杂度 3 → 当前默认路由
  - 复杂度 4-5 → opus/强 agent
  - 敏感度高 (security/secrets) → 强制强 agent + 人工确认
  - 成本预算超限 → 降级或暂停
- **集成**: 替换 `job-store.js` 中 `selectAgentWithFallback` 的部分逻辑
- **Feature flag**: `router_v1`，默认关闭，开启后仍保留旧路径作为 fallback
- **测试**: 路由决策回归测试集 (20+ 代表性任务)

### 2.3 路由评测集
- **文件**: 新增 `tests/routing-benchmark/`
- **内容**: 20-30 个代表性仓库任务 (bugfix/test/docs/security/frontend/backend)
- **指标**: 成功率、成本、时延、route 回退率
- **CI**: 每次路由逻辑变更自动跑 benchmark

### 2.4 成本追踪
- **文件**: 新增 `server/services/cost-tracker.js`
- **事件**: `cost_recorded` (含 agent, model, input_tokens, output_tokens, cost_usd)
- **API**: `GET /api/projects/:name/costs`
- **集成**: ACP client 返回 token 用量时自动记录

**验收**: 20 个 benchmark 任务中 ≥16 个路由合理；成本面板可用；`router_v1` flag 可一键关闭回退。

---

## Phase 3: 白盒决策记忆 (12-20 周)

> 目标：从"只记事件"升级为"记决策、约束、偏好、失败教训"。

### 3.1 Decision Ledger
- **文件**: 新增 `server/services/decision-ledger.js`
- **存储**: `cpb-task/packs/{project}/ledger.jsonl`
- **条目类型**: `constraint` / `preference` / `failure_lesson` / `human_ruling` / `code_convention`
- **生命周期**: 从 job events + handoff 中自动提取，支持人工编辑
- **测试**: 提取准确性 + CRUD

### 3.2 记忆注入
- **文件**: 修改 `server/services/phase-context.js` (或新增 `memory-injector.js`)
- **行为**: 任务开始时从 WorkPack + Ledger 中检索相关条目，注入 prompt context
- **Feature flag**: `memory_v1`，默认关闭
- **测试**: 注入命中率 + 无关条目过滤

### 3.3 记忆 UI
- **前端**: 新增 Decision Ledger 面板
- **功能**: 查看/编辑/删除/禁用单条记忆
- **API**: `GET/PUT/DELETE /api/projects/:name/ledger/:id`

### 3.4 记忆回收
- **逻辑**: 过期/冲突/低置信度记忆自动降权
- **策略**: 30 天未命中的 constraint → 标记为 stale；人工 ruling 优先于自动提取

**验收**: 20 个回放任务中 ≥16 个能正确恢复项目约束；记忆可编辑/禁用；`memory_v1` 可一键关闭。

---

## Phase 4: 后台调度与 Always-on (16-24 周)

> 目标：从"被动接任务"升级到"轻度主动推进"。

### 4.1 定时任务
- **文件**: 新增 `server/services/cron-scheduler.js`
- **功能**: cron 表达式驱动，支持 repo 巡检、回归验证、依赖更新检查
- **集成**: 复用现有 lease + supervisor 机制
- **Feature flag**: `scheduler_v1`

### 4.2 空闲触发
- **逻辑**: 检测 WorkPack 中 "上次 verify 通过但距今 >N 天" 的项目，自动触发巡检
- **预算**: 每日 token 上限，超限自动暂停
- **回滚**: 巡检失败不改代码，只写事件

### 4.3 进程恢复增强
- **改动**: `bridges/supervisor-loop.mjs` 增加 stale job 恢复后自动重入队列
- **测试**: 模拟进程 kill → 恢复 → 任务续跑

**验收**: 定时任务可配置且进程重启后可恢复；空闲巡检受预算控制；不重复执行已完成任务。

---

## Phase 5: 控制面 API 与扩展 (20-30 周)

> 目标：为 UI、IDE 集成、第三方扩展提供统一入口。

### 5.1 WS/HTTP 控制面 API
- **API 设计**:
  ```
  GET  /api/control/jobs              # 带 timeline 的 job 列表
  GET  /api/control/jobs/:id/timeline  # 完整 timeline
  GET  /api/control/routes             # 路由历史
  GET  /api/control/ledger/:project    # 决策记忆
  GET  /api/control/costs/:project     # 成本统计
  WS   /ws/events                      # 实时事件流 (扩展现有 WS)
  ```
- **安全**: 只读查询 + 控制写入分层，鉴权沿用现有机制

### 5.2 Hook/Plugin API v1
- **文件**: 新增 `core/hooks/schema.js` + `server/services/hook-registry.js`
- **生命周期**: `on_job_created` / `on_phase_completed` / `on_route_decision` / `on_memory_stored`
- **注册**: 通过 `cpb hook add <path>` 或项目 `.cpb/hooks.json`
- **测试**: hook 触发顺序 + 隔离 + 错误不影响主流程

### 5.3 MCP 集成探索
- **方向**: 工具/知识服务器通过 MCP 接入，ACP 继续作为 coding-agent 协议
- **PoC**: 一个 MCP server 提供项目文档检索，作为 context layer 注入
- **评估**: 性能、token 开销、维护成本

**验收**: 第三方可基于 Hook API 写出最小插件；控制面 API 可被 Web UI 消费；MCP PoC 可演示。

---

## 依赖关系

```
Phase 0 (可观测性)
  ├── 0.1 tool-loop-detector ─┐
  ├── 0.2 context-budget ─────┤
  ├── 0.3 job-run-report ─────┼──→ Phase 1 (WorkPack)
  ├── 0.4 job-timeline ───────┤         │
  └── 0.5 route-trace ────────┘         ▼
                               Phase 2 (智能路由)
                                      │
                                      ▼
                               Phase 3 (决策记忆)
                                      │
                                      ▼
                               Phase 4 (后台调度)
                                      │
                                      ▼
                               Phase 5 (控制面 API)
```

**硬约束**: 可观测性 → 路由 → 记忆，不可跳跃。没有 route trace 和 benchmark，路由不可验证；没有 WorkPack，记忆会泄漏成全局上下文。

---

## 指标体系

| 指标 | 定义 | 目标 | 阶段 |
|---|---|---|---|
| 任务成功率 | PASS verdict / total | ≥80% | Phase 0+ |
| 验证通过率 | verify PASS / verify total | ≥75% | Phase 0+ |
| 人工接管率 | human redirect / total | ≤15% | Phase 2+ |
| 平均成本/成功任务 | total cost / successful jobs | 下降 20% | Phase 2+ |
| p50/p95 端到端时延 | job created → completed | p50 <10min, p95 <30min | Phase 0+ |
| 工具死循环告警率 | tool-loop alerts / total jobs | ≤5% | Phase 0+ |
| route 回退率 | fallback to default / total | ≤20% | Phase 2+ |
| 记忆命中相关性 | useful injections / total injections | ≥70% | Phase 3+ |
| 重复执行率 | duplicate phase runs / total | ≤3% | Phase 4+ |

---

## 风险控制

### Feature Flag 清单
| Flag | 默认 | 控制范围 |
|---|---|---|
| `tool_loop_detector` | OFF | Phase 0.1 |
| `context_budget` | OFF | Phase 0.2 |
| `router_v1` | OFF | Phase 2 |
| `memory_v1` | OFF | Phase 3 |
| `scheduler_v1` | OFF | Phase 4 |
| `gateway_api_v1` | OFF | Phase 5 |
| `distributed_runner_v0` | OFF | 未来 |

### 回滚策略
- 每个 Phase 的新增文件可独立删除
- 所有新事件类型不改现有 materialize 逻辑
- 路由/记忆/调度均保留"静态 plan→execute→verify 旧路径"作为保底
- 双写单读：新路径稳定后再切读路径

### 暂停条件 (任一触发则停)
- 需要改现有事件格式的 schema
- 需要新增外部数据库依赖
- 现有 smoke/CI 退化
- 成本指标无改善

---

## 不做的事

| 能力 | 为什么不做 |
|---|---|
| IM 渠道接入 (Slack/Discord/飞书) | CPB 的稀缺性在仓库内交付，不在聊天入口 |
| 桌面壳层 | 增加维护成本，不解决核心问题 |
| 通用 Agent OS | 与 CPB "仓库内编排" 定位冲突 |
| 分布式 runner | 短期无此需求，本地优先是优势 |
| 自动上下文裁剪 | 没有预算数据前裁剪 = 盲切 |
| MCP 全面替换 ACP | ACP 天然适合 coding-agent，MCP 适合工具层，互补不替代 |

---

## 生态建设 (持续)

1. **ACP 兼容矩阵**: 公开哪些 agent/version 通过了哪些测试
2. **Benchmark 套件**: `tests/routing-benchmark/` 可重复运行
3. **Hook 示例仓库**: 最小可工作的 hook 插件模板
4. **Wiki 规范**: 已有 `wiki/schema.md`，补充 Hook/Plugin 注册规范
