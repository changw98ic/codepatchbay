# CodePatchbay — 本地 coding-agent 交付运行时

> 用 ACP (Agent Client Protocol) 连接 coding agents，执行任务拆解 → 分派 → 证据记录 → 验证 → 交付，结果落成本地可审查产物或草稿 PR。

## 项目概览

CodePatchbay 是一个 **纯 Node.js CLI 工具**（运行时依赖仅 `chokidar`），定位为本地/私有化的 coding-agent 交付运行时。它不替代 Claude Code / Codex / 其他 agent，而是用 ACP stdio 协议中立地连接它们，编排 plan → execute → verify 流水线，记录 evidence/checklist/verdict，并通过 durable event log + checkpoint 支持中断恢复与多 worker 调度。

核心使用路径：`cpb pipeline <project> "<task>" [retries]` 一条全自动流水线；也可单命令手动触发各阶段。

## 架构

代码按「领域核心 → 编排层 → 运行时胶水」三层组织。**`core/` 不依赖 `server/`**（注释明确要求），可被任何宿主复用。

```
cpb                         # bin 入口 → cli/cpb.ts (纯 Node.js 命令路由)
│
├── core/                   # 领域核心 (无 server/ 依赖)
│   ├── engine/             # 状态机主干
│   │   ├── run-job.ts      # ★ Engine.runJob — native phase state machine (主入口, ~78k)
│   │   ├── dag-builder.ts  # workflow DAG 构建 + adversarial verify 注入
│   │   ├── phase-policy.ts # 语义 phase 解析
│   │   ├── completion-gate.ts # verdict 解析 + 完成门判定
│   │   ├── scope-guard.ts  # 改动范围校验 (scope constraint)
│   │   ├── session-pin.ts / poisoned-session.ts # 会话钉住/毒化检测
│   │   └── workflow-runner.ts
│   ├── workflow/           # 工作流定义与执行
│   │   ├── definition.ts   # workflow + phase 解析 (nextPhaseFor / bridgeForPhaseJob)
│   │   ├── dag-executor.ts # DAG 节点 ready/topo 执行
│   │   ├── acceptance-checklist.ts # ★ checklist-first 验证 (冻结/事件索引/覆盖校验)
│   │   ├── checklist-artifacts.ts / verdict.ts / auto-route.ts / evidence-probes.ts
│   ├── phases/             # 各 phase native adapter: plan / execute / verify / review / remediate / adversarial_verify
│   ├── agents/             # agent 注册 / 路由 / 发现 / 评分 / session 缓存 / response 解析 (9 files)
│   ├── artifacts/          # 产物路径 + 存储 + 校验
│   ├── acp/policy.ts       # ACP 写权限策略
│   ├── policy/             # agent-sandbox / child-env / team-policy
│   ├── contracts/          # failure / phase-result / supervisor-decision / git-platform
│   ├── setup/              # setup wizard / detect / install-plan / health-check / agent-catalog (6 files)
│   ├── triage/  handoff/  evolve/  job/  auth/  paths.ts
│
├── server/                 # ★ 不是 HTTP server，是 hub/队列编排层
│   ├── orchestrator/       # 多 worker 调度
│   │   ├── hub-orchestrator.ts # 主调度循环 (tick 2s / janitor 30s / backoff)
│   │   ├── leader-lock.ts      # leader 选举 (单 leader 多 worker)
│   │   ├── scheduler.ts        # 任务 → worker 派发
│   │   ├── worker-supervisor.ts # managed-worker 进程生命周期
│   │   ├── reconciler.ts       # stale worker/job 对账
│   │   ├── failure-router.ts   # 失败分流 (重试/补救/升级)
│   │   └── acp-supervisor.ts   # ACP session 池监督
│   └── services/           # 编排服务
│       ├── engine-runner.ts # ★ 桥: 组装 ctx 注入 core/engine/run-job (createJob/appendEvent/pool 都从这里注入)
│       ├── hub/hub-queue.js + hub-registry.js # 任务队列 + 项目注册
│       ├── job/   event/   project/  acp/  provider-*.ts (provider 适配 + 配额 + usage)
│       ├── phase-runner.ts / phase-context.ts / permission-matrix.ts
│       └── stream/stream-server.ts # ★ 唯一的 HTTP: Node 原生 SSE (node:http), 由 `cpb stream` 启动
│
├── bridges/                # 运行时胶水 (worker 进程执行用, 不是领域核心)
│   ├── run-pipeline.ts     # pipeline 编排 (worker 侧)
│   ├── run-phase.ts / job-runner.ts / project-worker.ts
│   ├── runtime-services.ts / engine-bridge.ts
│   └── *.sh                # common.sh / run-pipeline.sh / verifier.sh
│
├── runtime/                # 运行时工作目录 (evolve/ git/ mcp/ worker/)
├── cpb-task/               # ★ durable 持久化
│   ├── events/{project}/{jobId}.jsonl  # append-only event log
│   ├── checkpoints/        # ★ job 检查点 (替代旧 lease 模型)
│   ├── jobs-index.json     # 全局 job 索引 (projection)
│   ├── agent-homes/  evolve/  acp-audit/  performance/  codegraph-logs/
│
├── cli/                    # cpb.ts 路由 + commands/*.ts (17 commands)
├── shared/                 # 跨层共享 (logger / orchestrator store)
├── scripts/                # 构建/测试/verify 脚本 (build:node, run-node-tests, verify-p0-p1)
├── wiki/                   # 共享记忆文件系统 (schema.md 宪法 + projects/)
├── profiles/               # ★ 5 个角色: planner / executor / reviewer / verifier / remediator (各含 soul.md + config.json)
├── templates/handoff/      # 交接文档模板 (plan-to-execute, execute-to-review)
└── tests/                  # 89+ .test.ts (Node 内置 runner) + integration/ + fixtures/ + helpers/
```

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript (strict, ESM) → 编译到 `dist/` 执行 |
| 运行时 | Node.js ≥ 20，**仅依赖 `chokidar`**（文件监听） |
| CLI | 纯 Node.js（`cli/cpb.ts`，无第三方 CLI 框架） |
| ACP 通信 | JSON-RPC over stdio |
| HTTP（可选） | Node 原生 `http` + SSE（仅 `cpb stream`，非框架） |
| 持久化 | 文件系统（JSONL events / JSON state / Markdown wiki / checkpoint） |
| 并发控制 | leader-lock（单 leader）+ worker-supervisor + reconciler，checkpoint 恢复 |
| 构建/测试 | `tsc` 编译；Node 内置 test runner；shell 冒烟测试 |

