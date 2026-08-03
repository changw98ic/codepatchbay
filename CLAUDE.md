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
├── server/                 # Hub HTTP API + hub/队列编排层
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
│       └── stream/stream-server.ts # 独立的 Node 原生 SSE/只读 job 服务，由 `cpb stream` 启动
│
├── bridges/                # 运行时胶水 (worker 进程执行用, 不是领域核心)
│   ├── run-phase.ts / job-runner.ts
│   ├── runtime-services.ts / engine-bridge.ts
│   └── *.js                # 运行时边界适配器
│
├── runtime/                # 运行时工作目录 (evolve/ git/ mcp/ worker/)
├── Hub projects/<project>/ # ★ 项目隔离的 durable runtime
│   ├── wiki/               # 项目上下文、inbox、outputs
│   ├── events/             # append-only event log
│   ├── checkpoints/        # job 检查点
│   ├── state/              # canonical runtime state
│   └── jobs-index.json     # 项目 job 索引
│
├── cli/                    # cpb.ts 路由 + commands/*.ts (17 commands)
├── shared/                 # 跨层共享 (logger / orchestrator store)
├── scripts/                # 构建/测试/verify 脚本 (build:node, run-node-tests, verify-p0-p1)
├── wiki/                   # 共享记忆文件系统 (schema.md 宪法 + projects/)
├── profiles/               # ★ 5 个角色: planner / executor / reviewer / verifier / remediator (各含 soul.md + config.json)
├── templates/handoff/      # 交接文档模板 (plan-to-execute, execute-to-review)
└── tests/                  # 230+ .test.ts (Node 内置 runner) + integration/ + fixtures/ + helpers/
```

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript (strict, ESM) → 编译到 `dist/` 执行 |
| 运行时 | Node.js ≥ 20，**仅依赖 `chokidar`**（文件监听） |
| CLI | 纯 Node.js（`cli/cpb.ts`，无第三方 CLI 框架） |
| ACP 通信 | JSON-RPC over stdio |
| HTTP（可选） | Node 原生 `http`：Hub API，以及独立的 `cpb stream` SSE/只读服务 |
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
- Event log: `<hub>/projects/<project>/events/<project>/<jobId>.jsonl` (append-only)
- Checkpoints: `<hub>/projects/<project>/checkpoints/` (job 检查点，恢复用)
- 索引: `<hub>/projects/<project>/jobs-index.json` (projection)
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
cpb setup --quickstart --demo             # 本地无密钥演示
cpb setup                                 # 交互式 setup 向导

```

<!-- BEGIN REPOSITORY COMMAND CONTRACT -->
## Local code index and repository checks

Use the repository-owned local index before relying on code-search results. The index lives outside the source tree and does not use an MCP server, daemon, PID file, socket, or `.codegraph` state.

```bash
cpb code-index status -s . --json
cpb code-index build -s . --json
cpb code-index query definitions --symbol runJob -s . --json
cpb code-index query references --symbol runJob -s . --json
cpb code-index query inventory -s . --json
```

Use indexed results only when status reports `available: true` and `fresh: true`. Rebuild a missing or stale index, then check status again. Read the source file directly for exact text. If status reports file-inventory-only coverage, describe only file-level coverage; do not claim a complete symbol or call graph.

The repository commands below are the supported development entry points:

- `npm ci` installs the locked dependencies.
- `npm run build:node` compiles the application to `dist/`.
- `npm run build:tests` compiles tests to `dist-tests/`.
- `npm run typecheck` checks the application and tests without emitting files.
- `npm test` runs the default Node and shell test suites.
- `npm run test:main` runs the main-flow profile and shell checks.
- `npm run test:integration` runs the real-process integration profile.
- `npm run test:specialized` runs benchmark, evaluation, release-rehearsal, and packaging checks.
- `node dist-tests/scripts/run-node-tests.js --main --list` prints the current main-flow file set without running it; documentation must not copy a fixed file count.
- `npm run verify:release-contracts` runs the focused release-contract checks.
- `npm run verify:release-gate` runs the complete release gate and requires configured signing and external evidence.
<!-- END REPOSITORY COMMAND CONTRACT -->

## 测试结构

- `tests/*.test.ts` — Node 内置 test runner 单元/契合测试（编译到 `dist-tests/` 执行）
- `tests/integration/` — 端到端集成测试
- `tests/fixtures/` — fake ACP agent stub
- `tests/helpers/` — 测试工具（spawn-file 等）
- `tests/cpb-bridges.test.sh` / `cpb-jobs.test.sh` — shell 冒烟测试
- 测试包含 **10 轮 adversarial-round-{1..10}** 验证
- 入口: `npm test`（经 `pretest:node` 自动 `build:node + build:tests`）→ `node dist-tests/scripts/run-node-tests.js`

### 跑单个测试

runner 接受文件路径参数（自动剥 `dist-tests/`/`dist/` 前缀并 `.ts→.js`），改过源码先编译：

```bash
npm run build:tests                                                       # 若刚改过源码/测试
node dist-tests/scripts/run-node-tests.js tests/path/to/file.test.ts      # 单文件
node dist-tests/scripts/run-node-tests.js tests/foo.test.ts tests/bar.test.ts  # 多文件
node dist-tests/scripts/run-node-tests.js --unit         # 仅 unit
node dist-tests/scripts/run-node-tests.js --integration  # 仅 integration
```

runner 启动时清掉所有 `CPB_*` 环境变量并强制 `CPB_CHECKLIST_DECOMPOSE=0` / `CPB_WORKER_DISPATCH_ENABLED=0`（测试用 fake agent pool，生产默认行为不受影响）。

## HTTP 服务（可选）

项目有两个基于 Node 原生 `http` 的可选服务，不依赖 Fastify 或 Express：

- `cpb hub start` 启动 `server/index.ts` 的 Hub API，提供身份检查、健康状态、项目清单和内部 worker 状态入口。Hub 默认监听回环地址；服务令牌或 OIDC 用于认证，匿名开发模式只能显式用于回环地址。
- `cpb stream` 启动 `server/services/stream/stream-server.ts`，提供 `/stream` SSE、`/jobs` 和只读 job/wiki 查询。它默认要求 bearer token；匿名开发模式同样只允许回环地址。

两个服务在非回环地址上使用明文 HTTP 时都要求显式确认；正式部署应在可信反向代理处终止 TLS。

## 注意事项

- 项目名只允许 `[a-zA-Z0-9-]`，通过 `require_safe_name` 校验
- **领域核心入口是 `core/engine/run-job.ts`**（不是 server/）—— server/engine-runner 只是注入 ctx 的桥
- `core/` 严禁 import `server/`（分层不变量，注释中声明）
- 持久化根由 `CPB_ROOT` / `CPB_EXECUTOR_ROOT` / hub root 解析
- Pipeline 的 total timeout 通过 watchdog 写 state flag，不杀进程
- `wiki/schema.md` 是 Wiki 宪法，所有 agent 必须遵守其写入权限和不可变规则
- 所有 `.ts` 编译到 `dist/` 运行；改完源码需 `npm run build` 才生效（`npm test` 经 `pretest:node` 会自动 build，单独跑 `node dist-tests/...` 需手动 `npm run build:tests`）
- **稳定化周期（README 红线）**：当前冻结横向能力扩张——**不新增** agent 类型、workflow 类别、scheduler 特性或 provider 集成，优先清偿执行内核恢复边界 / 事件顺序 / provider handoff 拆分 / managed-worker 隔离证据。触及发布门禁的 PR 必须跑 `npm run verify:release-gate`，并在 PR 中说明是否触及门禁


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
