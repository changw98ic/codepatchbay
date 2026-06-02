# CodePatchbay — Codex + Claude Code ACP Workflow

> Codex 做规划验证，Claude Code 做执行，ACP 做统一连接层，Wiki 做共享记忆。

## 项目概览

CodePatchbay 是一个 multi-agent 工作流编排系统。通过 ACP (Agent Client Protocol) stdio 协议连接 Codex 和 Claude Code，实现 plan → execute → verify 的自动化流水线。支持手动逐步、Web UI 协作、全自动流水线三种使用模式，以及基于 durable event log 的 24h 无人值守模式。

## 架构

```
cpb (CLI入口, Node.js — cli/cpb.mjs → cli/commands/*.js)
├── bridges/               # ACP bridges + runtime
│   ├── acp-client.mjs     # ACP stdio JSON-RPC client
│   ├── acp-pool.mjs       # ACP session pool
│   ├── run-pipeline.mjs   # Full pipeline orchestrator (plan→execute→verify+retry)
│   ├── engine-bridge.js   # Queue/orchestrator job bridge
│   ├── dual-research.mjs  # Dual-agent research
│   ├── multi-evolve.mjs   # Multi-phase evolution
│   └── ...                # review, merge, provider-soak, etc.
├── cli/                   # CLI router + command modules
│   ├── cpb.mjs            # Entry point + command router
│   └── commands/          # Individual command implementations
├── server/                # Fastify REST + WebSocket 后端
│   ├── index.js           # 入口 (Fastify + WS + file watcher)
│   ├── routes/projects.js # 项目 CRUD API
│   ├── routes/tasks.js    # 任务触发 API
│   └── services/
│       ├── event-store.js # JSONL event log (append-only, materialize)
│       ├── job-store.js   # Job lifecycle (create/phase/complete/fail/block)
│       ├── lease-manager.js # 分布式 lease (atomic write + lock dir)
│       └── hub-orchestrator.js # Queue/orchestrator + managed-worker lifecycle
├── web/                   # React 19 + Vite 前端
│   └── src/
│       ├── App.jsx        # Router + sidebar layout
│       ├── pages/         # Dashboard, Project, NewTask, Review
│       └── hooks/         # WebSocket hook
├── wiki/                  # 共享记忆文件系统
│   ├── schema.md          # Wiki 宪法 (命名规则、权限、不可变规则)
│   └── system/            # 全局文档 (handshake, dashboard, team architecture等)
├── profiles/              # Agent 角色定义 (codex/soul.md, claude/soul.md)
└── templates/handoff/     # 交接文档模板
```

## 技术栈

| 层 | 技术 |
|---|---|
| CLI | Node.js (`cli/cpb.mjs` → `cli/commands/*.js`) |
| Bridge | Node.js — ACP client, pipeline, queue/orchestrator job bridge |
| ACP 通信 | JSON-RPC over stdio |
| 后端 | Fastify 5 + @fastify/websocket + chokidar |
| 前端 | React 19 + React Router 7 + Vite 6 |
| 持久化 | 文件系统 (JSONL events, JSON state, Markdown wiki) |
| 并发控制 | mkdir-based atomic locks, lease with heartbeat |

## 核心数据流

```
Codex (plan) → wiki/projects/{name}/inbox/plan-{id}.md
                 ↓
Claude (execute) → wiki/projects/{name}/outputs/deliverable-{id}.md
                 ↓
Codex (verify) → wiki/projects/{name}/outputs/verdict-{id}.md
```

Wiki 写入权限隔离：Codex 写 `inbox/` 和 `outputs/verdict-*`，Claude 写 `outputs/`（除 verdict）。

## 关键约定