## 核心数据流

```
任务 → auto-route → prepare 自动构造 acceptance-checklist → 冻结 + 事件索引
                                    ↓
  workflow DAG (plan→execute→adversarial_verify→review→...)
                                    ↓
  各 phase 由 agent 路由选 agent (planner/executor/verifier/remediator)
  verify: probe-runner 产确定性证据 + verifier 产逐项 checklistVerdict
                                    ↓
  completion-gate 判定 PASS/FAIL/PARTIAL
```

- `core/engine/run-job.ts` 是状态机主干：构建 DAG → 冻结 checklist → 顺序执行 phase → quota fallback → handoff bundle → completion-gate。
- Agent 间共享记忆走文件系统（wiki + artifacts），写入权限由 `core/acp/policy.ts` 隔离。

## 关键约定

### ACP 连接
- Codex adapter: `codex-acp` 或 `npx -y @zed-industries/codex-acp`
- Claude adapter: `claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- 环境变量覆盖: `CPB_ACP_{CODEX|CLAUDE}_{COMMAND|ARGS}`, `CPB_ACP_CWD`, `CPB_ACP_TIMEOUT_MS`
- `CPB_ACP_TIMEOUT_MS` 是空闲超时（activity-based），设 `0` 禁用

### Agent 角色（5 个，非 codex/claude 二元）
`profiles/` 定义 5 个角色，每个含 `soul.md`（系统提示）+ `config.json`：
- **planner** — 规划，写 `inbox/plan-*`
- **executor** — 执行，写项目代码 + `outputs/deliverable-*`
- **verifier** — 验证，写 `outputs/verdict-*`（`VERDICT: <PASS|FAIL|PARTIAL>`）
- **reviewer** — 审查交付物
- **remediator** — 补救失败（带 skills: debug/lint/tdd/test/review-feedback）

> 任意 ACP-compatible agent（Codex/Claude/其他）通过 `core/agents/routing.ts` 映射到这 5 个语义角色。

### Checklist-first 验证（核心不变量，默认启用）
- `core/engine/run-job.ts` `freezeChecklistAndMaterializeDag`：prepare 阶段**默认为每个 job 自动构造** acceptance-checklist（task + documents + riskMap → `buildAcceptanceChecklist`），随后**冻结 + 事件索引**。外部经 `sourceContext.acceptanceChecklist` 注入的预构建 checklist 仍受支持（优先采用），但**无 legacy verifier 降级路径**——所有 job 都 checklist-aware
- `core/workflow/probe-runner.ts`：verify 阶段的**确定性静态探针**，为每个 static checklist item 产客观范围证据（queryId + matchCount），喂给 evidence-ledger。证据合法判据 = queryId 非空 + matchCount 整数（matchCount=0 也合法，诚实反映空范围 item）
- 构造后必须经 `validateAcceptanceChecklist` + `validateChecklistSourceCoverage`；任一失败 → job fail-closed
- verify phase（`core/phases/verify.ts`）：verifier agent 必须产出逐项 `checklistVerdict`；`status:"fail"` 的 checklistVerdict（或缺失/非法 → 合成）使 verify phase `VERIFICATION_FAILED`/`VERDICT_INVALID`

### Durable Job 系统
- Event log: `cpb-task/events/{project}/{jobId}.jsonl` (append-only)
- Checkpoints: `cpb-task/checkpoints/` (job 检查点，恢复用)
- 索引: `cpb-task/jobs-index.json` (projection)
- Leader/worker: `server/orchestrator/` 通过 checkpoint + event log 恢复执行
- Worktree: task-level git worktree 隔离改动

### Wiki 原子性
- Handoff 文件必须包含 `## Handoff` 头和 `## Acceptance-Criteria` 尾
- 原子 ID 生成 + 原子日志追加: mkdir lock 防碰撞

### Verdict 格式（机器解析）
```
VERDICT: <PASS|FAIL|PARTIAL>
```
Completion-gate 解析此行决定 job 走向。

## 开发命令

```bash
# === CLI（核心路径）===
cpb init /path/to/project my-project      # 初始化项目
cpb pipeline my-project "Add unit tests" 3  # 全自动流水线 (含 retries)
cpb run "Add dark mode" --project my-project  # pipeline 别名
cpb retry my-project <job-id> [--agent codex] # 重试 job phase
cpb status my-project                     # 项目状态
cpb list                                  # 列出项目
cpb jobs report [--json]                  # job 运行报告 (reconcile/gc 已移除，改用 report)
cpb jobs worktrees                        # 列出 task-level git worktrees
cpb diff my-project                       # git diff
cpb review my-project [id] [--agent]      # 审查交付物
cpb inbox my-project [read|ack|done|outputs]  # 计划/产物管理
cpb hub status|start|stop|projects        # hub 管理
cpb cancel my-project <jobId> "reason"
cpb redirect my-project <jobId> "new instruction"
cpb stream [--port PORT] [--host HOST]    # 启动 SSE 流式服务
cpb agents [list|detect|install|test]     # agent gateway 设置
cpb github [bind|connect|doctor]          # GitHub 集成
cpb doctor [--json]                       # 健康检查 (exit 0=ok, 1=errors)
cpb health-check                          # 完整自检 (含测试 + 构建)
cpb setup                                 # 交互式 setup 向导

# === 开发 ===
npm run build        # tsc → dist/ (build:node)
npm run build:tests # tsc tests → dist-tests/
npm test            # build:node + build:tests + run-node-tests + shell 冒烟
npm run test:unit / test:integration
npm run typecheck   # tsc --noEmit (node + tests configs)
npm run verify:p0p1 # build + 构建 + P0/P1 验证门
```

## 测试结构

- `tests/*.test.ts` — **89+ 个** Node 内置 test runner 单元/集成测试（编译到 `dist/tests/` 执行）
- `tests/integration/` — 端到端集成测试
- `tests/fixtures/` — fake ACP agent stub
- `tests/helpers/` — 测试工具（spawn-file 等）
- `tests/cpb-bridges.test.sh` / `cpb-jobs.test.sh` — shell 冒烟测试
- 测试包含 **10 轮 adversarial-round-{1..10}** 验证
- 入口: `npm test` → `dist/scripts/run-node-tests.js`

## HTTP 服务（仅可选）

项目**默认无 HTTP server**。唯一可选服务是 `cpb stream`，基于 Node 原生 `http` 提供 SSE 事件流：

```
GET  /events          # SSE — 实时推送 event log (job/phase/wiki 变更)
GET  /jobs            # job 列表 JSON
```

由 `server/services/stream/stream-server.ts` 实现，无 Fastify/Express 依赖。

## 注意事项

- **代码探索优先 codegraph**：符号查找、调用链、架构理解、where-is 先用 codegraph MCP 工具（`codegraph_context` / `codegraph_search` / `codegraph_node` / `codegraph_callers` / `codegraph_trace` / `codegraph_impact`），项目已 indexed（335 文件 / 6729 nodes / 15553 edges）。`grep` + `Read` 只补 codegraph 没覆盖的具体细节——不要用 grep+read loop 重复 codegraph 已做的索引工作（慢且漏跨文件关系）。**改代码前先 codegraph 查符号定义、callers、调用路径**。本次会话曾因全程 grep 漏掉 PhaseResult 8 套碎片化定义、文档引用漂移，代价不该重复。
- 项目名只允许 `[a-zA-Z0-9-]`，通过 `require_safe_name` 校验
- **领域核心入口是 `core/engine/run-job.ts`**（不是 server/）—— server/engine-runner 只是注入 ctx 的桥
- `core/` 严禁 import `server/`（分层不变量，注释中声明）
- 持久化根由 `CPB_ROOT` / `CPB_EXECUTOR_ROOT` / hub root 解析
- Pipeline 的 total timeout 通过 watchdog 写 state flag，不杀进程
- `wiki/schema.md` 是 Wiki 宪法，所有 agent 必须遵守其写入权限和不可变规则
- 所有 `.ts` 编译到 `dist/` 运行；改完源码需 `npm run build` 才生效