### ACP 连接
- Codex adapter: `codex-acp` 或 `npx -y @zed-industries/codex-acp`
- Claude adapter: `claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- 环境变量覆盖: `CPB_ACP_{CODEX|CLAUDE}_{COMMAND|ARGS}`, `CPB_ACP_CWD`, `CPB_ACP_TIMEOUT_MS`
- `CPB_ACP_TIMEOUT_MS` 是空闲超时（activity-based），设 `0` 禁用

### 权限约束 (`--dangerous` 移除)
- Codex plan: 只写 `inbox/`，不执行终端命令
- Claude execute: 只写项目代码和 `outputs/deliverable-*`
- Codex verify: 只写 `outputs/verdict-*`，不修改代码

### Durable Job 系统
- Event log: `cpb-task/events/{project}/{jobId}.jsonl` (append-only)
- Lease: `cpb-task/leases/{leaseId}.json` (TTL + heartbeat + atomic lock dir)
- State: `cpb-task/state/pipeline-{project}.json`
- Worktree: `cpb-task/worktrees/` (task-level git worktree)
- Hub orchestrator/worker 通过 durable queue 与 lease 状态恢复执行

### Wiki 原子性
- Handoff 文件必须包含 `## Handoff` 头和 `## Acceptance-Criteria` 尾
- 原子 ID 生成: mkdir lock + placeholder file 防止碰撞
- 原子日志追加: mkdir lock

### Verdict 格式 (机器解析)
```
VERDICT: <PASS|FAIL|PARTIAL>
```
Pipeline 通过 grep 此行决定下一步。

## 开发命令

```bash
# CLI
./cpb init /path/to/project my-project
./cpb run "Add dark mode" --project my-project
./cpb pipeline my-project "Add unit tests" 3
./cpb research my-project "Investigate auth patterns"
./cpb evolve-multi --once --project my-project
./cpb repair my-project <job-id> [--agent codex]
./cpb index refresh my-project
./cpb status my-project
./cpb list
./cpb jobs
./cpb jobs reconcile              # Mark stale jobs as failed
./cpb gc                          # Clean stale jobs + orphan leases + pollution
./cpb gc --dry-run                # Preview cleanup
./cpb doctor [--json]             # Health check (exit 0=ok, 1=errors)
./cpb health-check                # HTTP + test suite + frontend build
./cpb recover                     # Alias for gc
./cpb hub status|start|stop
./cpb release list|use|install|doctor|gc
./cpb cancel my-project <jobId> "reason"
./cpb redirect my-project <jobId> "new instruction"
./cpb merge-preview my-project <ref> --base main
./cpb install-bin                 # Install cpb to PATH
./cpb wiki lint

# Web UI (启动后端 + 前端)
./cpb ui [--port PORT] [--host HOST]

# 后端单独开发
cd server && npm run dev    # node --watch index.js

# 前端单独开发
cd web && npm run dev       # vite dev server :5173

# 测试
npm test                          # Node.js 单元测试 (tests/*.test.mjs)
npm run build:web                 # 构建 Vite UI
cd web && npm test                # 前端组件测试
```

## 测试结构

- `tests/*.test.mjs` — Node.js 内置测试运行器的单元测试 (`npm test`)
- `web/src/**/*.test.{jsx,js}` — Vitest 前端组件测试 (`cd web && npm test`)
- `tests/fixtures/` — fake ACP agent stub
- `tests/helpers/` — 测试工具 (如 spawn-file)

## API 端点

```
GET  /api/projects              # 列出所有项目
GET  /api/projects/:name        # 项目详情
GET  /api/projects/:name/inbox  # inbox 文件列表
GET  /api/projects/:name/outputs # outputs 文件列表
GET  /api/projects/:name/files/* # 读取项目文件 (防 path traversal)
POST /api/projects/init         # 初始化新项目
GET  /api/tasks/running         # 运行中任务
GET  /api/tasks/durable         # Durable jobs
POST /api/tasks/:name/plan      # 触发 Codex 规划
POST /api/tasks/:name/execute   # 触发 Claude 执行
POST /api/tasks/:name/verify    # 触发 Codex 验证
POST /api/tasks/:name/pipeline  # 触发全自动流水线
WS   /ws                        # WebSocket (实时事件推送)
```

## 注意事项

- 项目名只允许 `[a-zA-Z0-9-]`，通过 `require_safe_name` 校验
- ACP client (`bridges/acp-client.mjs`) 必须有执行权限
- 后端 CORS 仅允许 `localhost:5173` 和 `127.0.0.1:5173`
- Lease 默认 TTL 120s，heartbeat 间隔 TTL/3
- Pipeline 的 total timeout 通过 watchdog 写 state flag，不杀进程
- `wiki/schema.md` 是 Wiki 宪法，所有 agent 必须遵守其写入权限和不可变规则
